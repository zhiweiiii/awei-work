use super::{deadline, main_only, Connection, SshState};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub kind: &'static str,
    pub size: u64,
    pub modified: u64,
}

#[derive(Serialize)]
pub struct Listing {
    pub path: String,
    pub entries: Vec<Entry>,
}

pub(super) fn path(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 8192 || value.chars().any(char::is_control) {
        return Err("Invalid file path".into());
    }
    Ok(())
}

pub(super) fn name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.len() > 255
        || value.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        || value.ends_with(['.', ' '])
    {
        return Err("File name is not supported on Windows".into());
    }
    let stem = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return Err("Reserved Windows file name".into());
    }
    Ok(())
}

pub(super) fn remote_join(parent: &str, child: &str) -> String {
    format!("{}/{}", parent.trim_end_matches('/'), child)
}

pub(super) fn local_path(value: &str) -> Result<PathBuf, String> {
    path(value)?;
    let path = PathBuf::from(value);
    if !path.is_absolute()
        || value.starts_with(r"\\.\")
        || value.starts_with(r"\\?\")
        || value.get(2..).is_some_and(|s| s.contains(':'))
    {
        return Err("Use an absolute local file path".into());
    }
    Ok(path)
}

pub(super) fn local_list(directory: Option<String>) -> Result<Listing, String> {
    let directory = match directory {
        Some(value) if !value.is_empty() => local_path(&value)?,
        _ => dirs::home_dir().ok_or("Home directory unavailable")?,
    };
    let directory = std::fs::canonicalize(directory).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
        if entries.len() >= 10_000 {
            return Err("Directory exceeds 10000 entries; open a subdirectory".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        entries.push(Entry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: if metadata.file_type().is_symlink() {
                "link"
            } else if metadata.file_type().is_dir() {
                "dir"
            } else {
                "file"
            },
            size: metadata.len(),
            modified: metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs()),
        });
    }
    sort(&mut entries);
    Ok(Listing {
        path: crate::modules::fs::to_canon(directory),
        entries,
    })
}

pub(super) async fn remote_list(
    connection: &Connection,
    directory: &str,
) -> Result<Listing, String> {
    path(directory)?;
    let sftp = connection.sftp().await?;
    let directory = deadline(sftp.canonicalize(directory)).await?;
    let _slot = connection
        .directory_slots
        .try_acquire()
        .map_err(|_| "Too many remote directory reads; retry shortly")?;
    let raw = connection.directories().await?;
    let handle = deadline(raw.opendir(&directory)).await?.handle;
    let read = async {
        let mut entries = Vec::new();
        loop {
            let packet = match raw.readdir(&handle).await {
                Ok(packet) => packet,
                Err(russh_sftp::client::error::Error::Status(status))
                    if status.status_code == russh_sftp::protocol::StatusCode::Eof =>
                {
                    break
                }
                Err(error) => return Err(error.to_string()),
            };
            if packet.files.is_empty() {
                return Err("Server returned an empty directory packet without EOF".into());
            }
            for entry in packet.files {
                if entries.len() >= 10_000 {
                    return Err("Directory exceeds 10000 entries; open a subdirectory".into());
                }
                let metadata = entry.attrs;
                let entry_name = entry.filename;
                if entry_name.len() > 4096 {
                    return Err("Remote file name exceeds its size limit".into());
                }
                if entry_name == "."
                    || entry_name == ".."
                    || entry_name.contains('/')
                    || entry_name.contains('\0')
                {
                    continue;
                }
                entries.push(Entry {
                    name: entry_name,
                    kind: if metadata.file_type().is_symlink() {
                        "link"
                    } else if metadata.file_type().is_dir() {
                        "dir"
                    } else if metadata.file_type().is_file() {
                        "file"
                    } else {
                        "special"
                    },
                    size: metadata.size.unwrap_or(0),
                    modified: u64::from(metadata.mtime.unwrap_or(0)),
                });
            }
        }
        sort(&mut entries);
        Ok::<_, String>(entries)
    };
    let entries = deadline(read).await;
    let closed = deadline(raw.close(handle)).await;
    let entries = entries?;
    closed?;
    Ok(Listing {
        path: directory,
        entries,
    })
}

fn sort(entries: &mut [Entry]) {
    entries.sort_by(|a, b| {
        (a.kind != "dir")
            .cmp(&(b.kind != "dir"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

#[tauri::command]
pub async fn ssh_list_dir(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SshState>,
    id: u32,
    side: String,
    directory: Option<String>,
) -> Result<Listing, String> {
    main_only(&window)?;
    let connection = state.connection(id)?;
    match side.as_str() {
        "local" => crate::modules::fs::blocking(move || local_list(directory)).await,
        "remote" => remote_list(&connection, directory.as_deref().unwrap_or(".")).await,
        _ => Err("Invalid file browser side".into()),
    }
}

#[tauri::command]
pub async fn ssh_mkdir(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SshState>,
    id: u32,
    side: String,
    directory: String,
    folder_name: String,
) -> Result<(), String> {
    main_only(&window)?;
    path(&directory)?;
    name(&folder_name)?;
    let connection = state.connection(id)?;
    match side.as_str() {
        "local" => {
            crate::modules::fs::blocking(move || {
                std::fs::create_dir(local_path(&directory)?.join(folder_name))
                    .map_err(|e| e.to_string())
            })
            .await
        }
        "remote" => {
            deadline(
                connection
                    .sftp()
                    .await?
                    .create_dir(remote_join(&directory, &folder_name)),
            )
            .await
        }
        _ => Err("Invalid file browser side".into()),
    }
}

pub(super) fn ensure_plain_local(path: &Path) -> Result<std::fs::Metadata, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.is_symlink() {
        return Err("Symbolic links and junctions are not transferred".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Symbolic links and junctions are not transferred".into());
        }
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("Only regular files and directories can be transferred".into());
    }
    Ok(metadata)
}
