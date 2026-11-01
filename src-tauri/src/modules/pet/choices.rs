use super::PetWindowState;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

#[derive(Default)]
pub(super) struct ChoiceState {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Vec<ChoiceReply>>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChoiceTarget {
    leaf_id: u32,
    pty_id: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceReply {
    pty_id: u32,
    awaiting_choice: bool,
}

pub(super) async fn awaiting_choices(
    app: &tauri::AppHandle,
    sessions: &[super::PetSession],
) -> Result<HashSet<u32>, String> {
    let targets: Vec<_> = sessions
        .iter()
        .filter(|session| session.agent.is_some() && session.run_id.is_some())
        .filter_map(|session| {
            session.pty_id.map(|pty_id| ChoiceTarget {
                leaf_id: session.leaf_id,
                pty_id,
            })
        })
        .collect();
    if targets.is_empty() {
        return Ok(HashSet::new());
    }
    let state = app.state::<PetWindowState>();
    let id = state.choices.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = state.choices.pending.lock().map_err(|_| "选项状态不可用")?;
        if pending.len() >= 32 {
            return Err("选项状态查询繁忙".into());
        }
        pending.insert(id, sender);
    }
    let sent = app.emit_to(
        "main",
        "awei-work:pet-choice-status",
        serde_json::json!({ "requestId": id, "targets": targets }),
    );
    let result = if sent.is_ok() {
        tokio::time::timeout(Duration::from_millis(1500), receiver)
            .await
            .map_err(|_| "终端状态未响应".to_string())
            .and_then(|reply| reply.map_err(|_| "选项状态查询已中断".to_string()))
    } else {
        Err("无法读取终端状态".into())
    };
    state
        .choices
        .pending
        .lock()
        .map_err(|_| "选项状态不可用")?
        .remove(&id);
    Ok(result?
        .into_iter()
        .filter(|reply| reply.awaiting_choice)
        .map(|reply| reply.pty_id)
        .collect())
}

#[tauri::command]
pub fn pet_choice_status_reply(
    window: tauri::WebviewWindow,
    state: tauri::State<PetWindowState>,
    request_id: u64,
    responses: Vec<ChoiceReply>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("状态只能由主窗口读取".into());
    }
    let mut ids = HashSet::new();
    if responses.len() > 4096 || responses.iter().any(|reply| !ids.insert(reply.pty_id)) {
        return Err("无效选项状态".into());
    }
    let sender = state
        .choices
        .pending
        .lock()
        .map_err(|_| "选项状态不可用")?
        .remove(&request_id);
    if let Some(sender) = sender {
        let _ = sender.send(responses);
    }
    Ok(())
}
