//! Claude Code writes one JSONL per session under
//! `~/.claude/projects/<escaped cwd>/<session-uuid>.jsonl`, appended as the
//! session runs.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use super::{
    clip_output, flatten_text, merge_assistant_steps, push_part, same_dir, timestamp, Message,
    Part, Transcript, Working,
};

/// Only look at directories touched this recently when the escaped-name guess
/// misses and we have to search. A project nobody has used today cannot be the
/// session running in front of us.
const SEARCH_MAX_AGE_SECS: u64 = 24 * 60 * 60;

/// Resolved project directories, keyed by cwd. The fallback search reads a
/// line out of every recently used project, which is far too much work to
/// repeat on a poll.
fn dir_cache() -> &'static Mutex<HashMap<String, PathBuf>> {
    static CACHE: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn projects_root() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let root = home.join(".claude").join("projects");
    root.is_dir().then_some(root)
}

/// Claude derives the directory name from the cwd by replacing everything that
/// is not alphanumeric with a dash. That is reproduced for the fast path, but
/// it is not treated as the contract: the mapping is lossy (two paths can
/// collide) and non-ASCII paths do not come out the way a naive replacement
/// predicts. When the guess does not exist, recently used directories are read
/// and matched on the `cwd` each line actually carries.
pub(super) fn project_dir(cwd: &str) -> Option<PathBuf> {
    if let Some(hit) = dir_cache().lock().ok().and_then(|c| c.get(cwd).cloned()) {
        if hit.is_dir() {
            return Some(hit);
        }
    }
    let root = projects_root()?;
    let guess: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let direct = root.join(&guess);
    let found = if direct.is_dir() {
        direct
    } else {
        search_project_dir(&root, cwd)?
    };
    if let Ok(mut cache) = dir_cache().lock() {
        if cache.len() >= 64 && !cache.contains_key(cwd) {
            cache.clear();
        }
        cache.insert(cwd.to_string(), found.clone());
    }
    Some(found)
}

fn search_project_dir(root: &Path, cwd: &str) -> Option<PathBuf> {
    let now = std::time::SystemTime::now();
    let started = std::time::Instant::now();
    let mut remaining = 8192usize;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(root).ok()? {
        if remaining == 0 || started.elapsed() > std::time::Duration::from_secs(2) {
            return None;
        }
        remaining -= 1;
        let entry = entry.ok()?;
        let kind = entry.file_type().ok()?;
        if !kind.is_dir() || kind.is_symlink() {
            continue;
        }
        let dir = entry.path();
        let Some(file) = newest_transcript(&dir, &mut remaining, started) else {
            if remaining == 0 || started.elapsed() > std::time::Duration::from_secs(2) {
                return None;
            }
            continue;
        };
        let Ok(modified) = file.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if now
            .duration_since(modified)
            .map(|age| age.as_secs() > SEARCH_MAX_AGE_SECS)
            .unwrap_or(false)
        {
            continue;
        }
        if !transcript_cwd(&file).is_some_and(|found| same_dir(&found, cwd)) {
            continue;
        }
        if best.as_ref().is_none_or(|(at, _)| modified > *at) {
            best = Some((modified, dir));
        }
    }
    best.map(|(_, dir)| dir)
}

/// The cwd a transcript belongs to, from the first line that names one.
fn transcript_cwd(file: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader, Read};
    let reader = BufReader::new(fs::File::open(file).ok()?.take(192 * 1024));
    for line in reader.lines().take(64).map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            return Some(cwd.to_string());
        }
    }
    None
}

fn newest_transcript(
    dir: &Path,
    remaining: &mut usize,
    started: std::time::Instant,
) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(dir).ok()? {
        if *remaining == 0 || started.elapsed() > std::time::Duration::from_secs(2) {
            *remaining = 0;
            return None;
        }
        *remaining -= 1;
        let entry = entry.ok()?;
        let kind = entry.file_type().ok()?;
        if !kind.is_file() || kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if best.as_ref().is_none_or(|(at, _)| modified > *at) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, path)| path)
}

#[derive(Default)]
struct ParseState {
    sequence: usize,
    mode: Option<String>,
    permission: Option<String>,
    steps: Vec<Message>,
    turn_started: Option<i64>,
    turn_open: bool,
    awaiting_result: HashMap<String, (usize, usize)>,
}

pub(super) fn read_file(file: &Path) -> Option<std::sync::Arc<Transcript>> {
    static CACHE: OnceLock<super::jsonl::ReaderCache<ParseState>> = OnceLock::new();
    CACHE
        .get_or_init(super::jsonl::ReaderCache::new)
        .read(file, || {
            Some(file.file_stem()?.to_string_lossy().into_owned())
        })
}

impl super::jsonl::JsonlState for ParseState {
    fn ingest(&mut self, text: &str) {
        let mut mode = self.mode.take();
        let mut permission = self.permission.take();
        let mut steps = std::mem::take(&mut self.steps);
        // When the current turn started, and whether it is still running.
        //
        // "An assistant entry arrived" is NOT the end of a turn: Claude writes one
        // per model round trip, so a turn that calls three tools writes four of
        // them. Treating the first as the end made the working indicator vanish a
        // second after it appeared, for the whole of a long turn.
        //
        // What actually says "still going" is a tool call with no result yet. Tool
        // results come back as user entries (the ones not typed by a person), so
        // counting calls out and results in tracks the turn exactly.
        let mut turn_started = self.turn_started;
        let mut turn_open = self.turn_open;
        // tool_use id -> where its Part sits, so the result can be written back.
        let mut awaiting_result = std::mem::take(&mut self.awaiting_result);

        for line in text.lines() {
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            self.sequence += 1;
            match value.get("type").and_then(Value::as_str) {
                Some("mode") => {
                    mode = value
                        .get("mode")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                Some("permission-mode") => {
                    permission = value
                        .get("permissionMode")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                Some("user") => {
                    let results = count_blocks(&value, "tool_result");
                    if results > 0 {
                        // Not conversation, but it carries what the calls printed.
                        // This is the whole reason the phone can show a command and
                        // its output where it ran without reading the screen.
                        fill_tool_results(&value, &mut steps, &mut awaiting_result);
                        continue;
                    }
                    let origin = value
                        .get("origin")
                        .and_then(|o| o.get("kind"))
                        .and_then(Value::as_str);
                    if origin.is_some_and(|kind| kind != "human")
                        || value.get("isMeta").and_then(Value::as_bool) == Some(true)
                        || value.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
                    {
                        continue;
                    }
                    let at = timestamp(&value);
                    turn_started = Some(at);
                    turn_open = true;
                    awaiting_result.clear();
                    steps.push(Message {
                        id: entry_id(&value, self.sequence),
                        role: "user",
                        at,
                        text: user_text(&value),
                        reasoning: None,
                        parts: Vec::new(),
                    });
                }
                Some("assistant") => {
                    let at = timestamp(&value);
                    let (text, reasoning, parts) = assistant_blocks(&value);
                    // Remember where each call landed so the result, which arrives
                    // on a later line, can be written back into it.
                    let mut call_ids = tool_use_ids(&value).into_iter();
                    for (index, part) in parts.iter().enumerate() {
                        if let Part::Tool { .. } = part {
                            if let Some(Some(id)) = call_ids.next() {
                                awaiting_result.insert(id, (steps.len(), index));
                            }
                        }
                    }
                    // Still going while a call it just made has not come back.
                    turn_open = !awaiting_result.is_empty();
                    steps.push(Message {
                        id: entry_id(&value, self.sequence),
                        role: "assistant",
                        at,
                        text,
                        reasoning,
                        parts,
                    });
                }
                _ => {}
            }
        }

        super::jsonl::compact_steps(&mut steps, &mut awaiting_result);
        self.mode = mode;
        self.permission = permission;
        self.steps = steps;
        self.turn_started = turn_started;
        self.turn_open = turn_open;
        self.awaiting_result = awaiting_result;
    }

    fn snapshot(&self, session_id: String, revision: i64) -> Option<Transcript> {
        if self.steps.is_empty() {
            return None;
        }

        Some(Transcript {
            prompt_at: None,
            source: "claude",
            session_id,
            title: None,
            // Claude states the permission mode and the conversation mode
            // separately; the permission mode is the one that changes what
            // sending a message does, so it leads.
            mode: self.permission.clone().or_else(|| self.mode.clone()),
            model: None,
            messages: merge_assistant_steps(self.steps.clone()),
            working: self
                .turn_open
                .then(|| self.turn_started.map(|since| Working { since }))
                .flatten(),
            revision,
        })
    }
}

/// How many content blocks of a kind an entry carries.
fn count_blocks(value: &Value, kind: &str) -> i32 {
    value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some(kind))
                .count() as i32
        })
        .unwrap_or(0)
}

fn entry_id(value: &Value, index: usize) -> String {
    value
        .get("uuid")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("entry-{index}"))
}

/// The ids of this entry's tool calls, in the order the blocks appear — the
/// same order `assistant_blocks` pushes their parts, so the two zip.
fn tool_use_ids(value: &Value) -> Vec<Option<String>> {
    value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
                .filter(|b| b.get("name").and_then(Value::as_str).is_some())
                .map(|b| b.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Input keys worth showing, best first.
///
/// What the desktop prints after the tool name is the one field that says
/// which call this was: the command, the file, the pattern. Tools disagree
/// about what to call it, and an unknown tool simply gets no subject rather
/// than a guess at one.
const SUBJECT_KEYS: &[&str] = &[
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "skill",
    "description",
    "prompt",
];

/// The call's subject, on one line.
fn call_subject(input: Option<&Value>) -> Option<String> {
    let input = input?.as_object()?;
    let raw = SUBJECT_KEYS
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))?;
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    const MAX: usize = 140;
    if flat.chars().count() <= MAX {
        return Some(flat);
    }
    Some(flat.chars().take(MAX).collect::<String>() + "…")
}

/// Write each `tool_result` in this entry back into the call it answers.
///
/// The link is the `tool_use_id` the agent itself recorded, so nothing here is
/// matched on text or position.
fn fill_tool_results(
    value: &Value,
    steps: &mut [Message],
    awaiting: &mut HashMap<String, (usize, usize)>,
) {
    let Some(blocks) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
            continue;
        };
        let Some((step, index)) = awaiting.remove(id) else {
            continue;
        };
        let Some(Part::Tool {
            output,
            elided,
            failed,
            ..
        }) = steps.get_mut(step).and_then(|m| m.parts.get_mut(index))
        else {
            continue;
        };
        let (text, elided_now) = clip_output(&tool_result_text(block));
        *failed = block
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        *elided = elided_now;
        *output = Some(text);
    }
}

/// A result's text. The content is a plain string for most tools and an array
/// of blocks for the rest; images and other non-text blocks are skipped rather
/// than described, because a phone showing "[image]" learns nothing.
fn tool_result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn user_text(value: &Value) -> String {
    let Some(content) = value.get("message").and_then(|m| m.get("content")) else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One entry's content, in the order Claude wrote the blocks.
///
/// That order IS the turn's order: a `text` block, the `tool_use` blocks it
/// led to, then the next `text`. Collecting the two kinds into separate lists
/// threw it away, and the phone drew every command after all of the prose
/// while the desktop drew them interleaved.
fn assistant_blocks(value: &Value) -> (String, Option<String>, Vec<Part>) {
    let mut parts: Vec<Part> = Vec::new();
    let mut reasoning = None;
    let Some(blocks) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return (String::new(), None, parts);
    };
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    push_part(
                        &mut parts,
                        Part::Text {
                            text: t.trim().to_string(),
                        },
                    );
                }
            }
            Some("thinking") => {
                if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                    let t = t.trim();
                    if !t.is_empty() {
                        reasoning = Some(t.to_string());
                    }
                }
            }
            Some("tool_use") => {
                if let Some(name) = block.get("name").and_then(Value::as_str) {
                    push_part(
                        &mut parts,
                        Part::Tool {
                            name: name.to_string(),
                            subject: call_subject(block.get("input")),
                            output: None,
                            elided: 0,
                            failed: false,
                        },
                    );
                }
            }
            _ => {}
        }
    }
    (flatten_text(&parts), reasoning, parts)
}
