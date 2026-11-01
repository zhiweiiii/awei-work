use crate::modules::transcript::{Part, Transcript};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Activity {
    id: String,
    turn_id: String,
    kind: &'static str,
    title: &'static str,
    text: String,
    failed: bool,
}

fn snippet(text: &str) -> String {
    let mut result = String::new();
    let mut whitespace = false;
    let mut length = 0;
    for character in text
        .trim_start_matches(['#', '*', '`', ' ', '\n'])
        .chars()
        .take(512)
    {
        if character.is_whitespace() {
            whitespace = !result.is_empty();
            continue;
        }
        if character.is_control() {
            continue;
        }
        if whitespace {
            result.push(' ');
            whitespace = false;
        }
        result.push(character);
        length += 1;
        if length >= 160 {
            result.push('…');
            break;
        }
    }
    result
}

pub(super) fn summarize(found: &Transcript, started_at: i64, phase: &str) -> Option<Activity> {
    let user = found
        .messages
        .iter()
        .rposition(|message| message.role == "user" && message.at >= started_at);
    let floor = user.map_or(started_at, |index| found.messages[index].at.max(started_at));
    let (_, message) = found
        .messages
        .iter()
        .enumerate()
        .skip(user.map_or(0, |index| index + 1))
        .rfind(|(_, message)| message.role == "assistant" && message.at >= floor)?;
    let turn_id = user
        .map(|index| found.messages[index].id.clone())
        .unwrap_or_else(|| started_at.to_string());
    if phase == "finished" {
        let text = message
            .parts
            .iter()
            .rev()
            .find_map(|part| match part {
                Part::Text { text } if !text.trim().is_empty() => Some(text.as_str()),
                _ => None,
            })
            .unwrap_or(&message.text);
        if !text.trim().is_empty() {
            return Some(Activity {
                id: format!("{}:result", message.id),
                turn_id,
                kind: "text",
                title: "处理完成",
                text: snippet(text),
                failed: false,
            });
        }
    }
    let Some((part_index, part)) = message.parts.iter().enumerate().next_back() else {
        return (!message.text.trim().is_empty()).then(|| Activity {
            id: format!("{}:text", message.id),
            turn_id,
            kind: "text",
            title: "正在处理",
            text: snippet(&message.text),
            failed: false,
        });
    };
    let (title, text, failed) = match part {
        Part::Text { text } => ("正在处理", snippet(text), false),
        Part::Tool {
            name,
            subject,
            output,
            failed,
            ..
        } => {
            let title = if *failed {
                "步骤执行遇到问题"
            } else {
                match name.to_ascii_lowercase().as_str() {
                    "read" | "read_file" => "正在读取文件",
                    "edit" | "write" | "apply_patch" => "正在修改文件",
                    "bash" | "exec_command" | "shell_command" => "正在执行命令",
                    "grep" | "glob" | "search" => "正在搜索项目",
                    _ => "正在调用工具",
                }
            };
            let detail = if *failed {
                output.as_deref().or(subject.as_deref())
            } else {
                subject.as_deref()
            }
            .unwrap_or(name);
            (title, snippet(detail), *failed)
        }
    };
    if text.is_empty() {
        return None;
    }
    Some(Activity {
        id: format!("{}:{part_index}", message.id),
        turn_id,
        kind: if matches!(part, Part::Tool { .. }) {
            "tool"
        } else {
            "text"
        },
        title,
        text,
        failed,
    })
}
