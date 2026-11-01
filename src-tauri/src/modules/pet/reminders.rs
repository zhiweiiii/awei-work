use serde::Serialize;
use tauri::{Emitter, Manager};

use super::PetWindowState;

const EVENT: &str = "awei-work:pet-reminders";

#[derive(Clone, Serialize)]
pub struct Reminder {
    id: String,
    text: String,
}

pub async fn show_reminder(app: tauri::AppHandle, id: String, text: String) -> Result<(), String> {
    super::open_pet_window(app.clone(), Some(false)).await?;
    let state = app.state::<PetWindowState>();
    let mut reminders = state.reminders.lock().map_err(|_| "宠物提醒不可用")?;
    if reminders.iter().any(|reminder| reminder.id == id) {
        return Ok(());
    }
    if reminders.len() >= 128 {
        return Err("宠物提醒已满，请先查看已有提醒".into());
    }
    reminders.push(Reminder { id, text });
    drop(reminders);
    let _ = app.emit_to(super::LABEL, EVENT, ());
    Ok(())
}

#[tauri::command]
pub fn pet_reminders(state: tauri::State<PetWindowState>) -> Result<Vec<Reminder>, String> {
    state
        .reminders
        .lock()
        .map(|reminders| reminders.iter().take(2).cloned().collect())
        .map_err(|_| "宠物提醒不可用".into())
}

#[tauri::command]
pub fn pet_dismiss_reminder(
    app: tauri::AppHandle,
    state: tauri::State<PetWindowState>,
    id: String,
) -> Result<(), String> {
    let mut reminders = state.reminders.lock().map_err(|_| "宠物提醒不可用")?;
    reminders.retain(|reminder| reminder.id != id);
    drop(reminders);
    let _ = app.emit_to(super::LABEL, EVENT, ());
    Ok(())
}
