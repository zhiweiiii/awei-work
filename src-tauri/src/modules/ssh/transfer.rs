use super::{deadline, files, main_only, Connection, SshState};
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    task_id: String,
    direction: String,
    names: Vec<String>,
    local_directory: String,
    remote_directory: String,
    overwrite: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    task_id: String,
    file: String,
    bytes: u64,
    files: u32,
}

struct Running {
    connection: Arc<Connection>,
    cancel: Arc<AtomicBool>,
    progress: Progress,
    notify: tauri::ipc::Channel<Progress>,
    last: Instant,
    visited: usize,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.connection
            .transfers
            .lock()
            .unwrap()
            .remove(&self.progress.task_id);
    }
}

impl Running {
    fn check(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Acquire) || self.connection.closed.load(Ordering::Acquire) {
            return Err("Transfer cancelled".into());
        }
        Ok(())
    }
    fn tick(&mut self, bytes: u64, force: bool) -> Result<(), String> {
        self.check()?;
        self.progress.bytes = self.progress.bytes.saturating_add(bytes);
        if force || self.last.elapsed() >= Duration::from_millis(100) {
            self.notify
                .send(self.progress.clone())
                .map_err(|_| "Transfer view closed".to_string())?;
            self.last = Instant::now();
        }
        Ok(())
    }
    async fn copy(
        &mut self,
        source: &mut (impl tokio::io::AsyncRead + Unpin),
        destination: &mut (impl tokio::io::AsyncWrite + Unpin),
    ) -> Result<(), String> {
        let mut buffer = vec![0; 128 * 1024];
        loop {
            self.check()?;
            let count = deadline(source.read(&mut buffer)).await?;
            if count == 0 {
                break;
            }
            deadline(destination.write_all(&buffer[..count])).await?;
            self.tick(count as u64, false)?;
        }
        deadline(destination.flush()).await?;
        self.check()
    }
}

#[tauri::command]
pub async fn ssh_transfer_cancel(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SshState>,
    id: u32,
    task_id: String,
) -> Result<(), String> {
    main_only(&window)?;
    let connection = state.connection(id)?;
    if let Some(cancel) = connection.transfers.lock().unwrap().get(&task_id) {
        cancel.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_transfer(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SshState>,
    id: u32,
    request: Transfer,
    on_progress: tauri::ipc::Channel<Progress>,
) -> Result<Progress, String> {
    main_only(&window)?;
    if request.task_id.is_empty()
        || request.task_id.len() > 100
        || request.names.is_empty()
        || request.names.len() > 1000
        || !matches!(request.direction.as_str(), "upload" | "download")
    {
        return Err("Invalid transfer request".into());
    }
    files::path(&request.remote_directory)?;
    for name in &request.names {
        files::name(name)?;
    }
    let local_directory = files::local_path(&request.local_directory)?;
    let connection = state.connection(id)?;
    let _slot = connection
        .transfer_slots
        .try_acquire()
        .map_err(|_| "A transfer is already running on this connection")?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut transfers = connection.transfers.lock().unwrap();
        if transfers.contains_key(&request.task_id) {
            return Err("Transfer is already running".into());
        }
        transfers.insert(request.task_id.clone(), cancel.clone());
    }
    let mut running = Running {
        connection: connection.clone(),
        cancel,
        progress: Progress {
            task_id: request.task_id.clone(),
            file: String::new(),
            bytes: 0,
            files: 0,
        },
        notify: on_progress,
        last: Instant::now(),
        visited: 0,
    };
    let local_check = local_directory.clone();
    crate::modules::fs::blocking(move || {
        if !files::ensure_plain_local(&local_check)?.is_dir() {
            return Err("Local destination is not a directory".into());
        }
        Ok(())
    })
    .await?;
    let sftp = connection.sftp().await?;
    let remote_directory = deadline(sftp.canonicalize(&request.remote_directory)).await?;
    let mut queue: Vec<(PathBuf, String, usize)> = request
        .names
        .iter()
        .rev()
        .map(|name| {
            (
                local_directory.join(name),
                files::remote_join(&remote_directory, name),
                0,
            )
        })
        .collect();
    while let Some((local, remote, depth)) = queue.pop() {
        running.check()?;
        running.visited += 1;
        if running.visited > 10_000 || depth > 32 {
            return Err("Transfer exceeds 10000 entries or 32 directory levels".into());
        }
        running.progress.file = remote.clone();
        running.tick(0, true)?;
        if request.direction == "upload" {
            let check = local.clone();
            let metadata =
                crate::modules::fs::blocking(move || files::ensure_plain_local(&check)).await?;
            if metadata.is_dir() {
                match deadline(sftp.symlink_metadata(&remote)).await {
                    Ok(metadata) if metadata.file_type().is_dir() => {}
                    Ok(_) => {
                        return Err(format!("Destination is not a regular directory: {remote}"))
                    }
                    Err(_) => {
                        deadline(sftp.create_dir(&remote)).await?;
                    }
                }
                let read = local.clone();
                let names = crate::modules::fs::blocking(move || {
                    let mut names = Vec::new();
                    for entry in std::fs::read_dir(read).map_err(|e| e.to_string())? {
                        if names.len() >= 10_000 {
                            return Err("Directory exceeds the transfer entry limit".into());
                        }
                        let name = entry
                            .map_err(|e| e.to_string())?
                            .file_name()
                            .into_string()
                            .map_err(|_| "File name is not UTF-8")?;
                        files::name(&name)?;
                        names.push(name);
                    }
                    Ok(names)
                })
                .await?;
                if queue.len() + names.len() + running.visited > 10_000 {
                    return Err("Transfer exceeds 10000 entries".into());
                }
                for name in names.into_iter().rev() {
                    queue.push((
                        local.join(&name),
                        files::remote_join(&remote, &name),
                        depth + 1,
                    ));
                }
            } else {
                if deadline(sftp.try_exists(&remote)).await? && !request.overwrite {
                    return Err(format!(
                        "Destination exists: {remote}. Enable overwrite to replace it."
                    ));
                }
                if let Ok(metadata) = deadline(sftp.symlink_metadata(&remote)).await {
                    if !metadata.file_type().is_file() {
                        return Err("Cannot overwrite a directory or symbolic link".into());
                    }
                }
                let mut random = [0u8; 8];
                getrandom::fill(&mut random).map_err(|e| e.to_string())?;
                let temporary = format!("{remote}.awei-{}.part", u64::from_le_bytes(random));
                let mut output = deadline(sftp.open_with_flags(
                    &temporary,
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                ))
                .await?;
                let result = async {
                    let mut input = tokio::fs::File::open(&local)
                        .await
                        .map_err(|e| e.to_string())?;
                    running.copy(&mut input, &mut output).await?;
                    deadline(output.shutdown()).await?;
                    running.check()?;
                    commit_upload(sftp, &temporary, &remote, request.overwrite).await
                }
                .await;
                if let Err(error) = result {
                    let _ = deadline(output.shutdown()).await;
                    drop(output);
                    if let Err(cleanup) = deadline(sftp.remove_file(&temporary)).await {
                        if deadline(sftp.try_exists(&temporary)).await.unwrap_or(true) {
                            return Err(format!("{error}; cannot confirm cleanup of temporary file {temporary}: {cleanup}"));
                        }
                    }
                    return Err(error);
                }
                running.progress.files += 1;
            }
        } else {
            let metadata = deadline(sftp.symlink_metadata(&remote)).await?;
            if metadata.file_type().is_dir() {
                let target = local.clone();
                crate::modules::fs::blocking(move || {
                    if target.exists() {
                        if !files::ensure_plain_local(&target)?.is_dir() {
                            return Err("Destination is not a regular directory".into());
                        }
                        Ok(())
                    } else {
                        std::fs::create_dir(&target).map_err(|e| e.to_string())
                    }
                })
                .await?;
                let listing = files::remote_list(&connection, &remote).await?;
                if queue.len() + listing.entries.len() + running.visited > 10_000 {
                    return Err("Transfer exceeds 10000 entries".into());
                }
                for entry in listing.entries.into_iter().rev() {
                    files::name(&entry.name)?;
                    queue.push((
                        local.join(&entry.name),
                        files::remote_join(&remote, &entry.name),
                        depth + 1,
                    ));
                }
            } else if metadata.file_type().is_file() {
                let target = local.clone();
                let overwrite = request.overwrite;
                let temporary = crate::modules::fs::blocking(move || {
                    if target.exists() {
                        if !files::ensure_plain_local(&target)?.is_file() {
                            return Err("Cannot overwrite a directory or link".into());
                        }
                        if !overwrite {
                            return Err("Destination exists; enable overwrite to replace it".into());
                        }
                    }
                    tempfile::NamedTempFile::new_in(target.parent().ok_or("Invalid destination")?)
                        .map_err(|e| e.to_string())
                })
                .await?;
                let (temporary, file) = crate::modules::fs::blocking(move || {
                    let file = temporary.reopen().map_err(|e| e.to_string())?;
                    Ok((temporary, file))
                })
                .await?;
                let mut output = tokio::fs::File::from_std(file);
                let mut input = deadline(sftp.open(&remote)).await?;
                running.copy(&mut input, &mut output).await?;
                deadline(input.shutdown()).await?;
                deadline(output.sync_all()).await?;
                drop(output);
                running.check()?;
                crate::modules::fs::blocking(move || {
                    if overwrite {
                        temporary.persist(local).map_err(|e| e.to_string())?;
                    } else {
                        temporary
                            .persist_noclobber(local)
                            .map_err(|e| e.to_string())?;
                    }
                    Ok(())
                })
                .await?;
                running.progress.files += 1;
            } else {
                return Err(format!(
                    "Symbolic links and special files are not transferred: {remote}"
                ));
            }
        }
        running.tick(0, true)?;
    }
    Ok(running.progress.clone())
}

async fn commit_upload(
    sftp: &russh_sftp::client::SftpSession,
    temporary: &str,
    target: &str,
    overwrite: bool,
) -> Result<(), String> {
    if !deadline(sftp.try_exists(target)).await? {
        return deadline(sftp.rename(temporary, target)).await;
    }
    if !overwrite {
        return Err(format!("Destination exists: {target}"));
    }
    if !deadline(sftp.symlink_metadata(target))
        .await?
        .file_type()
        .is_file()
    {
        return Err("Cannot overwrite a directory or link".into());
    }
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let backup = format!("{target}.awei-{}.backup", u64::from_le_bytes(random));
    deadline(sftp.rename(target, &backup)).await?;
    if let Err(error) = deadline(sftp.rename(temporary, target)).await {
        if deadline(sftp.rename(&backup, target)).await.is_err() {
            return Err(format!(
                "Replacement failed; original file retained at {backup}: {error}"
            ));
        }
        return Err(error);
    }
    deadline(sftp.remove_file(&backup))
        .await
        .map_err(|error| format!("File replaced; cannot remove old backup {backup}: {error}"))
}
