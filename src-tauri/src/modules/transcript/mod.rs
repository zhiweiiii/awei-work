//! What a coding agent actually said, read from where it writes it down.
//!
//! The phone used to reconstruct an agent conversation by parsing the TUI's
//! screen. That works, but it is a parse of a picture: a side panel reads as
//! speech, a spinner reads as a sentence, and every layout change is a bug.
//! Every supported agent persists the conversation in a structured
//! form, so the conversation is read from there and the screen is left to do
//! the one thing only it knows: what the program is asking you to pick right
//! now (see `docs/mobile.md`).
//!
//! Three backends, one shape:
//!
//! - `claude` - `~/.claude/projects/<escaped cwd>/<session>.jsonl`, appended
//!   as the session runs. Shared incremental JSONL parsing.
//! - `opencode` - `~/.local/share/opencode/opencode.db`, SQLite. Its TUI opens
//!   no port and `opencode export` costs a process per read, so the database
//!   is read directly, read-only.
//! - `codex` - `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`.

mod claude;
mod codex;
mod jsonl;
mod opencode;

pub(crate) fn read_file(file: &std::path::Path, agent: &str) -> Option<std::sync::Arc<Transcript>> {
    match agent {
        "claude" => claude::read_file(file, false),
        "codex" => codex::read_file(file, false),
        _ => None,
    }
}

pub(crate) fn read_activity_at(file: &std::path::Path, agent: &str) -> Option<i64> {
    let transcript = match agent {
        "claude" => claude::read_file(file, true),
        "codex" => codex::read_file(file, true),
        _ => None,
    }?;
    transcript.last_user_message_at()
}

use serde::Serialize;

pub(super) fn timestamp(value: &serde_json::Value) -> i64 {
    value
        .get("timestamp")
        .and_then(serde_json::Value::as_str)
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
        .map(|at| at.timestamp_millis())
        .unwrap_or(0)
}

/// One piece of a turn, in the order the agent produced it.
///
/// A turn is not "some prose and some tool calls", it is prose, then the tools
/// that prose led to, then more prose. Collapsing it into two flat lists put
/// every command at the bottom of the answer, so the phone showed all the
/// writing together and all the commands together while the desktop showed
/// them interleaved.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Part {
    /// Prose the agent wrote.
    Text { text: String },
    /// A tool it ran before writing the next piece, and what came back.
    ///
    /// The agent records the call and its result as structured fields linked
    /// by an id, so this is read rather than recognised: no screen scraping,
    /// no matching on how the TUI happens to draw a command today, and nothing
    /// to de-duplicate against, because it is the same record the conversation
    /// itself comes from.
    Tool {
        /// "Bash", "Read", "Edit".
        name: String,
        /// What it was called on, in one line: the command for Bash, the path
        /// for Read. This is what the desktop prints in parentheses after the
        /// tool name.
        #[serde(skip_serializing_if = "Option::is_none")]
        subject: Option<String>,
        /// What it printed, truncated - see `TOOL_OUTPUT_LINES`. None while
        /// the call is still outstanding.
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        /// Lines truncation dropped, so the page can say how much is missing
        /// instead of quietly showing less than there was.
        #[serde(skip_serializing_if = "is_zero")]
        elided: usize,
        /// The tool reported failure.
        #[serde(skip_serializing_if = "is_false")]
        failed: bool,
    },
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Lines of a tool's output carried to the phone, and the byte ceiling that
/// bounds a single very long line.
///
/// A transcript is mostly tool results - the biggest on this machine is 48 MB
/// of them - and the phone is showing a conversation, not an archive. Enough
/// to see what a command did, with the count of what was dropped.
const TOOL_OUTPUT_LINES: usize = 40;
const TOOL_OUTPUT_BYTES: usize = 4096;

/// Trim a tool's output to something a phone can show, reporting how many
/// lines were dropped.
pub(crate) fn clip_output(text: &str) -> (String, usize) {
    let text = text.trim_end();
    if text.is_empty() {
        return (String::new(), 0);
    }
    let total = text.lines().count();
    let mut out = String::new();
    let mut kept: usize = 0;
    for line in text.lines().take(TOOL_OUTPUT_LINES) {
        if out.len() + line.len() > TOOL_OUTPUT_BYTES && kept > 0 {
            break;
        }
        if kept > 0 {
            out.push('\n');
        }
        out.push_str(line);
        kept += 1;
    }
    let end = out
        .char_indices()
        .map(|(i, c)| i + c.len_utf8())
        .take_while(|end| *end <= TOOL_OUTPUT_BYTES)
        .last()
        .unwrap_or(0);
    if end < out.len() {
        kept = kept.saturating_sub(1);
        out.truncate(end);
    }
    (out, total.saturating_sub(kept))
}

/// One turn of the conversation.
///
/// Consecutive steps by the agent are merged into a single turn: both tools
/// write a row per model round trip (a tool call, its result, the next call),
/// and a reader wants the answer, not the machinery. Merging concatenates
/// `parts`, so the order within the turn survives it.
#[derive(Serialize, Clone, Debug)]
pub struct Message {
    pub id: String,
    /// "user" or "assistant".
    pub role: &'static str,
    /// Epoch milliseconds.
    pub at: i64,
    /// What was said: the message for a user turn, the prose flattened out of
    /// `parts` for an agent one. Empty for a turn that only ran tools. This is
    /// what comparisons are made against — echo matching, screen de-duplication
    /// — where the structure is not wanted.
    pub text: String,
    /// The agent's own reasoning for this turn, last block only - the earlier
    /// ones are steps toward it and reading them all back is not thinking, it
    /// is a transcript of thinking.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// The turn as it happened. Empty for a user turn, whose whole content is
    /// `text`.
    pub parts: Vec<Part>,
}

/// The agent is still producing an answer.
#[derive(Serialize, Clone, Debug)]
pub struct Working {
    /// Epoch milliseconds the current turn started, so the page can count up
    /// on its own rather than being told the elapsed time on every poll.
    pub since: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Transcript {
    /// "claude", "codex", or "opencode".
    pub source: &'static str,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The mode the session is in - what sending a message will DO.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working: Option<Working>,
    /// Snapshot generation. A poller compares this instead of
    /// diffing the whole conversation.
    pub revision: i64,
    #[serde(skip)]
    pub prompt_at: Option<i64>,
}

impl Transcript {
    pub fn last_user_message_at(&self) -> Option<i64> {
        if self.source == "codex" {
            return self.prompt_at;
        }
        self.messages
            .iter()
            .filter(|message| message.role == "user" && message.at > 0)
            .map(|message| message.at)
            .max()
    }
}

pub(crate) fn read_opencode(cwd: &str) -> Option<std::sync::Arc<Transcript>> {
    opencode::read(cwd)
}

pub(crate) fn opencode_fingerprint() -> Option<i64> {
    opencode::changed_at()
}

/// Windows paths reach us with either separator depending on who wrote them
/// (the PTY reports backslashes, opencode stores forward slashes), and drive
/// letters differ in case. Compared in a normal form so a directory matches
/// itself.
/// Where Claude Code keeps this directory's sessions. Exposed so the session
/// picker can list them without duplicating the escaping rules, which are lossy
/// enough that `claude.rs` has a fallback search for them.
pub(crate) fn claude_project_dir(cwd: &str) -> Option<std::path::PathBuf> {
    claude::project_dir(cwd)
}

pub(crate) fn same_dir(a: &str, b: &str) -> bool {
    normalize_dir(a) == normalize_dir(b)
}

pub(crate) fn normalize_dir(path: &str) -> String {
    let mut out = path.replace('\\', "/").to_lowercase();
    while out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    out
}

/// Merge the agent's consecutive steps into one turn.
///
/// Shared by all backends: they disagree about everything except that a turn
/// is "one user message, then whatever the agent did until it asked again".
pub(crate) fn merge_assistant_steps(steps: Vec<Message>) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::with_capacity(steps.len());
    for step in steps {
        let Some(last) = out.last_mut() else {
            out.push(step);
            continue;
        };
        if last.role != "assistant" || step.role != "assistant" {
            out.push(step);
            continue;
        }
        if !step.text.is_empty() {
            if !last.text.is_empty() {
                last.text.push('\n');
            }
            last.text.push_str(&step.text);
        }
        // Last reasoning wins: the earlier blocks are the steps that led to it.
        if step.reasoning.is_some() {
            last.reasoning = step.reasoning;
        }
        for part in step.parts {
            push_part(&mut last.parts, part);
        }
        last.at = step.at;
    }
    // A turn that neither said anything nor thought anything is pure
    // machinery; its tools are already recorded on the turn it belongs to.
    out.retain(|m| {
        m.role == "user" || !m.text.is_empty() || m.reasoning.is_some() || !m.parts.is_empty()
    });
    out
}

/// Append a part, folding consecutive prose together.
///
/// Two prose blocks in a row are one run of writing, so they merge; a tool
/// call always stands on its own, where it ran. Empty prose is dropped rather
/// than rendered as a gap.
pub(crate) fn push_part(parts: &mut Vec<Part>, part: Part) {
    match part {
        Part::Text { text } if text.is_empty() => {}
        Part::Text { text } => match parts.last_mut() {
            Some(Part::Text { text: last }) => {
                last.push('\n');
                last.push_str(&text);
            }
            _ => parts.push(Part::Text { text }),
        },
        // Tool calls are never folded together: each one carries its own
        // subject and its own output, and they are shown where they ran.
        tool => parts.push(tool),
    }
}

/// The prose out of a turn's parts, joined the way the old flat `text` was.
pub(crate) fn flatten_text(parts: &[Part]) -> String {
    let mut out = String::new();
    for part in parts {
        if let Part::Text { text } = part {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(text);
        }
    }
    out
}
