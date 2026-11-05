pub mod code;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Manager, WebviewWindow};

#[derive(Default)]
pub struct EntryState {
    programs: Mutex<HashMap<String, Instant>>,
    code: code::CodeState,
}
impl EntryState {
    pub fn stop(&self) {
        self.code.stop();
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebStep {
    pub action: String,
    pub target: String,
    pub source: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub when: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SpecialEntry {
    Web {
        id: String,
        name: String,
        url: String,
        username: String,
        remember: bool,
        steps: Vec<WebStep>,
    },
    Program {
        id: String,
        name: String,
        program: String,
        args: Vec<String>,
    },
    Code {
        id: String,
        name: String,
        script_path: String,
        username: String,
        password_mode: String,
    },
}
pub fn web_url(value: &str) -> Result<tauri::Url, String> {
    if value.len() > 8192 || value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("Invalid website URL".into());
    }
    let url = tauri::Url::parse(value).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || matches!(
            url.host_str().unwrap_or("").trim_end_matches('.'),
            "tauri.localhost" | "asset.localhost" | "ipc.localhost"
        )
    {
        return Err("Only external HTTP/HTTPS websites are supported".into());
    }
    Ok(url)
}
fn valid_text(value: &str, max: usize, empty: bool) -> bool {
    value.len() <= max
        && (empty || !value.trim().is_empty())
        && !value.chars().any(char::is_control)
}
pub(super) fn launch_program(program: String, args: Vec<String>) -> Result<(), String> {
    SpecialEntry::Program {
        id: "code-launch".into(),
        name: "Program".into(),
        program: program.clone(),
        args: args.clone(),
    }
    .validate()?;
    let path = std::fs::canonicalize(program).map_err(|e| e.to_string())?;
    if !path.is_file() {
        return Err("Program path is not a file".into());
    }
    let mut command = std::process::Command::new(&path);
    command.args(args.into_iter().filter(|arg| !arg.is_empty()));
    if let Some(parent) = path.parent() {
        command.current_dir(parent);
    }
    crate::modules::proc::hide_console(&mut command);
    command.spawn().map_err(|e| e.to_string())?;
    Ok(())
}
impl SpecialEntry {
    pub fn id(&self) -> &str {
        match self {
            Self::Web { id, .. } | Self::Program { id, .. } | Self::Code { id, .. } => id,
        }
    }
    fn validate(&self) -> Result<(), String> {
        let id = self.id();
        if id.is_empty()
            || id.len() > 100
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("Invalid connection identifier".into());
        }
        let name = match self {
            Self::Web { name, .. } | Self::Program { name, .. } | Self::Code { name, .. } => name,
        };
        if !valid_text(name, 1024, false) {
            return Err("Invalid connection name".into());
        }
        match self {
            Self::Code {
                script_path,
                username,
                password_mode,
                ..
            } => {
                code::script_path(script_path)?;
                if !valid_text(username, 1024, true)
                    || !matches!(password_mode.as_str(), "none" | "saved" | "ask")
                {
                    return Err("Invalid code connection configuration".into());
                }
            }
            Self::Web {
                url,
                username,
                steps,
                ..
            } => {
                web_url(url)?;
                if !valid_text(username, 1024, true) || steps.len() > 32 {
                    return Err("Invalid website configuration".into());
                }
                for step in steps {
                    if !matches!(
                        step.action.as_str(),
                        "fill" | "click" | "wait" | "select" | "press" | "captcha"
                    ) || !valid_text(&step.target, 8192, false)
                        || !valid_text(&step.when, 8192, true)
                        || !matches!(step.source.as_str(), "text" | "username" | "password")
                        || !valid_text(&step.value, 16384, true)
                        || (step.source != "text"
                            && (step.action != "fill" || !step.value.is_empty()))
                        || (step.action == "press"
                            && !matches!(
                                step.value.as_str(),
                                "Enter" | "Tab" | "Escape" | "ArrowDown" | "ArrowUp"
                            ))
                        || (step.action == "captcha" && !valid_text(&step.value, 8192, false))
                    {
                        return Err("Invalid website action".into());
                    }
                }
            }
            Self::Program { program, args, .. } => {
                if !valid_text(program, 8192, false)
                    || !PathBuf::from(program).is_absolute()
                    || !program.to_ascii_lowercase().ends_with(".exe")
                    || args.len() > 100
                    || args.iter().any(|arg| !valid_text(arg, 8192, true))
                    || args
                        .iter()
                        .map(|arg| arg.encode_utf16().count() + 3)
                        .sum::<usize>()
                        + program.encode_utf16().count()
                        > 24000
                {
                    return Err("Use an absolute .exe path and valid launch arguments".into());
                }
            }
        }
        Ok(())
    }
}
#[tauri::command]
pub async fn ssh_open_special(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, EntryState>,
    entry: SpecialEntry,
    secret: Option<String>,
) -> Result<Option<String>, String> {
    super::main_only(&window)?;
    entry.validate()?;
    if secret.as_ref().is_some_and(|value| value.len() > 5000) {
        return Err("Login password is too long".into());
    }
    match entry {
        entry @ SpecialEntry::Code { .. } => code::start(app, entry, secret).await.map(Some),
        SpecialEntry::Program {
            id, program, args, ..
        } => {
            {
                let mut recent = state.programs.lock().unwrap();
                if recent
                    .get(&id)
                    .is_some_and(|last| last.elapsed().as_millis() < 1000)
                {
                    return Ok(None);
                }
                recent.retain(|_, last| last.elapsed().as_secs() < 60);
                recent.insert(id, Instant::now());
            }
            crate::modules::fs::blocking(move || {
                launch_program(program, args)?;
                Ok(None)
            })
            .await
        }
        SpecialEntry::Web { .. } => Err("Browser connections have been removed".into()),
    }
}
#[tauri::command]
pub async fn ssh_cancel_special(
    window: WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    super::main_only(&window)?;
    let state = app.state::<EntryState>();
    state.code.cancel(&id);
    Ok(())
}
