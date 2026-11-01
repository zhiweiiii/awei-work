use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use grep_regex::RegexMatcher;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::WalkBuilder;
use serde::Serialize;

use super::search::PRUNE_DIRS;
use super::{blocking, to_canon};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const FILE_SIZE_CAP: u64 = 5 * 1024 * 1024;
const DEFAULT_MAX_RESULTS: usize = 200;
const HARD_MAX_RESULTS: usize = 2000;
const MAX_FILES_SCANNED: usize = 20_000;
const MAX_ENTRIES_SCANNED: usize = 50_000;

#[derive(Default)]
pub struct ContentSearchState {
    generation: Arc<AtomicU64>,
}

#[derive(Serialize)]
pub struct GrepHit {
    pub path: String,
    pub rel: String,
    pub line: u64,
    pub text: String,
}

#[derive(Serialize)]
pub struct GrepResponse {
    pub hits: Vec<GrepHit>,
    pub truncated: bool,
    pub files_scanned: usize,
}

fn search_tree(
    root: &Path,
    matcher: &RegexMatcher,
    cap: usize,
    cancel: &dyn Fn() -> bool,
) -> GrepResponse {
    let walker = WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .sort_by_file_name(|left, right| left.cmp(right))
        .filter_entry(|entry| {
            entry.depth() == 0
                || !entry.file_type().is_some_and(|kind| kind.is_dir())
                || !entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| PRUNE_DIRS.contains(&name))
        })
        .build();
    let mut hits = Vec::with_capacity(cap.min(256));
    let mut files_scanned = 0;
    let mut truncated = false;
    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .line_number(true)
        .build();

    for (index, entry) in walker.flatten().enumerate() {
        if index >= MAX_ENTRIES_SCANNED || cancel() {
            truncated = true;
            break;
        }
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry.path();
        if path.metadata().is_ok_and(|meta| meta.len() > FILE_SIZE_CAP) {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        if files_scanned == MAX_FILES_SCANNED {
            truncated = true;
            break;
        }
        files_scanned += 1;
        let absolute = to_canon(path);
        let relative = to_canon(relative);
        let _ = searcher.search_path(
            matcher,
            path,
            UTF8(|line, text| {
                if cancel() {
                    truncated = true;
                    return Ok(false);
                }
                if hits.len() == cap {
                    truncated = true;
                    return Ok(false);
                }
                hits.push(GrepHit {
                    path: absolute.clone(),
                    rel: relative.clone(),
                    line,
                    text: text.trim_end_matches(['\r', '\n']).to_string(),
                });
                Ok(true)
            }),
        );
        if truncated {
            break;
        }
    }
    GrepResponse {
        hits,
        truncated,
        files_scanned,
    }
}

#[tauri::command]
pub async fn fs_grep_interactive(
    state: tauri::State<'_, ContentSearchState>,
    pattern: String,
    root: String,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<GrepResponse, String> {
    let generation = state.generation.clone();
    let request = generation.fetch_add(1, Ordering::SeqCst) + 1;
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let root_path = resolve_path(&root, &workspace);
        if !root_path.is_dir() {
            return Err(format!("not a directory: {root}"));
        }
        let matcher = super::literal::matcher(&pattern)?;
        let cap = max_results
            .unwrap_or(DEFAULT_MAX_RESULTS)
            .clamp(1, HARD_MAX_RESULTS);
        let cancel = || generation.load(Ordering::SeqCst) != request;
        Ok(search_tree(&root_path, &matcher, cap, &cancel))
    })
    .await
}
