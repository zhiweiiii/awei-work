use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HEAD_BYTES: u64 = 192 * 1024;
const MAX_PER_AGENT: usize = 40;
const SCAN_INTERVAL: Duration = Duration::from_secs(2);
const MAX_SCAN_ENTRIES: usize = 32_768;
const MAX_SCAN_FILES: usize = 8_192;
const MAX_SCAN_DEPTH: usize = 8;
const SCAN_DEADLINE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub agent: &'static str,
    pub id: String,
    pub title: String,
    pub updated_at: i64,
}
#[derive(Clone)]
struct Header {
    cwd: String,
    id: String,
    title: String,
}
struct CachedHeader {
    length: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    header: Option<Header>,
    used: Instant,
}
struct CachedDirectory {
    paths: Result<Vec<PathBuf>, String>,
    checked: Instant,
}

fn header_cache() -> &'static Mutex<HashMap<PathBuf, CachedHeader>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedHeader>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn session_root(cwd: &str, agent: &str) -> Option<PathBuf> {
    match agent {
        "claude" => crate::modules::transcript::claude_project_dir(cwd),
        "codex" => Some(dirs::home_dir()?.join(".codex").join("sessions")),
        _ => None,
    }
}
fn session_paths(cwd: &str, agent: &str) -> Result<Vec<PathBuf>, String> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedDirectory>>> = OnceLock::new();
    let Some(root) = session_root(cwd, agent) else {
        return Ok(Vec::new());
    };
    let mut cache = match CACHE.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        Ok(cache) => cache,
        Err(_) => return Err("Session directory cache is unavailable".into()),
    };
    if let Some(hit) = cache
        .get(&root)
        .filter(|hit| hit.checked.elapsed() < SCAN_INTERVAL)
    {
        return hit.paths.clone();
    }
    let paths = collect_paths(&root, agent == "codex");
    if cache.len() >= 32 && !cache.contains_key(&root) {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.checked)
            .map(|(path, _)| path.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        root,
        CachedDirectory {
            paths: paths.clone(),
            checked: Instant::now(),
        },
    );
    paths
}
fn collect_paths(dir: &Path, recursive: bool) -> Result<Vec<PathBuf>, String> {
    let started = Instant::now();
    let mut pending = vec![(dir.to_path_buf(), 0usize)];
    let mut out = Vec::new();
    let mut visited = 0usize;
    while let Some((dir, depth)) = pending.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if depth == 0 && error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(out)
            }
            Err(error) => return Err(format!("Cannot scan session directory: {error}")),
        };
        for entry in entries {
            visited += 1;
            if visited > MAX_SCAN_ENTRIES || started.elapsed() > SCAN_DEADLINE {
                return Err(
                    "Session directory scan exceeded its budget; use the CLI history picker".into(),
                );
            }
            let entry = entry.map_err(|error| error.to_string())?;
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if recursive && kind.is_dir() {
                if depth >= MAX_SCAN_DEPTH {
                    return Err("Session directory nesting exceeds the supported limit".into());
                }
                pending.push((path, depth + 1));
            } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
                if out.len() >= MAX_SCAN_FILES {
                    return Err("Too many session files; use the CLI history picker".into());
                }
                out.push(path);
            }
        }
    }
    Ok(out)
}
pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
fn message_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    Some(
        content
            .as_array()?
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.as_str())
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}
fn title_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect()
}
fn boilerplate(text: &str) -> bool {
    let text = text.trim_start();
    text.starts_with('<')
        || text.starts_with("Caveat:")
        || text.starts_with("# AGENTS.md")
        || text.starts_with("# CLAUDE.md")
}
fn parse_header(path: &Path, agent: &str) -> Option<Header> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(HEAD_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    let end = bytes.iter().rposition(|b| *b == b'\n')?;
    let text = std::str::from_utf8(&bytes[..end]).ok()?;
    let mut cwd = None;
    let mut id = if agent == "claude" {
        path.file_stem()?.to_str().map(str::to_owned)
    } else {
        None
    };
    let mut title = None;
    let mut first_ask = None;
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = value.get("payload").unwrap_or(&value);
        if cwd.is_none() {
            cwd = payload
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if agent == "codex" && value.get("type").and_then(Value::as_str) == Some("session_meta") {
            id = payload
                .get("session_id")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if agent == "claude" && value.get("type").and_then(Value::as_str) == Some("ai-title") {
            title = value
                .get("aiTitle")
                .and_then(Value::as_str)
                .map(title_text)
                .filter(|s| !s.is_empty());
        }
        if first_ask.is_none() {
            let content =
                if agent == "claude" && value.get("type").and_then(Value::as_str) == Some("user") {
                    value
                        .get("message")
                        .and_then(|message| message.get("content"))
                } else if agent == "codex"
                    && payload.get("role").and_then(Value::as_str) == Some("user")
                {
                    payload.get("content")
                } else {
                    None
                };
            first_ask = content
                .and_then(message_text)
                .filter(|s| !s.trim().is_empty() && !boilerplate(s))
                .map(|s| title_text(&s));
        }
        if cwd.is_some()
            && id.is_some()
            && (title.is_some() || (agent == "codex" && first_ask.is_some()))
        {
            break;
        }
    }
    let id = id.filter(|id| valid_id(id))?;
    Some(Header {
        cwd: cwd?,
        id,
        title: title
            .or(first_ask)
            .unwrap_or_else(|| "(无标题会话)".to_string()),
    })
}
fn session_header(path: &Path, agent: &str, metadata: &fs::Metadata) -> Option<Header> {
    let modified = metadata.modified().ok();
    let created = metadata.created().ok();
    if let Ok(mut cache) = header_cache().lock() {
        if let Some(hit) = cache.get_mut(path).filter(|hit| {
            hit.created == created
                && ((hit.length == metadata.len() && hit.modified == modified)
                    || (hit.header.is_some()
                        && hit.length >= HEAD_BYTES
                        && metadata.len() > hit.length))
        }) {
            hit.used = Instant::now();
            hit.length = metadata.len();
            hit.modified = modified;
            return hit.header.clone();
        }
    }
    let header = parse_header(path, agent);
    if let Ok(mut cache) = header_cache().lock() {
        if cache.len() >= 512 && !cache.contains_key(path) {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(path, _)| path.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(
            path.to_path_buf(),
            CachedHeader {
                length: metadata.len(),
                modified,
                created,
                header: header.clone(),
                used: Instant::now(),
            },
        );
    }
    header
}
fn list_sessions(cwd: &str, agent: &'static str) -> Result<Vec<Session>, String> {
    let mut files: Vec<_> = session_paths(cwd, agent)?
        .into_iter()
        .filter_map(|path| {
            let metadata = fs::metadata(&path).ok()?;
            let modified = metadata
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_secs() as i64;
            Some((modified, path, metadata))
        })
        .collect();
    files.sort_by_key(|(modified, _, _)| std::cmp::Reverse(*modified));
    Ok(files
        .into_iter()
        .filter_map(|(updated_at, path, metadata)| {
            let header = session_header(&path, agent, &metadata)?;
            crate::modules::transcript::same_dir(&header.cwd, cwd).then_some(Session {
                agent,
                id: header.id,
                title: header.title,
                updated_at,
            })
        })
        .take(MAX_PER_AGENT)
        .collect())
}
pub(crate) fn resolve_session_file(
    cwd: &str,
    agent: &str,
    id: Option<&str>,
    started_at: SystemTime,
) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for path in session_paths(cwd, agent).ok()? {
        if id.is_some_and(|id| {
            !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().contains(id))
        }) {
            continue;
        }
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if id.is_none()
            && !metadata
                .created()
                .is_ok_and(|created| created >= started_at)
        {
            continue;
        }
        let Some(header) = session_header(&path, agent, &metadata) else {
            continue;
        };
        if !crate::modules::transcript::same_dir(&header.cwd, cwd)
            || id.is_some_and(|id| header.id != id)
        {
            continue;
        }
        candidates.push(path);
        if candidates.len() > 1 {
            return None;
        }
    }
    (candidates.len() == 1).then(|| candidates.remove(0))
}

pub(crate) fn session_id_for_file(path: &Path, agent: &str, cwd: &str) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    let header = session_header(path, agent, &metadata)?;
    (valid_id(&header.id) && crate::modules::transcript::same_dir(&header.cwd, cwd))
        .then_some(header.id)
}

#[tauri::command]
pub async fn agent_resume_command(
    cwd: String,
    agent: String,
    id: String,
    workspace: Option<crate::modules::workspace::WorkspaceEnv>,
) -> Result<String, String> {
    let _ = workspace;
    if !matches!(agent.as_str(), "claude" | "codex")
        || !valid_id(&id)
        || cwd.is_empty()
        || cwd.len() > 32768
        || cwd.chars().any(char::is_control)
    {
        return Err("Invalid saved agent session".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        resolve_session_file(&cwd, &agent, Some(&id), UNIX_EPOCH)
            .ok_or("Saved agent session is missing or belongs to another directory")?;
        Ok(if agent == "claude" {
            format!("claude --resume {id}")
        } else {
            format!("codex resume {id}")
        })
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn agent_sessions(
    cwd: String,
    workspace: Option<crate::modules::workspace::WorkspaceEnv>,
) -> Result<Vec<Session>, String> {
    let _ = workspace;
    tauri::async_runtime::spawn_blocking(move || {
        let mut all = list_sessions(&cwd, "claude")?;
        all.extend(list_sessions(&cwd, "codex")?);
        all.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
        Ok(all)
    })
    .await
    .map_err(|error| error.to_string())?
}
