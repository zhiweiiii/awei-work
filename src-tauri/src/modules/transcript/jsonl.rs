use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant, SystemTime};

use super::Transcript;

static REVISION: AtomicI64 = AtomicI64::new(1);
const CACHE_LIMIT: usize = 8;
const MAX_RECORD_BYTES: u64 = 16 * 1024 * 1024;
const READ_SLICE_BYTES: u64 = 32 * 1024 * 1024;
const READ_SLICE_TIME: Duration = Duration::from_millis(200);

pub(super) trait JsonlState: Default + Send {
    fn ingest(&mut self, text: &str);
    fn snapshot(&self, session_id: String, revision: i64) -> Option<Transcript>;
}

#[derive(PartialEq, Eq, Clone)]
struct Mark {
    length: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
}

struct Entry<S> {
    state: S,
    session_id: Option<String>,
    offset: u64,
    mark: Option<Mark>,
    snapshot: Option<Arc<Transcript>>,
    used: std::time::Instant,
    revision: i64,
    caught_up: bool,
    rejected_record: bool,
}

impl<S: Default> Default for Entry<S> {
    fn default() -> Self {
        Self {
            state: S::default(),
            session_id: None,
            offset: 0,
            mark: None,
            snapshot: None,
            used: std::time::Instant::now(),
            revision: 0,
            caught_up: false,
            rejected_record: false,
        }
    }
}

pub(super) struct ReaderCache<S> {
    entries: Mutex<HashMap<PathBuf, Arc<Mutex<Entry<S>>>>>,
}

impl<S: JsonlState> ReaderCache<S> {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn read_complete(
        &self,
        path: &Path,
        mut session_id: impl FnMut() -> Option<String>,
    ) -> Option<Arc<Transcript>> {
        let started = Instant::now();
        loop {
            let snapshot = self.read(path, &mut session_id);
            if snapshot.is_some() || started.elapsed() >= Duration::from_secs(2) {
                return snapshot;
            }
            let entry = self.entries.lock().ok()?.get(path)?.clone();
            let entry = entry.lock().ok()?;
            if entry.mark.is_none() || entry.caught_up || entry.rejected_record {
                return None;
            }
        }
    }

    pub fn read(
        &self,
        path: &Path,
        session_id: impl FnOnce() -> Option<String>,
    ) -> Option<Arc<Transcript>> {
        let entry = {
            let mut entries = self.entries.lock().ok()?;
            if !entries.contains_key(path) && entries.len() >= CACHE_LIMIT {
                let oldest = entries
                    .iter()
                    .filter_map(|(path, entry)| {
                        entry.try_lock().ok().map(|e| (e.used, path.clone()))
                    })
                    .min_by_key(|(used, _)| *used)
                    .map(|(_, path)| path)?;
                entries.remove(&oldest);
            }
            entries
                .entry(path.to_path_buf())
                .or_insert_with(|| Arc::new(Mutex::new(Entry::default())))
                .clone()
        };
        let mut entry = entry.lock().ok()?;
        entry.used = std::time::Instant::now();
        let metadata = fs::metadata(path).ok()?;
        let mark = Mark {
            length: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
        };
        if entry.mark.as_ref() == Some(&mark) && entry.caught_up {
            return entry.snapshot.clone();
        }
        if entry.mark.as_ref().is_some_and(|old| {
            mark.length < old.length
                || mark.created != old.created
                || (mark.length == old.length && mark.modified != old.modified)
        }) {
            entry.state = S::default();
            entry.session_id = None;
            entry.offset = 0;
            entry.snapshot = None;
            entry.caught_up = false;
            entry.rejected_record = false;
        }
        if entry.rejected_record {
            entry.mark = Some(mark);
            entry.caught_up = true;
            return None;
        }
        let mut file = File::open(path).ok()?;
        file.seek(SeekFrom::Start(entry.offset)).ok()?;
        let mut reader = BufReader::new(file.take(mark.length.saturating_sub(entry.offset)));
        let mut bytes = Vec::new();
        let mut consumed = 0u64;
        let started = Instant::now();
        let mut caught_up = true;
        loop {
            if consumed > 0
                && (consumed >= READ_SLICE_BYTES || started.elapsed() >= READ_SLICE_TIME)
            {
                caught_up = false;
                break;
            }
            bytes.clear();
            let size = Read::by_ref(&mut reader)
                .take(MAX_RECORD_BYTES + 1)
                .read_until(b'\n', &mut bytes)
                .ok()?;
            if size == 0 {
                break;
            }
            if size as u64 > MAX_RECORD_BYTES {
                entry.rejected_record = true;
                entry.caught_up = true;
                entry.snapshot = None;
                entry.mark = Some(mark);
                log::warn!("transcript: record exceeds size limit; using screen fallback");
                return None;
            }
            if bytes.last() != Some(&b'\n') {
                break;
            }
            consumed += size as u64;
            entry.offset += size as u64;
            if let Ok(text) = std::str::from_utf8(&bytes) {
                entry.state.ingest(text);
            }
        }
        entry.caught_up = caught_up;
        if !caught_up {
            entry.mark = Some(mark);
            entry.snapshot = None;
            return None;
        }
        if consumed == 0 && entry.snapshot.is_some() {
            entry.mark = Some(mark);
            return entry.snapshot.clone();
        }
        let id = entry.session_id.clone().or_else(session_id)?;
        entry.session_id = Some(id.clone());
        entry.revision = REVISION.fetch_add(1, Ordering::Relaxed);
        entry.snapshot = entry.state.snapshot(id, entry.revision).map(Arc::new);
        entry.mark = Some(mark);
        entry.snapshot.clone()
    }
}

pub(super) fn compact_steps(
    steps: &mut Vec<super::Message>,
    pending: &mut HashMap<String, (usize, usize)>,
) {
    const MAX_STEPS: usize = 600;
    const MAX_STORED_BYTES: usize = 8 * 1024 * 1024;
    const MAX_STORED_PARTS: usize = 20_000;
    let mut weights: Vec<usize> = steps
        .iter()
        .map(|message| {
            message.id.len()
                + message.text.len()
                + message.reasoning.as_ref().map_or(0, String::len)
                + message
                    .parts
                    .iter()
                    .map(|part| match part {
                        super::Part::Text { text } => text.len(),
                        super::Part::Tool {
                            name,
                            subject,
                            output,
                            ..
                        } => {
                            name.len()
                                + subject.as_ref().map_or(0, String::len)
                                + output.as_ref().map_or(0, String::len)
                        }
                    })
                    .sum::<usize>()
        })
        .collect();
    for (id, (index, _)) in pending.iter() {
        if let Some(weight) = weights.get_mut(*index) {
            *weight = weight.saturating_add(id.len());
        }
    }
    let mut bytes = 0usize;
    let mut parts = 0usize;
    let mut kept = 0usize;
    for (message, weight) in steps.iter().zip(weights).rev().take(MAX_STEPS) {
        bytes = bytes.saturating_add(weight);
        parts = parts.saturating_add(message.parts.len());
        if bytes > MAX_STORED_BYTES || parts > MAX_STORED_PARTS {
            break;
        }
        kept += 1;
    }
    let removed = steps.len() - kept;
    steps.drain(..removed);
    pending.retain(|_, (index, _)| {
        if *index < removed {
            return false;
        }
        *index -= removed;
        true
    });
}
