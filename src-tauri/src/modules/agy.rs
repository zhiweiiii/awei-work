use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

use crate::modules::{
    proc::background,
    pty::shell_init::agy_executable,
    sessions::{valid_id, Session},
    transcript::same_dir,
};

fn data_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".gemini").join("antigravity-cli"))
}

fn summaries() -> Option<Connection> {
    let db = Connection::open_with_flags(
        data_dir()?.join("conversation_summaries.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    db.busy_timeout(Duration::from_millis(50)).ok()?;
    Some(db)
}

fn matching_workspace(uris: &str, cwd: &str) -> bool {
    serde_json::from_str::<Vec<String>>(uris).is_ok_and(|items| {
        items.iter().any(|uri| {
            reqwest::Url::parse(uri)
                .ok()
                .and_then(|url| url.to_file_path().ok())
                .is_some_and(|path| same_dir(&path.to_string_lossy(), cwd))
        })
    })
}

fn timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .or_else(|_| chrono::DateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f%:z"))
        .ok()
        .map(|time| time.timestamp_millis())
        .filter(|time| *time > 0)
}

pub(crate) fn sessions(cwd: &str, limit: usize) -> Vec<Session> {
    let Some(db) = summaries() else {
        return Vec::new();
    };
    let Ok(mut query) = db.prepare(
        "SELECT conversation_id, title, last_modified_time, workspace_uris
         FROM conversation_summaries WHERE parent_conversation_id = ''
         ORDER BY last_modified_time DESC LIMIT 4096",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = query.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .filter_map(|(id, title, updated_at, uris)| {
            if !valid_id(&id) || !matching_workspace(&uris, cwd) || !conversation_exists(&id) {
                return None;
            }
            Some(Session {
                agent: "agy",
                id,
                title: if title.trim().is_empty() {
                    "(无标题会话)".to_owned()
                } else {
                    title
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(80)
                        .collect()
                },
                updated_at: timestamp(&updated_at)? / 1000,
            })
        })
        .take(limit)
        .collect()
}

fn workspace_activity(cwd: &str, id: &str) -> Option<Option<i64>> {
    if !valid_id(id) {
        return None;
    }
    let (uris, user_time): (String, String) = summaries()?
        .query_row(
            "SELECT workspace_uris, last_user_input_time FROM conversation_summaries
             WHERE conversation_id = ?1 AND parent_conversation_id = ''",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    matching_workspace(&uris, cwd).then(|| timestamp(&user_time))
}

pub(crate) fn last_user_message_at(cwd: &str, id: &str) -> Option<i64> {
    workspace_activity(cwd, id).flatten()
}

fn conversation_exists(id: &str) -> bool {
    data_dir().is_some_and(|root| {
        let base = root.join("conversations").join(id);
        base.with_extension("db").is_file() || base.with_extension("pb").is_file()
    })
}

pub(crate) fn may_resume(cwd: &str, id: &str) -> bool {
    workspace_activity(cwd, id).is_some() && conversation_exists(id)
}

pub(crate) fn transcript_path(id: &str) -> Option<PathBuf> {
    valid_id(id).then_some(())?;
    Some(
        data_dir()?
            .join("brain")
            .join(id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl"),
    )
}

pub(crate) fn transcript_id(path: &Path) -> Option<&str> {
    let id = path.ancestors().nth(3)?.file_name()?.to_str()?;
    valid_id(id).then_some(id)
}

pub(crate) fn log_conversation(path: &Path, started: SystemTime) -> Option<String> {
    const TAIL_BYTES: u64 = 256 * 1024;
    let mut file = File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if meta.modified().ok()? < started {
        return None;
    }
    file.seek(SeekFrom::Start(meta.len().saturating_sub(TAIL_BYTES)))
        .ok()?;
    let mut bytes = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut bytes).ok()?;
    String::from_utf8_lossy(&bytes)
        .lines()
        .rev()
        .find_map(|line| {
            let (prefix, value) = line.split_once("] Streaming conversation ")?;
            if !prefix.contains("manager.go:") {
                return None;
            }
            let id = value.split_whitespace().next()?;
            valid_id(id).then(|| id.to_owned())
        })
}

pub(crate) fn run_prompt(
    directory: &Path,
    prompt: String,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
    summarize: bool,
    model: Option<&str>,
) -> Result<String, String> {
    let executable = agy_executable().ok_or("找不到 Antigravity CLI，请先安装并登录 agy")?;
    let mut command = Command::new(executable);
    command.current_dir(directory).args([
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--disable-slash-commands",
    ]);
    if let Some(model) = model {
        command.args(["--model", model]);
    }
    if summarize {
        command.arg("--settings").arg(
            json!({
                "agentMode": "",
                "toolPermission": "strict",
                "allowNonWorkspaceAccess": false,
                "permissions": {
                    "allow": [],
                    "deny": ["command(*)", "read_file(*)", "edit_file(*)", "read_url(*)", "execute_url(*)", "mcp(*)"],
                },
            })
            .to_string(),
        );
    }
    let input = json!({"event": "user", "message": {"content": prompt}}).to_string() + "\n";
    background::run_with_output(&mut command, input, timeout, cancelled, result_text).map_err(
        |error| match error.as_str() {
            "任务已取消" | "后台执行超时，已停止" => error,
            _ => "Anti 后台执行失败，请确认 CLI 已登录并支持 stream-json".into(),
        },
    )?
}

fn result_text(stdout: impl Read) -> Result<String, String> {
    const MAX_EVENT_BYTES: u64 = 512 * 1024;
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    let mut result = None;
    loop {
        line.clear();
        let n = reader
            .by_ref()
            .take(MAX_EVENT_BYTES)
            .read_until(b'\n', &mut line)
            .map_err(|_| "无法读取 Anti 的后台结果")?;
        if n == 0 {
            break;
        }
        if n as u64 == MAX_EVENT_BYTES && line.last() != Some(&b'\n') {
            reader
                .skip_until(b'\n')
                .map_err(|_| "无法读取 Anti 的后台结果")?;
            continue;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&line) {
            if value["event"] == "result" {
                result = (value["result"]["status"] == "SUCCESS")
                    .then(|| value["result"]["response"].as_str())
                    .flatten()
                    .map(|text| text.trim().chars().take(16384).collect::<String>());
            }
        }
    }
    result
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "Anti 没有返回有效的后台结果".into())
}
