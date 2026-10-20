pub mod modules;

use modules::{
    fs, gateway, git, history, lsp, pty, schedule, sessions, shell, usage, web, workspace,
};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

/// Drained on first read so HMR / re-mounts can't replay the launch dir.
#[derive(Default)]
struct LaunchDir(Mutex<Option<String>>);

/// Drained on first read so HMR / re-mounts can't replay the launch files.
#[derive(Default)]
struct LaunchFiles(Mutex<Vec<String>>);

/// Drained on first read so HMR / re-mounts can't re-run the launch command.
#[derive(Default)]
struct LaunchCommand(Mutex<Option<String>>);

#[tauri::command]
fn get_launch_dir(state: State<'_, LaunchDir>) -> Option<String> {
    state.0.lock().expect("LaunchDir mutex poisoned").take()
}

#[tauri::command]
fn get_launch_files(state: State<'_, LaunchFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().expect("LaunchFiles mutex poisoned"))
}

#[tauri::command]
fn get_launch_command(state: State<'_, LaunchCommand>) -> Option<String> {
    state.0.lock().expect("LaunchCommand mutex poisoned").take()
}

enum LaunchEntry {
    Dir(PathBuf),
    File(PathBuf),
}

#[derive(Default, Debug, PartialEq)]
struct LaunchTarget {
    dir: Option<String>,
    files: Vec<String>,
}

/// First dir arg (else the first file's parent) becomes the workspace; every
/// file arg is opened. Kept free of fs/env access so it stays unit-testable.
fn resolve_launch_target(entries: Vec<LaunchEntry>) -> LaunchTarget {
    let mut dir = None;
    let mut files = Vec::new();
    for entry in entries {
        match entry {
            LaunchEntry::Dir(path) => {
                if dir.is_none() {
                    dir = Some(fs::to_canon(&path));
                }
            }
            LaunchEntry::File(path) => {
                if dir.is_none() {
                    dir = path.parent().map(fs::to_canon);
                }
                files.push(fs::to_canon(&path));
            }
        }
    }
    LaunchTarget { dir, files }
}

/// Roomy enough for a command that carries a prompt, still far under the OS
/// argv limit so a runaway caller can't push megabytes through startup.
const MAX_LAUNCH_COMMAND_CHARS: usize = 2048;

/// argv is a trust boundary: the command is typed into a PTY and followed by a
/// CR, so an embedded newline or escape byte would run something the caller
/// never sees. Reject rather than strip, so a mangled command never half-runs.
fn sanitize_launch_command(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_LAUNCH_COMMAND_CHARS {
        return None;
    }
    if trimmed.chars().any(char::is_control) {
        return None;
    }
    Some(trimmed.to_string())
}

/// Splits argv into the optional `--run` command and the remaining path args.
/// The first `--run` wins and always consumes its value, so a rejected command
/// can't fall through and be treated as a path. `--` ends option parsing.
/// Kept free of fs/env access so it stays unit-testable.
fn split_launch_args(args: Vec<String>) -> (Option<String>, Vec<String>) {
    let mut command = None;
    let mut seen_run = false;
    let mut paths = Vec::new();
    let mut options = true;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if options {
            if arg == "--" {
                options = false;
                index += 1;
                continue;
            }
            if let Some(value) = arg.strip_prefix("--run=") {
                if !seen_run {
                    seen_run = true;
                    command = sanitize_launch_command(value);
                }
                index += 1;
                continue;
            }
            if arg == "--run" {
                if !seen_run {
                    seen_run = true;
                    command = args.get(index + 1).and_then(|v| sanitize_launch_command(v));
                }
                index += 2;
                continue;
            }
            if arg.starts_with('-') {
                index += 1;
                continue;
            }
        }
        paths.push(arg.clone());
        index += 1;
    }
    (command, paths)
}

fn parse_launch_target() -> (LaunchTarget, Option<String>) {
    let (command, paths) = split_launch_args(std::env::args().skip(1).collect());
    let entries = paths
        .into_iter()
        .filter_map(|arg| std::fs::canonicalize(arg).ok())
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok()?;
            Some(if meta.is_dir() {
                LaunchEntry::Dir(path)
            } else {
                LaunchEntry::File(path)
            })
        })
        .collect();
    (resolve_launch_target(entries), command)
}

#[tauri::command]
async fn open_settings_window(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    // Whitelist the known settings tabs: the value rides into the settings
    // URL, so anything else would produce a malformed/odd path.
    const KNOWN_TABS: [&str; 6] = [
        "general",
        "editor",
        "version-control",
        "themes",
        "shortcuts",
        "about",
    ];
    let safe_tab = tab.filter(|t| KNOWN_TABS.contains(&t.as_str()));
    let url_path = match safe_tab.as_deref() {
        Some(t) => format!("settings.html?tab={}", t),
        _ => "settings.html".to_string(),
    };

    // Reopening a window that is only hidden is instant. Building one is not:
    // it spins up a webview, parses the bundle and boots React before anything
    // appears, which is why opening settings used to lag behind the click.
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if let Some(t) = safe_tab.as_deref() {
            // emit() serializes via JSON, no string-escape footgun unlike
            // eval() with format!(). Frontend listens via Tauri event API.
            let _ = window.emit("terax:settings-tab", t);
        }
        return Ok(());
    }

    // A plain top-level window. It used to be built as a child of the main
    // window, which pinned it above the app: clicking back into the terminal
    // left settings floating over the work. Being independent is the point of
    // a settings window.
    let window = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url_path.into()))
        .title("Settings")
        .inner_size(900.0, 700.0)
        .min_inner_size(820.0, 620.0)
        .resizable(true)
        .visible(false)
        .decorations(false)
        .transparent(true)
        .build()
        .map_err(|e| e.to_string())?;

    // Closing hides instead of destroying, so every later open takes the fast
    // path above. Without this the handle survives the close but the native
    // window does not, and `show()` on it does nothing at all: settings would
    // simply stop opening until the app restarted.
    let hidden = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hidden.hide();
        }
    });

    Ok(())
}

/// Destroy the settings window for real. A hidden window still counts as an
/// open window, so leaving it around after the main window goes keeps the
/// process alive with nothing on screen.
fn close_settings_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.destroy();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (launch, launch_command) = parse_launch_target();
    let cli_dir = launch.dir.clone();
    workspace::init_launch_cwd(cli_dir.as_deref());

    let builder = tauri::Builder::default();
    builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Skip restoring VISIBLE — frontend calls window.show() after first
        // paint so the user never sees a transparent window-shadow flash on
        // Windows/Linux.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::default())
        .manage(fs::watch::FsWatchState::default())
        .manage(history::HistoryState::default())
        .manage(lsp::LspState::default())
        .manage(fs::grep::ContentSearchState::default())
        .manage(fs::search::FileSearchState::default())
        .manage(schedule::ScheduleState::default())
        .manage({
            let registry = workspace::WorkspaceRegistry::default();
            workspace::bootstrap_registry(&registry);
            if let Some(ref launch_dir) = cli_dir {
                let _ = registry.authorize(launch_dir);
            }
            registry
        })
        .manage(LaunchDir(Mutex::new(cli_dir)))
        .manage(LaunchFiles(Mutex::new(launch.files)))
        .manage(LaunchCommand(Mutex::new(launch_command)))
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_agent_session,
            sessions::agent_resume_command,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kick,
            pty::pty_close,
            pty::pty_close_all,
            pty::pty_has_foreground_process,
            pty::pty_has_foreground_job,
            pty::pty_shell_name,
            pty::pty_list_shells,
            schedule::schedule_add,
            schedule::schedule_add_at,
            schedule::schedule_list,
            schedule::schedule_cancel,
            schedule::schedule_rebind,
            pty::web_sync_tabs,
            pty::web_sync_spaces,
            pty::web_activate_leaf,
            web::web_status,
            web::web_snapshot_reply,
            web::web_set_password,
            web::web_has_custom_password,
            gateway::gateway_test_provider,
            sessions::agent_sessions,
            usage::claude_usage,
            usage::claude_usage_cached,
            usage::codex_usage,
            usage::codex_usage_cached,
            gateway::gateway_status,
            gateway::gateway_set_config,
            fs::tree::list_subdirs,
            fs::tree::fs_read_dir,
            fs::file::fs_read_file,
            fs::file::fs_write_file,
            fs::file::fs_stat,
            fs::file::fs_canonicalize,
            fs::clipboard::fs_save_clipboard_image,
            fs::clipboard::fs_clipboard_file_paths,
            fs::mutate::fs_create_file,
            fs::mutate::fs_create_dir,
            fs::mutate::fs_rename,
            fs::mutate::fs_delete,
            fs::mutate::fs_copy,
            fs::watch::fs_watch_add,
            fs::watch::fs_watch_remove,
            lsp::lsp_detect,
            lsp::lsp_host_pid,
            lsp::lsp_resolve_root,
            lsp::lsp_spawn,
            lsp::lsp_send,
            lsp::lsp_kill,
            fs::search::fs_search,
            fs::grep::fs_grep_interactive,
            git::commands::git_resolve_repo,
            git::commands::git_panel_snapshot,
            git::commands::git_status,
            git::commands::git_diff,
            git::commands::git_diff_content,
            git::commands::git_stage,
            git::commands::git_unstage,
            git::commands::git_discard,
            git::commands::git_commit,
            git::commands::git_fetch,
            git::commands::git_pull_ff_only,
            git::commands::git_push,
            git::commands::git_log,
            git::commands::git_log_file,
            git::commands::git_show_commit,
            git::commands::git_commit_files,
            git::commands::git_commit_file_diff,
            git::commands::git_remote_url,
            git::commands::git_list_branches,
            git::commands::git_checkout_branch,
            git::commands::git_scan_repos,
            git::commands::git_workspace_snapshot,
            git::commands::git_fetch_all,
            git::commands::git_commit_reword,
            git::commands::git_pre_commit_checks,
            git::commands::git_config_user,
            git::commands::git_create_branch,
            git::commands::git_rename_branch,
            git::commands::git_delete_branch,
            git::commands::git_merge,
            git::commands::git_rebase,
            git::commands::git_tag_create,
            git::commands::git_diff_with_ref,
            git::commands::git_compare_branches,
            git::commands::git_pull_advanced,
            git::commands::git_push_advanced,
            git::commands::git_push_up_to_commit,
            git::commands::git_remote_list,
            git::commands::git_remote_add,
            git::commands::git_remote_remove,
            git::commands::git_remote_set_url,
            git::commands::git_clone,
            git::commands::git_fetch_unshallow,
            git::commands::git_log_filtered,
            git::commands::git_reset,
            git::commands::git_revert_commit,
            git::commands::git_cherry_pick,
            git::commands::git_diff_range,
            git::commands::git_diff_commit_vs_worktree,
            git::commands::git_branches_containing,
            shell::shell_run_command,
            workspace::workspace_authorize,
            workspace::workspace_current_dir,
            get_launch_dir,
            get_launch_files,
            get_launch_command,
            open_settings_window,
            history::history_suggest,
            history::history_commands,
            history::history_record,
            history::history_list,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                // The settings window only hides on close, so the main window
                // going away has to take it with it or the process lingers
                // with no visible window.
                tauri::RunEvent::WindowEvent {
                    ref label,
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } if label == "main" => {
                    close_settings_window(app);
                }
                tauri::RunEvent::Ready => {
                    // Start the web terminal bridge once every managed state is
                    // registered. Runs on its own listener thread; failure only
                    // logs so the desktop app keeps working.
                    if let Err(e) = web::start(app.clone()) {
                        log::warn!("could not start web terminal server: {e}");
                    }
                    // The clock for queued commands. Same reason it starts
                    // here: it resolves terminals through managed state.
                    schedule::start(app.clone());
                }
                // Servers exit on stdin EOF, but destructors are not guaranteed
                // on process exit; kill explicitly.
                tauri::RunEvent::Exit => {
                    if let Some(state) = app.try_state::<lsp::LspState>() {
                        state.kill_all();
                    }
                    web::stop();
                    gateway::stop();
                }
                _ => {}
            }
        });
}
