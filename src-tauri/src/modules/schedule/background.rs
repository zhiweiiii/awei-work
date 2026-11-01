use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::Manager;

use super::{Job, ScheduleState, Target};
use crate::modules::proc::{hide_console, job::ProcessJob};

fn capture(mut pipe: impl Read) -> String {
    let mut output = Vec::new();
    let mut buffer = [0; 4096];
    while let Ok(count) = pipe.read(&mut buffer) {
        if count == 0 {
            break;
        }
        let keep = count.min(16384usize.saturating_sub(output.len()));
        output.extend_from_slice(&buffer[..keep]);
    }
    String::from_utf8_lossy(&output).trim().to_string()
}

pub(super) fn run(app: &tauri::AppHandle, job: &Job) -> Result<String, String> {
    let executable = match job.target {
        Target::Codex => which::which("codex.exe").or_else(|_| which::which("codex.cmd")),
        Target::Claude => which::which("claude.exe").or_else(|_| which::which("claude.cmd")),
        Target::Terminal | Target::Pet => return Err("invalid background target".into()),
    }
    .map_err(|e| format!("找不到程序，请先安装并登录对应 CLI：{e}"))?;
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("scheduled-agent");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let mut command = Command::new(executable);
    match job.target {
        Target::Codex => {
            command.args(["exec", "--skip-git-repo-check", "--color", "never", "-"]);
        }
        Target::Claude => {
            command.args(["-p", "--output-format", "text"]);
        }
        Target::Terminal | Target::Pet => unreachable!(),
    }
    command
        .current_dir(directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let process_job = match ProcessJob::create_for(child.id()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
    };
    let mut stdin = child.stdin.take().ok_or("missing stdin")?;
    let prompt = job.command.clone();
    let input = std::thread::spawn(move || stdin.write_all(prompt.as_bytes()));
    let stdout = child.stdout.take().ok_or("missing stdout")?;
    let stderr = child.stderr.take().ok_or("missing stderr")?;
    let output = std::thread::spawn(move || capture(stdout));
    let errors = std::thread::spawn(move || capture(stderr));
    let started = Instant::now();
    let status = loop {
        let exists = app
            .state::<ScheduleState>()
            .jobs
            .lock()
            .unwrap()
            .iter()
            .any(|j| j.id == job.id);
        if !exists {
            break Err("任务已取消".to_string());
        }
        if started.elapsed() > Duration::from_secs(30 * 60) {
            break Err("执行超过 30 分钟，已停止".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(error) => break Err(error.to_string()),
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
        }
    };
    drop(process_job);
    let _ = child.wait();
    let input = input.join().map_err(|_| "input worker failed")?;
    let output = output.join().map_err(|_| "output worker failed")?;
    let errors = errors.join().map_err(|_| "error worker failed")?;
    let status = status?;
    if !status.success() {
        return Err(format!("{status}: {errors}"));
    }
    input.map_err(|e| e.to_string())?;
    Ok(output)
}
