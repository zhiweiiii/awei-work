use super::SpecialEntry;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, WebviewWindow};

fn nonce() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn write_if_changed(path: PathBuf, value: &[u8]) -> Result<(), String> {
    if std::fs::read(&path).ok().as_deref() == Some(value) {
        return Ok(());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing script directory")?)
            .map_err(|e| e.to_string())?;
    temporary.write_all(value).map_err(|e| e.to_string())?;
    temporary.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
const LIMIT: usize = 256 * 1024;
const TEMPLATE: &str = "export default async ({ log }) => {\n  log('Ready');\n};\n";
#[derive(Default)]
pub(super) struct CodeState {
    runs: Mutex<HashMap<String, Run>>,
    writes: Mutex<()>,
}
struct Run {
    task: String,
    cancelled: Arc<AtomicBool>,
    message: String,
}
impl CodeState {
    pub(super) fn stop(&self) {
        for run in self.runs.lock().unwrap().values() {
            run.cancelled.store(true, Ordering::Relaxed);
        }
    }
    pub(super) fn cancel(&self, id: &str) {
        if let Some(run) = self.runs.lock().unwrap().get(id) {
            run.cancelled.store(true, Ordering::Relaxed);
        }
    }
}
pub(super) fn script_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute()
        || !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mjs"))
        || path.as_os_str().len() > 8192
    {
        return Err("请使用 .mjs 脚本的完整路径".into());
    }
    Ok(path)
}
fn default_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty()
        || id.len() > 100
        || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("Invalid connection identifier".into());
    }
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("connection-scripts");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    write_if_changed(
        directory.join("AWEI-CODE.md"),
        include_bytes!("../../../../../docs/connection-code.md"),
    )?;
    Ok(directory.join(format!("{id}.mjs")))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    path: String,
    source: String,
    hash: Option<String>,
}
fn read(path: PathBuf) -> Result<Document, String> {
    let mut bytes = Vec::new();
    match std::fs::File::open(&path) {
        Ok(file) => {
            file.take((LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Document {
                path: crate::modules::fs::to_canon(&path),
                source: TEMPLATE.into(),
                hash: None,
            })
        }
        Err(error) => return Err(error.to_string()),
    }
    if bytes.len() > LIMIT {
        return Err("脚本不能超过 256 KiB".into());
    }
    let hash = Some(format!("{:x}", Sha256::digest(&bytes)));
    let source = String::from_utf8(bytes).map_err(|_| "脚本需使用 UTF-8 编码")?;
    Ok(Document {
        path: crate::modules::fs::to_canon(&path),
        source,
        hash,
    })
}
#[tauri::command]
pub async fn ssh_code_read(
    window: WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    path: Option<String>,
) -> Result<Document, String> {
    super::super::main_only(&window)?;
    crate::modules::fs::blocking(move || {
        read(match path {
            Some(path) => script_path(&path)?,
            None => default_path(&app, &id)?,
        })
    })
    .await
}
#[tauri::command]
pub async fn ssh_code_write(
    window: WebviewWindow,
    app: tauri::AppHandle,
    path: String,
    source: String,
    expected_hash: Option<String>,
) -> Result<Document, String> {
    super::super::main_only(&window)?;
    crate::modules::fs::blocking(move || {
        let state = app.state::<super::EntryState>();
        let _guard = state.code.writes.lock().unwrap();
        let path = script_path(&path)?;
        if source.len() > LIMIT || source.trim().is_empty() {
            return Err("脚本不能为空且不能超过 256 KiB".into());
        }
        if read(path.clone())?.hash != expected_hash {
            return Err("脚本已被 agent 或其他程序修改，请先重新读取，未覆盖文件".into());
        }
        std::fs::create_dir_all(path.parent().ok_or("Missing script directory")?)
            .map_err(|e| e.to_string())?;
        let mut file =
            tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
        file.write_all(source.as_bytes())
            .map_err(|e| e.to_string())?;
        if read(path.clone())?.hash != expected_hash {
            return Err("脚本在保存期间发生变化，未覆盖文件".into());
        }
        if expected_hash.is_none() {
            file.persist_noclobber(&path).map_err(|e| e.to_string())?;
        } else {
            file.persist(&path).map_err(|e| e.to_string())?;
        }
        read(path)
    })
    .await
}
#[tauri::command]
pub async fn ssh_code_migrate(
    window: WebviewWindow,
    app: tauri::AppHandle,
    entry: Value,
) -> Result<Value, String> {
    super::super::main_only(&window)?;
    crate::modules::fs::blocking(move || {
        let parsed: SpecialEntry = serde_json::from_value(entry.clone()).map_err(|e| e.to_string())?;
        parsed.validate()?;
        let id = parsed.id().to_string();
        let (source, username, mode) = match &parsed {
            SpecialEntry::Web { username, remember, .. } => (
                "export default async () => {\n  throw new Error('Browser connections have been removed. Edit this script to use Node.js or launch().');\n};\n".to_string(),
                username.clone(), if *remember { "saved" } else { "none" }),
            SpecialEntry::Program { program, args, .. } => (format!("export default async ({{ launch }}) => {{\n  await launch({}, {});\n}};\n", json!(program), json!(args)), String::new(), "none"),
            _ => return Err("Only legacy website/program entries need conversion".into()),
        };
        let path = default_path(&app, &id)?;
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
        temporary.write_all(source.as_bytes()).map_err(|e| e.to_string())?;
        match temporary.persist_noclobber(&path) {
            Ok(_) => {},
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {},
            Err(error) => return Err(error.to_string()),
        }
        read(path.clone())?;
        Ok(json!({"kind":"code","id":id,"name":entry["name"],"groupId":entry["groupId"],"scriptPath":crate::modules::fs::to_canon(path),"username":username,"passwordMode":mode,"legacyEntry":entry}))
    }).await
}
fn emit(app: &tauri::AppHandle, id: &str, task: &str, phase: &str, message: &str) {
    if let Some(run) = app
        .state::<super::EntryState>()
        .code
        .runs
        .lock()
        .unwrap()
        .get_mut(id)
    {
        if run.task == task {
            run.message = message.into();
        }
    }
    let _ = app.emit_to(
        "main",
        "ssh:code-task",
        json!({"id":id,"taskId":task,"phase":phase,"message":message}),
    );
}
#[tauri::command]
pub fn ssh_code_status(window: WebviewWindow, app: tauri::AppHandle) -> Result<Value, String> {
    super::super::main_only(&window)?;
    Ok(json!(app
        .state::<super::EntryState>()
        .code
        .runs
        .lock()
        .unwrap()
        .iter()
        .map(|(id, run)| json!({"id":id,"taskId":run.task,"phase":"running","message":run.message}))
        .collect::<Vec<_>>()))
}
pub(super) async fn start(
    app: tauri::AppHandle,
    entry: SpecialEntry,
    secret: Option<String>,
) -> Result<String, String> {
    let task = nonce()?;
    let id = entry.id().to_string();
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<super::EntryState>();
        let mut runs = state.code.runs.lock().unwrap();
        if let Some(run) = runs.get(&id) {
            return Ok(run.task.clone());
        }
        if runs.len() >= 4 {
            return Err("最多同时执行 4 个动态脚本".into());
        }
        runs.insert(
            id.clone(),
            Run {
                task: task.clone(),
                cancelled: cancelled.clone(),
                message: "正在执行脚本".into(),
            },
        );
    }
    emit(&app, &id, &task, "queued", "正在执行脚本");
    let running_task = task.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = run(&app, entry, secret, &cancelled, &running_task);
        let phase = if cancelled.load(Ordering::Relaxed) {
            "cancelled"
        } else if result.is_ok() {
            "done"
        } else {
            "failed"
        };
        let message = result.err().unwrap_or_else(|| "脚本执行完成".into());
        app.state::<super::EntryState>()
            .code
            .runs
            .lock()
            .unwrap()
            .remove(&id);
        emit(&app, &id, &running_task, phase, &message);
    });
    Ok(task)
}
fn run(
    app: &tauri::AppHandle,
    entry: SpecialEntry,
    secret: Option<String>,
    cancelled: &AtomicBool,
    task: &str,
) -> Result<(), String> {
    let SpecialEntry::Code {
        id,
        name: _,
        script_path: path,
        username,
        password_mode,
    } = entry
    else {
        return Err("Not a code entry".into());
    };
    let path = std::fs::canonicalize(script_path(&path)?).map_err(|e| e.to_string())?;
    if read(path.clone())?.hash.is_none() {
        return Err("脚本文件不存在".into());
    }
    let password = match password_mode.as_str() {
        "saved" => super::super::credentials::read(&id)?.unwrap_or_default(),
        "ask" => secret.unwrap_or_default(),
        _ => String::new(),
    };
    if password_mode != "none" && password.is_empty() {
        return Err("请提供登录密码，或将密码设置改为不使用".into());
    }
    let redact = |value: &str| {
        if password.is_empty() {
            value.to_string()
        } else {
            value.replace(&password, "[redacted]")
        }
    };
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("connection-scripts");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let mut runner = tempfile::Builder::new()
        .prefix(".runner-")
        .suffix(".mjs")
        .tempfile_in(directory)
        .map_err(|e| e.to_string())?;
    runner
        .write_all(include_bytes!("code-runner.mjs"))
        .map_err(|e| e.to_string())?;
    let node = which::which("node.exe")
        .map_err(|_| "未找到 Node.js，请安装 Node.js 22 或更新版本并重启应用")?;
    let mut command = Command::new(node);
    command
        .args(["--unhandled-rejections=strict"])
        .arg(runner.path())
        .arg(&path)
        .current_dir(path.parent().unwrap())
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut command);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let job = match crate::modules::proc::job::ProcessJob::create_for(child.id()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
    };
    let mut stdin = child.stdin.take().ok_or("Missing script stdin")?;
    let prefix = format!("@AWEI:{task}:");
    let output = child.stdout.take().ok_or("Missing script stdout")?;
    let errors = child.stderr.take().ok_or("Missing script stderr")?;
    let (send, receive) = std::sync::mpsc::sync_channel(32);
    let output_thread = std::thread::spawn(move || {
        let mut pipe = output;
        let mut chunk = [0u8; 4096];
        let mut line = Vec::new();
        let mut overflow = false;
        while let Ok(size) = pipe.read(&mut chunk) {
            if size == 0 {
                break;
            }
            for byte in &chunk[..size] {
                if *byte == b'\n' {
                    if !overflow && send.send(std::mem::take(&mut line)).is_err() {
                        return;
                    }
                    line.clear();
                    overflow = false;
                } else if line.len() < LIMIT * 2 && !overflow {
                    line.push(*byte);
                } else {
                    line.clear();
                    overflow = true;
                }
            }
        }
    });
    let error_thread = std::thread::spawn(move || {
        let mut pipe = errors;
        let mut kept = Vec::new();
        let mut buffer = [0u8; 4096];
        while let Ok(size) = pipe.read(&mut buffer) {
            if size == 0 {
                break;
            }
            let keep = size.min(16384usize.saturating_sub(kept.len()));
            kept.extend_from_slice(&buffer[..keep]);
        }
        kept
    });
    let result = (|| {
        writeln!(
            stdin,
            "{}",
            json!({"prefix":prefix,"username":username,"password":password})
        )
        .map_err(|e| e.to_string())?;
        let started = Instant::now();
        let mut last_log = None::<Instant>;
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err("脚本已停止".into());
            }
            if started.elapsed() > Duration::from_secs(300) {
                return Err("脚本执行超过 5 分钟，已停止".into());
            }
            match receive.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => {
                    let line = String::from_utf8_lossy(&line);
                    let Some(body) = line.strip_prefix(&prefix) else {
                        continue;
                    };
                    let Ok(message) = serde_json::from_str::<Value>(body) else {
                        continue;
                    };
                    match message["type"].as_str() {
                        Some("log")
                            if last_log.is_none_or(|last| {
                                last.elapsed() >= Duration::from_millis(250)
                            }) =>
                        {
                            last_log = Some(Instant::now());
                            emit(
                                app,
                                &id,
                                task,
                                "running",
                                &redact(message["message"].as_str().unwrap_or(""))
                                    .chars()
                                    .take(4000)
                                    .collect::<String>(),
                            );
                        }
                        Some("done") => return Ok(()),
                        Some("failed") => {
                            return Err(redact(
                                message["message"].as_str().unwrap_or("脚本执行失败"),
                            ));
                        }
                        Some("request") => {
                            let value = operation(&message);
                            let reply = match value {
                                Ok(value) => json!({"id":message["id"],"value":value}),
                                Err(error) => json!({"id":message["id"],"error":redact(&error)}),
                            };
                            writeln!(stdin, "{reply}").map_err(|e| e.to_string())?;
                        }
                        _ => {}
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("脚本异常退出，未收到完成信号".into());
                }
            }
        }
    })();
    drop(job);
    let _ = child.kill();
    let _ = child.wait();
    drop(stdin);
    drop(receive);
    let _ = output_thread.join();
    let errors = error_thread.join().unwrap_or_default();
    result.map_err(|error| {
        if errors.is_empty() {
            error
        } else {
            format!("{error}\n{}", redact(&String::from_utf8_lossy(&errors)))
        }
    })
}
fn operation(message: &Value) -> Result<Value, String> {
    let args = &message["args"];
    match message["method"].as_str() {
        Some("launch") => {
            let program = args["program"]
                .as_str()
                .ok_or("Missing program path")?
                .to_string();
            let args = serde_json::from_value(args["args"].clone()).map_err(|e| e.to_string())?;
            super::launch_program(program, args)?;
            Ok(Value::Null)
        }
        _ => Err("Unknown script operation".into()),
    }
}
