use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use ignore::WalkBuilder;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;

use super::{blocking, to_canon};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

#[derive(Serialize, Clone)]
pub struct SearchHit {
    /// Absolute path of the matched file.
    pub path: String,
    /// Path relative to the search root, for display.
    pub rel: String,
    /// File name only.
    pub name: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// True if the scan stopped early (entry budget or hit cap reached).
    pub truncated: bool,
}

/// Hard cap on entries the walker is allowed to visit before bailing. Protects
/// against pathological roots like $HOME where there's no .gitignore and the
/// tree is effectively unbounded.
const MAX_SCANNED: usize = 50_000;

/// Supersession counter for the explorer's file-name search. Each new query
/// bumps the generation so in-flight walks for keystrokes the user has already
/// typed past abandon their scan instead of running to completion.
#[derive(Default)]
pub struct FileSearchState {
    generation: Arc<AtomicU64>,
}

/// Directory names pruned unconditionally — they're rarely useful in a
/// file-explorer search and they dominate scan time when present.
pub(super) const PRUNE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".venv",
    "__pycache__",
];

#[tauri::command]
pub async fn fs_search(
    state: tauri::State<'_, FileSearchState>,
    root: String,
    query: String,
    limit: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
) -> Result<SearchResult, String> {
    let generation = state.generation.clone();
    let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;
    blocking(move || {
        let cancel = move || generation.load(Ordering::SeqCst) != my_gen;
        search_with_cancel(root, query, limit, workspace, show_hidden, &cancel)
    })
    .await
}

pub fn fs_search_impl(
    root: String,
    query: String,
    limit: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
) -> Result<SearchResult, String> {
    search_with_cancel(root, query, limit, workspace, show_hidden, &|| false)
}

fn search_with_cancel(
    root: String,
    query: String,
    limit: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
    cancel: &dyn Fn() -> bool,
) -> Result<SearchResult, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            truncated: false,
        });
    }
    let cap = limit.unwrap_or(200).min(1000);
    let show_hidden = show_hidden.unwrap_or(false);
    let workspace = WorkspaceEnv::from_option(workspace);
    let root_path = resolve_path(&root, &workspace);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    // Score each entry as it is visited and keep only the matches. Building a
    // SearchHit for every one of up to MAX_SCANNED entries and ranking
    // afterwards allocated three strings per entry on every keystroke, which is
    // what made typing here stutter.
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let pattern = Pattern::parse(q, CaseMatching::Smart, Normalization::Smart);
    let mut buf = Vec::new();

    let mut scored: Vec<(u32, SearchHit)> = Vec::new();
    let mut scanned: usize = 0;
    let mut truncated = false;

    let walker = WalkBuilder::new(&root_path)
        .hidden(!show_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .filter_entry(|dent| {
            // Prune known-heavy dirs even when no .gitignore is present (e.g.
            // searching from $HOME).
            if dent.depth() == 0 || !dent.file_type().is_some_and(|kind| kind.is_dir()) {
                return true;
            }
            match dent.file_name().to_str() {
                Some(name) => !PRUNE_DIRS.contains(&name),
                None => true,
            }
        })
        .build();

    for dent in walker.flatten() {
        scanned += 1;
        if scanned > MAX_SCANNED {
            truncated = true;
            break;
        }
        // Superseded by a newer keystroke — drop the rest of the walk.
        if scanned.is_multiple_of(512) && cancel() {
            truncated = true;
            break;
        }
        let path = dent.path();
        if path == root_path {
            continue;
        }
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => to_canon(r),
            Err(_) => continue,
        };
        let Some(score) = pattern.score(Utf32Str::new(&rel, &mut buf), &mut matcher) else {
            continue;
        };
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        scored.push((
            score,
            SearchHit {
                path: display_path(path, &root_path, &root, &workspace),
                rel,
                name,
                is_dir,
            },
        ));
    }

    // Best score first; ties break toward shorter relative paths.
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.rel.len().cmp(&b.1.rel.len()))
    });
    truncated |= scored.len() > cap;
    let hits = scored.into_iter().take(cap).map(|(_, h)| h).collect();
    Ok(SearchResult { hits, truncated })
}

#[derive(Serialize)]
pub struct ListFilesResult {
    pub files: Vec<String>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn fs_list_files(
    root: String,
    limit: Option<usize>,
    max_depth: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
) -> Result<ListFilesResult, String> {
    blocking(move || fs_list_files_impl(root, limit, max_depth, workspace, show_hidden)).await
}

pub fn fs_list_files_impl(
    root: String,
    limit: Option<usize>,
    max_depth: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    show_hidden: Option<bool>,
) -> Result<ListFilesResult, String> {
    const DEFAULT_LIMIT: usize = 2_000;
    const HARD_LIMIT: usize = 10_000;
    const DEFAULT_DEPTH: usize = 8;
    const HARD_DEPTH: usize = 16;

    let cap = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, HARD_LIMIT);
    let depth = max_depth.unwrap_or(DEFAULT_DEPTH).clamp(1, HARD_DEPTH);
    let show_hidden = show_hidden.unwrap_or(false);
    let workspace = WorkspaceEnv::from_option(workspace);
    let root_path = resolve_path(&root, &workspace);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    let walker = WalkBuilder::new(&root_path)
        .hidden(!show_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .max_depth(Some(depth))
        .filter_entry(|dent| {
            if dent.depth() == 0 || !dent.file_type().is_some_and(|kind| kind.is_dir()) {
                return true;
            }
            match dent.file_name().to_str() {
                Some(name) => !PRUNE_DIRS.contains(&name),
                None => true,
            }
        })
        .build();

    let mut files: Vec<String> = Vec::with_capacity(cap.min(256));
    let mut scanned: usize = 0;
    let mut truncated = false;

    for dent in walker.flatten() {
        scanned += 1;
        if scanned > MAX_SCANNED {
            truncated = true;
            break;
        }
        let is_file = dent.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        let path = dent.path();
        let rel = match path.strip_prefix(&root_path) {
            Ok(r) => to_canon(r),
            Err(_) => continue,
        };
        if rel.is_empty() {
            continue;
        }
        files.push(rel);
        if files.len() >= cap {
            truncated = true;
            break;
        }
    }

    files.sort_by_key(|a| a.to_lowercase());
    Ok(ListFilesResult { files, truncated })
}

fn display_path(
    path: &std::path::Path,
    _root_path: &std::path::Path,
    _root_display: &str,
    _workspace: &WorkspaceEnv,
) -> String {
    to_canon(path)
}
