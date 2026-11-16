//! dsh: DeepSeek Harness. A web surface rather than a terminal client, and a
//! session log format of its own.
//!
//! Two jobs live here:
//!
//! - Reading `~/.dsh/sessions/<project>/<session>/session*.jsonl.zstd` for the
//!   history menu, plus the project cache that carries the session titles and
//!   the directory each one belongs to.
//! - Running the web server, once, for the app. It has no terminal surface (the
//!   `tui` profile the launcher mentions is not installed), so "open a new dsh
//!   conversation" means starting the server and showing the page, not typing
//!   into a shell.
//!
//! The log is written as a sequence of independently compressed zstd frames,
//! not one stream: a session that is still being appended to has a new frame
//! per flush, and concatenating the decompressed frames is the only way to read
//! all of it. Stopping at the first frame yields the header and nothing else,
//! which is what a single-stream reader would do.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;

use crate::modules::proc::job::ProcessJob;

/// The port the server listens on when nothing else claims it. Not specified on
/// the command line: the launcher's fallback is 3080 and pinning a port here
/// would make two profiles fight over it.
const DEFAULT_PORT: u16 = 3080;
/// How long a readiness probe waits for the listener to appear. First run
/// installs the web profile from its template and is far slower than a warm
/// one.
const START_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshSession {
    /// The file name's id, which is what the UI keys on and what a resume
    /// would need.
    pub id: String,
    pub title: String,
    pub updated_at: i64,
}

/// The dsh home, or None when dsh has never run on this machine.
fn home() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".dsh"))
}

/// Encode a directory the way dsh names its per-project folder.
///
/// Mirrors `projectKey` in `dsh-session-persistence-jsonl`: separators collapse
/// into one `-`, anything outside `[A-Za-z0-9._-]` becomes `~` plus four hex
/// digits of its code point, and the whole thing is wrapped in `--`. Getting
/// this wrong means an empty history rather than a wrong one, so it is worth
/// being exact.
fn project_key(cwd: &str) -> String {
    let mut readable = String::new();
    let mut separator_run = false;
    for ch in cwd.chars() {
        if ch == '/' || ch == '\\' || ch == ':' {
            if !separator_run {
                readable.push('-');
            }
            separator_run = true;
        } else if ch != '~' && (ch.is_ascii_alphanumeric() || "._-".contains(ch)) {
            readable.push(ch);
            separator_run = false;
        } else {
            use std::fmt::Write;
            let _ = write!(readable, "~{:04X}", ch as u32);
            separator_run = false;
        }
    }
    let trimmed = readable.trim_start_matches('-');
    let body = if trimmed.is_empty() { "root" } else { trimmed };
    let body: String = body.chars().take(251).collect();
    format!("--{body}--")
}

/// Decompress every zstd frame in `data` and concatenate the results.
///
/// A frame that fails to decode is skipped rather than fatal: the last frame of
/// a log that is being written may be truncated, and the rest of the session is
/// still worth reading.
fn decompress_frames(data: &[u8]) -> Vec<u8> {
    const MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut search = 0usize;
    loop {
        let next = data[search..]
            .windows(4)
            .position(|window| window == MAGIC)
            .map(|offset| search + offset);
        let end = match next {
            // A magic at `start` itself is the frame we are already reading, so
            // look past it before treating a match as a boundary.
            Some(at) if at > start => at,
            Some(_) => {
                search = start + 4;
                continue;
            }
            None => data.len(),
        };
        let frame = &data[start..end];
        if let Ok(mut decoder) = ruzstd::decoding::StreamingDecoder::new(frame) {
            // Bounded: a session log is a few megabytes at most, and a corrupt
            // frame must not be allowed to expand without limit.
            let mut buffer = Vec::new();
            if (&mut decoder)
                .take(16 * 1024 * 1024)
                .read_to_end(&mut buffer)
                .is_ok()
            {
                out.extend_from_slice(&buffer);
            }
        }
        if end >= data.len() {
            break;
        }
        start = end;
        search = end;
    }
    out
}

/// Everything a session's events can tell the menu without reading its body.
struct LogSummary {
    title: Option<String>,
    /// The first prompt, used when dsh never wrote a title of its own.
    first_user_text: Option<String>,
    cwd: Option<String>,
    /// The last event's own timestamp, which is closer to "when did anyone last
    /// talk to this" than the file's mtime, because the file is also touched by
    /// compaction and projection writes.
    last_event_ms: Option<u64>,
}

/// Read the head and tail of a log for the fields the menu shows.
///
/// The whole file is decompressed: frame boundaries do not line up with events,
/// and a session's title may be written long after its first prompt. Logs are
/// a few hundred kilobytes decompressed, and the menu reads at most a handful.
fn summarize(path: &Path) -> Option<LogSummary> {
    // Bound what is decompressed as well as what is read: a long-running
    // session's log grows without limit, and a menu entry does not need the
    // middle of it.
    const MAX_COMPRESSED: u64 = 8 * 1024 * 1024;
    let file = fs::File::open(path).ok()?;
    let mut data = Vec::new();
    file.take(MAX_COMPRESSED).read_to_end(&mut data).ok()?;
    let text = String::from_utf8_lossy(&decompress_frames(&data)).into_owned();

    let mut summary = LogSummary {
        title: None,
        first_user_text: None,
        cwd: None,
        last_event_ms: None,
    };
    for line in text.lines() {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let kind = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(ms) = event.get("time").and_then(|v| v.as_u64()) {
            summary.last_event_ms = Some(ms);
        }
        match kind {
            "session" => {
                summary.cwd = event
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
            "session/title" => {
                if let Some(title) = event
                    .get("data")
                    .and_then(|d| d.get("title"))
                    .and_then(|v| v.as_str())
                    .filter(|t| !t.trim().is_empty())
                {
                    summary.title = Some(title.to_string());
                }
            }
            "user/message" if summary.first_user_text.is_none() => {
                // Harness reminders and runtime-context snapshots arrive as
                // user messages too. They are not what the user typed, and
                // showing one as the title would be misleading.
                let text = event
                    .get("data")
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_array())
                    .and_then(|parts| {
                        parts
                            .iter()
                            .find_map(|part| part.get("text").and_then(|t| t.as_str()))
                    });
                if let Some(text) = text.filter(|t| !is_boilerplate(t)) {
                    summary.first_user_text = Some(first_line(text));
                }
            }
            _ => {}
        }
    }
    Some(summary)
}

fn is_boilerplate(text: &str) -> bool {
    let text = text.trim_start();
    text.starts_with('<')
        || text.starts_with("Current runtime context")
        || text.starts_with("A skill is a reusable")
        || text.starts_with("The following workspace instructions")
}

fn first_line(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    let trimmed: String = line.chars().take(160).collect();
    if trimmed.is_empty() {
        "(空消息)".to_string()
    } else {
        trimmed
    }
}

/// Session ids and titles from dsh's own project cache.
///
/// Written by the server as it goes, so it is the cheapest source of titles.
/// Missing or unreadable is normal: dsh may never have started.
fn cached_titles(home: &Path) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    let Ok(text) = fs::read_to_string(home.join("storages").join("session_projcache.json")) else {
        return titles;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return titles;
    };
    let Some(sessions) = json
        .get("tables")
        .and_then(|t| t.get("sessions"))
        .and_then(|s| s.as_object())
    else {
        return titles;
    };
    for (id, entry) in sessions {
        if let Some(title) = entry
            .get("rows")
            .and_then(|r| r.get("title"))
            .and_then(|t| t.get("val"))
            .and_then(|v| v.as_str())
            .filter(|t| !t.trim().is_empty())
        {
            titles.insert(id.clone(), title.to_string());
        }
    }
    titles
}

fn mtime_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// Past dsh conversations in `cwd`, newest first.
///
/// Scoped to the directory for the same reason the other agents are: a history
/// list that mixes projects is not a history of the project in front of you.
pub fn sessions_for(cwd: &str) -> Vec<DshSession> {
    let Some(home) = home() else {
        return Vec::new();
    };
    let project = home.join("sessions").join(project_key(cwd));
    let Ok(entries) = fs::read_dir(&project) else {
        return Vec::new();
    };
    let titles = cached_titles(&home);

    let mut found: Vec<DshSession> = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(id) = dir
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| n.starts_with("session-"))
            .map(|n| n.to_string())
        else {
            continue;
        };
        // The v4 log supersedes the plain one when both exist; it is the format
        // the current server writes.
        let log = [
            dir.join("session.v4.jsonl.zstd"),
            dir.join("session.jsonl.zstd"),
        ]
        .into_iter()
        .find(|path| path.is_file());
        let Some(log) = log else {
            continue;
        };
        let summary = summarize(&log);
        let updated_at = summary
            .as_ref()
            .and_then(|s| s.last_event_ms)
            .or_else(|| mtime_ms(&log))
            .unwrap_or(0) as i64
            / 1000;
        // A log whose header names another directory belongs to a moved
        // project; dsh's own folder name still decides, so this is only a
        // fallback check and never a reason to hide a session.
        let title = titles
            .get(&id)
            .cloned()
            .or_else(|| summary.as_ref().and_then(|s| s.title.clone()))
            .or_else(|| summary.as_ref().and_then(|s| s.first_user_text.clone()))
            .unwrap_or_else(|| "(无标题)".to_string());
        found.push(DshSession {
            id,
            title,
            updated_at,
        });
    }
    found.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    found.truncate(40);
    found
}

/// The running web server, kept alive for the life of the app.
struct Server {
    child: Child,
    /// Kills the process tree, npm shims included, when the app exits.
    _job: Option<ProcessJob>,
    port: u16,
    /// The URL the server printed, which carries its process token. Opening the
    /// bare origin lands on a page that cannot authenticate.
    url: String,
}

fn server() -> &'static Mutex<Option<Server>> {
    static STATE: OnceLock<Mutex<Option<Server>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

/// Whether something already answers on the port.
fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .expect("literal address"),
        Duration::from_millis(250),
    )
    .is_ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshLaunch {
    /// The authenticated URL to open. Empty while the server is still starting
    /// on a later poll.
    pub url: String,
    /// True once the server is up. False means "still coming up"; failures come
    /// back as an error instead.
    pub ready: bool,
}

/// Start the dsh web server unless it is already running, and return its URL.
///
/// `dsh` is launched directly: it is installed globally on this machine, and
/// the npx fallback exists only for an install where it is not. `--no-open`
/// matters: the server opens a browser itself otherwise, which would leave two
/// windows on the same page.
#[tauri::command]
pub async fn dsh_launch() -> Result<DshLaunch, String> {
    tauri::async_runtime::spawn_blocking(launch_blocking)
        .await
        .map_err(|e| e.to_string())?
}

fn launch_blocking() -> Result<DshLaunch, String> {
    let mut guard = server().lock().map_err(|_| "dsh 状态不可用")?;
    if let Some(current) = guard.as_mut() {
        // A server that died (crash, port taken after start) should be replaced
        // rather than reported as running.
        match current.child.try_wait() {
            Ok(Some(_)) => *guard = None,
            Ok(None) => {
                return Ok(DshLaunch {
                    url: current.url.clone(),
                    ready: true,
                })
            }
            Err(_) => *guard = None,
        }
    }

    // Something else on the port is either a dsh this app started in an earlier
    // process or one the user started by hand. Either way, opening that page is
    // better than failing to bind over it, but its authenticated URL is unknown
    // to us, so the plain origin is all that can be offered.
    if port_open(DEFAULT_PORT) {
        let url = format!("http://127.0.0.1:{DEFAULT_PORT}/");
        return Ok(DshLaunch { url, ready: true });
    }

    let (mut command, program) = dsh_command()?;
    command
        .arg("web")
        .arg("--no-open")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 {program}：{e}"))?;
    let job = ProcessJob::create_for(child.id()).ok();

    // The URL is printed on stdout once the connection layer is up, and the
    // line is the only place the token appears. Read it here rather than
    // polling the port: a listening socket that has not printed its URL is not
    // usable yet.
    let stdout = child.stdout.take().ok_or("dsh 没有输出")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(url) = line.trim().strip_prefix("dsh web: ") {
                if url.starts_with("http") && tx.send(url.to_string()).is_ok() {
                    // Later lines are status messages, not more URLs.
                }
            }
        }
    });

    let url = match rx.recv_timeout(START_TIMEOUT) {
        Ok(url) => url,
        Err(_) => {
            // Nothing printed: take whatever the process said on the way out,
            // so the message names the real cause (missing profile, port taken,
            // a frontend that was never built).
            let _ = child.kill();
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            let _ = child.wait();
            let reason: String = stderr.trim().chars().take(400).collect();
            return Err(if reason.is_empty() {
                "dsh 启动超时，且没有输出原因".to_string()
            } else {
                format!("dsh 启动失败：{reason}")
            });
        }
    };

    // Keep draining stderr so a chatty server cannot block on a full pipe.
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut sink = std::io::sink();
            let _ = std::io::copy(&mut stderr, &mut sink);
        });
    }

    let port = url
        .split("//")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .and_then(|authority| authority.rsplit(':').next())
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    *guard = Some(Server {
        child,
        _job: job,
        port,
        url: url.clone(),
    });
    Ok(DshLaunch { url, ready: true })
}

/// `dsh` from PATH, or `npx @deepseek-ai/dsh` when only npm is installed.
///
/// The npx form is a shim that spawns node under a cmd wrapper, which is why
/// the job object matters here: killing the shim alone would leave the server.
fn dsh_command() -> Result<(Command, String), String> {
    if which::which("dsh").is_ok() {
        return Ok((Command::new("dsh"), "dsh".to_string()));
    }
    if which::which("npx").is_ok() {
        #[cfg(target_os = "windows")]
        let command = {
            let mut c = Command::new("cmd");
            c.args(["/C", "npx", "--yes", "@deepseek-ai/dsh"]);
            c
        };
        #[cfg(not(target_os = "windows"))]
        let mut command = {
            let mut c = Command::new("npx");
            c.args(["--yes", "@deepseek-ai/dsh"]);
            c
        };
        return Ok((command, "npx @deepseek-ai/dsh".to_string()));
    }
    Err("没有找到 dsh。先安装：npm i -g @deepseek-ai/dsh".to_string())
}

/// Stop the server if this app started it.
#[tauri::command]
pub fn dsh_stop() -> Result<(), String> {
    let mut guard = server().lock().map_err(|_| "dsh 状态不可用")?;
    if let Some(mut current) = guard.take() {
        // Dropping the job kills the tree; the explicit kill covers a build
        // without the job object.
        let _ = current.child.kill();
        let _ = current.child.wait();
    }
    Ok(())
}

/// Whether the server this app owns is up, for a status badge.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshStatus {
    running: bool,
    port: Option<u16>,
}

#[tauri::command]
pub fn dsh_status() -> DshStatus {
    let Ok(mut guard) = server().lock() else {
        return DshStatus {
            running: false,
            port: None,
        };
    };
    match guard.as_mut() {
        Some(current) => match current.child.try_wait() {
            Ok(None) => DshStatus {
                running: true,
                port: Some(current.port),
            },
            _ => {
                *guard = None;
                DshStatus {
                    running: false,
                    port: None,
                }
            }
        },
        None => DshStatus {
            running: false,
            port: None,
        },
    }
}
