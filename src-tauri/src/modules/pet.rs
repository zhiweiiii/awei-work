use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::modules::pty::PtyState;
mod activity;
mod bounds;
pub mod choices;
mod layout;
pub mod reminders;
pub use reminders::show_reminder;
#[cfg(windows)]
mod region;

pub const CONTEXT_EVENT: &str = "awei-work:pet-context";

pub fn context_changed(app: &tauri::AppHandle, focused: Option<bool>) {
    let _ = app.emit(CONTEXT_EVENT, focused);
}

const LABEL: &str = "pet";
const VISIBILITY_EVENT: &str = "awei-work:pet-visibility";
const LAYOUT_EVENT: &str = "awei-work:pet-layout";

#[derive(Default)]
pub struct PetWindowState {
    lifecycle: tokio::sync::Mutex<()>,
    stopping: AtomicBool,
    refresh_queued: AtomicBool,
    layout: std::sync::Mutex<Option<layout::Layout>>,
    reminders: std::sync::Mutex<Vec<reminders::Reminder>>,
    choices: choices::ChoiceState,
    #[cfg(windows)]
    shape: std::sync::Mutex<Option<region::Shape>>,
}

pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<PetWindowState>() {
        state.stopping.store(true, Ordering::Release);
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        if let Err(error) = window.destroy() {
            log::warn!("pet shutdown failed: {error}");
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSession {
    leaf_id: u32,
    project_id: Option<u32>,
    pty_id: Option<u32>,
    run_id: Option<u64>,
    cwd: Option<String>,
    title: Option<String>,
    agent: Option<String>,
    phase: Option<&'static str>,
    for_secs: Option<u64>,
    active: bool,
    viewed: bool,
    watched: bool,
    awaiting_choice: bool,
    activity: Option<activity::Activity>,
}

#[tauri::command]
pub async fn pet_sessions(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
) -> Result<Vec<PetSession>, String> {
    let tabs: Vec<_> = state
        .web_tabs()
        .into_iter()
        .map(|tab| {
            let session = tab.pty_id.and_then(|id| state.web_get(id));
            (tab, session)
        })
        .collect();
    let mut sessions: Vec<PetSession> = tauri::async_runtime::spawn_blocking(move || {
        tabs.into_iter()
            .map(|(tab, session)| {
                let status = session.and_then(|s| s.agent_status(tab.cwd.as_deref()));
                let activity = status.as_ref().and_then(|status| {
                    status.transcript.as_deref().and_then(|found| {
                        activity::summarize(found, status.started_at_ms, status.phase.as_str())
                    })
                });
                PetSession {
                    leaf_id: tab.leaf_id,
                    project_id: tab.project_id,
                    pty_id: tab.pty_id,
                    run_id: status.as_ref().map(|s| s.run_id),
                    cwd: tab.cwd,
                    title: tab.title,
                    agent: status.as_ref().map(|s| s.agent.clone()),
                    phase: status.as_ref().map(|s| s.phase.as_str()),
                    for_secs: status.as_ref().map(|s| s.for_secs),
                    active: tab.active,
                    viewed: tab.viewed || tab.active,
                    watched: false,
                    awaiting_choice: false,
                    activity,
                }
            })
            .collect()
    })
    .await
    .map_err(|error| error.to_string())?;
    let awaiting = choices::awaiting_choices(&app, &sessions).await?;
    let main_focused = app
        .get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(true);
    for session in &mut sessions {
        session.watched = session.viewed && main_focused;
        session.awaiting_choice = session.pty_id.is_some_and(|pty_id| {
            awaiting.contains(&pty_id)
                && state.web_get(pty_id).is_some_and(|current| {
                    current
                        .agent_run()
                        .is_some_and(|(id, _)| Some(id) == session.run_id)
                })
        });
    }
    Ok(sessions)
}

#[tauri::command]
pub async fn pet_reveal(
    app: tauri::AppHandle,
    leaf_id: Option<u32>,
    pty_id: Option<u32>,
    run_id: Option<u64>,
) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
    on_window_thread(window, move |window| {
        let app = window.app_handle();
        let state = app.state::<PtyState>();
        if pty_id.is_some() != run_id.is_some() || (leaf_id.is_none() && pty_id.is_some()) {
            return Err("对话身份不完整，请刷新后重试".into());
        }
        if let Some(leaf_id) = leaf_id {
            let tab = state
                .web_tabs()
                .into_iter()
                .find(|tab| tab.leaf_id == leaf_id)
                .ok_or("该项目已关闭")?;
            if let (Some(pty_id), Some(run_id)) = (pty_id, run_id) {
                if tab.pty_id != Some(pty_id)
                    || state.web_get(pty_id).is_none_or(|session| {
                        session.agent_run().is_none_or(|(id, _)| id != run_id)
                    })
                {
                    return Err("Agent 已退出或已切换，请刷新后重试".into());
                }
            }
        }
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        if let Some(leaf_id) = leaf_id {
            crate::modules::pty::web_activate_leaf(app.clone(), leaf_id);
        }
        window.set_focus().map_err(|error| error.to_string())
    })
    .await
}

fn announce(app: &tauri::AppHandle, visible: bool) -> Result<(), String> {
    app.emit(VISIBILITY_EVENT, visible)
        .map_err(|e| e.to_string())
}

async fn on_window_thread<T: Send + 'static>(
    window: tauri::WebviewWindow,
    action: impl FnOnce(&tauri::WebviewWindow) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let dispatch = window.clone();
    let (reply, result) = tokio::sync::oneshot::channel();
    dispatch
        .run_on_main_thread(move || {
            let _ = reply.send(action(&window));
        })
        .map_err(|error| error.to_string())?;
    result.await.map_err(|_| "宠物窗口操作已中断".to_string())?
}

fn queue_layout(window: &tauri::WebviewWindow) {
    let app = window.app_handle().clone();
    let state = app.state::<PetWindowState>();
    if state.stopping.load(Ordering::Acquire) || state.refresh_queued.swap(true, Ordering::AcqRel) {
        return;
    }
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<PetWindowState>();
        let _guard = state.lifecycle.lock().await;
        let result = on_window_thread(window, |window| {
            let state = window.state::<PetWindowState>();
            if state.stopping.load(Ordering::Acquire)
                || !window.is_visible().map_err(|error| error.to_string())?
            {
                return Ok(());
            }
            let mode = state
                .layout
                .lock()
                .map_err(|_| "pet layout unavailable")?
                .as_ref()
                .map(|layout| layout.mode);
            if let Some(mode) = mode {
                let layout = arrange_panel(window, mode)?;
                window
                    .emit(LAYOUT_EVENT, &layout)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })
        .await;
        state.refresh_queued.store(false, Ordering::Release);
        if let Err(error) = result {
            log::warn!("pet layout refresh failed: {error}");
        }
    });
}

fn surface_work(window: &tauri::WebviewWindow) -> Result<(i32, i32, i32, i32), String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let center = (
        position
            .x
            .saturating_add(((layout::ICON.x + layout::ICON.width / 2.0) * scale).round() as i32),
        position
            .y
            .saturating_add(((layout::ICON.y + layout::ICON.height / 2.0) * scale).round() as i32),
    );
    #[cfg(windows)]
    {
        layout::work_area(center)
    }
    #[cfg(not(windows))]
    {
        let _ = center;
        let monitor = window
            .current_monitor()
            .map_err(|e| e.to_string())?
            .ok_or("pet monitor unavailable")?;
        let area = monitor.work_area();
        Ok((
            area.position.x,
            area.position.y,
            area.position.x + area.size.width as i32,
            area.position.y + area.size.height as i32,
        ))
    }
}

fn initialize_surface(window: &tauri::WebviewWindow) -> Result<(), String> {
    use tauri_plugin_window_state::{StateFlags, WindowExt};
    window
        .restore_state(StateFlags::POSITION | StateFlags::SIZE)
        .map_err(|e| e.to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size: tauri::PhysicalSize<u32> =
        tauri::LogicalSize::new(layout::CANVAS_WIDTH, layout::CANVAS_HEIGHT).to_physical(scale);
    #[cfg(windows)]
    bounds::apply(
        window.hwnd().map_err(|e| e.to_string())?.0,
        (position.x, position.y),
        (size.width, size.height),
    )?;
    #[cfg(not(windows))]
    window.set_size(size).map_err(|e| e.to_string())?;
    window
        .set_min_size(Some(tauri::LogicalSize::new(
            layout::CANVAS_WIDTH,
            layout::CANVAS_HEIGHT,
        )))
        .map_err(|e| e.to_string())?;
    window
        .set_max_size(Some(tauri::LogicalSize::new(
            layout::CANVAS_WIDTH,
            layout::CANVAS_HEIGHT,
        )))
        .map_err(|e| e.to_string())
}

fn arrange_panel(
    window: &tauri::WebviewWindow,
    mode: layout::Mode,
) -> Result<layout::Layout, String> {
    let app = window.app_handle();
    let state = app.state::<PetWindowState>();
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let mut position = window.outer_position().map_err(|e| e.to_string())?;
    let (left, top, right, bottom) = surface_work(window)?;
    let offset_x = (layout::ICON.x * scale).round() as i32;
    let offset_y = (layout::ICON.y * scale).round() as i32;
    let icon_width = (layout::ICON.width * scale).ceil() as i32;
    let icon_height = (layout::ICON.height * scale).ceil() as i32;
    let clamped = bounds::anchor(
        (
            position.x.saturating_add(offset_x),
            position.y.saturating_add(offset_y),
        ),
        (icon_width as u32, icon_height as u32),
        (icon_width as u32, icon_height as u32),
        Some((
            left,
            top,
            right.saturating_sub(left) as u32,
            bottom.saturating_sub(top) as u32,
        )),
    );
    let x = clamped.0.saturating_sub(offset_x);
    let y = clamped.1.saturating_sub(offset_y);
    if x != position.x || y != position.y {
        #[cfg(windows)]
        {
            let size = window.outer_size().map_err(|e| e.to_string())?;
            bounds::apply(
                window.hwnd().map_err(|e| e.to_string())?.0,
                (x, y),
                (size.width, size.height),
            )?;
        }
        #[cfg(not(windows))]
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        position = tauri::PhysicalPosition::new(x, y);
    }
    let mut stored = state.layout.lock().map_err(|_| "pet layout unavailable")?;
    let revision = stored
        .as_ref()
        .map_or(1, |current| current.revision.saturating_add(1));
    let next = layout::arrange(
        mode,
        (f64::from(position.x) / scale, f64::from(position.y) / scale),
        layout::Rect {
            x: f64::from(left) / scale,
            y: f64::from(top) / scale,
            width: (f64::from(right) - f64::from(left)) / scale,
            height: (f64::from(bottom) - f64::from(top)) / scale,
        },
        revision,
    );
    *stored = Some(next.clone());
    drop(stored);
    #[cfg(windows)]
    {
        let shape = region::Shape::new(&next, scale)?;
        let mut previous = state.shape.lock().map_err(|_| "pet region unavailable")?;
        let changed = previous.as_ref() != Some(&shape);
        if changed {
            *previous = Some(shape.clone());
        }
        drop(previous);
        if changed {
            if let Err(error) = region::apply(window.hwnd().map_err(|e| e.to_string())?.0, &shape) {
                if let Ok(mut cached) = state.shape.lock() {
                    *cached = None;
                }
                return Err(error);
            }
        }
    }
    Ok(next)
}

#[tauri::command]
pub async fn pet_set_notification(
    app: tauri::AppHandle,
    notification: bool,
) -> Result<layout::Layout, String> {
    let state = app.state::<PetWindowState>();
    let _guard = state.lifecycle.lock().await;
    if state.stopping.load(Ordering::Acquire) {
        return Err("程序正在退出".into());
    }
    let window = app.get_webview_window(LABEL).ok_or("宠物窗口不可用")?;
    on_window_thread(window, move |window| {
        if !window.is_visible().map_err(|e| e.to_string())? {
            return Err("宠物窗口已隐藏".into());
        }
        arrange_panel(
            window,
            if notification {
                layout::Mode::Notice
            } else {
                layout::Mode::Compact
            },
        )
    })
    .await
}

#[tauri::command]
pub async fn open_pet_window(app: tauri::AppHandle, focus: Option<bool>) -> Result<(), String> {
    let state = app.state::<PetWindowState>();
    let _guard = state.lifecycle.lock().await;
    if state.stopping.load(Ordering::Acquire) || app.get_webview_window("main").is_none() {
        return Err("程序正在退出".into());
    }
    let window = if let Some(window) = app.get_webview_window(LABEL) {
        window
    } else {
        let mut builder =
            WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("pet.html".into()))
                .title("awei-work pet")
                .inner_size(layout::CANVAS_WIDTH, layout::CANVAS_HEIGHT)
                .resizable(false)
                .decorations(false)
                .shadow(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(false)
                .focused(false);
        if let Some(monitor) = app.primary_monitor().map_err(|e| e.to_string())? {
            let area = monitor.work_area();
            let scale = monitor.scale_factor();
            builder = builder.position(
                (f64::from(area.position.x) + f64::from(area.size.width) - 24.0) / scale
                    - layout::ICON.x
                    - layout::ICON.width,
                (f64::from(area.position.y) + f64::from(area.size.height) - 24.0) / scale
                    - layout::ICON.y
                    - layout::ICON.height,
            );
        }
        let window = builder.build().map_err(|e| e.to_string())?;
        if let Err(error) = on_window_thread(window.clone(), initialize_surface).await {
            let _ = window.destroy();
            return Err(error);
        }
        #[cfg(windows)]
        if let Ok(mut cached) = state.shape.lock() {
            *cached = None;
        }
        let handle = app.clone();
        let shaped = window.clone();
        window.on_window_event(move |event| {
            if matches!(
                event,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                queue_layout(&shaped);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = close_pet_window(handle).await {
                        log::warn!("pet close failed: {error}");
                    }
                });
            }
        });
        window
    };
    on_window_thread(window, move |window| {
        let app = window.app_handle();
        let state = app.state::<PetWindowState>();
        if state.stopping.load(Ordering::Acquire) || app.get_webview_window("main").is_none() {
            let _ = window.destroy();
            return Err("程序正在退出".into());
        }
        if !window.is_visible().map_err(|e| e.to_string())? {
            arrange_panel(window, layout::Mode::Compact)?;
            window.show().map_err(|e| e.to_string())?;
        }
        announce(app, true)?;
        if focus.unwrap_or(true) && !window.is_focused().map_err(|e| e.to_string())? {
            window.set_focus().map_err(|e| e.to_string())
        } else {
            Ok(())
        }
    })
    .await
}

#[tauri::command]
pub async fn close_pet_window(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<PetWindowState>();
    let _guard = state.lifecycle.lock().await;
    if state.stopping.load(Ordering::Acquire) {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        on_window_thread(window, |window| {
            window.hide().map_err(|e| e.to_string())?;
            announce(window.app_handle(), false)
        })
        .await?;
    }
    Ok(())
}

#[tauri::command]
pub fn pet_window_open(app: tauri::AppHandle) -> bool {
    app.get_webview_window(LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}
