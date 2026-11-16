//! Codex writes a JSONL rollout for each session below `~/.codex/sessions`.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::sync::OnceLock;

use serde_json::Value;

use super::{
    clip_output, merge_assistant_steps, push_part, timestamp, Message, Part, Transcript, Working,
};

fn session_id(file: &Path) -> Option<String> {
    let reader = BufReader::new(fs::File::open(file).ok()?.take(192 * 1024));
    for line in reader.lines().take(8).map_while(Result::ok) {
        let value = serde_json::from_str::<Value>(&line).ok()?;
        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        if let Some(id) = value
            .get("payload")
            .and_then(|payload| payload.get("session_id").or_else(|| payload.get("id")))
            .and_then(Value::as_str)
        {
            return Some(id.to_string());
        }
    }
    file.file_stem()
        .and_then(|name| name.to_str())
        .map(str::to_string)
}

#[derive(Default)]
struct ParseState {
    sequence: usize,
    steps: Vec<Message>,
    pending_tools: HashMap<String, (usize, usize)>,
    working: Option<Working>,
    prompt_at: Option<i64>,
}

pub(super) fn read_file(file: &Path) -> Option<std::sync::Arc<Transcript>> {
    static CACHE: OnceLock<super::jsonl::ReaderCache<ParseState>> = OnceLock::new();
    CACHE
        .get_or_init(super::jsonl::ReaderCache::new)
        .read(file, || session_id(file))
}

impl super::jsonl::JsonlState for ParseState {
    fn ingest(&mut self, text: &str) {
        let mut steps = std::mem::take(&mut self.steps);
        let mut pending_tools = std::mem::take(&mut self.pending_tools);
        let mut working = self.working.take();

        for line in text.lines() {
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            self.sequence += 1;
            match value.get("type").and_then(Value::as_str) {
                Some("response_item") => response_item(
                    value.get("payload").unwrap_or(&Value::Null),
                    timestamp(&value),
                    &mut steps,
                    &mut pending_tools,
                    self.sequence,
                ),
                Some("event_msg") => match value
                    .get("payload")
                    .and_then(|payload| payload.get("type"))
                    .and_then(Value::as_str)
                {
                    Some("user_message") => {
                        let at = timestamp(&value);
                        if at > 0 {
                            self.prompt_at = Some(self.prompt_at.unwrap_or(0).max(at));
                        }
                    }
                    Some("task_started") => {
                        let since = value
                            .get("payload")
                            .and_then(|payload| payload.get("started_at"))
                            .and_then(Value::as_i64)
                            .map(|seconds| seconds.saturating_mul(1000))
                            .unwrap_or_else(|| timestamp(&value));
                        working = Some(Working { since });
                    }
                    Some("task_complete") | Some("turn_aborted") => working = None,
                    _ => {}
                },
                _ => {}
            }
        }

        super::jsonl::compact_steps(&mut steps, &mut pending_tools);
        self.steps = steps;
        self.pending_tools = pending_tools;
        self.working = working;
    }

    fn snapshot(&self, session_id: String, revision: i64) -> Option<Transcript> {
        if self.steps.is_empty() {
            return None;
        }

        Some(Transcript {
            prompt_at: self.prompt_at,
            source: "codex",
            session_id,
            title: None,
            mode: None,
            model: None,
            messages: merge_assistant_steps(self.steps.clone()),
            working: self.working.clone(),
            revision,
        })
    }
}

fn response_item(
    item: &Value,
    at: i64,
    steps: &mut Vec<Message>,
    pending_tools: &mut HashMap<String, (usize, usize)>,
    sequence: usize,
) {
    match item.get("type").and_then(Value::as_str) {
        Some("message") => match item.get("role").and_then(Value::as_str) {
            Some("user") => push_message(steps, "user", item, at, sequence),
            Some("assistant") => push_message(steps, "assistant", item, at, sequence),
            _ => {}
        },
        Some("reasoning") => {
            let Some(reasoning) = item.get("summary").and_then(value_text) else {
                return;
            };
            let reasoning = reasoning.trim();
            if reasoning.is_empty() {
                return;
            }
            steps.push(Message {
                id: item_id(item, sequence),
                role: "assistant",
                at,
                text: String::new(),
                reasoning: Some(reasoning.to_string()),
                parts: Vec::new(),
            });
        }
        Some("function_call") | Some("custom_tool_call") => {
            let Some(name) = item.get("name").and_then(Value::as_str) else {
                return;
            };
            let subject = item
                .get("arguments")
                .or_else(|| item.get("input"))
                .and_then(value_text)
                .and_then(subject);
            let step = steps.len();
            steps.push(Message {
                id: item_id(item, sequence),
                role: "assistant",
                at,
                text: String::new(),
                reasoning: None,
                parts: vec![Part::Tool {
                    name: name.to_string(),
                    subject,
                    output: None,
                    elided: 0,
                    failed: false,
                }],
            });
            if let Some(call_id) = item
                .get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
            {
                pending_tools.insert(call_id.to_string(), (step, 0));
            }
        }
        Some("function_call_output") | Some("custom_tool_call_output") => {
            let Some(call_id) = item.get("call_id").and_then(Value::as_str) else {
                return;
            };
            let Some((step, part)) = pending_tools.remove(call_id) else {
                return;
            };
            let Some(Part::Tool {
                output,
                elided,
                failed,
                ..
            }) = steps
                .get_mut(step)
                .and_then(|message| message.parts.get_mut(part))
            else {
                return;
            };
            let text = item.get("output").and_then(value_text).unwrap_or_default();
            let (clipped, elided_now) = clip_output(&text);
            *output = Some(clipped);
            *elided = elided_now;
            *failed = item
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        }
        _ => {}
    }
}

fn push_message(
    steps: &mut Vec<Message>,
    role: &'static str,
    item: &Value,
    at: i64,
    sequence: usize,
) {
    let text = item
        .get("content")
        .and_then(message_text)
        .unwrap_or_default();
    if text.is_empty() {
        return;
    }
    let mut parts = Vec::new();
    if role == "assistant" {
        push_part(&mut parts, Part::Text { text: text.clone() });
    }
    steps.push(Message {
        id: item_id(item, sequence),
        role,
        at,
        text,
        reasoning: None,
        parts,
    });
}

fn item_id(item: &Value, index: usize) -> String {
    item.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("entry-{index}"))
}

fn message_text(content: &Value) -> Option<String> {
    let items = content.as_array()?;
    let text = items
        .iter()
        .filter(|part| {
            matches!(
                part.get("type").and_then(Value::as_str),
                Some("input_text") | Some("output_text") | Some("text")
            )
        })
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty()).then_some(text)
}

fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .or_else(|| item.get("output"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        Value::Object(_) => value
            .get("text")
            .or_else(|| value.get("output"))
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

fn subject(text: String) -> Option<String> {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    const MAX: usize = 140;
    if flat.chars().count() <= MAX {
        return Some(flat);
    }
    Some(flat.chars().take(MAX).collect::<String>() + "…")
}
