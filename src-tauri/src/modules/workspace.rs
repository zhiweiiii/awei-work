use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

// Short TTL keeps the auth-check TOCTOU window tight while still coalescing the
// burst of canonicalize calls within a single panel refresh (~100ms).
const CANONICAL_TTL: Duration = Duration::from_secs(1);
const CANONICAL_CACHE_CAP: usize = 256;

struct CanonicalEntry {
    canonical: PathBuf,
    inserted_at: Instant,
}

#[derive(Default)]
pub struct WorkspaceRegistry {
    roots: Mutex<HashSet<PathBuf>>,
    canonical_cache: Mutex<HashMap<PathBuf, CanonicalEntry>>,
}

impl WorkspaceRegistry {
    pub fn authorize<P: AsRef<Path>>(&self, path: P) -> std::io::Result<PathBuf> {
        let canonical = std::fs::canonicalize(path.as_ref())?;
        let mut set = self.roots.lock().expect("workspace registry poisoned");
        set.insert(canonical.clone());
        Ok(canonical)
    }

    pub fn is_authorized(&self, target: &Path) -> bool {
        let set = self.roots.lock().expect("workspace registry poisoned");
        set.iter().any(|root| target.starts_with(root))
    }

    pub fn canonicalize_cached<P: AsRef<Path>>(&self, path: P) -> std::io::Result<PathBuf> {
        let key = path.as_ref().to_path_buf();
        {
            let cache = self
                .canonical_cache
                .lock()
                .expect("canonical cache poisoned");
            if let Some(entry) = cache.get(&key) {
                if entry.inserted_at.elapsed() < CANONICAL_TTL {
                    return Ok(entry.canonical.clone());
                }
            }
        }
        let canonical = std::fs::canonicalize(&key)?;
        let mut cache = self
            .canonical_cache
            .lock()
            .expect("canonical cache poisoned");
        if cache.len() >= CANONICAL_CACHE_CAP {
            cache.retain(|_, entry| entry.inserted_at.elapsed() < CANONICAL_TTL);
            if cache.len() >= CANONICAL_CACHE_CAP {
                cache.clear();
            }
        }
        cache.insert(
            key,
            CanonicalEntry {
                canonical: canonical.clone(),
                inserted_at: Instant::now(),
            },
        );
        Ok(canonical)
    }
}

// `None` means "use bootstrapped default". `Some` is canonicalized to defeat
// symlink/`..` traversal and must sit under an authorized root.
pub fn authorize_spawn_cwd(
    registry: &WorkspaceRegistry,
    cwd: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<Option<PathBuf>, String> {
    let Some(cwd) = cwd.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let resolved = resolve_path(cwd, workspace);
    let canonical =
        std::fs::canonicalize(&resolved).map_err(|e| format!("cwd not accessible: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("cwd is not a directory: {}", canonical.display()));
    }
    if !registry.is_authorized(&canonical) {
        return Err(format!(
            "cwd is outside the authorized workspace: {}",
            canonical.display()
        ));
    }
    Ok(Some(canonical))
}

// User-initiated terminal spawn: canonicalize, require a real dir, and register
// it as a root instead of rejecting paths outside existing roots.
pub fn authorize_user_spawn_cwd(
    registry: &WorkspaceRegistry,
    cwd: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<Option<PathBuf>, String> {
    let Some(cwd) = cwd.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let resolved = resolve_path(cwd, workspace);
    let canonical =
        std::fs::canonicalize(&resolved).map_err(|e| format!("cwd not accessible: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("cwd is not a directory: {}", canonical.display()));
    }
    registry.authorize(&canonical).map_err(|e| e.to_string())?;
    Ok(Some(canonical))
}

// Saved directories may no longer exist; fall back to home.
pub fn user_spawn_cwd_or_home(
    registry: &WorkspaceRegistry,
    cwd: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Option<String> {
    let cwd = cwd.map(str::trim).filter(|s| !s.is_empty())?;
    match authorize_user_spawn_cwd(registry, Some(cwd), workspace) {
        Ok(_) => Some(cwd.to_owned()),
        Err(e) => {
            log::warn!("pty cwd {cwd:?} unusable in {workspace:?} ({e}); opening home");
            None
        }
    }
}

pub fn bootstrap_registry(registry: &WorkspaceRegistry) {
    let _ = registry.authorize(resolve_launch_dir());
    if let Some(home) = dirs::home_dir() {
        let _ = registry.authorize(home);
    }
}

#[tauri::command]
pub async fn workspace_authorize(
    path: String,
    workspace: Option<WorkspaceEnv>,
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let resolved = resolve_path(&path, &workspace);
    let canonical = registry.authorize(&resolved).map_err(|e| e.to_string())?;
    Ok(crate::modules::fs::to_canon(&canonical))
}

#[tauri::command]
pub async fn workspace_current_dir(
    registry: tauri::State<'_, WorkspaceRegistry>,
) -> Result<String, String> {
    let launch = resolve_launch_dir();
    let canonical = registry.authorize(&launch).map_err(|e| e.to_string())?;
    Ok(crate::modules::fs::to_canon(&canonical))
}

// Snapshotted once at app startup so the live `current_dir()` drifting later
// (file dialogs, plugin chdir) can't shift the value seen by IPC or spawn.
static LAUNCH_CWD: OnceLock<Option<PathBuf>> = OnceLock::new();

pub fn init_launch_cwd(cli_dir: Option<&str>) {
    LAUNCH_CWD.get_or_init(|| resolve_launch_cwd(cli_dir, std::env::current_dir().ok()));
}

fn resolve_launch_cwd(cli_dir: Option<&str>, env_cwd: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(dir) = cli_dir {
        let p = PathBuf::from(dir);
        if p.is_dir() {
            return Some(p);
        }
    }
    env_cwd.filter(|p| is_usable_launch_dir(p))
}

pub fn launch_cwd_snapshot() -> Option<PathBuf> {
    LAUNCH_CWD.get().and_then(|o| o.clone())
}

fn resolve_launch_dir() -> PathBuf {
    if let Some(cwd) = launch_cwd_snapshot() {
        return cwd;
    }
    if let Some(cwd) = std::env::current_dir()
        .ok()
        .filter(|p| is_usable_launch_dir(p))
    {
        return cwd;
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn is_usable_launch_dir(path: &Path) -> bool {
    if !path.is_dir() || path == Path::new("/") {
        return false;
    }
    if is_executable_dir(path) {
        return false;
    }
    let s = path.to_string_lossy();
    if s.contains(".app/Contents/") {
        return false;
    }
    if cfg!(debug_assertions) && path.file_name().and_then(|s| s.to_str()) == Some("src-tauri") {
        return false;
    }
    true
}

fn is_executable_dir(path: &Path) -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(exe_dir) = exe.parent() else {
        return false;
    };
    match (std::fs::canonicalize(path), std::fs::canonicalize(exe_dir)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WorkspaceEnv {
    #[default]
    Local,
}

impl WorkspaceEnv {
    pub fn from_option(workspace: Option<Self>) -> Self {
        workspace.unwrap_or_default()
    }
}

pub fn resolve_path(path: &str, _workspace: &WorkspaceEnv) -> PathBuf {
    PathBuf::from(path)
}
