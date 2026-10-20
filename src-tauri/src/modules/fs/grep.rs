use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::{WalkBuilder, WalkState};
use serde::Serialize;

use super::search::PRUNE_DIRS;
use super::{blocking, to_canon};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const FILE_SIZE_CAP: u64 = 5 * 1024 * 1024;
const DEFAULT_MAX_RESULTS: usize = 200;
const HARD_MAX_RESULTS: usize = 2000;

/// Hard cap on files opened for one interactive query. Keeps a search rooted at
/// a huge tree from pinning the CPU long after the user stopped caring.
const MAX_FILES_SCANNED: usize = 20_000;

/// Threads the parallel walker may use. Deliberately below the core count:
/// saturating every core starves the webview and makes the whole app janky
/// while typing in the search box.
fn walk_threads() -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    (cores.saturating_sub(1)).clamp(1, 4)
}

/// Supersession counter for interactive content search. Each new interactive
/// query bumps the generation; in-flight walks observe the change and quit,
/// so fast typing stops superseded searches server-side instead of letting
/// them run to completion.
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

fn escape_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// More terms than this stops describing a line and starts describing a novel.
const MAX_TERMS: usize = 12;

/// How the query's words are matched against a line: every word has to be
/// somewhere in it, plain substring, order irrelevant.
///
/// Deliberately not a regex over the whole query. Joining the words with `.*?`
/// expresses the same idea but costs the searcher its fast path: a single
/// literal is found with memchr and skips most of the file, while a pattern
/// with gaps in it drags the automaton across every byte. So one word, the
/// longest, is handed to the searcher as a literal to find candidate lines, and
/// the rest are checked here with `contains` on the few lines that survived.
struct Terms {
    /// The word given to the searcher. The longest one, because the rarest
    /// literal is what skips the most input.
    anchor: String,
    /// Everything else, lowercased when the match is case insensitive.
    rest: Vec<String>,
    /// Smart case: a query typed in lowercase matches either case.
    ignore_case: bool,
}

impl Terms {
    fn parse(query: &str) -> Option<Terms> {
        let mut words: Vec<&str> = query.split_whitespace().take(MAX_TERMS).collect();
        if words.is_empty() {
            return None;
        }
        let ignore_case = !query.chars().any(char::is_uppercase);
        let longest = words
            .iter()
            .enumerate()
            .max_by_key(|(_, word)| word.len())
            .map(|(i, _)| i)
            .unwrap_or(0);
        let anchor = words.remove(longest).to_string();
        let rest = words
            .into_iter()
            .map(|word| {
                if ignore_case {
                    word.to_lowercase()
                } else {
                    word.to_string()
                }
            })
            .collect();
        Some(Terms {
            anchor,
            rest,
            ignore_case,
        })
    }

    /// Whether a line the searcher matched on the anchor also carries the rest.
    fn accepts(&self, line: &str) -> bool {
        if self.rest.is_empty() {
            return true;
        }
        let haystack = if self.ignore_case {
            line.to_lowercase()
        } else {
            line.to_string()
        };
        self.rest.iter().all(|word| haystack.contains(word))
    }
}

#[allow(clippy::too_many_arguments)]
fn search_tree(
    root_path: &Path,
    root_display: &str,
    workspace: &WorkspaceEnv,
    matcher: &RegexMatcher,
    terms: &Terms,
    cap: usize,
    cancel: &(dyn Fn() -> bool + Sync),
) -> GrepResponse {
    let walker = WalkBuilder::new(root_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .threads(walk_threads())
        .filter_entry(|dent| {
            if dent.depth() == 0 || !dent.file_type().is_some_and(|kind| kind.is_dir()) {
                return true;
            }
            match dent.file_name().to_str() {
                Some(name) => !PRUNE_DIRS.contains(&name),
                None => true,
            }
        })
        .build_parallel();

    let hits: Arc<Mutex<Vec<GrepHit>>> = Arc::new(Mutex::new(Vec::new()));
    let scanned = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));

    walker.run(|| {
        let matcher = matcher.clone();
        let hits = hits.clone();
        let scanned = scanned.clone();
        let truncated = truncated.clone();
        let root_path = root_path.to_path_buf();
        let root_display = root_display.to_string();
        let workspace = workspace.clone();

        Box::new(move |dent_res| {
            if truncated.load(Ordering::Relaxed) || cancel() {
                return WalkState::Quit;
            }
            let dent = match dent_res {
                Ok(d) => d,
                Err(_) => return WalkState::Continue,
            };
            if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return WalkState::Continue;
            }
            let path = dent.path();
            let rel = match path.strip_prefix(&root_path) {
                Ok(r) => to_canon(r),
                Err(_) => return WalkState::Continue,
            };
            if let Ok(meta) = std::fs::metadata(path) {
                if meta.len() > FILE_SIZE_CAP {
                    return WalkState::Continue;
                }
            }

            if scanned.fetch_add(1, Ordering::Relaxed) >= MAX_FILES_SCANNED {
                truncated.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }

            let abs = display_path(path, &root_path, &root_display, &workspace);
            let rel_clone = rel.clone();
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(b'\x00'))
                .line_number(true)
                .build();

            let _ = searcher.search_path(
                &matcher,
                path,
                UTF8(|line_num, text| {
                    if cancel() {
                        return Ok(false);
                    }
                    let line_text = text.trim_end_matches('\n').to_string();
                    // The searcher only knows the anchor word; the rest of the
                    // query is applied here, on the few lines that got this far.
                    if !terms.accepts(&line_text) {
                        return Ok(true);
                    }
                    let mut guard = hits.lock().unwrap();
                    if guard.len() >= cap {
                        truncated.store(true, Ordering::Relaxed);
                        return Ok(false);
                    }
                    guard.push(GrepHit {
                        path: abs.clone(),
                        rel: rel_clone.clone(),
                        line: line_num,
                        text: line_text,
                    });
                    Ok(true)
                }),
            );

            WalkState::Continue
        })
    });

    let final_hits = Arc::try_unwrap(hits)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();

    GrepResponse {
        hits: final_hits,
        truncated: truncated.load(Ordering::Relaxed),
        files_scanned: scanned.load(Ordering::Relaxed),
    }
}

/// Interactive content search for the header search bar and command palette.
/// Matches the query's words as a subsequence within a line (smart-case), and
/// self-cancels when a newer query arrives.
#[tauri::command]
pub async fn fs_grep_interactive(
    state: tauri::State<'_, ContentSearchState>,
    pattern: String,
    root: String,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<GrepResponse, String> {
    if pattern.trim().is_empty() {
        return Err("empty pattern".into());
    }
    let generation = state.generation.clone();
    let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;

    let workspace = WorkspaceEnv::from_option(workspace);
    let root_path = resolve_path(&root, &workspace);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let cap = max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, HARD_MAX_RESULTS);

    let terms = Terms::parse(&pattern).ok_or_else(|| "empty pattern".to_string())?;
    let matcher = RegexMatcherBuilder::new()
        .case_smart(true)
        .line_terminator(Some(b'\n'))
        .build(&escape_literal(&terms.anchor))
        .map_err(|e| format!("bad pattern: {e}"))?;

    // The walk is CPU-bound and can take seconds on a large tree: it must never
    // run on the main thread, or every frame of the app stalls behind it.
    blocking(move || {
        let cancel = || generation.load(Ordering::SeqCst) != my_gen;
        Ok(search_tree(
            &root_path, &root, &workspace, &matcher, &terms, cap, &cancel,
        ))
    })
    .await
}

fn display_path(
    path: &std::path::Path,
    _root_path: &std::path::Path,
    _root_display: &str,
    _workspace: &WorkspaceEnv,
) -> String {
    to_canon(path)
}
