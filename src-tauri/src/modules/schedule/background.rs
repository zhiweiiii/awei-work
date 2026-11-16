use super::{Job, ScheduleState, Target};
use crate::modules::proc::background;
use std::process::Command;
use std::time::Duration;
use tauri::Manager;

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
    command.current_dir(directory);
    background::run(
        &mut command,
        job.command.clone(),
        Duration::from_secs(30 * 60),
        || {
            !app.state::<ScheduleState>()
                .jobs
                .lock()
                .unwrap()
                .iter()
                .any(|item| item.id == job.id)
        },
    )
}
