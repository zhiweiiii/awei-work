//! What Claude Code says is left of the subscription's limits.
//!
//! The numbers are not on disk. They arrive in API response headers and Claude
//! Code keeps them in memory, surfacing them through `/usage` and through the
//! JSON it pipes to a statusLine command. Nothing under `~/.claude` holds them:
//! the transcripts record tokens spent, which is a different quantity from
//! percent of a plan window consumed.
//!
//! So this asks Claude Code, by running `claude -p "/usage"`.
//!
//! Successful replies are cached for five minutes. The answer is prose meant
//! for a human, so parsing is best effort and the raw text is always kept.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use shared_child::SharedChild;

use crate::modules::workspace::WorkspaceEnv;

const MIN_REFETCH: Duration = Duration::from_secs(300);
const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// `session` for the rolling 5 hour window, or the parenthetical from a
    /// weekly line such as `all models` / `Opus`.
    pub label: String,
    pub percent: Option<u32>,
    /// When the window rolls over, exactly as Claude Code worded it.
    pub resets: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// The rolling 5 hour window.
    pub session: Option<UsageWindow>,
    /// Weekly windows. A plan can report more than one, such as an overall
    /// figure plus a separate Opus allowance.
    pub weeks: Vec<UsageWindow>,
    /// Everything Claude Code printed, so the panel can show what was not
    /// parsed rather than pretend it does not exist.
    pub raw: String,
    /// Unix seconds this answer was fetched.
    pub fetched_at: i64,
    /// Set when the fetch itself failed. `raw` then holds whatever came out.
    pub error: Option<String>,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn cache() -> &'static Mutex<Option<(Usage, Instant)>> {
    static CACHE: std::sync::OnceLock<Mutex<Option<(Usage, Instant)>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Read a percentage out of `... 73% used ...`.
fn percent_before_used(text: &str) -> Option<u32> {
    let cut = text.find("% used")?;
    let digits: String = text[..cut]
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.chars().rev().collect::<String>().parse().ok()
}

/// Read the reset phrase out of `... resets Sep 7, 4:30pm (Asia/Shanghai)`.
fn resets_after(text: &str) -> Option<String> {
    let start = text.find("resets ")? + "resets ".len();
    let value = text[start..].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Pull `all models` out of `Current week (all models): ...`.
fn parenthetical(text: &str) -> Option<String> {
    let open = text.find('(')?;
    let close = text[open..].find(')')? + open;
    let value = text[open + 1..close].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Best effort read of the `/usage` output.
///
/// Only the two shapes that carry a limit are matched, and anything else is
/// left to `raw`. Matching loosely on the leading words rather than the whole
/// line means a reworded suffix does not lose the number.
pub fn parse(raw: &str) -> (Option<UsageWindow>, Vec<UsageWindow>) {
    let mut session = None;
    let mut weeks = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("current session") {
            session = Some(UsageWindow {
                label: "session".to_string(),
                percent: percent_before_used(line),
                resets: resets_after(line),
            });
        } else if lower.starts_with("current week") {
            weeks.push(UsageWindow {
                label: parenthetical(line).unwrap_or_else(|| "week".to_string()),
                percent: percent_before_used(line),
                resets: resets_after(line),
            });
        }
    }
    (session, weeks)
}

fn drain<R: std::io::Read>(reader: &mut R) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    while let Ok(read) = reader.read(&mut buf) {
        if read == 0 {
            break;
        }
        if out.len() < MAX_OUTPUT_BYTES {
            let take = (MAX_OUTPUT_BYTES - out.len()).min(read);
            out.extend_from_slice(&buf[..take]);
        }
    }
    out
}

fn fetch() -> Usage {
    // Quoted so the shell hands `/usage` over as one argument. Git Bash would
    // otherwise translate a leading slash into a Windows path, which is exactly
    // how this gets mistaken for a missing feature.
    let command = "claude -p \"/usage\"";
    let mut cmd =
        match crate::modules::shell::build_oneshot_command(command, &WorkspaceEnv::Local, None) {
            Ok(cmd) => cmd,
            Err(message) => {
                return Usage {
                    fetched_at: now_secs(),
                    error: Some(message),
                    ..Usage::default()
                }
            }
        };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let child = match SharedChild::spawn(&mut cmd) {
        Ok(child) => Arc::new(child),
        Err(e) => {
            return Usage {
                fetched_at: now_secs(),
                error: Some(format!("无法启动 claude：{e}")),
                ..Usage::default()
            }
        }
    };
    let process_job = match crate::modules::proc::job::ProcessJob::create_for(child.id()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Usage {
                fetched_at: now_secs(),
                error: Some(format!("无法管理 claude 进程：{error}")),
                ..Usage::default()
            };
        }
    };
    let stdout = child.take_stdout();
    let stderr = child.take_stderr();
    let out_handle = thread::spawn(move || stdout.map(|mut p| drain(&mut p)).unwrap_or_default());
    let err_handle = thread::spawn(move || stderr.map(|mut p| drain(&mut p)).unwrap_or_default());

    let (tx, rx) = mpsc::channel();
    let waiter = Arc::clone(&child);
    thread::spawn(move || {
        let _ = tx.send(waiter.wait());
    });
    let waited = rx.recv_timeout(TIMEOUT);
    drop(process_job);
    let timed_out = match waited {
        Ok(Ok(_)) => false,
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            true
        }
    };

    let raw = String::from_utf8_lossy(&out_handle.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_handle.join().unwrap_or_default()).into_owned();
    let (session, weeks) = parse(&raw);
    let error = if timed_out {
        Some("查询超时".to_string())
    } else if session.is_none() && weeks.is_empty() {
        // Nothing recognizable came back. Prefer the tool's own complaint.
        Some(match stderr.trim() {
            "" => "未能从 claude 的输出中解析出用量".to_string(),
            message => message.chars().take(300).collect(),
        })
    } else {
        None
    };
    Usage {
        session,
        weeks,
        raw: if raw.trim().is_empty() { stderr } else { raw },
        fetched_at: now_secs(),
        error,
    }
}

/// Tauri command: the subscription's current limit usage.
///
/// `force` bypasses the refetch floor for an explicit refresh. Without it a
/// cached answer younger than `MIN_REFETCH` is returned untouched.
#[tauri::command]
pub async fn claude_usage(force: Option<bool>) -> Usage {
    let force = force.unwrap_or(false);
    if !force {
        if let Some((usage, at)) = cache().lock().expect("usage cache").as_ref() {
            if at.elapsed() < MIN_REFETCH {
                return usage.clone();
            }
        }
    }
    let usage = tauri::async_runtime::spawn_blocking(fetch)
        .await
        .unwrap_or_else(|e| Usage {
            fetched_at: now_secs(),
            error: Some(format!("查询任务失败：{e}")),
            ..Usage::default()
        });
    // A failure is not worth caching: the next open should try again rather
    // than show the same error for five minutes.
    if usage.error.is_none() {
        *cache().lock().expect("usage cache") = Some((usage.clone(), Instant::now()));
    }
    usage
}

/// The cached answer without ever spawning anything, for first paint.
#[tauri::command]
pub fn claude_usage_cached() -> Option<Usage> {
    cache()
        .lock()
        .expect("usage cache")
        .as_ref()
        .map(|(usage, _)| usage.clone())
}

/// Codex's subscription rate-limit windows. Unlike Claude Code, Codex exposes
/// these through its local app-server JSON-RPC protocol, including exact reset
/// timestamps, so no transcript or auth file needs to be read.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageWindow {
    pub used_percent: Option<u32>,
    pub resets_at: Option<i64>,
    pub window_duration_mins: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    pub primary: Option<CodexUsageWindow>,
    pub secondary: Option<CodexUsageWindow>,
    pub plan_type: Option<String>,
    pub fetched_at: i64,
    pub error: Option<String>,
}

fn codex_cache() -> &'static Mutex<Option<(CodexUsage, Instant)>> {
    static CACHE: std::sync::OnceLock<Mutex<Option<(CodexUsage, Instant)>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn codex_window(value: Option<&Value>) -> Option<CodexUsageWindow> {
    let value = value?;
    Some(CodexUsageWindow {
        used_percent: value
            .get("usedPercent")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
        resets_at: value.get("resetsAt").and_then(Value::as_i64),
        window_duration_mins: value.get("windowDurationMins").and_then(Value::as_i64),
    })
}

fn codex_usage_from_response(response: &Value) -> Result<CodexUsage, String> {
    if let Some(error) = response.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Codex 拒绝读取用量")
            .to_string());
    }
    let result = response
        .get("result")
        .ok_or_else(|| "Codex 没有返回用量结果".to_string())?;
    // Newer Codex versions may return several buckets. Prefer the canonical
    // `codex` bucket and retain the single-bucket response as a compatibility
    // fallback for older clients.
    let limits = result
        .pointer("/rateLimitsByLimitId/codex")
        .or_else(|| result.get("rateLimits"))
        .ok_or_else(|| "Codex 返回的用量结果缺少额度窗口".to_string())?;
    Ok(CodexUsage {
        primary: codex_window(limits.get("primary")),
        secondary: codex_window(limits.get("secondary")),
        plan_type: limits
            .get("planType")
            .and_then(Value::as_str)
            .map(str::to_string),
        fetched_at: now_secs(),
        error: None,
    })
}

/// Ask one short-lived Codex app-server instance for its account rate limits.
/// It is deliberately not reused: the terminal runs Codex independently, and
/// this request must neither attach to nor alter that interactive session.
fn fetch_codex() -> CodexUsage {
    let mut command = if cfg!(windows) {
        // npm installs Codex as `codex.cmd` on Windows. Executing that shim
        // directly preserves stdin/stdout JSON-RPC pipes (unlike a shell).
        Command::new("codex.cmd")
    } else {
        Command::new("codex")
    };
    command
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return CodexUsage {
                fetched_at: now_secs(),
                error: Some(format!("无法启动 codex app-server：{error}")),
                ..CodexUsage::default()
            }
        }
    };
    let process_job = match crate::modules::proc::job::ProcessJob::create_for(child.id()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return CodexUsage {
                fetched_at: now_secs(),
                error: Some(format!("无法管理 codex app-server 进程：{error}")),
                ..CodexUsage::default()
            };
        }
    };
    let Some(mut stdin) = child.stdin.take() else {
        process_job.terminate();
        let _ = child.kill();
        let _ = child.wait();
        return CodexUsage {
            fetched_at: now_secs(),
            error: Some("无法打开 codex app-server 的输入流".to_string()),
            ..CodexUsage::default()
        };
    };
    let Some(stdout) = child.stdout.take() else {
        process_job.terminate();
        let _ = child.kill();
        let _ = child.wait();
        return CodexUsage {
            fetched_at: now_secs(),
            error: Some("无法打开 codex app-server 的输出流".to_string()),
            ..CodexUsage::default()
        };
    };
    let stderr = child.stderr.take();

    let initialize = json!({
        "id": 1,
        "method": "initialize",
        "params": { "clientInfo": { "name": "awei-work", "version": env!("CARGO_PKG_VERSION") } }
    });
    let read_limits = json!({
        "id": 2,
        "method": "account/rateLimits/read",
        "params": { "excludeResetCreditDetails": true, "supportsLunaReserve": false }
    });
    let write_result = (|| -> Result<(), String> {
        serde_json::to_writer(&mut stdin, &initialize).map_err(|error| error.to_string())?;
        stdin.write_all(b"\n").map_err(|error| error.to_string())?;
        stdin.flush().map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut stdin, &read_limits).map_err(|error| error.to_string())?;
        stdin.write_all(b"\n").map_err(|error| error.to_string())?;
        stdin.flush().map_err(|error| error.to_string())
    })();
    if let Err(error) = write_result {
        drop(stdin);
        process_job.terminate();
        let _ = child.kill();
        let _ = child.wait();
        return CodexUsage {
            fetched_at: now_secs(),
            error: Some(format!("无法向 codex app-server 发送查询：{error}")),
            ..CodexUsage::default()
        };
    }

    let (tx, rx) = mpsc::sync_channel(1);
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("id").and_then(Value::as_i64) == Some(2) {
                let _ = tx.send(codex_usage_from_response(&value));
                break;
            }
        }
    });
    let stderr_reader =
        stderr.map(|stderr| thread::spawn(move || drain(&mut BufReader::new(stderr))));
    let result = rx.recv_timeout(TIMEOUT);
    // The app-server is only a read probe. End it immediately after the one
    // response so it cannot outlive awei-work or compete with an open Codex TUI.
    drop(stdin);
    process_job.terminate();
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    let stderr = stderr_reader
        .and_then(|reader| reader.join().ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();

    match result {
        Ok(Ok(usage)) => usage,
        Ok(Err(error)) => CodexUsage {
            fetched_at: now_secs(),
            error: Some(error),
            ..CodexUsage::default()
        },
        Err(_) => CodexUsage {
            fetched_at: now_secs(),
            error: Some(if stderr.trim().is_empty() {
                "查询 Codex 用量超时或未返回结果".to_string()
            } else {
                stderr.chars().take(300).collect()
            }),
            ..CodexUsage::default()
        },
    }
}

/// Tauri command: current Codex subscription limit usage.
#[tauri::command]
pub async fn codex_usage(force: Option<bool>) -> CodexUsage {
    let force = force.unwrap_or(false);
    if !force {
        if let Some((usage, at)) = codex_cache().lock().expect("codex usage cache").as_ref() {
            if at.elapsed() < MIN_REFETCH {
                return usage.clone();
            }
        }
    }
    let usage = tauri::async_runtime::spawn_blocking(fetch_codex)
        .await
        .unwrap_or_else(|error| CodexUsage {
            fetched_at: now_secs(),
            error: Some(format!("Codex 用量查询任务失败：{error}")),
            ..CodexUsage::default()
        });
    if usage.error.is_none() {
        *codex_cache().lock().expect("codex usage cache") = Some((usage.clone(), Instant::now()));
    }
    usage
}

/// The cached Codex answer without starting the app-server.
#[tauri::command]
pub fn codex_usage_cached() -> Option<CodexUsage> {
    codex_cache()
        .lock()
        .expect("codex usage cache")
        .as_ref()
        .map(|(usage, _)| usage.clone())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgyQuotaWindow {
    percent: Option<u32>,
    resets_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgyQuotaGroup {
    name: String,
    five_hour: Option<AgyQuotaWindow>,
    week: Option<AgyQuotaWindow>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgyUsage {
    groups: Vec<AgyQuotaGroup>,
    fetched_at: i64,
    error: Option<String>,
}

fn agy_cache() -> &'static Mutex<Option<(AgyUsage, Instant)>> {
    static CACHE: std::sync::OnceLock<Mutex<Option<(AgyUsage, Instant)>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn agy_quota_window(buckets: &[Value], period: &str) -> Option<AgyQuotaWindow> {
    let bucket = buckets.iter().find(|bucket| bucket["window"] == period)?;
    let remaining = bucket["remaining_fraction"]
        .as_f64()
        .filter(|value| (0.0..=1.0).contains(value));
    Some(AgyQuotaWindow {
        percent: remaining.map(|value| ((1.0 - value) * 100.0).round() as u32),
        resets_at: bucket["reset_time"].as_str().map(str::to_owned),
    })
}

fn parse_agy_usage(output: &str) -> Result<Vec<AgyQuotaGroup>, String> {
    let value: Value = serde_json::from_str(output).map_err(|_| "无法解析 agy 用量输出")?;
    if value["status"] != "SUCCESS"
        || value["command"]["name"] != "usage"
        || value["num_turns"].as_u64() != Some(0)
    {
        return Err("agy 未返回只读用量结果，请确认已登录并更新 CLI".into());
    }
    let raw = value["command"]["data"]["groups"]
        .as_array()
        .ok_or("agy 未返回额度分组")?;
    let groups: Vec<_> = raw
        .iter()
        .filter_map(|group| {
            let name = group["name"].as_str()?;
            let buckets = group["buckets"].as_array()?;
            let five_hour = agy_quota_window(buckets, "5h");
            let week = agy_quota_window(buckets, "weekly");
            (five_hour.is_some() || week.is_some()).then(|| AgyQuotaGroup {
                name: name.to_owned(),
                five_hour,
                week,
            })
        })
        .collect();
    if groups.is_empty() {
        return Err("agy 未返回 5 小时或周额度".into());
    }
    Ok(groups)
}

fn fetch_agy() -> Result<Vec<AgyQuotaGroup>, String> {
    let executable = crate::modules::pty::shell_init::agy_executable()
        .ok_or("找不到 Antigravity CLI，请先安装并登录 agy")?;
    let mut cmd = portable_pty::CommandBuilder::new(executable);
    cmd.cwd(std::env::temp_dir());
    cmd.env("NO_COLOR", "1");
    cmd.args([
        "--print",
        "/usage",
        "--output-format",
        "json",
        "--print-timeout",
        "15s",
    ]);
    let output = crate::modules::pty::capture_console(cmd, Duration::from_secs(20))
        .map_err(|_| "读取 Antigravity 用量失败，请确认 agy 已登录并可运行 /usage")?;
    let json = output
        .find('{')
        .zip(output.rfind('}'))
        .and_then(|(start, end)| output.get(start..=end))
        .ok_or("agy 未返回用量 JSON")?;
    parse_agy_usage(json)
}

#[tauri::command]
pub async fn agy_usage(force: Option<bool>) -> AgyUsage {
    if !force.unwrap_or(false) {
        if let Some((usage, at)) = agy_cache().lock().expect("agy usage cache").as_ref() {
            if at.elapsed() < MIN_REFETCH {
                return usage.clone();
            }
        }
    }
    let fetched = tauri::async_runtime::spawn_blocking(fetch_agy)
        .await
        .map_err(|_| "Antigravity 用量查询任务失败".to_string())
        .and_then(std::convert::identity);
    match fetched {
        Ok(groups) => {
            let usage = AgyUsage {
                groups,
                fetched_at: now_secs(),
                error: None,
            };
            *agy_cache().lock().expect("agy usage cache") = Some((usage.clone(), Instant::now()));
            usage
        }
        Err(error) => AgyUsage {
            fetched_at: now_secs(),
            error: Some(error),
            ..AgyUsage::default()
        },
    }
}

#[tauri::command]
pub fn agy_usage_cached() -> Option<AgyUsage> {
    agy_cache()
        .lock()
        .expect("agy usage cache")
        .as_ref()
        .map(|(usage, _)| usage.clone())
}
