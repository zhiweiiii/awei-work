use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use shared_child::SharedChild;

use crate::modules::git::errors::{GitError, Result};
use crate::modules::git::types::{
    GitOutput, TextSource, DEFAULT_TIMEOUT_SECS, MAX_FILE_BYTES, MAX_OUTPUT_BYTES,
    MAX_TIMEOUT_SECS, MIN_GIT_VERSION,
};
use crate::modules::workspace::WorkspaceEnv;

#[derive(Clone)]
enum Availability {
    Ok,
    NotInstalled,
    TooOld(String),
}

const AVAILABILITY_TTL: Duration = Duration::from_secs(60);

struct AvailabilityCache {
    value: Availability,
    checked_at: Instant,
}

static GIT_AVAILABILITY: OnceLock<Mutex<Option<AvailabilityCache>>> = OnceLock::new();

fn availability_cell() -> &'static Mutex<Option<AvailabilityCache>> {
    GIT_AVAILABILITY.get_or_init(|| Mutex::new(None))
}

pub fn ensure_git_available(workspace: &WorkspaceEnv) -> Result<()> {
    let cached = availability_cell()
        .lock()
        .expect("git availability poisoned")
        .as_ref()
        .filter(|entry| entry.checked_at.elapsed() < AVAILABILITY_TTL)
        .map(|entry| entry.value.clone());
    let value = match cached {
        Some(value) => value,
        None => {
            let fresh = check_git_availability(workspace);
            *availability_cell()
                .lock()
                .expect("git availability poisoned") = Some(AvailabilityCache {
                value: fresh.clone(),
                checked_at: Instant::now(),
            });
            fresh
        }
    };
    match value {
        Availability::Ok => Ok(()),
        Availability::NotInstalled => Err(GitError::NotInstalled),
        Availability::TooOld(v) => Err(GitError::TooOld {
            found: v,
            required: MIN_GIT_VERSION,
        }),
    }
}

fn check_git_availability(workspace: &WorkspaceEnv) -> Availability {
    let output = match run_git_uncached(workspace, None, ["--version"], None, 10) {
        Ok(o) => o,
        Err(_) => return Availability::NotInstalled,
    };
    if output.timed_out || output.exit_code != Some(0) {
        return Availability::NotInstalled;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = parse_git_version(stdout.trim()).unwrap_or_else(|| "unknown".into());
    if !version_meets_minimum(&version, MIN_GIT_VERSION) {
        return Availability::TooOld(version);
    }
    Availability::Ok
}

fn parse_git_version(line: &str) -> Option<String> {
    line.split_whitespace()
        .find(|tok| tok.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(|s| s.split('.').take(3).collect::<Vec<_>>().join("."))
}

fn version_meets_minimum(found: &str, required: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        s.split('.')
            .map(|p| p.parse::<u32>().unwrap_or(0))
            .collect()
    };
    let f = parse(found);
    let r = parse(required);
    for (i, &b) in r.iter().enumerate() {
        let a = f.get(i).copied().unwrap_or(0);
        if a > b {
            return true;
        }
        if a < b {
            return false;
        }
    }
    true
}

pub fn git_show_text(workspace: &WorkspaceEnv, repo_root: &str, spec: &str) -> Result<TextSource> {
    let output = run_git(
        workspace,
        Some(repo_root),
        [
            OsStr::new("show"),
            OsStr::new("--no-textconv"),
            OsStr::new(spec),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.timed_out {
        return Err(GitError::TimedOut("git show"));
    }
    if output.exit_code != Some(0) {
        return Ok(TextSource::Missing);
    }
    if output.truncated {
        return Err(GitError::command(
            "git show",
            "file content exceeds the output limit",
        ));
    }
    Ok(decode_text(output.stdout))
}

pub fn git_stdout_line_opt<I, S>(
    workspace: &WorkspaceEnv,
    cwd: &str,
    args: I,
) -> Result<Option<String>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = run_git(workspace, Some(cwd), args, DEFAULT_TIMEOUT_SECS)?;
    if output.timed_out {
        return Err(GitError::TimedOut("git command"));
    }
    if output.exit_code != Some(0) {
        return Ok(None);
    }
    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    let line = stdout.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        Ok(None)
    } else {
        Ok(Some(line.to_string()))
    }
}

/// Run git, returning multiple stdout lines (UTF-8). Empty trailing lines stripped.
pub fn git_stdout_lines<I, S>(workspace: &WorkspaceEnv, cwd: &str, args: I) -> Result<Vec<String>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = run_git(workspace, Some(cwd), args, DEFAULT_TIMEOUT_SECS)?;
    if output.timed_out {
        return Err(GitError::TimedOut("git command"));
    }
    if output.exit_code != Some(0) {
        return Ok(Vec::new());
    }
    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    Ok(stdout
        .lines()
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect())
}

pub fn read_text_file(path: &Path) -> Result<TextSource> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(TextSource::Missing),
        Err(e) => return Err(GitError::Io(e)),
    };
    if meta.file_type().is_symlink() {
        return Err(GitError::SymlinkRejected(path.to_path_buf()));
    }
    if !meta.is_file() {
        return Ok(TextSource::Missing);
    }
    let size = meta.len();
    if size > MAX_FILE_BYTES {
        return Err(GitError::FileTooLarge {
            path: path.to_path_buf(),
            size,
            max: MAX_FILE_BYTES,
        });
    }
    let mut bytes = Vec::with_capacity(size as usize);
    std::fs::File::open(path)?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(GitError::FileTooLarge {
            path: path.to_path_buf(),
            size: bytes.len() as u64,
            max: MAX_FILE_BYTES,
        });
    }
    Ok(decode_text(bytes))
}

pub fn run_git<I, S>(
    workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    args: I,
    timeout_secs: u64,
) -> Result<GitOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git_uncached(workspace, cwd, args, None, timeout_secs)
}

/// Like `run_git`, with bytes piped to stdin (e.g. `git cat-file --batch-check`).
pub fn run_git_with_input<I, S>(
    workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    args: I,
    stdin: &[u8],
    timeout_secs: u64,
) -> Result<GitOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git_uncached(workspace, cwd, args, Some(stdin), timeout_secs)
}

fn run_git_uncached<I, S>(
    workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    args: I,
    stdin: Option<&[u8]>,
    timeout_secs: u64,
) -> Result<GitOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let dur = Duration::from_secs(timeout_secs.clamp(1, MAX_TIMEOUT_SECS));
    let args: Vec<OsString> = args
        .into_iter()
        .map(|arg| arg.as_ref().to_os_string())
        .collect();
    let mut cmd = build_git_command(workspace, cwd, &args)?;
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GCM_PROVIDER", "")
        .env("LC_ALL", "C")
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let child = Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| GitError::Spawn(e.to_string()))?);
    let process_job =
        crate::modules::proc::job::ProcessJob::create_for(child.id()).map_err(|e| {
            let _ = child.kill();
            let _ = child.wait();
            GitError::Io(e)
        })?;
    let input_handle = stdin.map(|bytes| {
        let bytes = bytes.to_vec();
        let pipe = child.take_stdin();
        thread::spawn(move || -> std::io::Result<()> {
            use std::io::Write;
            let mut pipe = pipe.ok_or_else(|| std::io::Error::other("no stdin pipe"))?;
            pipe.write_all(&bytes)
        })
    });
    let mut stdout_pipe = child
        .take_stdout()
        .ok_or_else(|| GitError::Spawn("no stdout pipe".into()))?;
    let mut stderr_pipe = child
        .take_stderr()
        .ok_or_else(|| GitError::Spawn("no stderr pipe".into()))?;

    let stdout_handle = thread::spawn(move || drain(&mut stdout_pipe, 64 * 1024));
    let stderr_handle = thread::spawn(move || drain(&mut stderr_pipe, 4 * 1024));

    let (tx, rx) = mpsc::channel();
    let waiter = Arc::clone(&child);
    thread::spawn(move || {
        let _ = tx.send(waiter.wait());
    });

    let waited = rx.recv_timeout(dur);
    drop(process_job);
    let (exit_code, timed_out) = match waited {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(e)) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(GitError::Io(e));
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            (None, true)
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(GitError::Spawn("git wait thread disconnected".into()));
        }
    };
    if let Some(input) = input_handle {
        let result = input
            .join()
            .map_err(|_| GitError::Spawn("git input worker failed".into()))?;
        if !timed_out && exit_code == Some(0) {
            result.map_err(GitError::Io)?;
        }
    }

    let (stdout, stdout_truncated) = stdout_handle.join().unwrap_or((Vec::new(), false));
    let (stderr, _stderr_truncated) = stderr_handle.join().unwrap_or((Vec::new(), false));

    Ok(GitOutput {
        stdout,
        stderr,
        exit_code,
        timed_out,
        truncated: stdout_truncated,
    })
}

fn build_git_command(
    _workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    args: &[OsString],
) -> Result<Command> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    if let Some(dir) = cwd.filter(|s| !s.is_empty()) {
        cmd.current_dir(Path::new(dir));
    }
    Ok(cmd)
}

pub fn ensure_success(output: &GitOutput, context: &'static str) -> Result<()> {
    if output.timed_out {
        return Err(GitError::TimedOut(context));
    }
    if output.exit_code == Some(0) {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if let Some(err) = classify_auth_error(&stderr) {
        return Err(err);
    }
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "unknown git error".into()
    };
    Err(GitError::CommandFailed { context, detail })
}

fn classify_auth_error(stderr: &str) -> Option<GitError> {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("authentication failed")
        || lower.contains("permission denied (publickey)")
        || lower.contains("invalid credentials")
    {
        return Some(GitError::AuthRequired(
            stderr.lines().next().unwrap_or(stderr).to_string(),
        ));
    }
    if lower.contains("host key verification failed") {
        return Some(GitError::HostKeyUnverified);
    }
    None
}

fn decode_text(bytes: Vec<u8>) -> TextSource {
    let sniff_len = bytes.len().min(8192);
    if bytes[..sniff_len].contains(&0) {
        return TextSource::Binary;
    }
    match String::from_utf8(bytes) {
        Ok(text) => TextSource::Text(text),
        Err(e) => TextSource::Text(String::from_utf8_lossy(&e.into_bytes()).into_owned()),
    }
}

fn drain<R: Read>(reader: &mut R, prealloc: usize) -> (Vec<u8>, bool) {
    let mut out: Vec<u8> = Vec::with_capacity(prealloc.min(MAX_OUTPUT_BYTES));
    let mut buf = [0u8; 16 * 1024];
    let mut truncated = false;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if out.len() >= MAX_OUTPUT_BYTES {
                    truncated = true;
                    continue;
                }
                let take = (MAX_OUTPUT_BYTES - out.len()).min(n);
                out.extend_from_slice(&buf[..take]);
                if take < n {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (out, truncated)
}
