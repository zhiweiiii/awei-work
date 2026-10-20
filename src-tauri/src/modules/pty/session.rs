use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager};

use super::agent_detect::{AgentDetector, Transition};
use super::da_filter::DaFilter;
use super::shell_init;
use crate::modules::workspace::WorkspaceEnv;

const AGENT_EVENT: &str = "terax:agent-signal";

pub(crate) fn valid_grid(cols: u16, rows: u16) -> bool {
    cols >= 2
        && rows >= 2
        && cols <= 2048
        && rows <= 1024
        && u32::from(cols) * u32::from(rows) <= 262144
}

// Flusher coalesces a short window after first-byte arrival so we send chunks,
// not single bytes. MAX_IDLE is only a safety net for missed signals.
const FLUSH_COALESCE: Duration = Duration::from_millis(4);
const FLUSH_MAX_IDLE: Duration = Duration::from_millis(50);
const READ_BUF: usize = 16 * 1024;
// Cap on buffered-but-not-yet-flushed bytes. On overflow we discard the
// entire pending buffer and emit an SGR-reset + notice in its place.
// Dropping a partial prefix would slice a CSI sequence in half and corrupt
// xterm's screen state. 4 MiB is ~1000 full 80x24 screens.
const MAX_PENDING: usize = 4 * 1024 * 1024;
// Hard reset (ESC c) + dim notice. Written verbatim into the stream when
// we're forced to discard backlog.
const OVERFLOW_NOTICE: &[u8] =
    b"\x1bc\x1b[2m[awei-work: dropped output due to backpressure]\x1b[0m\r\n";

/// A full queue disconnects its viewer rather than blocking PTY output.
const WEB_SUB_QUEUE: usize = 64;

/// Message sent to a Web viewer: live output bytes, or a final exit notice so
/// the page can clear its attached state instead of waiting forever.
pub enum WebMsg {
    Output(Vec<u8>),
    Exited(i32),
    /// The grid changed because the other end claimed the session; the viewer
    /// has to re-size to it or the byte stream stops parsing correctly.
    Resized(u16, u16),
}

/// Which end last claimed a session and therefore owns its PTY grid.
///
/// The grid cannot be per-viewer: the byte stream carries absolute cursor
/// moves and \r redraws laid out against one specific cols x rows, so every
/// viewer has to render at the same grid. Ownership decides whose grid that
/// is, and moves to whichever end the user is actually at.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SizeOwner {
    Desktop,
    Web,
}

/// Minimum gap between ownership transfers. Every transfer resizes the PTY,
/// which makes full-screen TUIs repaint, so two ends taking turns must not be
/// able to ping-pong the grid.
///
/// Only a keystroke transfers ownership. Merely looking at a session does not:
/// attaching the phone, focusing the desktop window, switching tabs and window
/// resizes all just record that end's preferred grid. Making those claim was
/// what put a watched session in a loop, since the desktop refits constantly
/// and would take the grid straight back from a phone that was only watching.
const OWNER_COOLDOWN: Duration = Duration::from_secs(3);

pub struct Session {
    // Field drop order is intentional. Rust drops fields top-to-bottom:
    //   1. `_job` — on Windows, closing the Job HANDLE fires
    //      KILL_ON_JOB_CLOSE, terminating the pwsh tree before the master
    //      pipe drops. Without this, ClosePseudoConsole in `master`'s Drop
    //      can block waiting for conhost to drain pending output, freezing
    //      the Tauri worker thread that triggered the close.
    //   2. `killer` — best-effort kill (redundant on Windows once Job
    //      closed, but harmless and required on Unix where there is no Job).
    //   3. `writer` — closes the input side of the master pipe.
    //   4. `master` — last; ClosePseudoConsole on Windows. By now the child
    //      is dead and conhost has nothing left to drain.
    #[cfg(windows)]
    _job: Option<crate::modules::proc::job::ProcessJob>,
    /// PID of the shell process. 0 means unknown; callers must skip checks when 0.
    pub shell_pid: u32,
    pub shell_kind: shell_init::ShellQuoteKind,
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Mutex<SerializedMaster>,
    // Set by the waiter once the child exits, so pty_open can reap a shell
    // that died before it was registered.
    pub(super) exited: Arc<AtomicBool>,
    /// Display metadata for the web page's session list.
    pub cwd: Option<String>,
    pub(super) leaf_id: Option<u32>,
    /// The coding agent running in this shell, as its own OSC markers
    /// announced it. Both the gate for reading an agent transcript - a
    /// directory that once ran one must not show that conversation over an
    /// idle prompt - and the choice of which transcript to read.
    agent: Arc<Mutex<Option<AgentRun>>>,
    web_submissions: Mutex<std::collections::VecDeque<(String, Result<(), String>)>>,
    /// Web viewers attached to this session (bounded queues).
    web_subs: Mutex<Vec<(u64, SyncSender<WebMsg>)>>,
    next_web_subscription: AtomicU64,
    /// Whether the PTY is currently on the alternate screen (opencode / claude
    /// / vim). Set by the flusher as it scans output; reported on attach so a
    /// phone can put its headless parser into the right mode before replaying
    /// the backlog — otherwise a ring that started mid-TUI parses as a shell.
    in_alt: AtomicBool,
    /// End that currently owns the grid, and when it took over.
    owner: Mutex<(SizeOwner, Instant)>,
    /// The live PTY grid, mirrored so viewers can be told without asking the
    /// master (which would need the lock the resize path already holds).
    size: Mutex<(u16, u16)>,
    /// Last grid each end asked for. A claim triggered by a keystroke has no
    /// dimensions of its own, so it restores the claimer's remembered grid.
    desktop_grid: Mutex<Option<(u16, u16)>>,
    web_grid: Mutex<Option<(u16, u16)>>,
}

#[derive(Clone)]
struct AgentRun {
    name: String,
    session_id: Option<String>,
    started_at: std::time::SystemTime,
    file: Option<std::path::PathBuf>,
}

#[derive(serde::Serialize)]
pub struct AgentResume {
    agent: String,
    id: String,
    cwd: String,
}

impl Drop for Session {
    fn drop(&mut self) {
        // If the session Arc is dropped without an explicit pty_close (e.g.
        // frontend disconnected, window crashed, dev HMR), the reader/flusher
        // threads would otherwise stay alive forever holding the child. Kill
        // the child here so the reader hits EOF and the threads unwind.
        self.terminate();
    }
}
// Serializes ConPTY create and close: overlapping pseudoconsole lifecycle
// calls corrupt the new console so its shell never pumps output (issue #356).
#[cfg(windows)]
static CONPTY_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn drop_session(session: Arc<Session>) {
    drop(session);
}

struct SerializedMaster(Option<Box<dyn MasterPty + Send>>);

impl std::ops::Deref for SerializedMaster {
    type Target = dyn MasterPty + Send;

    fn deref(&self) -> &Self::Target {
        self.0.as_deref().expect("live PTY master")
    }
}

impl Drop for SerializedMaster {
    fn drop(&mut self) {
        #[cfg(windows)]
        let _guard = CONPTY_LIFECYCLE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        drop(self.0.take());
    }
}

impl Session {
    pub(super) fn terminate(&self) {
        #[cfg(windows)]
        if let Some(job) = &self._job {
            job.terminate();
        }
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }

    /// Whether the PTY is on the alternate screen right now, so a phone can
    /// parse the replayed backlog in the right mode.
    pub fn web_in_alt(&self) -> bool {
        self.in_alt.load(Ordering::Acquire)
    }

    /// The coding agent running in this shell right now, if any.
    pub fn web_agent(&self) -> Option<String> {
        self.agent.lock().ok()?.as_ref().map(|run| run.name.clone())
    }

    pub fn agent_resume(&self, cwd: &str) -> Option<AgentResume> {
        let run = self.agent.lock().ok()?.as_ref()?.clone();
        if !matches!(run.name.as_str(), "claude" | "codex") {
            return None;
        }
        let file = self.web_transcript_file(cwd)?;
        let id = crate::modules::sessions::session_id_for_file(&file, &run.name, cwd)?;
        let current = self.agent.lock().ok()?;
        current.as_ref().filter(|current| {
            current.started_at == run.started_at
                && current.name == run.name
                && current.file.as_ref() == Some(&file)
        })?;
        Some(AgentResume {
            agent: run.name,
            id,
            cwd: cwd.to_string(),
        })
    }

    pub fn web_transcript(
        &self,
        cwd: &str,
        agent: &str,
    ) -> Option<Arc<crate::modules::transcript::Transcript>> {
        let generation = self.agent.lock().ok()?.as_ref()?.started_at;
        let file = self.web_transcript_file(cwd)?;
        let transcript = crate::modules::transcript::read_file(&file, agent)?;
        let current = self.agent.lock().ok()?;
        current.as_ref().filter(|run| {
            run.started_at == generation
                && run.name == agent
                && run.file.as_deref() == Some(file.as_path())
        })?;
        Some(transcript)
    }

    fn web_transcript_file(&self, cwd: &str) -> Option<std::path::PathBuf> {
        let run = self.agent.lock().ok()?.as_ref()?.clone();
        if run.file.is_some() {
            return run.file;
        }
        let file = crate::modules::sessions::resolve_session_file(
            cwd,
            &run.name,
            run.session_id.as_deref(),
            run.started_at,
        )?;
        let mut agent = self.agent.lock().ok()?;
        let current = agent.as_mut()?;
        if current.started_at != run.started_at
            || current.name != run.name
            || current.session_id != run.session_id
        {
            return None;
        }
        current.file = Some(file.clone());
        Some(file)
    }

    pub fn web_submit(&self, id: &str, text: &str) -> Result<(), String> {
        if id.is_empty()
            || id.len() > 64
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || text.len() > 64 * 1024
        {
            return Err("invalid submission".to_string());
        }
        let mut submissions = self
            .web_submissions
            .lock()
            .map_err(|_| "submission state unavailable")?;
        if let Some((_, result)) = submissions.iter().find(|(key, _)| key == id) {
            return result.clone();
        }
        let result = (|| {
            if self.exited.load(Ordering::Acquire) {
                return Err("terminal exited".to_string());
            }
            let bracketed = self.web_agent().as_deref() == Some("codex");
            if text.contains("\x1b[201~") || text.contains("\x1b[200~") {
                return Err("paste boundary in input".to_string());
            }
            let mut writer = self
                .writer
                .lock()
                .map_err(|_| "terminal input unavailable")?;
            if bracketed {
                writer.write_all(b"\x1b[200~").map_err(|e| e.to_string())?;
            }
            writer
                .write_all(text.as_bytes())
                .map_err(|e| e.to_string())?;
            if bracketed {
                writer.write_all(b"\x1b[201~").map_err(|e| e.to_string())?;
            }
            writer
                .write_all(b"\r")
                .and_then(|_| writer.flush())
                .map_err(|e| e.to_string())
        })();
        if submissions.len() == 128 {
            submissions.pop_front();
        }
        submissions.push_back((id.to_string(), result.clone()));
        result
    }

    /// Attach a Web viewer: returns the ID used to cancel this exact
    /// subscription, and a receiver for live chunks. Returns None if the
    /// session already exited.
    ///
    /// No backlog comes out of here. What a viewer sees first is the desktop
    /// terminal's own buffer, asked for on attach (`web::request_snapshot`):
    /// keeping a second copy of every session's output on this side made the
    /// phone open on a history the desktop no longer had.
    pub fn web_subscribe(&self) -> Option<(u64, mpsc::Receiver<WebMsg>)> {
        let mut subs = self.web_subs.lock().unwrap();
        if self.exited.load(Ordering::Acquire) {
            return None;
        }
        let (tx, rx) = mpsc::sync_channel(WEB_SUB_QUEUE);
        let id = self.next_web_subscription.fetch_add(1, Ordering::Relaxed);
        subs.push((id, tx));
        Some((id, rx))
    }

    /// The live PTY grid.
    pub fn size(&self) -> (u16, u16) {
        *self.size.lock().unwrap()
    }

    /// Record the grid an end would like, without claiming ownership. Lets a
    /// watching viewer keep its preference ready for the moment it does claim.
    pub fn note_grid(&self, who: SizeOwner, cols: u16, rows: u16) {
        if !valid_grid(cols, rows) {
            return;
        }
        let slot = match who {
            SizeOwner::Desktop => &self.desktop_grid,
            SizeOwner::Web => &self.web_grid,
        };
        *slot.lock().unwrap() = Some((cols, rows));
    }

    /// Ask for a grid on behalf of one end.
    ///
    /// Only the owner can move the live grid; anyone else just records what it
    /// would like, ready for the moment it does take over. This is the path
    /// every non-keystroke trigger uses: attaching, window focus, tab switches
    /// and container refits.
    pub fn request_grid(&self, who: SizeOwner, cols: u16, rows: u16) -> Option<(u16, u16)> {
        self.note_grid(who, cols, rows);
        if self.owner.lock().unwrap().0 != who {
            return None;
        }
        self.apply_grid(cols, rows)
    }

    /// Take ownership on a keystroke and switch to that end's recorded grid.
    ///
    /// Returns the new grid only when the PTY was actually resized, so callers
    /// broadcast exactly once per real change. Returns None when that end
    /// already owned the session at that size, when the cooldown has not
    /// elapsed, or when it never recorded a grid.
    pub fn claim(&self, who: SizeOwner) -> Option<(u16, u16)> {
        let slot = match who {
            SizeOwner::Desktop => &self.desktop_grid,
            SizeOwner::Web => &self.web_grid,
        };
        let (cols, rows) = (*slot.lock().unwrap())?;
        {
            let mut owner = self.owner.lock().unwrap();
            if owner.0 != who {
                if owner.1.elapsed() < OWNER_COOLDOWN {
                    return None;
                }
                *owner = (who, Instant::now());
            }
        }
        self.apply_grid(cols, rows)
    }

    /// The phone attaches at its own fixed grid and takes the PTY grid for it.
    /// Deliberate and one-shot (a page load), so it bypasses the ownership
    /// cooldown; the desktop reclaims on its next keystroke.
    pub fn web_take_grid(&self, cols: u16, rows: u16) -> Option<(u16, u16)> {
        if !valid_grid(cols, rows) {
            return None;
        }
        *self.web_grid.lock().unwrap() = Some((cols, rows));
        {
            let mut owner = self.owner.lock().unwrap();
            *owner = (SizeOwner::Web, Instant::now());
        }
        self.apply_grid(cols, rows)
    }

    /// Force a SIGWINCH without changing the session's grid.
    ///
    /// Linux only signals when the winsize ioctl actually changes, so this
    /// bumps a row and puts it straight back. It deliberately skips the size
    /// mirror, the ownership bookkeeping and the viewer broadcast: the grid
    /// ends exactly where it started, and telling attached phones about the
    /// transient made them re-grid twice on every renderer-slot rebind, which
    /// is constant while a full-screen TUI is running.
    pub fn kick_grid(&self, cols: u16, rows: u16) {
        if !valid_grid(cols, rows) || self.exited.load(Ordering::Acquire) {
            return;
        }
        let Ok(master) = self.master.lock() else {
            return;
        };
        let at = |r: u16| PtySize {
            rows: r,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        let _ = master.resize(at(rows.saturating_add(1)));
        let _ = master.resize(at(rows));
    }

    /// Resize the PTY and tell every attached viewer. Returns None when the
    /// grid was already the live one, so callers broadcast only real changes.
    fn apply_grid(&self, cols: u16, rows: u16) -> Option<(u16, u16)> {
        if !valid_grid(cols, rows) || self.exited.load(Ordering::Acquire) {
            return None;
        }
        let mut size = self.size.lock().unwrap();
        if *size == (cols, rows) {
            return None;
        }
        self.master
            .lock()
            .unwrap()
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .ok()?;
        *size = (cols, rows);
        drop(size);
        self.web_subs
            .lock()
            .unwrap()
            .retain(|(_, s)| s.try_send(WebMsg::Resized(cols, rows)).is_ok());
        Some((cols, rows))
    }

    /// Remove one specific subscriber (not the whole table, so other viewers
    /// of the same session are never affected).
    pub fn web_unsubscribe(&self, id: u64) {
        self.web_subs.lock().unwrap().retain(|(key, _)| *key != id);
    }

    /// Fan out one output chunk to every attached Web viewer. A viewer whose
    /// queue is full is evicted (its handle_ws sees the channel disconnect and
    /// notifies the page), so a slow phone is told instead of silently
    /// missing output, and one laggy viewer can't accumulate unbounded state.
    fn web_broadcast(&self, chunk: &[u8]) {
        let mut subs = self.web_subs.lock().unwrap();
        subs.retain(|(_, s)| s.try_send(WebMsg::Output(chunk.to_vec())).is_ok());
    }

    /// Tell every Web viewer that this session exited (final message). The
    /// page clears its attached state; the caller detaches the WS table
    /// afterwards via handle_ws.
    fn web_broadcast_exit(&self, code: i32) {
        let mut subs = self.web_subs.lock().unwrap();
        for (_, s) in subs.drain(..) {
            let _ = s.try_send(WebMsg::Exited(code));
        }
    }
}

struct ChildKillGuard {
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

impl ChildKillGuard {
    fn new(killer: Box<dyn ChildKiller + Send + Sync>) -> Self {
        Self {
            killer: Some(killer),
        }
    }

    fn disarm(&mut self) {
        self.killer = None;
    }
}

impl Drop for ChildKillGuard {
    fn drop(&mut self) {
        if let Some(mut k) = self.killer.take() {
            let _ = k.kill();
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn spawn(
    id: u32,
    leaf_id: Option<u32>,
    app: AppHandle,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    blocks: bool,
    shell: Option<String>,
    gateway_provider: Option<String>,
    on_data: Option<Box<dyn Fn(Vec<u8>) + Send + Sync>>,
    on_exit: Option<Box<dyn Fn(i32) + Send + Sync>>,
) -> Result<(Arc<Session>, PtySize), String> {
    if !valid_grid(cols, rows) {
        return Err("terminal grid exceeds the supported size".into());
    }
    let on_data = on_data.map(Arc::new);
    let on_exit = on_exit.map(Arc::new);
    #[cfg(windows)]
    let _spawn_guard = CONPTY_LIFECYCLE_LOCK.lock().unwrap();

    let pty_system = native_pty_system();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let (cmd, shell_kind) =
        shell_init::build_command(cwd.clone(), workspace, blocks, shell, gateway_provider)?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    // Kill the child if any of the pipe setup below fails so the spawned shell
    // can't outlive an aborted pty_open.
    let mut guard = ChildKillGuard::new(child.clone_killer());
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(
        pair.master.take_writer().map_err(|e| e.to_string())?,
    ));
    let shell_pid = child.process_id().unwrap_or(0);

    #[cfg(windows)]
    let job = crate::modules::proc::job::ProcessJob::create_for(
        child.process_id().ok_or("missing shell process ID")?,
    )
    .map_err(|e| format!("PTY job setup failed: {e}"))?;
    guard.disarm();

    let exited = Arc::new(AtomicBool::new(false));
    // Shared rather than read off the session: the reader thread that learns
    // the agent's name is spawned after this value is built.
    let agent_name: Arc<Mutex<Option<AgentRun>>> = Arc::new(Mutex::new(None));

    let session = Arc::new(Session {
        #[cfg(windows)]
        _job: Some(job),
        shell_pid,
        shell_kind,
        killer: Mutex::new(killer),
        writer: writer.clone(),
        master: Mutex::new(SerializedMaster(Some(pair.master))),
        exited: exited.clone(),
        cwd,
        leaf_id,
        agent: agent_name.clone(),
        web_submissions: Mutex::new(std::collections::VecDeque::new()),
        web_subs: Mutex::new(Vec::new()),
        next_web_subscription: AtomicU64::new(1),
        in_alt: AtomicBool::new(false),
        owner: Mutex::new((SizeOwner::Desktop, Instant::now())),
        size: Mutex::new((cols, rows)),
        desktop_grid: Mutex::new(Some((cols, rows))),
        web_grid: Mutex::new(None),
    });
    #[cfg(windows)]
    drop(_spawn_guard);

    let pending: Arc<(Mutex<Vec<u8>>, Condvar)> =
        Arc::new((Mutex::new(Vec::with_capacity(READ_BUF)), Condvar::new()));
    let done = Arc::new(AtomicBool::new(false));
    let spawn_at = Instant::now();

    let done_abort = done.clone();
    let pending_abort = pending.clone();
    let spawn_error = |error: std::io::Error| {
        session.terminate();
        done_abort.store(true, Ordering::Release);
        pending_abort.1.notify_all();
        error.to_string()
    };

    let first_byte = Arc::new(AtomicBool::new(false));

    let pending_r = pending.clone();
    let writer_for_da = writer.clone();
    let app_reader = app.clone();
    let agent_name_r = agent_name.clone();
    let first_byte_r = first_byte;
    let reader_thread = thread::Builder::new()
        .name("terax-pty-reader".into())
        .spawn(move || {
            let mut buf = [0u8; READ_BUF];
            let mut filtered: Vec<u8> = Vec::with_capacity(READ_BUF);
            let mut da_filter = DaFilter::new();
            let mut agent_detect = AgentDetector::new();
            let mut dropped_bytes: u64 = 0;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !first_byte_r.load(Ordering::Relaxed) {
                            first_byte_r.store(true, Ordering::Release);
                            log::debug!(
                                "pty first byte after {}ms",
                                spawn_at.elapsed().as_millis()
                            );
                        }
                        agent_detect.process(&buf[..n], |t| {
                            match &t {
                                Transition::Started {
                                    agent,
                                    session_id,
                                    started_at_ms,
                                } => {
                                    let now = std::time::SystemTime::now();
                                    let started_at = started_at_ms
                                        .and_then(|ms| {
                                            std::time::UNIX_EPOCH
                                                .checked_add(Duration::from_millis(ms))
                                        })
                                        .filter(|at| {
                                            *at <= now
                                                && now
                                                    .duration_since(*at)
                                                    .is_ok_and(|age| age < Duration::from_secs(60))
                                        })
                                        .unwrap_or(now);
                                    *agent_name_r.lock().unwrap() = Some(AgentRun {
                                        name: agent.clone(),
                                        session_id: session_id.clone(),
                                        started_at,
                                        file: None,
                                    });
                                }
                                Transition::Exited => {
                                    *agent_name_r.lock().unwrap() = None;
                                }
                                _ => {}
                            }
                            let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
                        });
                        filtered.clear();
                        da_filter.process(&buf[..n], &mut filtered, |reply| {
                            if let Ok(mut w) = writer_for_da.lock() {
                                let _ = w.write_all(reply);
                            }
                        });
                        if filtered.is_empty() {
                            continue;
                        }
                        let (lock, cv) = &*pending_r;
                        let mut g = lock.lock().unwrap();
                        if g.len() + filtered.len() > MAX_PENDING {
                            dropped_bytes += g.len() as u64;
                            g.clear();
                            g.extend_from_slice(OVERFLOW_NOTICE);
                        }
                        g.extend_from_slice(&filtered);
                        cv.notify_one();
                    }
                    Err(e) => {
                        log::debug!("pty reader ended: {e}");
                        break;
                    }
                }
            }
            agent_detect.finish(|t| {
                let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
            });
            pending_r.1.notify_one();
            if dropped_bytes > 0 {
                log::warn!("pty backpressure: dropped {dropped_bytes} bytes (cap {MAX_PENDING})");
            }
        })
        .map_err(&spawn_error)?;

    let on_data_ref = on_data.clone();
    let pending_f = pending.clone();
    let done_f = done.clone();
    let session_f = session.clone();
    // Alternate-screen enter/leave (opencode / claude / vim). Tracked so a
    // phone can parse the backlog in the right buffer mode.
    const ENTER_ALT: &[u8] = b"\x1b[?1049h";
    const LEAVE_ALT: &[u8] = b"\x1b[?1049l";
    let flusher_thread = thread::Builder::new()
        .name("terax-pty-flusher".into())
        .spawn(move || {
            let (lock, cv) = &*pending_f;
            // Tail of the previous chunk, so a mode-switch sequence split
            // across chunk boundaries is still detected.
            let mut mode_carry: Vec<u8> = Vec::new();
            loop {
                {
                    let mut g = lock.lock().unwrap();
                    while g.is_empty() {
                        if done_f.load(Ordering::Acquire) {
                            return;
                        }
                        let (next, _) = cv.wait_timeout(g, FLUSH_MAX_IDLE).unwrap();
                        g = next;
                    }
                }
                // Coalesce a short window so a burst flushes as one chunk.
                thread::sleep(FLUSH_COALESCE);
                let chunk = std::mem::take(&mut *lock.lock().unwrap());
                if chunk.is_empty() {
                    continue;
                }
                // Track alternate-screen mode transitions in this chunk. Both
                // patterns are scanned left to right, so the last transition
                // in the window wins.
                let mut mode: Option<bool> = None;
                {
                    let mut window: Vec<u8> = Vec::with_capacity(mode_carry.len() + chunk.len());
                    window.extend_from_slice(&mode_carry);
                    window.extend_from_slice(&chunk);
                    for w in window.windows(ENTER_ALT.len()) {
                        if w == ENTER_ALT {
                            mode = Some(true);
                        } else if w == LEAVE_ALT {
                            mode = Some(false);
                        }
                    }
                }
                if let Some(m) = mode {
                    session_f.in_alt.store(m, Ordering::Release);
                }
                mode_carry = chunk[chunk.len().saturating_sub(ENTER_ALT.len() - 1)..].to_vec();
                if let Some(cb) = &on_data_ref {
                    cb(chunk.clone());
                }
                // Fan the chunk out to currently attached Web viewers.
                session_f.web_broadcast(&chunk);
            }
        })
        .map_err(&spawn_error)?;

    let on_exit_cb = on_exit;
    let pending_e = pending;
    let done_e = done;
    let app_waiter = app;
    let exited_w = exited;
    let session_exit_f = session.clone();
    thread::Builder::new()
        .name("terax-pty-waiter".into())
        .spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(e) => {
                    log::warn!("pty child wait failed: {e}");
                    -1
                }
            };
            exited_w.store(true, Ordering::Release);
            session_exit_f.terminate();
            // Wait for the reader to hit EOF before taking a final snapshot of
            // `pending`, so the last line of output never races the Exit event.
            // On Windows the reader cannot be joined (it is not the thread that
            // owns the master handle), so poll it with a generous deadline
            // instead of a fixed short sleep (issue #10).
            #[cfg(windows)]
            {
                let deadline = Instant::now() + Duration::from_millis(2000);
                while Instant::now() < deadline && !reader_thread.is_finished() {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            #[cfg(not(windows))]
            if let Err(e) = reader_thread.join() {
                log::error!("pty reader thread panicked: {e:?}");
            }
            done_e.store(true, Ordering::Release);
            pending_e.1.notify_all();
            // One output owner preserves ordering, including a chunk already
            // taken from pending when the child exits.
            if let Err(e) = flusher_thread.join() {
                log::error!("pty flusher thread panicked: {e:?}");
            }
            // Final word to attached Web viewers before the session is reaped:
            // they clear their attached state immediately instead of waiting
            // for a reconnect.
            session_exit_f.web_broadcast_exit(code);
            if let Some(cb) = &on_exit_cb {
                cb(code);
            }
            if let Some(state) = app_waiter.try_state::<super::PtyState>() {
                if let Some(s) = state.take(id) {
                    drop_session(s);
                }
            }
        })
        .map_err(spawn_error)?;

    Ok((session, size))
}
