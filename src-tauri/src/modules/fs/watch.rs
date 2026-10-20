use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::modules::fs::to_canon;
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

// Quiet-gap before a batch flushes; MAX_WINDOW caps latency under a long stream.
const DEBOUNCE: Duration = Duration::from_millis(150);
const MAX_WINDOW: Duration = Duration::from_millis(1000);
const MAX_PENDING_EVENTS: usize = 4096;
const MAX_CHANGED_PATHS: usize = 4096;
const MAX_LEASES: usize = 4096;
const MAX_PATH_BYTES: usize = 8 * 1024 * 1024;

// Matched on the final path component. Never watched even when expanded: large
// or generated trees where live updates cost more than they're worth.
const SKIP_DIRS: &[&str] = &[
    // VCS
    ".git",
    ".hg",
    ".svn",
    ".jj",
    // JS / web
    "node_modules",
    "bower_components",
    ".pnpm-store",
    ".yarn",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".astro",
    ".vite",
    ".turbo",
    ".parcel-cache",
    ".angular",
    ".vercel",
    ".netlify",
    ".output",
    ".cache",
    // Rust
    "target",
    // Python
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".nox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".ipynb_checkpoints",
    ".eggs",
    // JVM / Gradle
    ".gradle",
    // .NET
    "obj",
    // Go / PHP
    "vendor",
    // Elixir
    "_build",
    "deps",
    // Dart / Flutter
    ".dart_tool",
    // Haskell
    "dist-newstyle",
    ".stack-work",
    // Swift / Zig
    ".build",
    "zig-cache",
    "zig-out",
    // CMake (CLion)
    "cmake-build-debug",
    "cmake-build-release",
    // IDE / coverage / infra
    ".idea",
    "coverage",
    ".nyc_output",
    ".terraform",
];

fn is_skipped(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| SKIP_DIRS.contains(&n))
}

#[derive(Default)]
pub struct FsWatchState {
    inner: Mutex<Option<WatchInner>>,
}

struct WatchInner {
    watcher: RecommendedWatcher,
    // Explorer (expanded dirs) and editor (dirs of open files) can request the
    // same dir; unwatch only when the last requester releases it.
    refcounts: HashMap<PathBuf, usize>,
    leases: HashMap<u64, WatchLease>,
    next_lease: u64,
}

struct RegisteredPath {
    canonical: PathBuf,
    display: String,
}

struct WatchLease {
    paths: Vec<RegisteredPath>,
}

#[derive(Clone, serde::Serialize)]
struct ChangedPayload {
    paths: Vec<String>,
    rescan: bool,
    workspace: WorkspaceEnv,
}

fn ensure_started(state: &FsWatchState, app: &AppHandle) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|_| "fs watch unavailable")?;
    if guard.is_some() {
        return Ok(());
    }

    let (tx, rx) = mpsc::sync_channel::<notify::Result<Event>>(MAX_PENDING_EVENTS);
    let overflow = Arc::new(AtomicBool::new(false));
    let callback_overflow = Arc::clone(&overflow);
    let watcher = RecommendedWatcher::new(
        move |res| {
            if let Err(mpsc::TrySendError::Full(_)) = tx.try_send(res) {
                callback_overflow.store(true, Ordering::Release);
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    let app = app.clone();
    std::thread::Builder::new()
        .name("terax-fs-watch".into())
        .spawn(move || drain_loop(rx, app, overflow))
        .map_err(|e| e.to_string())?;

    *guard = Some(WatchInner {
        watcher,
        refcounts: HashMap::new(),
        leases: HashMap::new(),
        next_lease: 0,
    });
    Ok(())
}

fn drain_loop(
    rx: mpsc::Receiver<notify::Result<Event>>,
    app: AppHandle,
    overflow: Arc<AtomicBool>,
) {
    loop {
        let first = match rx.recv() {
            Ok(ev) => ev,
            Err(_) => return,
        };

        let mut paths: HashSet<String> = HashSet::new();
        let mut path_bytes = 0;
        let mut rescan = collect(&mut paths, &mut path_bytes, first);

        let deadline = Instant::now() + MAX_WINDOW;
        loop {
            let timeout = DEBOUNCE.min(deadline.saturating_duration_since(Instant::now()));
            match rx.recv_timeout(timeout) {
                Ok(ev) => rescan |= collect(&mut paths, &mut path_bytes, ev),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if Instant::now() >= deadline {
                break;
            }
        }

        rescan |= overflow.swap(false, Ordering::AcqRel);
        if paths.is_empty() && !rescan {
            continue;
        }
        let state = app.state::<FsWatchState>();
        let payloads = {
            let Ok(guard) = state.inner.lock() else {
                continue;
            };
            let Some(inner) = guard.as_ref() else {
                continue;
            };
            changed_payloads(paths, rescan, &inner.leases)
        };
        for payload in payloads {
            if !payload.paths.is_empty() || payload.rescan {
                let _ = app.emit("fs:changed", payload);
            }
        }
    }
}

fn collect(set: &mut HashSet<String>, bytes: &mut usize, ev: notify::Result<Event>) -> bool {
    let Ok(ev) = ev else { return true };
    if matches!(ev.kind, EventKind::Access(_)) {
        return false;
    }
    let mut rescan = ev.need_rescan();
    for p in ev.paths {
        if set.len() >= MAX_CHANGED_PATHS {
            rescan = true;
            break;
        }
        let path = to_canon(&p);
        if set.contains(&path) {
            continue;
        }
        if *bytes + path.len() > MAX_PATH_BYTES {
            rescan = true;
            break;
        }
        *bytes += path.len();
        set.insert(path);
    }
    rescan
}

fn watch_key(path: &str) -> String {
    path.trim_end_matches('/').to_ascii_lowercase()
}

fn changed_payloads(
    paths: HashSet<String>,
    rescan: bool,
    leases: &HashMap<u64, WatchLease>,
) -> Vec<ChangedPayload> {
    let mut changed = paths.clone();
    let mut bytes = paths.iter().map(String::len).sum::<usize>();
    let mut bindings: HashMap<String, HashSet<String>> = HashMap::new();
    for lease in leases.values() {
        for registered in &lease.paths {
            bindings
                .entry(watch_key(&to_canon(&registered.canonical)))
                .or_default()
                .insert(registered.display.trim_end_matches('/').to_string());
        }
    }
    let mut overflow = rescan;
    'events: for path in paths {
        let parent = path.rsplit_once('/');
        let targets = [
            (watch_key(&path), None),
            (
                watch_key(parent.map(|p| p.0).unwrap_or("")),
                parent.map(|p| p.1),
            ),
        ];
        for (key, name) in targets {
            let Some(aliases) = bindings.get(&key) else {
                continue;
            };
            for display in aliases {
                let mapped = match name {
                    Some(name) => format!("{display}/{name}"),
                    None if display.is_empty() => "/".to_string(),
                    None => display.clone(),
                };
                if changed.contains(&mapped) {
                    continue;
                }
                if changed.len() >= MAX_CHANGED_PATHS || bytes + mapped.len() > MAX_PATH_BYTES {
                    overflow = true;
                    break 'events;
                }
                bytes += mapped.len();
                changed.insert(mapped);
            }
        }
    }
    vec![ChangedPayload {
        workspace: WorkspaceEnv::Local,
        paths: changed.into_iter().collect(),
        rescan: overflow,
    }]
}

fn add_paths(inner: &mut WatchInner, paths: Vec<RegisteredPath>) -> Vec<RegisteredPath> {
    let mut added = Vec::new();
    for path in paths {
        let canonical = &path.canonical;
        let current = inner.refcounts.get(canonical).copied().unwrap_or(0);
        if current == 0 {
            match inner.watcher.watch(canonical, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    inner.refcounts.insert(canonical.clone(), 1);
                    added.push(path);
                }
                Err(e) => log::debug!("fs_watch add {} failed: {e}", canonical.display()),
            }
        } else {
            inner.refcounts.insert(canonical.clone(), current + 1);
            added.push(path);
        }
    }
    added
}

fn remove_paths(inner: &mut WatchInner, paths: Vec<PathBuf>) {
    for key in paths {
        let current = inner.refcounts.get(&key).copied().unwrap_or(0);
        if current <= 1 {
            inner.refcounts.remove(&key);
            let _ = inner.watcher.unwatch(&key);
        } else {
            inner.refcounts.insert(key, current - 1);
        }
    }
}

fn prepare_add(
    registry: &WorkspaceRegistry,
    workspace: &WorkspaceEnv,
    paths: Vec<String>,
) -> Vec<RegisteredPath> {
    paths
        .into_iter()
        .filter_map(|raw| {
            let resolved = resolve_path(&raw, workspace);
            let canonical = std::fs::canonicalize(&resolved).ok()?;
            if !canonical.is_dir() || is_skipped(&canonical) || !registry.is_authorized(&canonical)
            {
                return None;
            }
            let display = raw.replace('\\', "/");
            Some(RegisteredPath { canonical, display })
        })
        .collect()
}

#[tauri::command]
pub async fn fs_watch_add(
    paths: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    if paths.len() > MAX_CHANGED_PATHS
        || paths.iter().any(|path| path.len() > 32768)
        || paths.iter().map(String::len).sum::<usize>() > 1024 * 1024
    {
        return Err("fs watch request exceeds supported size".into());
    }
    super::blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let registry = app.state::<WorkspaceRegistry>();
        let prepared = prepare_add(&registry, &workspace, paths);
        if prepared.is_empty() {
            return Ok(None);
        }
        let state = app.state::<FsWatchState>();
        ensure_started(&state, &app)?;
        let mut guard = state.inner.lock().map_err(|_| "fs watch unavailable")?;
        let inner = guard.as_mut().ok_or("fs watch unavailable")?;
        if inner.leases.len() >= MAX_LEASES {
            return Err("fs watch registration limit reached".into());
        }
        if inner.refcounts.len() + prepared.len() > 8192 {
            return Err("fs watch directory limit reached".into());
        }
        if inner
            .leases
            .values()
            .map(|lease| lease.paths.len())
            .sum::<usize>()
            + prepared.len()
            > 8192
        {
            return Err("fs watch alias limit reached".into());
        }
        let path_size =
            |path: &RegisteredPath| path.display.len() + path.canonical.as_os_str().len();
        if inner
            .leases
            .values()
            .flat_map(|lease| &lease.paths)
            .map(path_size)
            .sum::<usize>()
            + prepared.iter().map(path_size).sum::<usize>()
            > MAX_PATH_BYTES
        {
            return Err("fs watch path storage limit reached".into());
        }
        let lease = inner
            .next_lease
            .checked_add(1)
            .ok_or("fs watch IDs exhausted")?;
        let added = add_paths(inner, prepared);
        if added.is_empty() {
            return Ok(None);
        }
        inner.next_lease = lease;
        inner.leases.insert(lease, WatchLease { paths: added });
        Ok(Some(lease.to_string()))
    })
    .await
}

#[tauri::command]
pub async fn fs_watch_remove(lease: String, app: AppHandle) -> Result<(), String> {
    let lease: u64 = lease.parse().map_err(|_| "invalid fs watch registration")?;
    super::blocking(move || {
        let state = app.state::<FsWatchState>();
        let mut guard = state.inner.lock().map_err(|_| "fs watch unavailable")?;
        if let Some(inner) = guard.as_mut() {
            if let Some(lease) = inner.leases.remove(&lease) {
                remove_paths(
                    inner,
                    lease.paths.into_iter().map(|path| path.canonical).collect(),
                );
            }
        }
        Ok(())
    })
    .await
}
