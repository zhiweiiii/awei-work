//! opencode keeps its sessions in SQLite at
//! `~/.local/share/opencode/opencode.db`.
//!
//! Read directly, read-only, because the alternatives do not work for a live
//! view: the running TUI opens no port (so there is nothing to attach to), and
//! `opencode export` costs a process launch per read. The database is opened
//! without ever writing to it, so a running opencode is unaffected.
//!
//! The tables are opencode's own, not an interface it promises, so everything
//! here degrades to "no transcript" rather than erroring: a schema that moves
//! under us puts the phone back on the screen view, it does not break it.

use std::collections::VecDeque;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc, Mutex, OnceLock,
};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use super::{
    flatten_text, merge_assistant_steps, normalize_dir, push_part, Message, Part, Transcript,
    Working,
};

const MAX_MESSAGES: i64 = 600;
const MAX_ROW_BYTES: usize = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: usize = 16 * 1024 * 1024;
const MAX_PARTS: usize = 20_000;
const CACHE_LIMIT: usize = 8;
static REVISION: AtomicI64 = AtomicI64::new(1);

struct Cached {
    path: PathBuf,
    cwd: String,
    mark: i64,
    transcript: Arc<Transcript>,
}

fn database() -> Option<PathBuf> {
    let path = dirs::home_dir()?
        .join(".local")
        .join("share")
        .join("opencode")
        .join("opencode.db");
    path.is_file().then_some(path)
}

/// Include WAL length and full timestamps: different commits can share a millisecond.
pub fn changed_at() -> Option<i64> {
    let db = database()?;
    fingerprint(&db)
}

fn fingerprint(db: &std::path::Path) -> Option<i64> {
    let wal = db.with_extension("db-wal");
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    for file in [db, wal.as_path()] {
        match file.metadata() {
            Ok(metadata) => {
                metadata.len().hash(&mut hash);
                metadata.modified().ok().hash(&mut hash);
                metadata.created().ok().hash(&mut hash);
            }
            Err(_) if file == db => return None,
            Err(_) => 0u64.hash(&mut hash),
        }
    }
    Some((hash.finish() & i64::MAX as u64) as i64)
}

pub fn read(cwd: &str) -> Option<Arc<Transcript>> {
    static CACHE: OnceLock<Mutex<VecDeque<Cached>>> = OnceLock::new();
    let path = database()?;
    let mark = fingerprint(&path)?;
    let cwd = normalize_dir(cwd);
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .ok()?;
    if let Some(index) = cache
        .iter()
        .position(|entry| entry.path == path && entry.cwd == cwd)
    {
        let entry = cache.remove(index)?;
        if entry.mark == mark {
            let result = Arc::clone(&entry.transcript);
            cache.push_back(entry);
            return Some(result);
        }
    }
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()?;
    conn.busy_timeout(std::time::Duration::from_millis(500))
        .ok()?;
    let transaction = conn.unchecked_transaction().ok()?;
    let mut transcript = read_with(&transaction, &cwd)?;
    transaction.commit().ok()?;
    transcript.revision = REVISION.fetch_add(1, Ordering::Relaxed);
    let transcript = Arc::new(transcript);
    cache.push_back(Cached {
        path,
        cwd,
        mark,
        transcript: Arc::clone(&transcript),
    });
    while cache.len() > CACHE_LIMIT {
        cache.pop_front();
    }
    Some(transcript)
}

fn read_with(conn: &Connection, cwd: &str) -> Option<Transcript> {
    let want = normalize_dir(cwd);
    // `directory` is stored however opencode was launched, so the match is
    // made in Rust on a normalised form rather than in SQL.
    let mut stmt = conn
        .prepare(
            "select id, title, agent, model, directory, time_updated \
             from session order by time_updated desc limit 200",
        )
        .ok()?;
    let mut rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        })
        .ok()?
        .flatten();
    let (session_id, title, agent, model, _, updated) =
        rows.find(|(_, _, _, _, dir, _)| dir.as_deref().is_some_and(|d| normalize_dir(d) == want))?;

    let steps = messages(conn, &session_id)?;
    if steps.is_empty() {
        return None;
    }
    let working = working_since(conn, &session_id);
    let revision = steps
        .iter()
        .map(|m| m.at)
        .max()
        .unwrap_or(0)
        .max(updated.unwrap_or(0));

    Some(Transcript {
        prompt_at: None,
        source: "opencode",
        session_id,
        title,
        // opencode calls it the agent ("build", "plan"); it is the same thing
        // Claude calls a mode - what sending a message will do.
        mode: agent,
        model: model.as_deref().and_then(model_name),
        messages: merge_assistant_steps(steps),
        working,
        revision,
    })
}

/// `model` is stored as JSON (`{"id":…,"providerID":…,"variant":…}`).
fn model_name(raw: &str) -> Option<String> {
    serde_json::from_str::<Value>(raw)
        .ok()?
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn messages(conn: &Connection, session_id: &str) -> Option<Vec<Message>> {
    let mut stmt = conn
        .prepare(
            "select id, time_created, case when length(cast(data as blob)) <= ?2 then data end from message \
             where session_id = ?1 order by time_created desc, id desc limit ?3",
        )
        .ok()?;
    let mut rows = stmt
        .query(rusqlite::params![
            session_id,
            MAX_ROW_BYTES as i64,
            MAX_MESSAGES
        ])
        .ok()?;
    let mut stored = Vec::new();
    let mut bytes_left = MAX_TRANSCRIPT_BYTES;
    while let Some(row) = rows.next().ok()? {
        let id: String = row.get(0).ok()?;
        let at: i64 = row.get(1).ok()?;
        let data: String = row.get(2).ok()?;
        bytes_left = bytes_left.checked_sub(data.len())?;
        stored.push((id, at, data));
    }
    let mut parts_stmt = conn
        .prepare(
            "select case when length(cast(data as blob)) <= ?2 then data end from part \
         where message_id = ?1 order by time_created, id limit ?3",
        )
        .ok()?;
    let mut parts_left = MAX_PARTS;
    let mut out = Vec::with_capacity(stored.len());
    for (id, at, data) in stored.into_iter().rev() {
        let info: Value = serde_json::from_str(&data).ok()?;
        let role = match info.get("role").and_then(Value::as_str) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let (text, reasoning, parts) =
            message_parts(&mut parts_stmt, &id, &mut bytes_left, &mut parts_left)?;
        out.push(Message {
            id,
            role,
            at,
            text,
            reasoning,
            parts,
        });
    }
    Some(out)
}

/// A message's content, in the order opencode stored the parts. `step-start`
/// and `step-finish` are the model round trip's own bookkeeping and carry
/// nothing.
///
/// The row order is the turn's order, which is why the query is sorted: prose,
/// the tools it led to, then the next prose. Collecting the two kinds into
/// separate lists threw that away and the phone drew all the commands after
/// all of the writing.
fn message_parts(
    stmt: &mut rusqlite::Statement<'_>,
    message_id: &str,
    bytes_left: &mut usize,
    parts_left: &mut usize,
) -> Option<(String, Option<String>, Vec<Part>)> {
    let mut parts: Vec<Part> = Vec::new();
    let mut reasoning = None;

    let mut rows = stmt
        .query(rusqlite::params![
            message_id,
            MAX_ROW_BYTES as i64,
            (*parts_left + 1) as i64
        ])
        .ok()?;
    while let Some(row) = rows.next().ok()? {
        *parts_left = parts_left.checked_sub(1)?;
        let data: String = row.get(0).ok()?;
        *bytes_left = bytes_left.checked_sub(data.len())?;
        let Ok(part) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = part.get("text").and_then(Value::as_str) {
                    push_part(
                        &mut parts,
                        Part::Text {
                            text: t.to_string(),
                        },
                    );
                }
            }
            Some("reasoning") => {
                if let Some(t) = part.get("text").and_then(Value::as_str) {
                    let t = t.trim();
                    if !t.is_empty() {
                        reasoning = Some(t.to_string());
                    }
                }
            }
            Some("tool") => {
                if let Some(name) = part.get("tool").and_then(Value::as_str) {
                    // opencode stores the call's arguments and output under a
                    // `state` object whose shape varies by tool; until that is
                    // read, the name alone still lands in the right place.
                    push_part(
                        &mut parts,
                        Part::Tool {
                            name: name.to_string(),
                            subject: None,
                            output: None,
                            elided: 0,
                            failed: false,
                        },
                    );
                }
            }
            _ => {}
        }
    }
    Some((flatten_text(&parts), reasoning, parts))
}

/// When the newest assistant message has no completion time, opencode is still
/// producing it.
fn working_since(conn: &Connection, session_id: &str) -> Option<Working> {
    let mut stmt = conn
        .prepare(
            "select time_created, case when length(cast(data as blob)) <= ?2 then data end from message \
             where session_id = ?1 order by time_created desc, id desc limit 1",
        )
        .ok()?;
    let (at, data): (i64, String) = stmt
        .query_row(rusqlite::params![session_id, MAX_ROW_BYTES as i64], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .ok()?;
    let info: Value = serde_json::from_str(&data).ok()?;
    match info.get("role").and_then(Value::as_str) {
        // The user's message is in and nothing has answered it yet.
        Some("user") => Some(Working { since: at }),
        Some("assistant") => {
            let completed = info
                .get("time")
                .and_then(|t| t.get("completed"))
                .and_then(Value::as_i64);
            completed.is_none().then(|| Working {
                since: info
                    .get("time")
                    .and_then(|t| t.get("created"))
                    .and_then(Value::as_i64)
                    .unwrap_or(at),
            })
        }
        _ => None,
    }
}
