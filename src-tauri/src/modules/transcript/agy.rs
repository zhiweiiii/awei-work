use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use serde_json::Value;

use super::{clip_output, jsonl, Message, Part, Transcript, Working};

#[derive(Clone, Copy)]
enum Kind {
    User,
    Reply,
    Tool,
}

struct Step {
    kind: Kind,
    at: i64,
    text: String,
    active: bool,
    failed: bool,
}

#[derive(Default)]
struct State {
    steps: BTreeMap<u64, Step>,
    model: Option<String>,
    prompt_at: Option<i64>,
}

impl jsonl::JsonlState for State {
    fn ingest(&mut self, line: &str) {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let Some(index) = record["step_index"].as_u64() else {
            return;
        };
        let at = record["created_at"]
            .as_str()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|at| at.timestamp_millis())
            .unwrap_or(0);
        let kind = match (record["type"].as_str(), record["source"].as_str()) {
            (Some("USER_INPUT"), Some("USER_EXPLICIT")) => Kind::User,
            (Some("PLANNER_RESPONSE" | "AGENT_RESPONSE"), Some("MODEL")) => Kind::Reply,
            (
                Some("GENERIC" | "RUN_COMMAND" | "READ_FILE" | "WRITE_FILE" | "MCP_TOOL"),
                Some("MODEL"),
            ) => Kind::Tool,
            _ => return,
        };
        let content = record["content"].as_str().unwrap_or_default();
        let content = if matches!(kind, Kind::User) {
            let request = content
                .split_once("<USER_REQUEST>")
                .and_then(|(_, request)| request.rsplit_once("</USER_REQUEST>"))
                .map_or(content, |(request, _)| request);
            if at > 0 {
                self.prompt_at = Some(self.prompt_at.unwrap_or(0).max(at));
            }
            request
        } else {
            content
        };
        if let Some(model) = record["model"].as_str().filter(|model| !model.is_empty()) {
            self.model = Some(model.chars().take(120).collect());
        }
        self.steps.insert(
            index,
            Step {
                kind,
                at,
                text: content.trim().chars().take(16384).collect(),
                active: matches!(
                    record["status"].as_str(),
                    Some("RUNNING" | "ACTIVE" | "PENDING")
                ),
                failed: matches!(record["status"].as_str(), Some("ERROR" | "FAILED")),
            },
        );
        if self.steps.len() > 300 {
            self.steps.pop_first();
        }
    }

    fn snapshot(&self, session_id: String, revision: i64) -> Option<Transcript> {
        let mut messages: Vec<Message> = Vec::new();
        let mut working = None;
        let mut turn_start = 0;
        for (index, step) in &self.steps {
            if matches!(step.kind, Kind::User) {
                if step.text.is_empty() {
                    continue;
                }
                turn_start = step.at;
                working = (turn_start > 0).then_some(Working { since: turn_start });
                messages.push(Message {
                    id: index.to_string(),
                    role: "user",
                    at: step.at,
                    text: step.text.clone(),
                    reasoning: None,
                    parts: Vec::new(),
                });
                continue;
            }
            let part = match step.kind {
                Kind::Reply if !step.text.is_empty() => Part::Text {
                    text: step.text.clone(),
                },
                Kind::Tool => {
                    let (output, elided) = clip_output(&step.text);
                    Part::Tool {
                        name: "Antigravity".into(),
                        subject: None,
                        output: (!output.is_empty()).then_some(output),
                        elided,
                        failed: step.failed,
                    }
                }
                _ => continue,
            };
            if step.active && turn_start > 0 {
                working = Some(Working { since: turn_start });
            } else if step.failed || matches!(step.kind, Kind::Reply) {
                working = None;
            }
            if messages.last().is_none_or(|message| message.role == "user") {
                messages.push(Message {
                    id: index.to_string(),
                    role: "assistant",
                    at: step.at,
                    text: String::new(),
                    reasoning: None,
                    parts: Vec::new(),
                });
            }
            let message = messages.last_mut()?;
            message.at = message.at.max(step.at);
            if let Part::Text { text } = &part {
                if !message.text.is_empty() {
                    message.text.push_str("\n\n");
                }
                message.text.push_str(text);
            }
            message.parts.push(part);
        }
        (!messages.is_empty()).then_some(Transcript {
            source: "agy",
            session_id,
            title: None,
            mode: None,
            model: self.model.clone(),
            messages,
            working,
            revision,
            prompt_at: self.prompt_at,
        })
    }
}

pub(super) fn read_file(path: &Path) -> Option<Arc<Transcript>> {
    static CACHE: OnceLock<jsonl::ReaderCache<State>> = OnceLock::new();
    CACHE.get_or_init(jsonl::ReaderCache::new).read(path, || {
        crate::modules::agy::transcript_id(path).map(str::to_owned)
    })
}
