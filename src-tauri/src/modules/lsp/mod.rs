mod env;
mod framing;
mod java;
mod java_cache;
mod mapper;
mod root;
mod rss;
mod session;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use tauri::ipc::{Channel, Response};

use crate::modules::workspace::{authorize_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};
use session::LspSession;

pub struct LspState {
    sessions: RwLock<HashMap<u32, Arc<LspSession>>>,
    next_id: AtomicU32,
    maintenance: Mutex<()>,
    cache_generation: AtomicU32,
}

impl Default for LspState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            maintenance: Mutex::new(()),
            cache_generation: AtomicU32::new(0),
        }
    }
}

impl LspState {
    pub(super) fn take(&self, id: u32) -> Option<Arc<LspSession>> {
        self.sessions.write().unwrap().remove(&id)
    }

    pub fn kill_all(&self) {
        let drained: Vec<Arc<LspSession>> = self
            .sessions
            .write()
            .unwrap()
            .drain()
            .map(|(_, s)| s)
            .collect();
        for session in drained {
            session.kill();
        }
    }
}

#[tauri::command]
pub fn lsp_host_pid() -> u32 {
    std::process::id()
}

#[tauri::command]
pub async fn lsp_detect(command: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        env::resolve_binary(&command).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lsp_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    root: String,
    max_rss_mb: Option<u64>,
    cache_generation: Option<u32>,
    workspace: Option<WorkspaceEnv>,
    on_message: Channel<Response>,
    on_exit: Channel<session::LspExit>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let root = authorize_spawn_cwd(&registry, Some(root.as_str()), &workspace)?
        .ok_or("lsp: workspace root is required")?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let spawn_log = format!("cmd={command} root={}", root.display());
    let session = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<LspState>();
        let _maintenance = state.maintenance.lock().unwrap();
        if cache_generation
            .is_some_and(|generation| generation != state.cache_generation.load(Ordering::Acquire))
        {
            return Err("Java 索引缓存已变更，请重新打开项目".into());
        }
        let binary = env::resolve_binary(&command)
            .ok_or_else(|| format!("lsp: binary not found: {command}"))?;
        let extra_env = env.unwrap_or_default();
        let session = session::spawn(
            id,
            app.clone(),
            &binary,
            &args,
            &extra_env,
            &root,
            max_rss_mb,
            on_message,
            on_exit,
        )?;
        state.sessions.write().unwrap().insert(id, session.clone());
        Ok::<_, String>(session)
    })
    .await
    .map_err(|e| e.to_string())??;

    drop(session);
    // The server can die before this insert; the waiter's reap then ran with
    // the id absent. Re-check so a dead session isn't stranded in the map.
    let exited = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .map(|s| s.exited.load(Ordering::Acquire))
        .unwrap_or(false);
    if exited {
        state.take(id);
    }
    log::info!("lsp spawned id={id} {spawn_log}");
    Ok(id)
}

#[tauri::command]
pub async fn lsp_java_launch(
    app: tauri::AppHandle,
    state: tauri::State<'_, LspState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    root: String,
    args: Vec<String>,
) -> Result<java::JavaLaunch, String> {
    use tauri::Manager;
    let root = authorize_spawn_cwd(&registry, Some(&root), &WorkspaceEnv::Local)?
        .ok_or("lsp: workspace root is required")?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let generation = state.cache_generation.load(Ordering::Acquire);
    let mut launch = java::prepare(cache, root, args).await?;
    launch.cache_generation = generation;
    Ok(launch)
}

#[tauri::command]
pub async fn lsp_java_cached(app: tauri::AppHandle, root: String) -> Result<bool, String> {
    use tauri::Manager;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<WorkspaceRegistry>();
        let root = authorize_spawn_cwd(&registry, Some(&root), &WorkspaceEnv::Local)?
            .ok_or("Java project root is required")?;
        Ok(java_cache::is_cached(&cache, &root))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_java_caches(app: tauri::AppHandle) -> Result<Vec<java_cache::CacheEntry>, String> {
    use tauri::Manager;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<LspState>();
        let _maintenance = state.maintenance.lock().unwrap();
        let mut entries = java_cache::list(&cache)?;
        for entry in &mut entries {
            entry.active = state.sessions.read().unwrap().values().any(|session| {
                let path = if entry.id == "shared" {
                    &session.shared_index
                } else {
                    &session.java_cache
                };
                path.as_ref().is_some_and(|path| {
                    crate::modules::fs::to_canon(path).eq_ignore_ascii_case(&entry.path)
                })
            });
        }
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_java_cache_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<LspState>();
        let _maintenance = state.maintenance.lock().unwrap();
        let directory = java_cache::directory(&cache, &id)?;
        let identity = crate::modules::fs::to_canon(&directory);
        state.cache_generation.fetch_add(1, Ordering::AcqRel);
        let affected: Vec<_> = state
            .sessions
            .read()
            .unwrap()
            .values()
            .filter(|session| {
                let path = if id == "shared" {
                    &session.shared_index
                } else {
                    &session.java_cache
                };
                path.as_ref().is_some_and(|path| {
                    crate::modules::fs::to_canon(path).eq_ignore_ascii_case(&identity)
                })
            })
            .cloned()
            .collect();
        std::thread::scope(|scope| {
            for session in affected {
                scope.spawn(move || session.shutdown(Some("cache-deleted")));
            }
        });
        java_cache::delete(&cache, &id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lsp_shutdown(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<LspState>();
        let _maintenance = state.maintenance.lock().unwrap();
        if let Some(session) = state.take(id) {
            session.shutdown(None);
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_shutdown_all(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<LspState>();
        let _maintenance = state.maintenance.lock().unwrap();
        state.cache_generation.fetch_add(1, Ordering::AcqRel);
        let sessions: Vec<_> = state.sessions.read().unwrap().values().cloned().collect();
        std::thread::scope(|scope| {
            for session in sessions {
                scope.spawn(move || session.shutdown(Some("app-closing")));
            }
        });
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_resolve_root(
    app: tauri::AppHandle,
    path: String,
    markers: Vec<String>,
    language: Option<String>,
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let registry = app.state::<WorkspaceRegistry>();
        let candidate = root::resolve(&path, &markers, language.as_deref() == Some("java"))?;
        if authorize_spawn_cwd(&registry, Some(&candidate), &WorkspaceEnv::Local).is_ok() {
            return Some(candidate);
        }
        let fallback = root::resolve(&path, &markers, false)?;
        authorize_spawn_cwd(&registry, Some(&fallback), &WorkspaceEnv::Local).ok()?;
        Some(fallback)
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn lsp_mapper_files(
    app: tauri::AppHandle,
    root: String,
    namespace: String,
    kind: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let registry = app.state::<WorkspaceRegistry>();
        let root = authorize_spawn_cwd(&registry, Some(&root), &WorkspaceEnv::Local)?
            .ok_or("Mapper workspace root is required")?;
        mapper::files(&root, &namespace, &kind)
    })
    .await
    .map_err(|error| error.to_string())?
}

// Async so a stalled server with a full stdin pipe blocks a worker
// thread, never the main thread.
#[tauri::command]
pub async fn lsp_send(
    state: tauri::State<'_, LspState>,
    id: u32,
    message: String,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("lsp_send: unknown id={id}"))?;
    tauri::async_runtime::spawn_blocking(move || session.write_message(&message))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn lsp_kill(state: tauri::State<'_, LspState>, id: u32) {
    if let Some(session) = state.take(id) {
        session.kill();
        log::info!("lsp killed id={id}");
    }
}
