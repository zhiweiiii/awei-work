use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::{hide_console, job::ProcessJob};

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

pub fn run(
    command: &mut Command,
    prompt: String,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<String, String> {
    run_with_output(command, prompt, timeout, cancelled, capture)
}

pub(crate) fn run_with_output<T: Send + 'static>(
    command: &mut Command,
    prompt: String,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
    capture_output: impl FnOnce(std::process::ChildStdout) -> T + Send + 'static,
) -> Result<T, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(command);
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
    let input = std::thread::spawn(move || stdin.write_all(prompt.as_bytes()));
    let stdout = child.stdout.take().ok_or("missing stdout")?;
    let stderr = child.stderr.take().ok_or("missing stderr")?;
    let output = std::thread::spawn(move || capture_output(stdout));
    let errors = std::thread::spawn(move || capture(stderr));
    let started = Instant::now();
    let status = loop {
        if cancelled() {
            break Err("任务已取消".to_string());
        }
        if started.elapsed() > timeout {
            break Err("后台执行超时，已停止".to_string());
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
