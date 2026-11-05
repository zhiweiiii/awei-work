mod credentials;
pub mod entries;
pub mod files;
pub mod transfer;

use russh::{
    client,
    keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    ChannelMsg, ChannelWriteHalf,
};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{
    ipc::{Channel, Response},
    Manager,
};
use tokio::sync::{Mutex as AsyncMutex, OnceCell, Semaphore};

pub struct SshState {
    sessions: Mutex<HashMap<u32, Arc<Connection>>>,
    next: AtomicU32,
    connecting: Semaphore,
    host_writes: AsyncMutex<()>,
}

impl Default for SshState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next: AtomicU32::new(1),
            connecting: Semaphore::new(4),
            host_writes: AsyncMutex::new(()),
        }
    }
}

pub(super) struct Connection {
    handle: AsyncMutex<client::Handle<Verifier>>,
    terminal: AsyncMutex<Option<ChannelWriteHalf<client::Msg>>>,
    terminal_opened: AtomicBool,
    closed: AtomicBool,
    sftp: OnceCell<SftpSession>,
    directories: OnceCell<russh_sftp::client::RawSftpSession>,
    directory_slots: Semaphore,
    transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    transfer_slots: Semaphore,
}

pub(super) fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("SSH is available only in the main window".into());
    }
    Ok(())
}

impl SshState {
    fn take_all(&self) -> Vec<Arc<Connection>> {
        self.sessions
            .lock()
            .unwrap()
            .drain()
            .map(|(_, connection)| connection)
            .collect()
    }
    pub(super) fn connection(&self, id: u32) -> Result<Arc<Connection>, String> {
        let connection = self
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or("SSH connection is closed")?;
        if connection.closed.load(Ordering::Acquire) {
            return Err("SSH connection is closed".into());
        }
        Ok(connection)
    }
}

impl Connection {
    pub(super) async fn directories(&self) -> Result<&russh_sftp::client::RawSftpSession, String> {
        self.directories
            .get_or_try_init(|| async {
                let channel = deadline(self.handle.lock().await.channel_open_session()).await?;
                deadline(channel.request_subsystem(true, "sftp")).await?;
                let raw = russh_sftp::client::RawSftpSession::new(channel.into_stream());
                raw.set_timeout(30);
                deadline(raw.init()).await?;
                Ok(raw)
            })
            .await
    }
    pub(super) async fn sftp(&self) -> Result<&SftpSession, String> {
        self.sftp
            .get_or_try_init(|| async {
                let channel = deadline(self.handle.lock().await.channel_open_session()).await?;
                deadline(channel.request_subsystem(true, "sftp")).await?;
                let sftp = deadline(SftpSession::new(channel.into_stream())).await?;
                sftp.set_timeout(30);
                Ok(sftp)
            })
            .await
    }
    pub(super) async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        for cancel in self.transfers.lock().unwrap().values() {
            cancel.store(true, Ordering::Release);
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            self.handle
                .lock()
                .await
                .disconnect(russh::Disconnect::ByApplication, "Closed by user", "")
                .await
        })
        .await;
    }
}

pub(super) async fn deadline<T, E: std::fmt::Display>(
    future: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, String> {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .map_err(|_| "SSH request timed out".to_string())?
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Login {
    host: String,
    port: u16,
    username: String,
    auth: String,
    key_path: Option<String>,
    secret: Option<String>,
    accepted_fingerprint: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKey {
    fingerprint: String,
    previous: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Connected {
    HostKey { key: HostKey },
    Connected { id: u32 },
}

struct Verifier {
    known: Option<String>,
    accepted: Option<String>,
    challenge: Arc<Mutex<Option<HostKey>>>,
}

impl client::Handler for Verifier {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => {
                key.fingerprint(HashAlg::Sha256).to_string()
            }
            PublicKeyOrCertificate::Certificate(_) => return Ok(false),
        };
        if self.accepted.as_ref() == Some(&fingerprint)
            || (self.accepted.is_none() && self.known.as_ref() == Some(&fingerprint))
        {
            return Ok(true);
        }
        *self.challenge.lock().unwrap() = Some(HostKey {
            fingerprint,
            previous: self.known.clone(),
        });
        Ok(false)
    }
}

fn host_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("ssh-known-hosts.json"))
        .map_err(|e| e.to_string())
}

fn read_hosts(path: &std::path::Path) -> Result<HashMap<String, String>, String> {
    use std::io::Read;
    let bytes = std::fs::File::open(path).and_then(|file| {
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
        Ok(bytes)
    });
    match bytes {
        Ok(bytes) if bytes.len() <= 1024 * 1024 => serde_json::from_slice(&bytes)
            .map_err(|_| "Saved SSH host keys are invalid; original file retained".into()),
        Ok(_) => Err("SSH host key file is too large".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn ssh_connect(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    login: Login,
) -> Result<Connected, String> {
    main_only(&window)?;
    let _permit = state
        .connecting
        .try_acquire()
        .map_err(|_| "Too many SSH connections are being opened")?;
    if state.sessions.lock().unwrap().len() >= 12 {
        return Err("Close an SSH connection before opening another (maximum 12)".into());
    }
    let host = login.host.trim().to_lowercase();
    if host.is_empty()
        || host.len() > 253
        || host
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '/' | '\\' | '@'))
        || login.port == 0
        || login.username.is_empty()
        || login.username.len() > 256
        || login.username.chars().any(char::is_control)
        || !matches!(login.auth.as_str(), "password" | "key")
        || login.secret.as_ref().is_some_and(|s| s.len() > 8192)
    {
        return Err("Invalid SSH connection settings".into());
    }
    let endpoint = format!("[{host}]:{}", login.port);
    let path = host_file(&app)?;
    let read_path = path.clone();
    let hosts = crate::modules::fs::blocking(move || read_hosts(&read_path)).await?;
    let challenge = Arc::new(Mutex::new(None));
    let handler = Verifier {
        known: hosts.get(&endpoint).cloned(),
        accepted: login.accepted_fingerprint.clone(),
        challenge: challenge.clone(),
    };
    let config = client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    };
    let connected = deadline(client::connect(
        Arc::new(config),
        (host.as_str(), login.port),
        handler,
    ))
    .await;
    let mut handle = match connected {
        Ok(handle) => handle,
        Err(error) => {
            if let Some(key) = challenge.lock().unwrap().take() {
                return Ok(Connected::HostKey { key });
            }
            return Err(error);
        }
    };
    let auth = if login.auth == "key" {
        let key_path = login
            .key_path
            .filter(|s| !s.is_empty())
            .ok_or("Choose a private key file")?;
        let secret = login.secret;
        let key = crate::modules::fs::blocking(move || {
            let path = files::local_path(&key_path)?;
            let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            if !metadata.is_file() || metadata.len() > 1024 * 1024 {
                return Err("Invalid private key file".into());
            }
            russh::keys::load_secret_key(path, secret.as_deref().filter(|s| !s.is_empty()))
                .map_err(|_| "Cannot read private key; check its format and passphrase".into())
        })
        .await?;
        // RustCrypto RSA private-key operations still have an unresolved timing advisory.
        if matches!(key.algorithm(), russh::keys::Algorithm::Rsa { .. }) {
            return Err("RSA private-key login is not supported; use an Ed25519 or ECDSA key, or password login".into());
        }
        let hash = deadline(handle.best_supported_rsa_hash()).await?.flatten();
        deadline(handle.authenticate_publickey(
            login.username,
            PrivateKeyWithHashAlg::new(Arc::new(key), hash),
        ))
        .await?
    } else {
        deadline(handle.authenticate_password(login.username, login.secret.unwrap_or_default()))
            .await?
    };
    if !auth.success() {
        let _ = handle
            .disconnect(
                russh::Disconnect::ByApplication,
                "Authentication failed",
                "",
            )
            .await;
        return Err("SSH authentication failed; check username and password or key".into());
    }
    if let Some(fingerprint) = login.accepted_fingerprint {
        let _guard = state.host_writes.lock().await;
        crate::modules::fs::blocking(move || {
            let mut hosts = read_hosts(&path)?;
            hosts.insert(endpoint, fingerprint);
            let parent = path.parent().ok_or("Invalid SSH host key location")?;
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
            std::io::Write::write_all(
                &mut temp,
                &serde_json::to_vec(&hosts).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            temp.as_file().sync_all().map_err(|e| e.to_string())?;
            temp.persist(path).map_err(|e| e.to_string())?;
            Ok(())
        })
        .await?;
    }
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    let connection = Arc::new(Connection {
        handle: AsyncMutex::new(handle),
        terminal: AsyncMutex::new(None),
        terminal_opened: AtomicBool::new(false),
        closed: AtomicBool::new(false),
        sftp: OnceCell::new(),
        directories: OnceCell::new(),
        directory_slots: Semaphore::new(2),
        transfers: Mutex::new(HashMap::new()),
        transfer_slots: Semaphore::new(1),
    });
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.retain(|_, connection| !connection.closed.load(Ordering::Acquire));
        if sessions.len() >= 12 {
            return Err("Close an SSH connection before opening another (maximum 12)".into());
        }
        sessions.insert(id, connection);
    }
    Ok(Connected::Connected { id })
}

#[tauri::command]
pub async fn ssh_disconnect_all(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SshState>,
) -> Result<(), String> {
    main_only(&window)?;
    for connection in state.take_all() {
        connection.close().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SshState>,
    id: u32,
) -> Result<(), String> {
    main_only(&window)?;
    let connection = state.sessions.lock().unwrap().remove(&id);
    if let Some(connection) = connection {
        connection.close().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_terminal_open(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SshState>,
    id: u32,
    cols: u32,
    rows: u32,
    on_data: Channel<Response>,
    on_exit: Channel<String>,
) -> Result<(), String> {
    main_only(&window)?;
    grid(cols, rows)?;
    let connection = state.connection(id)?;
    if connection.terminal_opened.swap(true, Ordering::AcqRel) {
        return Err("SSH terminal is already open".into());
    }
    let opened = async {
        let channel = deadline(connection.handle.lock().await.channel_open_session()).await?;
        deadline(channel.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])).await?;
        deadline(channel.request_shell(true)).await?;
        Ok::<_, String>(channel)
    }
    .await;
    let channel = match opened {
        Ok(channel) => channel,
        Err(error) => {
            connection.terminal_opened.store(false, Ordering::Release);
            return Err(error);
        }
    };
    let (mut reader, writer) = channel.split();
    *connection.terminal.lock().await = Some(writer);
    tauri::async_runtime::spawn(async move {
        let mut reason = "SSH terminal closed".to_string();
        while let Some(message) = reader.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if on_data.send(Response::new(data.to_vec())).is_err() {
                        break;
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    reason = format!("SSH terminal exited ({exit_status})");
                }
                ChannelMsg::Failure => {
                    reason = "Server rejected the interactive terminal".into();
                    break;
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        connection.close().await;
        let _ = on_exit.send(reason);
    });
    Ok(())
}

fn grid(cols: u32, rows: u32) -> Result<(), String> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 || cols.saturating_mul(rows) > 200_000 {
        return Err("Invalid SSH terminal dimensions".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_terminal_write(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SshState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    main_only(&window)?;
    if data.len() > 1024 * 1024 {
        return Err("SSH input exceeds 1 MiB".into());
    }
    let connection = state.connection(id)?;
    let guard = connection.terminal.lock().await;
    let terminal = guard.as_ref().ok_or("SSH terminal is not open")?;
    deadline(terminal.data(data.as_bytes())).await
}

#[tauri::command]
pub async fn ssh_terminal_resize(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SshState>,
    id: u32,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    main_only(&window)?;
    grid(cols, rows)?;
    let connection = state.connection(id)?;
    let guard = connection.terminal.lock().await;
    if let Some(terminal) = guard.as_ref() {
        deadline(terminal.window_change(cols, rows, 0, 0)).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_credential_read(
    window: tauri::WebviewWindow,
    id: String,
) -> Result<Option<String>, String> {
    main_only(&window)?;
    crate::modules::fs::blocking(move || credentials::read(&id)).await
}

#[tauri::command]
pub async fn ssh_credential_save(
    window: tauri::WebviewWindow,
    id: String,
    secret: Option<String>,
) -> Result<(), String> {
    main_only(&window)?;
    crate::modules::fs::blocking(move || credentials::save(&id, secret)).await
}
