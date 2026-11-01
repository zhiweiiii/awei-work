//! Commands queued to run later.
//!
//! The timer lives here rather than in a page, and that is the whole design.
//! A phone that scheduled something locks its screen; a browser tab that is
//! closed takes its timers with it. The desktop process is the only thing
//! still running when the moment arrives, so it is the only honest place to
//! keep the clock. Both clients do nothing but ask this module to remember
//! something and read back what it remembers.
//!
//! Jobs are persisted before background execution. Terminal bindings are session-scoped.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use super::pty::PtyState;

mod background;
mod storage;

/// Emitted whenever the list changes, so the desktop refreshes without polling.
pub const SCHEDULE_EVENT: &str = "terax:schedules";

/// How long a due job keeps trying before it is given up on.
///
/// A cold terminal tab has no pty until the frontend opens one, and asking for
/// it is asynchronous (see `web_leaf_session`, which emits an activation
/// request and returns nothing this time round). Retrying across a few ticks
/// is what lets a job fire into a tab the user has not touched since launch;
/// retrying forever would leave a job for a tab that is gone queued for the
/// life of the process.
const RETRY_WINDOW: Duration = Duration::from_secs(60);

/// The longest a command may be queued for. Two days is far past the point
/// where the terminal it names still exists.
const MAX_DELAY: Duration = Duration::from_secs(48 * 60 * 60);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    Terminal,
    Codex,
    Claude,
    Pet,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Job {
    pub id: u64,
    /// The desktop leaf (terminal tab) this runs in.
    ///
    /// Bound to the leaf, not to the live pty id: a session that respawns
    /// keeps its leaf, and it is the id both clients already use to name a
    /// terminal - the phone attaches by leaf, the desktop syncs tabs by leaf.
    pub leaf_id: u32,
    pub command: String,
    /// Epoch milliseconds.
    pub fire_at: i64,
    pub created_at: i64,
    pub daily_time: Option<String>,
    pub target: Target,
    pub running: bool,
    pub finished: bool,
    pub last_result: Option<String>,
    #[serde(default)]
    pub paused: bool,
}

impl Job {
    fn is_due(&self, now: i64) -> bool {
        self.fire_at <= now && !self.running && !self.finished && !self.paused
    }
}

#[derive(Default)]
pub struct ScheduleState {
    jobs: Mutex<Vec<Job>>,
    next_id: AtomicU64,
    /// Bumped on every change. A poller compares this instead of diffing the
    /// list, so an unchanged queue costs one atomic read.
    revision: AtomicU64,
    active: AtomicUsize,
    storage: OnceLock<Result<storage::Storage, String>>,
    storage_error: Mutex<Option<String>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl ScheduleState {
    fn save(&self, jobs: &[Job]) -> Result<(), String> {
        let result = match self.storage.get() {
            Some(Ok(storage)) => storage.save(jobs),
            Some(Err(error)) => Err(error.clone()),
            None => Err("定时任务存储尚未初始化".into()),
        };
        *self.storage_error.lock().unwrap() = result.as_ref().err().cloned();
        result
    }

    fn insert(&self, job: &Job) -> Result<(), String> {
        let mut jobs = self.jobs.lock().unwrap();
        if jobs.len() >= 128 {
            return Err("最多保留 128 个任务，请清理已完成任务".into());
        }
        jobs.push(job.clone());
        if let Err(error) = self.save(&jobs) {
            jobs.pop();
            return Err(error);
        }
        self.revision.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Relaxed)
    }

    pub fn list(&self) -> Vec<Job> {
        let mut jobs = self.jobs.lock().unwrap().clone();
        jobs.sort_by_key(|j| j.fire_at);
        jobs
    }

    pub fn add(&self, leaf_id: u32, command: String, delay: Duration) -> Result<Job, String> {
        let command = command.trim().to_string();
        if command.is_empty() || command.len() > 65536 {
            return Err("empty command".into());
        }
        if delay > MAX_DELAY {
            return Err("delay too long".into());
        }
        let now = now_ms();
        let job = Job {
            id: self.next_id.fetch_add(1, Ordering::Relaxed) + 1,
            leaf_id,
            command,
            fire_at: now + delay.as_millis() as i64,
            created_at: now,
            daily_time: None,
            target: Target::Terminal,
            running: false,
            finished: false,
            last_result: None,
            paused: false,
        };
        self.insert(&job)?;
        Ok(job)
    }

    pub fn cancel(&self, id: u64) -> Result<bool, String> {
        let mut jobs = self.jobs.lock().unwrap();
        let Some(index) = jobs.iter().position(|j| j.id == id) else {
            return Ok(false);
        };
        let removed = jobs.remove(index);
        if let Err(error) = self.save(&jobs) {
            jobs.insert(index, removed);
            return Err(error);
        }
        self.revision.fetch_add(1, Ordering::Relaxed);
        Ok(true)
    }

    fn rebind(&self, id: u64, leaf_id: u32) -> Result<(), String> {
        let mut jobs = self.jobs.lock().unwrap();
        let index = jobs
            .iter()
            .position(|j| {
                j.id == id && j.target == Target::Terminal && j.paused && !j.running && !j.finished
            })
            .ok_or("任务不存在或无需绑定")?;
        let previous = jobs[index].clone();
        jobs[index].leaf_id = leaf_id;
        jobs[index].paused = false;
        jobs[index].fire_at = jobs[index].fire_at.max(now_ms());
        jobs[index].last_result = None;
        if let Err(error) = self.save(&jobs) {
            jobs[index] = previous;
            return Err(error);
        }
        self.revision.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// Never reuse an expired terminal binding for another session.
    pub fn forget_leaf(&self, leaf_id: u32) {
        let mut jobs = self.jobs.lock().unwrap();
        let mut changed = false;
        for job in jobs.iter_mut().filter(|j| {
            j.target == Target::Terminal && j.leaf_id == leaf_id && !j.paused && !j.finished
        }) {
            job.paused = true;
            job.last_result = Some("原终端已关闭，请重新绑定终端".into());
            changed = true;
        }
        if changed {
            if let Err(error) = self.save(&jobs) {
                log::error!("schedule persistence: {error}");
            }
            self.revision.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Jobs whose moment has come, without removing them: a job is only taken
    /// off the queue once it has actually been written to a terminal, or once
    /// it has spent its retry window failing to find one.
    fn due(&self, now: i64) -> Vec<Job> {
        if self.storage_error.lock().unwrap().is_some() {
            return Vec::new();
        }
        self.jobs
            .lock()
            .unwrap()
            .iter()
            .filter(|j| j.is_due(now))
            .cloned()
            .collect()
    }

    fn complete(&self, job: &Job, result: Result<(), String>) {
        let mut jobs = self.jobs.lock().unwrap();
        let Some(current) = jobs.iter_mut().find(|j| {
            j.id == job.id && j.leaf_id == job.leaf_id && j.fire_at == job.fire_at && !j.finished
        }) else {
            return;
        };
        current.running = false;
        current.last_result = Some(match result {
            Ok(()) => "已发送到终端".into(),
            Err(error) => format!("失败：{error}"),
        });
        if let Some(time) = &job.daily_time {
            match next_daily(time, now_ms()) {
                Ok(next) => current.fire_at = next,
                Err(_) => current.finished = true,
            }
        } else {
            current.finished = true;
        }
        if current.finished {
            current.paused = false;
        }
        if let Err(error) = self.save(&jobs) {
            log::error!("schedule persistence: {error}");
        }
        self.revision.fetch_add(1, Ordering::Relaxed);
    }

    fn finish_background(&self, job: &Job, result: Result<String, String>) {
        let mut jobs = self.jobs.lock().unwrap();
        if let Some(current) = jobs.iter_mut().find(|j| j.id == job.id) {
            current.running = false;
            current.last_result = Some(match result {
                Ok(text) => format!("已完成：{text}"),
                Err(error) => format!("失败：{error}"),
            });
            match job.daily_time.as_ref().map(|t| next_daily(t, now_ms())) {
                Some(Ok(next)) => current.fire_at = next,
                _ => current.finished = true,
            }
            self.revision.fetch_add(1, Ordering::Relaxed);
            if let Err(error) = self.save(&jobs) {
                log::error!("schedule persistence: {error}");
            }
        }
    }
}

fn next_daily(time: &str, after: i64) -> Result<i64, String> {
    let (hour, minute) = time.split_once(':').ok_or("invalid time")?;
    let hour: u32 = hour.parse().map_err(|_| "invalid hour")?;
    let minute: u32 = minute.parse().map_err(|_| "invalid minute")?;
    if hour > 23 || minute > 59 {
        return Err("invalid time".into());
    }
    let now = Local
        .timestamp_millis_opt(after)
        .single()
        .ok_or("invalid date")?;
    let mut day = now.date_naive();
    for _ in 0..4 {
        let local = day.and_hms_opt(hour, minute, 0).ok_or("invalid time")?;
        if let Some(candidate) = Local.from_local_datetime(&local).earliest() {
            if candidate.timestamp_millis() > after {
                return Ok(candidate.timestamp_millis());
            }
        }
        day = day.succ_opt().ok_or("invalid date")?;
    }
    Err("could not resolve local time".into())
}

#[tauri::command]
pub fn schedule_add_at(
    state: tauri::State<ScheduleState>,
    app: tauri::AppHandle,
    leaf_id: Option<u32>,
    command: String,
    fire_at: Option<i64>,
    daily_time: Option<String>,
    target: Target,
) -> Result<Job, String> {
    let now = now_ms();
    let fire_at = match &daily_time {
        Some(time) => next_daily(time, now)?,
        None => fire_at.filter(|t| *t > now).ok_or("请选择未来的发送时间")?,
    };
    let command = command.trim().to_string();
    if command.is_empty() || command.len() > 65536 {
        return Err("消息为空或过长".into());
    }
    let leaf_id = if target == Target::Terminal {
        leaf_id.ok_or("请选择终端")?
    } else {
        0
    };
    let job = Job {
        id: state.next_id.fetch_add(1, Ordering::Relaxed) + 1,
        leaf_id,
        command,
        fire_at,
        created_at: now,
        daily_time,
        target,
        running: false,
        finished: false,
        last_result: None,
        paused: false,
    };
    state.insert(&job)?;
    let _ = app.emit(SCHEDULE_EVENT, state.list());
    Ok(job)
}

/// Write a job's command into its terminal, as if it had been typed there.
fn deliver(app: &tauri::AppHandle, job: &Job) -> Result<(), String> {
    let state = app.state::<PtyState>();
    // Resolving a leaf that has never been opened emits an activation request
    // and returns nothing; the next tick finds the pty the frontend spawned.
    let session = state
        .web_leaf_session(job.leaf_id, app)
        .ok_or_else(|| "terminal not open yet".to_string())?;
    let schedule = app.state::<ScheduleState>();
    let mut jobs = schedule.jobs.lock().unwrap();
    let current = jobs
        .iter_mut()
        .find(|j| {
            j.id == job.id
                && j.leaf_id == job.leaf_id
                && j.fire_at == job.fire_at
                && j.is_due(now_ms())
        })
        .ok_or("任务已取消或暂停")?;
    current.running = true;
    if let Err(error) = schedule.save(&jobs) {
        if let Some(current) = jobs.iter_mut().find(|j| j.id == job.id) {
            current.running = false;
        }
        return Err(error);
    }
    session.web_submit(
        &format!("schedule-{}-{}", job.id, job.fire_at),
        &job.command,
    )?;
    drop(jobs);
    Ok(())
}

/// Start the one-second tick that fires due jobs.
///
/// Deliberately its own thread rather than work folded into an existing loop:
/// the web connection loop is what forwards terminal output, and anything
/// blocking in there stalls the stream for every viewer.
pub fn start(app: tauri::AppHandle) {
    let state = app.state::<ScheduleState>();
    let loaded = storage::Storage::load(&app);
    let storage = loaded.map(|(storage, jobs)| {
        state.next_id.store(
            jobs.iter().map(|j| j.id).max().unwrap_or(0),
            Ordering::Relaxed,
        );
        *state.jobs.lock().unwrap() = jobs;
        storage
    });
    if let Err(error) = &storage {
        log::error!("schedule restore: {error}");
        *state.storage_error.lock().unwrap() = Some(error.clone());
    }
    let _ = state.storage.set(storage);
    if matches!(state.storage.get(), Some(Ok(_))) {
        *state.storage_error.lock().unwrap() = None;
    }
    let _ = app.emit(SCHEDULE_EVENT, state.list());
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let state = app.state::<ScheduleState>();
        let now = now_ms();
        let due = state.due(now);
        if due.is_empty() {
            continue;
        }
        let mut changed = false;
        for job in due {
            if job.target != Target::Terminal {
                let agent = job.target != Target::Pet;
                if agent && state.active.load(Ordering::Relaxed) >= 4 {
                    continue;
                }
                {
                    let mut jobs = state.jobs.lock().unwrap();
                    let Some(current) = jobs
                        .iter_mut()
                        .find(|j| j.id == job.id && j.fire_at == job.fire_at && j.is_due(now_ms()))
                    else {
                        continue;
                    };
                    current.running = true;
                    if let Err(error) = state.save(&jobs) {
                        if let Some(current) = jobs.iter_mut().find(|j| j.id == job.id) {
                            current.running = false;
                        }
                        log::error!("schedule persistence: {error}");
                        break;
                    }
                }
                if agent {
                    state.active.fetch_add(1, Ordering::Relaxed);
                }
                state.revision.fetch_add(1, Ordering::Relaxed);
                let worker_app = app.clone();
                std::thread::spawn(move || {
                    let result = if job.target == Target::Pet {
                        tauri::async_runtime::block_on(super::pet::show_reminder(
                            worker_app.clone(),
                            format!("{}:{}", job.id, job.fire_at),
                            job.command.clone(),
                        ))
                        .map(|()| "已交给宠物提醒".to_string())
                    } else {
                        background::run(&worker_app, &job)
                    };
                    let state = worker_app.state::<ScheduleState>();
                    state.finish_background(&job, result);
                    if agent {
                        state.active.fetch_sub(1, Ordering::Relaxed);
                    }
                    let _ = worker_app.emit(SCHEDULE_EVENT, state.list());
                    let error = state.storage_error.lock().unwrap().clone();
                    if let Some(error) = error {
                        let _ = worker_app.emit("terax:schedule-error", error);
                    }
                });
                changed = true;
                continue;
            }
            match deliver(&app, &job) {
                Ok(()) => {
                    log::info!("schedule: ran job {} on leaf {}", job.id, job.leaf_id);
                    state.complete(&job, Ok(()));
                    changed = true;
                }
                Err(reason) => {
                    let started = state
                        .jobs
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|j| j.id == job.id && j.running);
                    let waited = Duration::from_millis((now - job.fire_at).max(0) as u64);
                    if started || waited > RETRY_WINDOW {
                        log::warn!(
                            "schedule: giving up on job {} for leaf {} ({reason})",
                            job.id,
                            job.leaf_id
                        );
                        state.complete(&job, Err(reason));
                        changed = true;
                    }
                }
            }
        }
        if changed {
            let _ = app.emit(SCHEDULE_EVENT, state.list());
        }
        let error = state.storage_error.lock().unwrap().clone();
        if let Some(error) = error {
            let _ = app.emit("terax:schedule-error", error);
        }
    });
}

#[tauri::command]
pub fn schedule_add(
    state: tauri::State<ScheduleState>,
    app: tauri::AppHandle,
    leaf_id: u32,
    command: String,
    delay_seconds: u64,
) -> Result<Job, String> {
    let job = state.add(leaf_id, command, Duration::from_secs(delay_seconds))?;
    let _ = app.emit(SCHEDULE_EVENT, state.list());
    Ok(job)
}

#[tauri::command]
pub fn schedule_list(state: tauri::State<ScheduleState>) -> Result<Vec<Job>, String> {
    if let Some(error) = state.storage_error.lock().unwrap().clone() {
        return Err(error);
    }
    Ok(state.list())
}

#[tauri::command]
pub fn schedule_cancel(
    state: tauri::State<ScheduleState>,
    app: tauri::AppHandle,
    id: u64,
) -> Result<bool, String> {
    let removed = state.cancel(id)?;
    if removed {
        let _ = app.emit(SCHEDULE_EVENT, state.list());
    }
    Ok(removed)
}

#[tauri::command]
pub fn schedule_rebind(
    state: tauri::State<ScheduleState>,
    app: tauri::AppHandle,
    id: u64,
    leaf_id: u32,
) -> Result<(), String> {
    state.rebind(id, leaf_id)?;
    let _ = app.emit(SCHEDULE_EVENT, state.list());
    Ok(())
}
