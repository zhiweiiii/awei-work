//! Web terminal bridge: exposes the running PTY sessions over HTTP + WebSocket
//! on port 34269 (dev) / 34268 (release) so a phone / other machine can watch
//! or drive the command lines from a plain browser page.
//!
//!   GET /     → embedded mobile page (single-file HTML, served as-is)
//!   GET /ws   → WebSocket (ttyd-style binary protocol, extended with a
//!               session list / attach handshake for multi-terminal support)
//!
//! Wire protocol (client → server):
//!   First message (text): { "attach": <id> } or { "list": true }
//!   Later (binary, first byte is the command):
//!     '0' + bytes        → write input to the attached session
//!     '1' + JSON         → resize { "cols": N, "rows": N } (kept for
//!                          completeness; the current page never sends it —
//!                          the desktop owns the PTY size)
//!     JSON submit {id, text, leafId} receives a writeAck after flushing.
//!     '2' + bytes        → submit text followed by Enter; bracket Codex input
//!                          so its paste-burst detector cannot absorb Enter
//!   Later (text):        { "attach": <id> }        → switch session
//!                        { "scheduleAdd": { "command": …, "delaySeconds": N } }
//!                        { "scheduleCancel": <job id> }
//!
//! Wire protocol (server → client):
//!   binary '0' + bytes   → terminal output
//!   binary '1' + bytes   → window title (UTF-8)
//!   text  { "type": "sessions", "sessions": [ {id,cwd,title,active,live,space} ] }
//!   text  { "type": "attached", "id": N }
//!   text  { "type": "exit", "id": N, "code": C }
//!   text  { "type": "error", "message": "..." }
//!
//! The WebSocket implementation is minimal (RFC 6455) — handshake + framing
//! only — because the rest of the crate has no HTTP/WS framework and this is
//! the only WebSocket endpoint.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};

mod auth;

use crate::modules::pty;
use crate::modules::pty::{PtyState, Session, SizeOwner, WebMsg};
use crate::modules::schedule;
use crate::modules::transcript;
use tauri::{Emitter, Manager};

// Dev builds listen on 34269, packaged (release) builds on 34268 — so the two
// can run side by side without clashing, and the phone can pick the right one.
const PORT: u16 = if cfg!(debug_assertions) { 34269 } else { 34268 };
const BIND_ADDR: &str = "0.0.0.0";

// The mobile page is embedded at build time by scripts/build-web.mjs.
const INDEX_HTML: &str = include_str!("../../../web.html");

const WS_GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Set the web bridge password. Rotates the session token, so phones that were
/// already signed in have to sign in again.
#[tauri::command]
pub async fn web_set_password(password: String) -> Result<(), String> {
    crate::modules::fs::blocking(move || auth::set_password(&password)).await
}

/// Whether a credential has been configured.
#[tauri::command]
pub fn web_has_custom_password() -> bool {
    auth::has_custom_password()
}

static SHUTDOWN: AtomicBool = AtomicBool::new(false);

/// True while the accept loop is actually listening (set after a successful
/// bind, cleared when the loop exits / stop() runs). Drives the desktop's
/// "remote service" indicator.
static RUNNING: AtomicBool = AtomicBool::new(false);

/// Live WebSocket connections; /ws is rejected once MAX_CONNECTIONS is hit so
/// a runaway client can't pile up unbounded threads.
static CONNECTIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
const MAX_CONNECTIONS: usize = 8;
static HTTP_CONNECTIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
const MAX_HTTP_CONNECTIONS: usize = 16;

struct HttpConnectionGuard;
impl Drop for HttpConnectionGuard {
    fn drop(&mut self) {
        HTTP_CONNECTIONS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Failed login attempts since boot (rate limit: >=5 consecutive fails = 5s
/// delay before the next attempt is even evaluated).
static FAILED_LOGINS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
/// Timestamp (Instant millis) of the last failed login, for the lockout.
static LAST_FAIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Start the web terminal server on 0.0.0.0:34269 (dev) / 34268 (release).
/// Returns an error only if the port cannot be bound; the accept loop runs on
/// its own thread.
pub fn start(app: tauri::AppHandle) -> Result<(), String> {
    SHUTDOWN.store(false, Ordering::Release);
    RUNNING.store(false, Ordering::Release);
    let listener = TcpListener::bind((BIND_ADDR, PORT))
        .map_err(|e| format!("web terminal: failed to bind {BIND_ADDR}:{PORT}: {e}"))?;
    log::info!("web terminal server listening on http://{BIND_ADDR}:{PORT}");
    RUNNING.store(true, Ordering::Release);
    thread::Builder::new()
        .name("terax-web-accept".into())
        .spawn(move || {
            for stream in listener.incoming() {
                if SHUTDOWN.load(Ordering::Acquire) {
                    break;
                }
                match stream {
                    Ok(stream) => {
                        if HTTP_CONNECTIONS.fetch_add(1, Ordering::AcqRel) >= MAX_HTTP_CONNECTIONS {
                            HTTP_CONNECTIONS.fetch_sub(1, Ordering::AcqRel);
                            continue;
                        }
                        let guard = HttpConnectionGuard;
                        let app = app.clone();
                        let _ = stream.set_nodelay(true);
                        thread::Builder::new()
                            .name("terax-web-conn".into())
                            .spawn(move || {
                                let _guard = guard;
                                handle_connection(app, stream);
                            })
                            .ok();
                    }
                    Err(e) => {
                        log::warn!("web terminal: accept error: {e}");
                    }
                }
            }
        })
        .expect("spawn web accept thread");
    Ok(())
}

pub fn stop() {
    SHUTDOWN.store(true, Ordering::Release);
    RUNNING.store(false, Ordering::Release);
}

/// Snapshot of the web terminal server for the desktop status bar.
#[derive(serde::Serialize)]
pub struct WebStatus {
    /// Whether the accept loop is listening (bound + not stopped).
    running: bool,
    port: u16,
    /// Live WebSocket viewer connections right now.
    connections: usize,
    /// Consecutive failed logins since boot (drives the 5s lockout).
    failed_logins: usize,
}

/// Tauri command: report the remote service's connection count and whether it
/// is up. Polled by the desktop status bar indicator.
#[tauri::command]
pub fn web_status() -> WebStatus {
    WebStatus {
        running: RUNNING.load(Ordering::Acquire),
        port: PORT,
        connections: CONNECTIONS.load(Ordering::Acquire),
        failed_logins: FAILED_LOGINS.load(Ordering::Acquire),
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Minimal WebSocket (RFC 6455)
// ──────────────────────────────────────────────────────────────────────────

// ── Desktop snapshot ─────────────────────────────────────────────────────
//
// What a phone sees when it attaches is the desktop terminal's own buffer,
// fetched from the window on demand. Nothing on this side stores session
// output: a second copy inevitably drifts from what the desktop shows (it
// outlives a `clear`, and it is bounded in bytes where the terminal is bounded
// in lines), and the phone then opened on a history the desktop did not have.

/// How long an attach waits for the window to hand its buffer over. The
/// webview answers in a few milliseconds; waiting longer would only hold the
/// attach open while an unresponsive window never replies.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_millis(1500);

fn checked_grid(cols: u64, rows: u64) -> Option<(u16, u16)> {
    let cols = u16::try_from(cols).ok()?;
    let rows = u16::try_from(rows).ok()?;
    pty::valid_grid(cols, rows).then_some((cols, rows))
}

static NEXT_SNAPSHOT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static SNAPSHOT_WAITERS: OnceLock<Mutex<HashMap<u64, SyncSender<String>>>> = OnceLock::new();

fn snapshot_waiters() -> &'static Mutex<HashMap<u64, SyncSender<String>>> {
    SNAPSHOT_WAITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ask the desktop what this command line currently shows. None when the
/// window does not answer in time, or has nothing for that leaf - the phone
/// then simply follows the live stream from here on.
fn request_snapshot(app: &tauri::AppHandle, leaf_id: u32) -> Option<String> {
    let id = NEXT_SNAPSHOT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    snapshot_waiters().lock().unwrap().insert(id, tx);
    let asked = app
        .emit(
            "terax:web-snapshot",
            json!({ "leafId": leaf_id, "requestId": id }),
        )
        .is_ok();
    let reply = if asked {
        rx.recv_timeout(SNAPSHOT_TIMEOUT).ok()
    } else {
        None
    };
    snapshot_waiters().lock().unwrap().remove(&id);
    if reply.is_none() && asked {
        log::warn!("web: no snapshot from desktop for leaf={leaf_id}");
    }
    reply.filter(|s| !s.is_empty())
}

/// The window's answer to `terax:web-snapshot`.
#[tauri::command]
pub fn web_snapshot_reply(request_id: u64, data: String) {
    let waiter = snapshot_waiters().lock().unwrap().remove(&request_id);
    if let Some(tx) = waiter {
        let _ = tx.try_send(if data.len() <= 8 * 1024 * 1024 {
            data
        } else {
            String::new()
        });
    }
}

const OP_CONT: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BIN: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

struct WsConn {
    stream: TcpStream,
    /// All bytes read but not yet consumed by the message parser. Includes
    /// anything past the HTTP head terminator (early WS frames) and every
    /// partial frame: parsing consumes only *complete* messages, so a
    /// fragmented frame is never lost and never misparsed.
    buffer: Vec<u8>,
    /// Consume cursor into `buffer`.
    consume: usize,
    fragment_opcode: Option<u8>,
    fragment_payload: Vec<u8>,
    /// Last time any byte was read (drives the dead-peer timeout).
    last_read_at: std::time::Instant,
}

impl WsConn {
    /// `head` is the full request head (up to and including \r\n\r\n); any
    /// bytes past the terminator were already in the receive buffer and
    /// belong to the WebSocket stream.
    fn from_handshake(mut stream: TcpStream, head: Vec<u8>) -> Result<Self, String> {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        let head_text = String::from_utf8_lossy(&head);
        let mut lines = head_text.lines();
        let request_line = lines.next().unwrap_or("");
        if !request_line.starts_with("GET ") {
            return Err("not a GET request".into());
        }
        let mut key = None;
        const KEY_PREFIX: &str = "sec-websocket-key:";
        for line in lines {
            let lower = line.to_ascii_lowercase();
            if lower.strip_prefix(KEY_PREFIX).is_some() {
                // Index the original line by the prefix length (case folding
                // does not change byte length) to grab the key value.
                key = Some(line[KEY_PREFIX.len()..].trim().to_string());
            }
        }
        let key = key.ok_or_else(|| "missing Sec-WebSocket-Key".to_string())?;

        let accept = {
            let mut hasher = Sha1::new();
            hasher.update(key.as_bytes());
            hasher.update(WS_GUID);
            base64::engine::general_purpose::STANDARD.encode(hasher.finalize())
        };
        let response = format!(
            "HTTP/1.1 101 Switching Protocols\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        stream
            .write_all(response.as_bytes())
            .map_err(|e| e.to_string())?;
        stream.flush().map_err(|e| e.to_string())?;
        // Non-blocking reads: handle_ws polls for complete messages while
        // draining session output between polls. Partial frames stay in
        // `buffer` until they are complete — a fragmented frame is never
        // lost, so quiet phones no longer get disconnected (issue #41).
        stream.set_nonblocking(true).map_err(|e| e.to_string())?;

        let terminator = head
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|p| p + 4)
            .unwrap_or(head.len());
        let buffer = head[terminator..].to_vec();
        Ok(Self {
            stream,
            buffer,
            consume: 0,
            fragment_opcode: None,
            fragment_payload: Vec::new(),
            last_read_at: std::time::Instant::now(),
        })
    }

    /// Try to parse one complete message out of the buffer. Returns
    /// `Ok(Some(...))` on a full message (consuming its bytes), `Ok(None)`
    /// when more bytes are needed (nothing is consumed), `Err` on protocol
    /// violations. Partial frames are never discarded.
    fn try_parse_message(&mut self) -> Result<Option<(u8, Vec<u8>)>, String> {
        let buf = self.buffer.as_slice();
        loop {
            let mut pos = self.consume;
            if buf.len() - pos < 2 {
                return Ok(None);
            }
            let fin = buf[pos] & 0x80 != 0;
            if buf[pos] & 0x70 != 0 {
                return Err("ws reserved bits set".into());
            }
            let opcode = buf[pos] & 0x0F;
            let masked = buf[pos + 1] & 0x80 != 0;
            let mut len = (buf[pos + 1] & 0x7F) as usize;
            pos += 2;
            if len == 126 {
                if buf.len() - pos < 2 {
                    return Ok(None);
                }
                len = u16::from_be_bytes([buf[pos], buf[pos + 1]]) as usize;
                pos += 2;
            } else if len == 127 {
                if buf.len() - pos < 8 {
                    return Ok(None);
                }
                let mut ext = [0u8; 8];
                ext.copy_from_slice(&buf[pos..pos + 8]);
                len = usize::try_from(u64::from_be_bytes(ext)).map_err(|_| "ws length overflow")?;
                pos += 8;
            }
            // Control frames must be small per RFC 6455; data frames capped
            // per-frame, and the reassembled message capped as a whole so
            // unlimited continuation frames cannot grow memory without bound.
            if opcode >= OP_CLOSE && (len > 125 || !fin) {
                return Err("ws control frame too large".into());
            }
            if len > 1024 * 1024 {
                return Err("ws frame too large".into());
            }
            if opcode < OP_CLOSE && self.fragment_payload.len() + len > 1024 * 1024 {
                return Err("ws message too large".into());
            }
            let mut mask = [0u8; 4];
            if masked {
                if buf.len() - pos < 4 {
                    return Ok(None);
                }
                mask.copy_from_slice(&buf[pos..pos + 4]);
                pos += 4;
            } else {
                // RFC 6455: client frames MUST be masked. A browser always
                // masks; an unmasked data frame means a hand-rolled client.
                // Strict per spec, so malformed peers fail fast instead of
                // being interpreted leniently (issue #16).
                return Err("ws client frame not masked".into());
            }
            if buf.len() - pos < len {
                return Ok(None);
            }
            let mut payload = buf[pos..pos + len].to_vec();
            pos += len;
            if masked {
                for (i, b) in payload.iter_mut().enumerate() {
                    *b ^= mask[i % 4];
                }
            }
            self.consume = pos;
            match opcode {
                OP_CONT => {
                    if self.fragment_opcode.is_none() {
                        return Err("continuation without initial frame".into());
                    }
                    self.fragment_payload.extend_from_slice(&payload);
                }
                OP_TEXT | OP_BIN => {
                    if self.fragment_opcode.is_some() {
                        return Err("new message before continuation finished".into());
                    }
                    self.fragment_opcode = Some(opcode);
                    self.fragment_payload = payload;
                }
                OP_CLOSE | OP_PING | OP_PONG => {
                    return Ok(Some((opcode, payload)));
                }
                _ => return Err("unknown ws opcode".into()),
            }
            if fin {
                let op = self
                    .fragment_opcode
                    .take()
                    .ok_or("missing ws message opcode")?;
                let message = std::mem::take(&mut self.fragment_payload);
                if op == OP_TEXT && std::str::from_utf8(&message).is_err() {
                    return Err("invalid ws text encoding".into());
                }
                return Ok(Some((op, message)));
            }
        }
    }

    /// Read one message, blocking up to the read loop's poll cadence.
    /// Returns `Ok(Some(msg))`, or `Ok(None)` when no complete message is
    /// available yet (the caller drains output and polls again). Protocol
    /// and I/O failures surface as `Err`.
    fn read_message(&mut self) -> Result<Option<(u8, Vec<u8>)>, String> {
        loop {
            if let Some(msg) = self.try_parse_message()? {
                return Ok(Some(msg));
            }
            // Compact consumed bytes so the buffer can't grow without bound.
            if self.consume > 0 {
                self.buffer.drain(..self.consume);
                self.consume = 0;
            }
            if self.buffer.len() > 4 * 1024 * 1024 {
                // Only reachable with many interleaved partial frames; cap it
                // so a misbehaving client cannot balloon memory.
                return Err("ws buffer overflow".into());
            }
            let mut chunk = [0u8; 8192];
            match self.stream.read(&mut chunk) {
                Ok(0) => return Err("read ws bytes: eof".into()),
                Ok(n) => {
                    self.buffer.extend_from_slice(&chunk[..n]);
                    self.last_read_at = std::time::Instant::now();
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    return Ok(None);
                }
                Err(e) => return Err(format!("read ws bytes: {e}")),
            }
        }
    }

    /// Send a single-frame message. Server frames are never masked.
    fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<(), String> {
        let mut head = Vec::with_capacity(10);
        head.push(0x80 | opcode);
        let len = payload.len();
        if len < 126 {
            head.push(len as u8);
        } else if len <= 0xFFFF {
            head.push(126);
            head.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            head.push(127);
            head.extend_from_slice(&(len as u64).to_be_bytes());
        }
        self.write_all_blocking(&head)?;
        if !payload.is_empty() {
            self.write_all_blocking(payload)?;
        }
        self.stream.flush().map_err(|e| e.to_string())
    }

    /// `write_all` on a non-blocking socket returns WouldBlock mid-write and
    /// loses the partial write; poll instead so big frames (the attach seed)
    /// still go out. A peer that never reads eventually errors out.
    fn write_all_blocking(&mut self, mut data: &[u8]) -> Result<(), String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !data.is_empty() {
            if std::time::Instant::now() > deadline {
                return Err("write ws bytes: timeout".into());
            }
            match self.stream.write(data) {
                Ok(0) => return Err("write ws bytes: eof".into()),
                Ok(n) => data = &data[n..],
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(e) => return Err(format!("write ws bytes: {e}")),
            }
        }
        Ok(())
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Connection handling
// ──────────────────────────────────────────────────────────────────────────

fn handle_connection(app: tauri::AppHandle, mut stream: TcpStream) {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    let header_deadline = std::time::Instant::now() + Duration::from_secs(5);
    // Read the complete request head (up to \r\n\r\n). Any bytes past the
    // terminator belong to the WebSocket stream and are kept in `head`.
    let mut head = Vec::with_capacity(2048);
    let mut buf = [0u8; 2048];
    let mut header_end = None;
    loop {
        if std::time::Instant::now() >= header_deadline {
            return;
        }
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                head.extend_from_slice(&buf[..n]);
                if let Some(pos) = head.windows(4).position(|w| w == b"\r\n\r\n") {
                    header_end = Some(pos + 4);
                    break;
                }
                if head.len() > 16 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let Some(header_end) = header_end else {
        return;
    };
    let head_text = String::from_utf8_lossy(&head[..header_end]);
    let mut lines = head_text.lines();
    let request_line = lines.next().unwrap_or("");
    let mut is_upgrade = false;
    let mut cookie: Option<String> = None;
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("upgrade: websocket") {
            is_upgrade = true;
        } else if lower.starts_with("cookie:") {
            cookie = Some(line[line.find(':').unwrap_or(6) + 1..].trim().to_string());
        }
    }
    let token = auth::session_token();
    let authenticated = cookie
        .as_deref()
        .zip(token.as_deref())
        .map(|(c, token)| {
            let want = format!("terax_web={token}");
            c.split(';').any(|part| part.trim() == want)
        })
        .unwrap_or(false);
    let path = request_line.split_whitespace().nth(1).unwrap_or("/");

    // Login endpoint: verify the password, then set the auth cookie.
    if path == "/auth" {
        // POST only — GET would put the password in URLs and access logs.
        let mut is_post = false;
        let mut content_length = 0usize;
        for line in head_text.lines() {
            let upper = line.to_ascii_uppercase();
            if upper.starts_with("POST ") {
                is_post = true;
            } else if upper.starts_with("CONTENT-LENGTH:") {
                content_length = line
                    .split_once(':')
                    .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
            }
        }
        let pwd: String = if is_post && (1..=256).contains(&content_length) {
            // The body may not have arrived in the same read as the head
            // (TCP fragmentation): read the remaining Content-Length bytes.
            let have = head.len().saturating_sub(header_end);
            let prefix = have.min(content_length);
            let mut body = vec![0u8; content_length];
            body[..prefix].copy_from_slice(&head[header_end..header_end + prefix]);
            if stream.read_exact(&mut body[prefix..]).is_ok() {
                String::from_utf8(body).unwrap_or_default()
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        // Brute-force lockout: 5+ consecutive failures impose a 5s delay.
        if FAILED_LOGINS.load(Ordering::Acquire) >= 5 {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let last = LAST_FAIL.load(Ordering::Acquire);
            if now.saturating_sub(last) < 5000 {
                let body = "<html><body><p>too many attempts, try again later</p></body></html>";
                let response = format!(
                    "HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/html; charset=utf-8\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(body.as_bytes());
                let _ = stream.flush();
                return;
            }
            FAILED_LOGINS.store(0, Ordering::Release);
        }

        if let Some(token) = auth::verify(&pwd) {
            FAILED_LOGINS.store(0, Ordering::Release);
            let body = "<html><body><p>OK</p><script>location.href='/'</script></body></html>";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
                 Set-Cookie: terax_web={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n",
                token,
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(body.as_bytes());
            let _ = stream.flush();
        } else {
            FAILED_LOGINS.fetch_add(1, Ordering::AcqRel);
            LAST_FAIL.store(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                Ordering::Release,
            );
            let body =
                "<html><body><p>wrong password</p><script>history.back()</script></body></html>";
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/html; charset=utf-8\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(body.as_bytes());
            let _ = stream.flush();
        }
        return;
    }

    // WebSocket upgrade requires a valid auth cookie.
    if path.starts_with("/ws") && is_upgrade {
        if !authenticated {
            let body = "unauthorized";
            let response = format!(
                "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(body.as_bytes());
            let _ = stream.flush();
            return;
        }
        // Cap concurrent connections so a runaway client cannot pile up
        // threads. A rejected client simply sees a failed upgrade.
        let prev = CONNECTIONS.fetch_add(1, Ordering::AcqRel);
        if prev >= MAX_CONNECTIONS {
            CONNECTIONS.fetch_sub(1, Ordering::AcqRel);
            let body = "busy: too many connections";
            let response = format!(
                "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(body.as_bytes());
            let _ = stream.flush();
            return;
        }
        struct ConnGuard;
        impl Drop for ConnGuard {
            fn drop(&mut self) {
                CONNECTIONS.fetch_sub(1, Ordering::AcqRel);
            }
        }
        let _guard = ConnGuard;
        match WsConn::from_handshake(stream, head) {
            Ok(conn) => handle_ws(app, conn, token.unwrap_or_default()),
            Err(e) => log::debug!("web terminal: ws handshake failed: {e}"),
        }
        return;
    }

    // Everything else (including /): serve the terminal page when
    // authenticated, otherwise the login page.
    if authenticated {
        serve_page(stream);
    } else {
        serve_login(stream);
    }
}

fn serve_login(mut stream: TcpStream) {
    let body = r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>awei-work Terminal</title>
<style>
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0d1117; color:#e6edf3; font-family:system-ui,sans-serif; }
  .card { width:min(320px,88vw); background:#161b22; border:1px solid #21262d;
          border-radius:14px; padding:28px 24px; text-align:center; }
  h1 { font-size:17px; margin:0 0 20px; }
  input { width:100%; box-sizing:border-box; padding:12px; font-size:16px;
          border:1px solid #21262d; border-radius:10px; background:#0d1117; color:#e6edf3;
          outline:none; }
  input:focus { border-color:#58a6ff; }
  button { width:100%; margin-top:14px; padding:12px; font-size:16px; border:none;
           border-radius:10px; background:#1f6feb; color:#fff; cursor:pointer; }
  .err { color:#f85149; font-size:13px; margin-top:10px; min-height:18px; }
</style>
</head>
<body>
  <div class="card">
    <h1>请输入密码</h1>
    <p>首次使用请先在桌面设置中配置手机访问密码。</p>
    <input id="pwd" type="password" placeholder="访问密码" autofocus />
    <button onclick="login()">进入</button>
    <div class="err" id="err"></div>
  </div>
  <script>
    async function login() {
      const v = document.getElementById('pwd').value;
      if (!v) return;
      const res = await fetch('/auth', { method: 'POST', body: v, credentials: 'same-origin' });
      if (res.ok) { location.href = '/'; }
      else if (res.status === 429) { document.getElementById('err').textContent = '尝试过多，请稍后再试'; }
      else { document.getElementById('err').textContent = '密码错误'; }
    }
    document.getElementById('pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  </script>
</body>
</html>"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Cache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn serve_page(mut stream: TcpStream) {
    let body = INDEX_HTML;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Cache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

/// Per-connection WS loop: one client watches one session at a time.
fn handle_ws(app: tauri::AppHandle, mut conn: WsConn, token: String) {
    let state = app.state::<PtyState>();
    // Grid this phone would render at, learned from its attach / resize frames.
    // Kept per connection so a keystroke can claim the session without the
    // phone having to restate its dimensions.
    let mut web_grid: Option<(u16, u16)> = None;
    // The leaf id this connection is attached to (for exit notices), plus the
    // (session, subscription ID, live receiver) triple.
    let mut attached_id: Option<u32> = None;
    let mut attached: Option<(Arc<Session>, u64, std::sync::mpsc::Receiver<WebMsg>)> = None;
    let mut last_ping = std::time::Instant::now();
    // What the attached leaf's agent has actually said, read from the agent's
    // own transcript rather than parsed off its screen. The cheap change
    // signal and the revision last sent are tracked per connection, so an idle
    // agent costs a stat per tick and nothing on the wire. The cwd is NOT
    // cached: a shell can cd, and a transcript read against where the terminal
    // used to be is a conversation from another project.
    let mut transcript_mark: Option<i64> = None;
    let mut transcript_rev: Option<(String, i64)> = None;
    let mut last_transcript = std::time::Instant::now();
    let mut last_web_agent: Option<String> = None;
    // Queued commands. The clock runs in the schedule module, not here; this
    // connection only mirrors the list, and compares a revision counter so an
    // untouched queue costs one atomic read per tick.
    let mut schedule_rev: u64 = u64::MAX;

    // Push the session list so the page renders without a round trip.
    send_sessions(&mut conn, &state);

    'connection: loop {
        if SHUTDOWN.load(Ordering::Acquire) || auth::session_token().as_deref() != Some(&token) {
            let _ = conn.send_frame(OP_CLOSE, &1008u16.to_be_bytes());
            break;
        }
        // Drain pending output on every iteration, whether or not the client
        // has sent anything: a phone that only watches still receives live
        // output instead of freezing when its input queue is quiet.
        if let Some((session, subscription, rx)) = &attached {
            for _ in 0..64 {
                match rx.try_recv() {
                    Ok(WebMsg::Output(chunk)) => {
                        if chunk.is_empty() {
                            continue;
                        }
                        let mut frame = Vec::with_capacity(chunk.len() + 1);
                        frame.push(b'0');
                        frame.extend_from_slice(&chunk);
                        if conn.send_frame(OP_BIN, &frame).is_err() {
                            break 'connection;
                        }
                    }
                    Ok(WebMsg::Resized(cols, rows)) => {
                        // The other end took the grid; the phone must re-size
                        // before the next bytes, which are laid out against it.
                        let _ = send_text(
                            &mut conn,
                            &json!({ "type": "resized", "cols": cols, "rows": rows }).to_string(),
                        );
                    }
                    Ok(WebMsg::Exited(code)) => {
                        // Session ended: tell the page, then drop this
                        // subscription so the stale viewer table stays clean.
                        let _ = send_text(
                            &mut conn,
                            &json!({ "type": "exit", "id": attached_id, "code": code }).to_string(),
                        );
                        session.web_unsubscribe(*subscription);
                        attached_id = None;
                        attached = None;
                        break;
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        // Evicted for falling behind (queue overflow): tell the
                        // page so it can surface the condition instead of
                        // silently losing output.
                        let _ = send_error(&mut conn, "output too fast, resubscribe");
                        attached_id = None;
                        attached = None;
                        break;
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                }
            }
        }

        // Follow the agent's transcript. Polled rather than watched: one of
        // the backends is a SQLite database whose commits land in a
        // write-ahead log, which no filesystem event describes usefully.
        if last_transcript.elapsed() >= TRANSCRIPT_POLL {
            last_transcript = std::time::Instant::now();
            let agent = attached
                .as_ref()
                .and_then(|(session, _, _)| session.web_agent());
            if agent != last_web_agent {
                last_web_agent = agent;
                if send_text(
                    &mut conn,
                    &json!({ "type": "agent", "agent": last_web_agent }).to_string(),
                )
                .is_err()
                {
                    break;
                }
            }
            let cwd = attached_id.and_then(|id| state.web_leaf_cwd(id));
            push_transcript(
                &mut conn,
                cwd.as_deref(),
                attached.as_ref().map(|(session, _, _)| session),
                &mut transcript_mark,
                &mut transcript_rev,
            );
        }

        // Mirror the queued commands whenever they change - added here, run,
        // or cancelled from the desktop.
        {
            let sched = app.state::<schedule::ScheduleState>();
            let rev = sched.revision();
            if rev != schedule_rev {
                schedule_rev = rev;
                let jobs = sched.list();
                if let Ok(payload) = serde_json::to_value(&jobs) {
                    let _ = send_text(
                        &mut conn,
                        &json!({ "type": "schedules", "jobs": payload }).to_string(),
                    );
                }
            }
        }

        // Server heartbeat: keep half-open connections honest and let NAT
        // keep the mapping alive on phones that sleep.
        if last_ping.elapsed() >= Duration::from_secs(30) {
            last_ping = std::time::Instant::now();
            if conn.send_frame(OP_PING, b"terax").is_err() {
                break;
            }
        }

        // A peer that goes 90s without a single byte (PONG included) is dead
        // or off the network: stop pinning a thread and a connection slot.
        if conn.last_read_at.elapsed() > Duration::from_secs(90) {
            log::debug!("web terminal: peer idle 90s, dropping connection");
            break;
        }

        match conn.read_message() {
            Ok(None) => {
                // No complete frame yet: yield briefly so the loop can keep
                // draining session output, then poll again. A quiet phone is
                // never disconnected for idling (issue #41).
                thread::sleep(Duration::from_millis(10));
            }
            Ok(Some((OP_TEXT, payload))) => {
                let text = String::from_utf8_lossy(&payload);
                let parsed: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = send_error(&mut conn, "invalid JSON");
                        continue;
                    }
                };
                if let Some(id) = parsed.get("attach").and_then(|v| v.as_u64()) {
                    let Ok(leaf_id) = u32::try_from(id) else {
                        let _ = send_error(&mut conn, "invalid terminal id");
                        continue;
                    };
                    // Detach the previous subscription precisely, so other
                    // viewers of the same session are never affected.
                    if let Some((session, subscription, _)) = attached.take() {
                        session.web_unsubscribe(subscription);
                    }
                    attached_id = None;

                    // The phone attaches by leaf id (the desktop tab's leaf).
                    // If that tab has no live pty yet, ask the desktop to open
                    // it and report "opening" so the page can retry shortly.
                    let session = state.web_leaf_session(leaf_id, &app);
                    let Some(session) = session else {
                        let _ = send_text(
                            &mut conn,
                            &json!({ "type": "opening", "id": id }).to_string(),
                        );
                        continue;
                    };
                    // Attach does NOT resize the shared PTY. The desktop owns
                    // the canonical size; the phone renders at exactly that
                    // grid so the byte stream (which is laid out against the
                    // desktop's cols/rows) parses correctly.
                    // Subscribe first, so output produced while the window is
                    // serializing its buffer is queued rather than lost. The
                    // few milliseconds in between can appear both in the seed
                    // and in the queue; a small duplicate is the accepted cost
                    // of not making the window count bytes for us.
                    let Some((subscription, rx)) = session.web_subscribe() else {
                        let _ = send_error(&mut conn, "session already exited");
                        continue;
                    };
                    // Send the grid size BEFORE the seed: the phone
                    // must size its xterm to the PTY grid first, otherwise the
                    // history bytes (positioned for the desktop grid) are
                    // parsed at the phone's fit width and every wrapped line /
                    // cursor move lands wrong.
                    // A phone normally sends no grid at all: it renders no
                    // terminal, so it has no size to want, and taking the grid
                    // would reflow the desktop's screen under a program laid
                    // out for it. cols/rows stay accepted for a client that
                    // does render a grid; without them this viewer never
                    // claims the size, on attach or on a keystroke.
                    let grid = parsed
                        .get("cols")
                        .and_then(|v| v.as_u64())
                        .zip(parsed.get("rows").and_then(|v| v.as_u64()))
                        .and_then(|(c, r)| checked_grid(c, r));
                    if let Some((c, r)) = grid {
                        web_grid = Some((c, r));
                        if let Some((c, r)) = session.web_take_grid(c, r) {
                            log::info!("web: phone took pty grid {c}x{r} leaf={leaf_id}");
                            let _ = app.emit(
                                pty::PTY_RESIZED_EVENT,
                                json!({ "leafId": leaf_id, "cols": c, "rows": r }),
                            );
                        }
                    }
                    // The seed is the desktop terminal's own buffer, asked
                    // for now. It carries its own buffer mode (the serialized
                    // form re-enters the alternate screen), so the phone must
                    // not force one before writing it - `alt` below is only
                    // for the case where no seed came back.
                    let seed = request_snapshot(&app, leaf_id);
                    let (cols, rows) = session.size();
                    last_web_agent = session.web_agent();
                    let _ = send_text(
                        &mut conn,
                        &json!({
                            "type": "attached",
                            "id": id,
                            "cols": cols,
                            "rows": rows,
                            "alt": session.web_in_alt(),
                            "agent": last_web_agent,
                            // Whether a seed frame follows this message.
                            "seed": seed.is_some(),
                        })
                        .to_string(),
                    );
                    if let Some(seed) = seed {
                        let bytes = seed.as_bytes();
                        let mut frame = Vec::with_capacity(bytes.len() + 1);
                        frame.push(b'0');
                        frame.extend_from_slice(bytes);
                        if conn.send_frame(OP_BIN, &frame).is_err() {
                            session.web_unsubscribe(subscription);
                            break;
                        }
                    }
                    attached_id = Some(leaf_id);
                    attached = Some((session, subscription, rx));
                    transcript_mark = None;
                    transcript_rev = None;
                    last_transcript = std::time::Instant::now();
                } else if let Some(req) = parsed.get("submit") {
                    let id = req.get("id").and_then(Value::as_str).unwrap_or_default();
                    let target = req.get("leafId").and_then(Value::as_u64);
                    let result = match attached.as_ref() {
                        Some((session, _, _)) if target == attached_id.map(u64::from) => {
                            if web_grid.is_some() {
                                if let Some((cols, rows)) = session.claim(SizeOwner::Web) {
                                    let _ = app.emit(
                                        pty::PTY_RESIZED_EVENT,
                                        json!({ "leafId": attached_id, "cols": cols, "rows": rows }),
                                    );
                                }
                            }
                            match req.get("text").and_then(Value::as_str) {
                                Some(text) => session.web_submit(id, text),
                                None => Err("missing submission text".to_string()),
                            }
                        }
                        _ => Err("terminal attachment changed".to_string()),
                    };
                    let _ = send_text(&mut conn, &json!({ "type": "writeAck", "requestId": id, "accepted": result.is_ok(), "message": result.err() }).to_string());
                } else if parsed.get("list").and_then(|v| v.as_bool()) == Some(true) {
                    send_sessions(&mut conn, &state);
                } else if let Some(req) = parsed.get("scheduleAdd") {
                    // Queued against the attached terminal: the phone never
                    // names a leaf of its own, and scheduling into a terminal
                    // you are not looking at is not something to infer.
                    let outcome = match attached_id {
                        None => Err("no terminal attached".to_string()),
                        Some(leaf) => {
                            let command = req
                                .get("command")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let secs = req
                                .get("delaySeconds")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            app.state::<schedule::ScheduleState>()
                                .add(leaf, command, Duration::from_secs(secs))
                                .map(|_| ())
                        }
                    };
                    if let Some(id) = req
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| id.len() <= 128)
                    {
                        let _ = send_text(
                            &mut conn,
                            &json!({ "type": "scheduleAck", "requestId": id, "accepted": outcome.is_ok(), "message": outcome.as_ref().err() }).to_string(),
                        );
                    }
                    if let Err(reason) = outcome {
                        let _ = send_error(&mut conn, &reason);
                    } else {
                        let _ = app.emit(
                            schedule::SCHEDULE_EVENT,
                            app.state::<schedule::ScheduleState>().list(),
                        );
                    }
                } else if let Some(id) = parsed.get("scheduleCancel").and_then(|v| v.as_u64()) {
                    let result = app.state::<schedule::ScheduleState>().cancel(id);
                    if let Err(reason) = &result {
                        let _ = send_error(&mut conn, reason);
                    }
                    if matches!(result, Ok(true)) {
                        let _ = app.emit(
                            schedule::SCHEDULE_EVENT,
                            app.state::<schedule::ScheduleState>().list(),
                        );
                    }
                }
            }
            Ok(Some((OP_BIN, payload))) => {
                let Some(session) = attached.as_ref().map(|(s, _, _)| s) else {
                    continue;
                };
                if payload.is_empty() {
                    continue;
                }
                let cmd = payload[0];
                let data = &payload[1..];
                match cmd {
                    b'0' | b'2' => {
                        // Typing on the phone claims the session back from the
                        // desktop, at the grid the phone last reported.
                        if web_grid.is_some() {
                            if let Some((c, r)) = session.claim(SizeOwner::Web) {
                                log::info!("web: phone reclaimed pty grid {c}x{r}");
                                let _ = app.emit(
                                    pty::PTY_RESIZED_EVENT,
                                    json!({ "leafId": attached_id, "cols": c, "rows": r }),
                                );
                            }
                        }
                        let codex_submit = cmd == b'2'
                            && session.web_agent().as_deref() == Some("codex")
                            && !data.windows(6).any(|part| part == b"\x1b[201~");
                        let result = (|| -> std::io::Result<()> {
                            let mut w = session
                                .writer
                                .lock()
                                .map_err(|_| std::io::Error::other("terminal input unavailable"))?;
                            if codex_submit {
                                w.write_all(b"\x1b[200~")?;
                            }
                            w.write_all(data)?;
                            if codex_submit {
                                w.write_all(b"\x1b[201~")?;
                            }
                            if cmd == b'2' {
                                w.write_all(b"\r")?;
                            }
                            w.flush()
                        })();
                        if let Err(error) = result {
                            let _ =
                                send_error(&mut conn, &format!("terminal write failed: {error}"));
                        }
                    }
                    b'1' => {
                        if let Ok(v) = serde_json::from_slice::<Value>(data) {
                            if let (Some(c), Some(r)) = (
                                v.get("cols").and_then(|x| x.as_u64()),
                                v.get("rows").and_then(|x| x.as_u64()),
                            ) {
                                let Some((c, r)) = checked_grid(c, r) else {
                                    continue;
                                };
                                web_grid = Some((c, r));
                                if let Some((c, r)) = session.request_grid(SizeOwner::Web, c, r) {
                                    let _ = app.emit(
                                        pty::PTY_RESIZED_EVENT,
                                        json!({ "leafId": attached_id, "cols": c, "rows": r }),
                                    );
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Some((OP_PING, payload))) => {
                let _ = conn.send_frame(OP_PONG, &payload);
            }
            Ok(Some((OP_PONG, _))) => {}
            Ok(Some((OP_CLOSE, _))) => break,
            Err(e) => {
                log::debug!("web terminal: ws read ended: {e}");
                break;
            }
            _ => {}
        }
    }

    // Detach this connection's subscription precisely, never the whole table.
    if let Some((session, subscription, _)) = attached {
        session.web_unsubscribe(subscription);
    }
}

/// How often an attached connection looks for new agent output. Fast enough
/// that a reply appears while it is still being read, cheap enough that an
/// idle session costs two stats.
const TRANSCRIPT_POLL: Duration = Duration::from_millis(700);

/// Send the agent transcript for this leaf, if it moved since the last send.
///
/// Three gates, because the phone should not pay for an agent that is idle:
/// nothing happens unless one is actually running, the filesystem mark is a
/// stat, and only when that moves is the transcript read and its revision
/// compared. A shell with no agent sends nothing at all and the page stays on
/// the screen view.
fn push_transcript(
    conn: &mut WsConn,
    cwd: Option<&str>,
    session: Option<&Arc<Session>>,
    mark: &mut Option<i64>,
    revision: &mut Option<(String, i64)>,
) {
    // No agent running means no transcript, whatever this directory has on
    // disk from an earlier session: showing yesterday's conversation over
    // today's shell prompt would be a lie about what is in front of you.
    let agent = session.and_then(|session| session.web_agent());
    let (Some(cwd), Some(agent), Some(session)) = (cwd, agent.as_deref(), session) else {
        if revision.take().is_some() {
            let _ = send_text(conn, &json!({ "type": "transcriptClear" }).to_string());
        }
        *mark = None;
        return;
    };
    let t = if agent == "opencode" {
        let found = transcript::opencode_fingerprint();
        if found.is_some() && found == *mark {
            return;
        }
        *mark = found;
        transcript::read_opencode(cwd)
    } else {
        session.web_transcript(cwd, agent)
    };
    let Some(t) = t else {
        if revision.take().is_some() {
            let _ = send_text(conn, &json!({ "type": "transcriptClear" }).to_string());
        }
        return;
    };
    let token = (format!("{}:{}", t.source, t.session_id), t.revision);
    if revision.as_ref() == Some(&token) {
        return;
    }
    *revision = Some(token);
    let Ok(mut payload) = serde_json::to_value(t.as_ref()) else {
        return;
    };
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("type".into(), Value::String("transcript".into()));
    }
    let _ = send_text(conn, &payload.to_string());
}

fn send_sessions(conn: &mut WsConn, state: &PtyState) {
    let tabs = state.web_tabs();
    let spaces = state.web_spaces();
    let msg = json!({
        "type": "sessions",
        "sessions": tabs.iter().map(|t| json!({
            "id": t.leaf_id,
            "cwd": t.cwd,
            "title": t.title,
            "active": t.active,
            "live": t.pty_id.is_some(),
            "space": t.space_id,
            "cols": t.pty_id.and_then(|id| state.web_get(id)).map(|s| state.web_session_size(&s).0),
            "rows": t.pty_id.and_then(|id| state.web_get(id)).map(|s| state.web_session_size(&s).1),
        })).collect::<Vec<_>>(),
        // Every group, including empty ones, so the switcher can show all.
        "spaces": spaces.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
    });
    let _ = send_text(conn, &msg.to_string());
}

fn send_text(conn: &mut WsConn, text: &str) -> Result<(), ()> {
    conn.send_frame(OP_TEXT, text.as_bytes()).map_err(|_| ())
}

fn send_error(conn: &mut WsConn, message: &str) -> Result<(), ()> {
    send_text(
        conn,
        &json!({ "type": "error", "message": message }).to_string(),
    )
}
