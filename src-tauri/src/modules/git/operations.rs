use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::sync::Mutex;
use std::thread;

use crate::modules::git::errors::{GitError, Result};
use crate::modules::git::parser::parse_porcelain_v2;
use crate::modules::git::process::{
    ensure_git_available, ensure_success, git_show_text, git_stdout_line_opt, git_stdout_lines,
    read_text_file, run_git, run_git_with_input,
};
use crate::modules::git::types::{
    DiscardEntry, GitBranchEntry, GitBranchListResult, GitCloneOptions, GitCommitFileChange,
    GitCommitResult, GitCompareResult, GitConfigUserResult, GitDiffContentResult, GitDiffResult,
    GitFetchResult, GitLogEntry, GitLogFilterOptions, GitMergeResult, GitMultiRepoEntry, GitOutput,
    GitPanelSnapshot, GitPreCommitChecksResult, GitPushOptions, GitPushResult, GitRebaseResult,
    GitRemoteEntry, GitRepoHead, GitRepoInfo, GitStatusSnapshot, GitTagCreateOptions,
    GitWorkspaceSnapshot, TextSource, DEFAULT_TIMEOUT_SECS, NETWORK_TIMEOUT_SECS,
};
use crate::modules::git::utils::{
    authorized_repo_root, canonical_dir, resolve_within_repo, split_upstream, ResolvedGitDirectory,
};
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

fn parallel_jobs<T: Send, R: Send>(items: Vec<T>, job: impl Fn(T) -> R + Sync) -> Result<Vec<R>> {
    let workers = items.len().min(4);
    let pending = Mutex::new(items.into_iter());
    let results = Mutex::new(Vec::new());
    thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            let pending = &pending;
            let results = &results;
            let job = &job;
            handles.push(
                thread::Builder::new()
                    .name("terax-git-batch".into())
                    .stack_size(512 * 1024)
                    .spawn_scoped(scope, move || loop {
                        let item = pending.lock().unwrap_or_else(|e| e.into_inner()).next();
                        let Some(item) = item else {
                            break;
                        };
                        let result = job(item);
                        results
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .push(result);
                    })
                    .map_err(|e| GitError::Spawn(e.to_string()))?,
            );
        }
        let mut failed = false;
        for handle in handles {
            failed |= handle.join().is_err();
        }
        if failed {
            return Err(GitError::Spawn("git batch worker failed".into()));
        }
        Ok(())
    })?;
    Ok(results.into_inner().unwrap_or_else(|e| e.into_inner()))
}

pub fn resolve_repo(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
) -> Result<Option<GitRepoInfo>> {
    let cwd = canonical_dir(registry, cwd, workspace)?;
    if !registry.is_authorized(&cwd.local_path) {
        return Err(GitError::PathOutsideWorkspace(cwd.local_path));
    }
    ensure_git_available(&cwd.workspace)?;
    resolve_repo_in_authorized(registry, &cwd)
}

fn resolve_repo_in_authorized(
    registry: &WorkspaceRegistry,
    cwd: &ResolvedGitDirectory,
) -> Result<Option<GitRepoInfo>> {
    let Some(root_line) = git_stdout_line_opt(
        &cwd.workspace,
        &cwd.git_path,
        ["rev-parse", "--show-toplevel"],
    )?
    else {
        return Ok(None);
    };
    let canonical_root = canonical_dir(registry, &root_line, &cwd.workspace)?;
    let _ = registry.authorize(&canonical_root.local_path);

    let head = match git_stdout_lines(
        &canonical_root.workspace,
        &canonical_root.git_path,
        ["rev-parse", "--abbrev-ref", "HEAD"],
    )?
    .into_iter()
    .next()
    {
        Some(h) => h,
        None => git_stdout_line_opt(
            &canonical_root.workspace,
            &canonical_root.git_path,
            ["symbolic-ref", "--short", "HEAD"],
        )?
        .ok_or(GitError::CommandFailed {
            context: "failed to resolve HEAD",
            detail: String::new(),
        })?,
    };

    let upstream = git_stdout_line_opt(
        &canonical_root.workspace,
        &canonical_root.git_path,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;

    Ok(Some(GitRepoInfo {
        repo_root: canonical_root.git_path,
        branch: head.clone(),
        upstream,
        is_detached: head == "HEAD",
    }))
}

pub fn panel_snapshot(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitPanelSnapshot> {
    let cwd = canonical_dir(registry, cwd, workspace)?;
    if !registry.is_authorized(&cwd.local_path) {
        return Err(GitError::PathOutsideWorkspace(cwd.local_path));
    }
    ensure_git_available(&cwd.workspace)?;
    let Some(root_line) = git_stdout_line_opt(
        &cwd.workspace,
        &cwd.git_path,
        ["rev-parse", "--show-toplevel"],
    )?
    else {
        return Ok(GitPanelSnapshot {
            repo: None,
            status: None,
        });
    };
    let canonical_root = canonical_dir(registry, &root_line, &cwd.workspace)?;
    let _ = registry.authorize(&canonical_root.local_path);

    let status = status_inner(&canonical_root)?;
    let repo = GitRepoInfo {
        repo_root: canonical_root.git_path.clone(),
        branch: status.branch.clone(),
        upstream: status.upstream.clone(),
        is_detached: status.is_detached,
    };
    Ok(GitPanelSnapshot {
        repo: Some(repo),
        status: Some(status),
    })
}

pub fn status(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitStatusSnapshot> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    status_inner(&repo_root)
}

fn status_inner(repo_root: &ResolvedGitDirectory) -> Result<GitStatusSnapshot> {
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git status failed")?;

    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    let parsed = parse_porcelain_v2(stdout);

    Ok(GitStatusSnapshot {
        repo_root: repo_root.git_path.clone(),
        branch: parsed.branch,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        is_detached: parsed.is_detached,
        truncated: output.truncated,
        changed_files: parsed.files,
    })
}

pub fn diff(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: Option<&str>,
    staged: bool,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    diff_inner(&repo_root, path, staged)
}

fn diff_inner(
    repo_root: &ResolvedGitDirectory,
    path: Option<&str>,
    staged: bool,
) -> Result<GitDiffResult> {
    let mut args: Vec<OsString> = vec!["diff".into(), "--no-ext-diff".into()];
    if staged {
        args.push("--cached".into());
    }
    let pathspec = match path.filter(|p| !p.is_empty()) {
        Some(p) => Some(pathspec_from_input(&repo_root.local_path, p)?),
        None => None,
    };
    if let Some(spec) = pathspec.as_ref() {
        args.push("--".into());
        args.push(spec.clone().into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git diff failed")?;

    let diff_text = match String::from_utf8(output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };
    Ok(GitDiffResult {
        diff_text,
        truncated: output.truncated,
    })
}

pub fn diff_content(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: &str,
    staged: bool,
    original_path: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffContentResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let worktree_path = resolve_within_repo(&repo_root.local_path, path)?;
    let rel_path = pathspec(&repo_root.local_path, &worktree_path);

    let original_rel = match original_path {
        Some(orig) if !orig.is_empty() => {
            let resolved = resolve_within_repo(&repo_root.local_path, orig)?;
            Some(pathspec(&repo_root.local_path, &resolved))
        }
        _ => None,
    };

    let original = if staged {
        let spec = original_rel.as_deref().unwrap_or(&rel_path);
        git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!("HEAD:{spec}"),
        )?
    } else {
        git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!(":{rel_path}"),
        )?
    };
    let modified = if staged {
        git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!(":{rel_path}"),
        )?
    } else {
        read_text_file(&worktree_path)?
    };
    let patch = diff_inner(&repo_root, Some(&rel_path), staged)?;
    let is_binary =
        matches!(original, TextSource::Binary) || matches!(modified, TextSource::Binary);

    Ok(GitDiffContentResult {
        original_content: original.into_text(),
        modified_content: modified.into_text(),
        is_binary,
        fallback_patch: patch.diff_text,
        truncated: patch.truncated,
    })
}

pub fn stage(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    paths: &[String],
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if paths.is_empty() {
        return Ok(());
    }
    let resolved = resolve_pathspecs(&repo_root.local_path, paths)?;
    let mut args: Vec<OsString> = vec!["add".into(), "--".into()];
    for p in &resolved {
        args.push(p.clone().into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git add failed")
}

pub fn unstage(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    paths: &[String],
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if paths.is_empty() {
        return Ok(());
    }
    let resolved = resolve_pathspecs(&repo_root.local_path, paths)?;
    let mut reset_args: Vec<OsString> = vec!["reset".into(), "HEAD".into(), "--".into()];
    for p in &resolved {
        reset_args.push(p.clone().into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        reset_args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.exit_code == Some(0) {
        return Ok(());
    }
    if !looks_like_no_head(&output) {
        return ensure_success(&output, "git reset failed");
    }
    let mut rm_args: Vec<OsString> = vec!["rm".into(), "--cached".into(), "-r".into(), "--".into()];
    for p in &resolved {
        rm_args.push(p.clone().into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        rm_args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git rm --cached failed")
}

fn looks_like_no_head(output: &GitOutput) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    stderr.contains("ambiguous argument 'head'")
        || stderr.contains("unknown revision")
        || stderr.contains("does not have any commits yet")
        || stderr.contains("bad revision 'head'")
}

pub fn discard(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    entries: &[DiscardEntry],
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if entries.is_empty() {
        return Ok(());
    }

    let mut tracked: Vec<String> = Vec::with_capacity(entries.len());
    let mut untracked: Vec<String> = Vec::new();
    for entry in entries {
        let resolved = pathspec_from_input(&repo_root.local_path, &entry.path)?;
        if entry.untracked {
            untracked.push(resolved);
        } else {
            tracked.push(resolved);
        }
    }

    if !tracked.is_empty() {
        let mut args: Vec<OsString> = vec!["restore".into(), "--worktree".into(), "--".into()];
        for p in &tracked {
            args.push(p.clone().into());
        }
        let output = run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            args,
            DEFAULT_TIMEOUT_SECS,
        )?;
        ensure_success(&output, "git restore failed")?;
    }

    if !untracked.is_empty() {
        let mut args: Vec<OsString> = vec!["clean".into(), "-f".into(), "-d".into(), "--".into()];
        for p in &untracked {
            args.push(p.clone().into());
        }
        let output = run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            args,
            DEFAULT_TIMEOUT_SECS,
        )?;
        ensure_success(&output, "git clean failed")?;
    }

    Ok(())
}

pub fn commit(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    message: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitCommitResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(GitError::EmptyCommitMessage);
    }

    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [OsStr::new("commit"), OsStr::new("-m"), OsStr::new(trimmed)],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.exit_code != Some(0) && nothing_to_commit(&output) {
        return Err(GitError::command("git commit", "nothing staged"));
    }
    ensure_success(&output, "git commit failed")?;

    let combined = git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        ["show", "-s", "--format=%H%n%s", "HEAD"],
    )?;
    let sha = combined.first().cloned().ok_or(GitError::CommandFailed {
        context: "failed to resolve commit sha",
        detail: String::new(),
    })?;
    let summary = combined.get(1).cloned().unwrap_or_default();

    Ok(GitCommitResult {
        commit_sha: sha,
        summary,
    })
}

pub fn push(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitPushResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;

    let upstream = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;
    if upstream.is_none() {
        return Err(GitError::NoUpstream);
    }

    let upstream = upstream.expect("checked above");
    let (remote, branch) = split_upstream(&upstream);

    // Name the destination instead of letting `git push` infer it. Under the
    // default `push.default = simple`, a bare push is fatal whenever the
    // upstream branch is named differently from the local one ("The upstream
    // branch of your current branch does not match the name of your current
    // branch"), and nothing is pushed. The upstream is already resolved above,
    // so the ambiguity git is complaining about does not exist here.
    let output = match (remote.as_deref(), branch.as_deref()) {
        (Some(remote), Some(branch)) => run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            ["push", remote, &format!("HEAD:{branch}")],
            NETWORK_TIMEOUT_SECS,
        )?,
        // An upstream without a remote is a local tracking branch; git's own
        // inference is the only thing that can resolve it.
        _ => run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            ["push"],
            NETWORK_TIMEOUT_SECS,
        )?,
    };
    ensure_success(&output, "git push failed")?;

    Ok(GitPushResult {
        remote,
        branch,
        pushed: true,
    })
}

const LOG_FORMAT: &str = "%H%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%s";
const MAX_LOG_LIMIT: u32 = 200;

pub fn log(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    limit: u32,
    before_sha: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitLogEntry>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let bounded = limit.clamp(1, MAX_LOG_LIMIT);
    let count_arg = format!("--max-count={bounded}");
    let format_arg = format!("--format={LOG_FORMAT}");
    let cursor = match before_sha {
        Some(sha) if !sha.is_empty() => {
            if !sha_is_safe(sha) {
                return Err(GitError::command("git log", "invalid cursor sha"));
            }
            Some(format!("{sha}^"))
        }
        _ => None,
    };
    let mut args: Vec<&OsStr> = vec![
        OsStr::new("log"),
        OsStr::new("--no-color"),
        OsStr::new("--shortstat"),
        OsStr::new(&count_arg),
        OsStr::new(&format_arg),
    ];
    if let Some(spec) = cursor.as_deref() {
        args.push(OsStr::new(spec));
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    run_log_entries(output)
}

fn run_log_entries(output: GitOutput) -> Result<Vec<GitLogEntry>> {
    if output.timed_out {
        return Err(GitError::TimedOut("git log"));
    }
    if output.exit_code != Some(0) {
        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if stderr.contains("does not have any commits yet")
            || stderr.contains("bad default revision")
            || stderr.contains("unknown revision")
            || stderr.contains("ambiguous argument 'head'")
        {
            return Ok(Vec::new());
        }
        return ensure_success(&output, "git log failed").map(|_| Vec::new());
    }
    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    Ok(parse_log_stdout(stdout, 0))
}

fn parse_log_stdout(stdout: &str, capacity: usize) -> Vec<GitLogEntry> {
    let mut entries: Vec<GitLogEntry> = Vec::with_capacity(capacity);
    // Lines we get back interleave:
    //   <sha>\x1f<author>\x1f<email>\x1f<ts>\x1f<parents>\x1f<subject>
    //   <blank>
    //    5 files changed, 12 insertions(+), 3 deletions(-)
    // Commits without diffstats (root commits, merges with no changes) just
    // skip the shortstat line. Detect commit headers by the presence of
    // the unit-separator we put in the format.
    for raw_line in stdout.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if line.contains('\x1f') {
            let mut fields = line.splitn(6, '\x1f');
            let sha = fields.next().unwrap_or("").to_string();
            if !sha_is_safe(&sha) {
                continue;
            }
            let author = fields.next().unwrap_or("").to_string();
            let author_email = fields.next().unwrap_or("").to_string();
            let timestamp = fields.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
            let parents_raw = fields.next().unwrap_or("");
            let parents: Vec<String> = parents_raw
                .split_ascii_whitespace()
                .map(|s| s.to_string())
                .collect();
            let subject = fields.next().unwrap_or("").to_string();
            let short_sha = sha.chars().take(7).collect::<String>();
            entries.push(GitLogEntry {
                sha,
                short_sha,
                author,
                author_email,
                timestamp_secs: timestamp,
                parents,
                subject,
                files_changed: 0,
                insertions: 0,
                deletions: 0,
            });
            continue;
        }
        if let Some(current) = entries.last_mut() {
            if line.contains("file changed") || line.contains("files changed") {
                let (files, ins, del) = parse_shortstat(line);
                current.files_changed = files;
                current.insertions = ins;
                current.deletions = del;
            }
        }
    }
    entries
}

pub fn show_commit_diff(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git show", "invalid commit identifier"));
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            OsStr::new("show"),
            OsStr::new("--no-color"),
            OsStr::new("--no-ext-diff"),
            OsStr::new("--patch-with-stat"),
            OsStr::new(sha),
            OsStr::new("--"),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git show failed")?;
    let diff_text = match String::from_utf8(output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };
    Ok(GitDiffResult {
        diff_text,
        truncated: output.truncated,
    })
}

fn parse_shortstat(tail: &str) -> (u32, u32, u32) {
    // Looks for a line like " 5 files changed, 12 insertions(+), 3 deletions(-)"
    for line in tail.lines() {
        let trimmed = line.trim();
        if !(trimmed.contains("file changed") || trimmed.contains("files changed")) {
            continue;
        }
        let mut files = 0u32;
        let mut ins = 0u32;
        let mut del = 0u32;
        for part in trimmed.split(',') {
            let part = part.trim();
            let num_str = part.split_ascii_whitespace().next().unwrap_or("0");
            let n: u32 = num_str.parse().unwrap_or(0);
            if part.contains("file") {
                files = n;
            } else if part.contains("insertion") {
                ins = n;
            } else if part.contains("deletion") {
                del = n;
            }
        }
        return (files, ins, del);
    }
    (0, 0, 0)
}

fn sha_is_safe(sha: &str) -> bool {
    !sha.is_empty() && sha.len() <= 64 && sha.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn commit_files(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitCommitFileChange>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git diff-tree", "invalid commit sha"));
    }

    let parents = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-list", "--parents", "-n", "1", sha],
    )?
    .ok_or_else(|| GitError::command("git diff-tree", "commit not found"))?;
    let parent = parents.split_ascii_whitespace().nth(1);
    let diff_args = |mode: &str| {
        let mut args = vec![
            "diff-tree".to_string(),
            "--no-commit-id".into(),
            "-r".into(),
            "-z".into(),
            mode.into(),
            "--root".into(),
            "-M".into(),
        ];
        if let Some(parent) = parent {
            args.push(parent.to_string());
        }
        args.push(sha.to_string());
        args
    };
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        diff_args("--name-status"),
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git diff-tree failed")?;

    if output.truncated {
        return Err(GitError::command(
            "git diff-tree",
            "commit file list exceeds the output limit",
        ));
    }
    let mut files = parse_diff_tree_name_status(&output.stdout);
    let stats = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        diff_args("--numstat"),
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&stats, "git diff-tree numstat failed")?;
    if stats.truncated {
        return Err(GitError::command(
            "git diff-tree",
            "commit file statistics exceed the output limit",
        ));
    }
    apply_numstat(&mut files, &stats.stdout);
    Ok(files)
}

pub fn commit_file_diff(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    path: &str,
    original_path: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffContentResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git show", "invalid commit sha"));
    }
    let resolved = resolve_within_repo(&repo_root.local_path, path)?;
    let rel = resolved
        .strip_prefix(&repo_root.local_path)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.replace('\\', "/"));

    let original_rel = match original_path {
        Some(orig) if !orig.is_empty() => {
            let resolved_orig = resolve_within_repo(&repo_root.local_path, orig)?;
            resolved_orig
                .strip_prefix(&repo_root.local_path)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| orig.replace('\\', "/"))
        }
        _ => rel.clone(),
    };

    let parent = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", &format!("{sha}^")],
    )?;
    let original = match parent.as_deref() {
        Some(p) => git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!("{p}:{original_rel}"),
        )?,
        None => TextSource::Missing,
    };
    let modified = git_show_text(
        &repo_root.workspace,
        &repo_root.git_path,
        &format!("{sha}:{rel}"),
    )?;

    let mut diff_args: Vec<OsString> = vec![
        "show".into(),
        "--no-color".into(),
        "--no-ext-diff".into(),
        "--format=".into(),
        "-m".into(),
        "--first-parent".into(),
        sha.into(),
        "--".into(),
    ];
    diff_args.push(rel.clone().into());
    if original_rel != rel {
        diff_args.push(original_rel.clone().into());
    }
    let patch_output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        diff_args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&patch_output, "git show <commit> -- <path> failed")?;
    let patch_text = match String::from_utf8(patch_output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };

    let is_binary =
        matches!(original, TextSource::Binary) || matches!(modified, TextSource::Binary);

    Ok(GitDiffContentResult {
        original_content: original.into_text(),
        modified_content: modified.into_text(),
        is_binary,
        fallback_patch: patch_text,
        truncated: patch_output.truncated,
    })
}

pub fn remote_url(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    name: &str,
    workspace: &WorkspaceEnv,
) -> Result<Option<String>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if name.is_empty() || name.len() > 64 || !name.chars().all(is_remote_name_char) {
        return Ok(None);
    }
    git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["config", "--get", &format!("remote.{name}.url")],
    )
}

fn is_remote_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'
}

fn parse_diff_tree_name_status(bytes: &[u8]) -> Vec<GitCommitFileChange> {
    let s = std::str::from_utf8(bytes).unwrap_or("");
    let mut tokens = s.split('\0').filter(|t| !t.is_empty());
    let mut files: Vec<GitCommitFileChange> = Vec::new();
    while let Some(status_tok) = tokens.next() {
        let status_char = status_tok.chars().next().unwrap_or(' ');
        if status_char == 'R' || status_char == 'C' {
            let original = match tokens.next() {
                Some(v) => v.to_string(),
                None => break,
            };
            let new_path = match tokens.next() {
                Some(v) => v.to_string(),
                None => break,
            };
            files.push(GitCommitFileChange {
                path: new_path,
                original_path: Some(original),
                status: status_char.to_string(),
                status_label: status_label_for(status_char),
                added: 0,
                removed: 0,
                is_binary: false,
            });
        } else {
            let path = match tokens.next() {
                Some(v) => v.to_string(),
                None => break,
            };
            files.push(GitCommitFileChange {
                path,
                original_path: None,
                status: status_char.to_string(),
                status_label: status_label_for(status_char),
                added: 0,
                removed: 0,
                is_binary: false,
            });
        }
    }
    files
}

fn apply_numstat(files: &mut [GitCommitFileChange], bytes: &[u8]) {
    let s = std::str::from_utf8(bytes).unwrap_or("");
    let tokens: Vec<&str> = s.split('\0').filter(|t| !t.is_empty()).collect();
    let mut idx = 0;
    while idx < tokens.len() {
        let header = tokens[idx];
        idx += 1;
        let mut cols = header.splitn(3, '\t');
        let added_raw = cols.next().unwrap_or("0");
        let removed_raw = cols.next().unwrap_or("0");
        let inline_path = cols.next().unwrap_or("");
        let is_binary = added_raw == "-" && removed_raw == "-";
        let added: u32 = if is_binary {
            0
        } else {
            added_raw.parse().unwrap_or(0)
        };
        let removed: u32 = if is_binary {
            0
        } else {
            removed_raw.parse().unwrap_or(0)
        };

        let (path, original) = if inline_path.is_empty() {
            let original = tokens.get(idx).map(|s| s.to_string()).unwrap_or_default();
            idx += 1;
            let new_path = tokens.get(idx).map(|s| s.to_string()).unwrap_or_default();
            idx += 1;
            (new_path, Some(original))
        } else {
            (inline_path.to_string(), None)
        };

        if path.is_empty() {
            continue;
        }
        if let Some(file) = files.iter_mut().find(|f| f.path == path) {
            file.added = added;
            file.removed = removed;
            file.is_binary = is_binary;
            if file.original_path.is_none() {
                if let Some(orig) = original {
                    if !orig.is_empty() && orig != file.path {
                        file.original_path = Some(orig);
                    }
                }
            }
        }
    }
}

fn status_label_for(c: char) -> String {
    match c {
        'A' => "Added".into(),
        'M' => "Modified".into(),
        'D' => "Deleted".into(),
        'R' => "Renamed".into(),
        'C' => "Copied".into(),
        'T' => "Type changed".into(),
        'U' => "Unmerged".into(),
        _ => format!("Status {c}"),
    }
}

pub fn fetch(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["fetch", "--prune"],
        NETWORK_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git fetch failed")
}

pub fn pull_ff_only(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["pull", "--ff-only"],
        NETWORK_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git pull --ff-only failed")
}

// ── Commit variants ───────────────────────────────────────────────────

fn head_commit_summary(repo_root: &ResolvedGitDirectory) -> Result<GitCommitResult> {
    let combined = git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        ["show", "-s", "--format=%H%n%s", "HEAD"],
    )?;
    let sha = combined.first().cloned().ok_or(GitError::CommandFailed {
        context: "failed to resolve commit sha",
        detail: String::new(),
    })?;
    let summary = combined.get(1).cloned().unwrap_or_default();
    Ok(GitCommitResult {
        commit_sha: sha,
        summary,
    })
}

pub fn commit_reword(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    message: &str,
    expected_sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitCommitResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(GitError::EmptyCommitMessage);
    }
    if !sha_is_safe(expected_sha) || head_commit_summary(&repo_root)?.commit_sha != expected_sha {
        return Err(GitError::command(
            "git reword",
            "HEAD changed; review the current commit before rewriting its message",
        ));
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["commit", "--amend", "--only", "-m", trimmed],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git commit --amend failed")?;
    head_commit_summary(&repo_root)
}

pub fn pre_commit_checks(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitPreCommitChecksResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let mut warnings: Vec<String> = Vec::new();

    let name = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["config", "user.name"],
    )?;
    let email = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["config", "user.email"],
    )?;
    if name.is_none() || email.is_none() {
        warnings.push(
            "未配置 git 用户信息：请先设置 git config --global user.name 与 user.email".into(),
        );
    }

    if let Ok(output) = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["diff", "--cached", "--raw", "--no-abbrev"],
        DEFAULT_TIMEOUT_SECS,
    ) {
        if output.exit_code == Some(0) && staged_blobs_over_limit(&repo_root, &output.stdout) {
            warnings.push("暂存区包含超过 2MB 的大文件，建议拆分为单独提交".into());
        }
    }

    if let Ok(Some(git_dir)) = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--absolute-git-dir"],
    ) {
        let git_dir = crate::modules::workspace::resolve_path(&git_dir, &repo_root.workspace);
        let in_progress = git_dir.join("rebase-merge").exists()
            || git_dir.join("rebase-apply").exists()
            || git_dir.join("MERGE_HEAD").exists();
        if in_progress {
            warnings.push("检测到 rebase 或 merge 正在进行，请先完成或中止当前操作".into());
        }
    }

    Ok(GitPreCommitChecksResult { warnings })
}

/// True when any staged blob is larger than 2MB. Blob shas come from
/// `git diff --cached --raw --no-abbrev`; sizes are batch-read via cat-file.
fn staged_blobs_over_limit(repo_root: &ResolvedGitDirectory, raw: &[u8]) -> bool {
    let raw = String::from_utf8_lossy(raw);
    let mut blobs: Vec<&str> = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if !line.starts_with(':') {
            continue;
        }
        let fields: Vec<&str> = line.split_ascii_whitespace().collect();
        if fields.len() < 5 {
            continue;
        }
        let status = fields[4];
        if status.starts_with('D') {
            continue;
        }
        let blob = fields[3];
        if !blob.is_empty() && blob != "0".repeat(blob.len()) {
            blobs.push(blob);
        }
    }
    if blobs.is_empty() {
        return false;
    }
    let input = blobs.join("\n") + "\n";
    let Ok(output) = run_git_with_input(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["cat-file", "--batch-check"],
        input.as_bytes(),
        DEFAULT_TIMEOUT_SECS,
    ) else {
        return false;
    };
    if output.exit_code != Some(0) {
        return false;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    const MAX_STAGED_FILE_BYTES: u64 = 2 * 1024 * 1024;
    stdout.lines().any(|line| {
        let fields: Vec<&str> = line.split_ascii_whitespace().collect();
        fields.len() == 3
            && fields[1] == "blob"
            && fields[2].parse::<u64>().unwrap_or(0) > MAX_STAGED_FILE_BYTES
    })
}

pub fn config_user(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitConfigUserResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let name = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["config", "user.name"],
    )?;
    let email = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["config", "user.email"],
    )?;
    Ok(GitConfigUserResult { name, email })
}

// ── Branch operations ─────────────────────────────────────────────────

fn validate_ref_name(kind: &str, name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(GitError::InvalidPath(format!("{kind}: {name}")));
    }
    Ok(())
}

pub fn create_branch(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    name: &str,
    checkout: bool,
    start_point: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    validate_ref_name("branch name", name)?;
    let mut args: Vec<OsString> = if checkout {
        vec!["checkout".into(), "-b".into()]
    } else {
        vec!["branch".into()]
    };
    args.push(name.into());
    if let Some(point) = start_point.filter(|p| !p.trim().is_empty()) {
        if point.starts_with('-') {
            return Err(GitError::InvalidPath(point.into()));
        }
        args.push(point.into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git branch failed")
}

pub fn rename_branch(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    old_name: &str,
    new_name: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    validate_ref_name("branch name", old_name)?;
    validate_ref_name("branch name", new_name)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["branch", "-m", old_name, new_name],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git branch -m failed")
}

pub fn delete_branch(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    name: &str,
    remote: bool,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    validate_ref_name("branch name", name)?;
    let output = if remote {
        run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            ["push", "origin", "--delete", name],
            NETWORK_TIMEOUT_SECS,
        )?
    } else {
        run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            ["branch", "-d", name],
            DEFAULT_TIMEOUT_SECS,
        )?
    };
    ensure_success(&output, "git branch delete failed")
}

#[allow(clippy::too_many_arguments)]
pub fn merge(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    branch: &str,
    ff_only: bool,
    no_ff: bool,
    squash: bool,
    message: Option<&str>,
    no_commit: bool,
    workspace: &WorkspaceEnv,
) -> Result<GitMergeResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    validate_ref_name("branch name", branch)?;

    let mut args: Vec<OsString> = vec!["merge".into()];
    if ff_only {
        args.push("--ff-only".into());
    } else if no_ff {
        args.push("--no-ff".into());
    }
    if squash {
        args.push("--squash".into());
    }
    if no_commit {
        args.push("--no-commit".into());
    } else if let Some(msg) = message.map(str::trim).filter(|m| !m.is_empty()) {
        args.push("-m".into());
        args.push(msg.into());
    } else {
        args.push("--no-edit".into());
    }
    args.push(branch.into());

    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.timed_out {
        return Err(GitError::TimedOut("git merge"));
    }
    merge_result(&output)
}

fn merge_result(output: &GitOutput) -> Result<GitMergeResult> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr);
    let lower = combined.to_ascii_lowercase();
    let up_to_date = lower.contains("already up to date");
    let conflicts = lower.contains("conflict");
    let message = if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        stderr.trim().to_string()
    };
    if output.exit_code == Some(0) {
        return Ok(GitMergeResult {
            merged: !up_to_date,
            up_to_date,
            conflicts: false,
            message,
        });
    }
    Ok(GitMergeResult {
        merged: false,
        up_to_date,
        conflicts,
        message,
    })
}

pub fn rebase(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    branch: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitRebaseResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    validate_ref_name("branch name", branch)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["rebase", branch],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.timed_out {
        return Err(GitError::TimedOut("git rebase"));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        stderr.trim().to_string()
    };
    if output.exit_code == Some(0) {
        return Ok(GitRebaseResult {
            ok: true,
            conflict: false,
            message,
        });
    }
    let lower = format!("{}\n{}", stdout, stderr).to_ascii_lowercase();
    Ok(GitRebaseResult {
        ok: false,
        conflict: lower.contains("conflict"),
        message,
    })
}

pub fn tag_create(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    name: &str,
    target: &str,
    options: &GitTagCreateOptions,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    validate_ref_name("tag name", name)?;
    if !sha_is_safe(target) {
        return Err(GitError::command("git tag", "invalid target commit sha"));
    }
    if options.annotated && options.message.as_deref().unwrap_or("").trim().is_empty() {
        return Err(GitError::command(
            "git tag",
            "annotated tag requires a message",
        ));
    }
    let mut args: Vec<OsString> = vec!["tag".into()];
    if options.annotated {
        args.push("-a".into());
        args.push("-m".into());
        args.push(options.message.as_deref().unwrap_or("").trim().into());
    }
    if options.force {
        args.push("-f".into());
    }
    args.push(name.into());
    args.push(target.into());
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git tag failed")
}

pub fn diff_with_ref(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    reference: &str,
    path: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    validate_ref_name("ref", reference)?;
    let mut args: Vec<OsString> = vec!["diff".into(), "--no-ext-diff".into(), reference.into()];
    if let Some(p) = path.filter(|p| !p.is_empty()) {
        args.push("--".into());
        args.push(pathspec_from_input(&repo_root.local_path, p)?.into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git diff failed")?;
    let diff_text = match String::from_utf8(output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };
    Ok(GitDiffResult {
        diff_text,
        truncated: output.truncated,
    })
}

pub fn compare_branches(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    left: &str,
    right: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitCompareResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    validate_ref_name("branch", left)?;
    validate_ref_name("branch", right)?;
    let format_arg = format!("--format={LOG_FORMAT}");
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            "log",
            "--no-color",
            "--shortstat",
            format_arg.as_str(),
            &format!("{right}..{left}"),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    let left_only = run_log_entries(output)?;
    let format_arg = format!("--format={LOG_FORMAT}");
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            "log",
            "--no-color",
            "--shortstat",
            format_arg.as_str(),
            &format!("{left}..{right}"),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    let right_only = run_log_entries(output)?;
    Ok(GitCompareResult {
        left_only,
        right_only,
    })
}

// ── Remotes ───────────────────────────────────────────────────────────

pub fn pull_advanced(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    strategy: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let flag: Option<&str> = match strategy {
        "merge" => None,
        "rebase" => Some("--rebase"),
        "ff-only" => Some("--ff-only"),
        "squash" => Some("--squash"),
        "no-commit" => Some("--no-commit"),
        other => {
            return Err(GitError::command(
                "git pull",
                format!("unknown strategy: {other}"),
            ));
        }
    };
    let args: Vec<&str> = match flag {
        Some(f) => vec!["pull", f],
        None => vec!["pull"],
    };
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        NETWORK_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git pull failed")
}

pub fn push_advanced(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    options: &GitPushOptions,
    workspace: &WorkspaceEnv,
) -> Result<GitPushResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;

    let upstream = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;
    let (upstream_remote, upstream_branch) = match upstream.as_deref() {
        Some(u) => split_upstream(u),
        None => (None, None),
    };
    let remote = match options
        .remote
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
    {
        Some(r) => {
            remote_name(r)?;
            r.to_string()
        }
        None => match upstream_remote.clone() {
            Some(r) => r,
            None => return Err(GitError::NoUpstream),
        },
    };

    remote_name(&remote)?;

    let local_branch = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--abbrev-ref", "HEAD"],
    )
    .ok()
    .flatten()
    .filter(|b| b != "HEAD");

    // Which branch this lands on depends on whether the chosen remote is the
    // one the upstream points at. Same remote means the configured upstream is
    // the target even when it is named differently; a different remote was
    // asked for explicitly, and there the same-named branch is the only sane
    // reading. Either way the destination is spelled out, because a bare
    // `git push <remote>` is still fatal under `push.default = simple` when the
    // two names disagree.
    let same_remote = upstream_remote.as_deref() == Some(remote.as_str());
    let branch = if same_remote {
        upstream_branch.or_else(|| local_branch.clone())
    } else {
        local_branch.clone().or(upstream_branch)
    };

    let tags = options.tags.as_deref();
    if tags == Some("all") {
        let output = run_git(
            &repo_root.workspace,
            Some(&repo_root.git_path),
            ["push", "--tags", &remote],
            NETWORK_TIMEOUT_SECS,
        )?;
        ensure_success(&output, "git push --tags failed")?;
    }

    let mut args: Vec<OsString> = vec!["push".into()];
    if options.force {
        args.push("--force-with-lease".into());
    }
    if options.no_verify {
        args.push("--no-verify".into());
    }
    if tags == Some("current") {
        args.push("--follow-tags".into());
    }
    args.push(remote.clone().into());
    if let Some(branch) = branch.as_deref() {
        args.push(format!("HEAD:{branch}").into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        NETWORK_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git push failed")?;

    Ok(GitPushResult {
        remote: Some(remote),
        branch,
        pushed: true,
    })
}

pub fn push_up_to_commit(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git push", "invalid commit sha"));
    }
    let branch = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--abbrev-ref", "HEAD"],
    )?
    .filter(|b| b != "HEAD")
    .ok_or_else(|| GitError::command("git push", "cannot push from a detached HEAD"))?;
    let spec = format!("{sha}:refs/heads/{branch}");
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["push", "origin", &spec],
        NETWORK_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git push failed")
}

pub fn remote_list(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitRemoteEntry>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let lines = git_stdout_lines(&repo_root.workspace, &repo_root.git_path, ["remote", "-v"])?;
    let mut remotes: Vec<GitRemoteEntry> = Vec::new();
    for line in lines {
        if !line.ends_with("(fetch)") {
            continue;
        }
        let mut parts = line.split_ascii_whitespace();
        let name = match parts.next() {
            Some(n) => n.to_string(),
            None => continue,
        };
        let url = match parts.next() {
            Some(u) => u.to_string(),
            None => continue,
        };
        if remotes.iter().any(|r| r.name == name) {
            continue;
        }
        remotes.push(GitRemoteEntry { name, url });
    }
    Ok(remotes)
}

fn remote_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.starts_with('-')
        || name.len() > 64
        || !name.chars().all(is_remote_name_char)
    {
        return Err(GitError::command("git remote", "invalid remote name"));
    }
    Ok(())
}

fn remote_url_arg(url: &str) -> Result<()> {
    if url.is_empty() || url.starts_with('-') {
        return Err(GitError::command("git remote", "invalid url"));
    }
    Ok(())
}

pub fn remote_add(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    name: &str,
    url: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    remote_name(name)?;
    remote_url_arg(url)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["remote", "add", name, url],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git remote add failed")
}

pub fn remote_remove(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    name: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    remote_name(name)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["remote", "remove", name],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git remote remove failed")
}

pub fn remote_set_url(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    name: &str,
    url: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    remote_name(name)?;
    remote_url_arg(url)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["remote", "set-url", name, url],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git remote set-url failed")
}

pub fn clone(
    registry: &WorkspaceRegistry,
    url: &str,
    target_dir: &str,
    options: &GitCloneOptions,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    if url.is_empty() || url.starts_with('-') {
        return Err(GitError::command("git clone", "invalid url"));
    }
    if target_dir.is_empty() || target_dir.starts_with('-') {
        return Err(GitError::command("git clone", "invalid target directory"));
    }
    let parent = Path::new(target_dir)
        .parent()
        .ok_or_else(|| GitError::command("git clone", "target has no parent directory"))?;
    let parent_str = parent.to_string_lossy();
    let parent = canonical_dir(registry, &parent_str, workspace)?;
    if !registry.is_authorized(&parent.local_path) {
        return Err(GitError::PathOutsideWorkspace(parent.local_path));
    }
    ensure_git_available(&parent.workspace)?;

    let mut args: Vec<OsString> = vec!["clone".into()];
    if options.shallow {
        args.push("--depth".into());
        args.push("1".into());
    }
    if options.recurse_submodules {
        args.push("--recurse-submodules".into());
    }
    args.push(url.into());
    args.push(target_dir.into());
    let output = run_git(&parent.workspace, None, args, NETWORK_TIMEOUT_SECS)?;
    ensure_success(&output, "git clone failed")?;

    if let Ok(dir) = canonical_dir(registry, target_dir, workspace) {
        let _ = registry.authorize(&dir.local_path);
    }
    Ok(())
}

pub fn fetch_unshallow(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["fetch", "--unshallow"],
        NETWORK_TIMEOUT_SECS,
    )?;
    if output.exit_code == Some(0) {
        return Ok(());
    }
    if output.timed_out {
        return Err(GitError::TimedOut("git fetch --unshallow"));
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if stderr.contains("does not appear to be a shallow repository")
        || stderr.contains("does not make sense")
    {
        return Ok(());
    }
    ensure_success(&output, "git fetch --unshallow failed")
}

// ── History editing ───────────────────────────────────────────────────

pub fn log_filtered(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    options: &GitLogFilterOptions,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitLogEntry>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let format_arg = format!("--format={LOG_FORMAT}");
    let mut args: Vec<OsString> = vec![
        "log".into(),
        "--no-color".into(),
        "--shortstat".into(),
        format_arg.into(),
    ];
    if let Some(branch) = options
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        if branch.starts_with('-') {
            return Err(GitError::InvalidPath(branch.into()));
        }
        args.push(branch.into());
    }
    if let Some(author) = options
        .author
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        args.push(format!("--author={author}").into());
    }
    if let Some(since) = options
        .since
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.push(format!("--since={since}").into());
    }
    if let Some(until) = options
        .until
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        args.push(format!("--until={until}").into());
    }
    if options.no_merges {
        args.push("--no-merges".into());
    }
    if let Some(count) = options.max_count {
        args.push(format!("--max-count={}", count.clamp(1, MAX_LOG_LIMIT)).into());
    }
    if let Some(skip) = options.skip {
        args.push(format!("--skip={skip}").into());
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    run_log_entries(output)
}

/// History of a single tracked file (renames followed), for the file-history
/// view. The path is repo-relative; separators are normalized on the way in.
pub fn log_file(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: &str,
    max_count: Option<u32>,
    skip: Option<u32>,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitLogEntry>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return Err(GitError::InvalidPath(path.into()));
    }
    let format_arg = format!("--format={LOG_FORMAT}");
    let mut args: Vec<OsString> = vec![
        "log".into(),
        "--no-color".into(),
        "--follow".into(),
        "--shortstat".into(),
        format_arg.into(),
    ];
    if let Some(count) = max_count {
        args.push(format!("--max-count={}", count.clamp(1, MAX_LOG_LIMIT)).into());
    }
    if let Some(skip_count) = skip {
        args.push(format!("--skip={skip_count}").into());
    }
    args.push("--".into());
    // Backslash separators from Windows callers are normalized to forward
    // slashes; git expects the latter in a repo-relative path.
    args.push(trimmed.replace('\\', "/").into());
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        args,
        DEFAULT_TIMEOUT_SECS,
    )?;
    run_log_entries(output)
}

pub fn reset(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    mode: &str,
    target: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let flag = match mode {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        other => {
            return Err(GitError::command(
                "git reset",
                format!("unknown mode: {other}"),
            ))
        }
    };
    let target = match target.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => {
            if !sha_is_safe(t) {
                return Err(GitError::command("git reset", "invalid target sha"));
            }
            t.to_string()
        }
        None => "HEAD".to_string(),
    };
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["reset", flag, &target],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git reset failed")
}

pub fn revert_commit(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git revert", "invalid commit sha"));
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["revert", "--no-edit", sha],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git revert failed")
}

pub fn cherry_pick(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git cherry-pick", "invalid commit sha"));
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["cherry-pick", sha],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git cherry-pick failed")
}

pub fn diff_range(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    from: &str,
    to: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    validate_ref_name("from", from)?;
    validate_ref_name("to", to)?;
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["diff", "--no-ext-diff", from, to],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git diff failed")?;
    let diff_text = match String::from_utf8(output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };
    Ok(GitDiffResult {
        diff_text,
        truncated: output.truncated,
    })
}

pub fn diff_commit_vs_worktree(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git diff", "invalid commit sha"));
    }
    let output = run_git(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        ["diff", "--no-ext-diff", sha],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git diff failed")?;
    let diff_text = match String::from_utf8(output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };
    Ok(GitDiffResult {
        diff_text,
        truncated: output.truncated,
    })
}

pub fn branches_containing(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<Vec<String>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git branch", "invalid commit sha"));
    }
    let lines = git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        ["branch", "-a", "--contains", sha],
    )?;
    let mut branches: Vec<String> = Vec::with_capacity(lines.len());
    for line in lines {
        let name = line.trim().trim_start_matches('*').trim();
        if !name.is_empty() {
            branches.push(name.to_string());
        }
    }
    Ok(branches)
}

fn nothing_to_commit(output: &GitOutput) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    stderr.contains("nothing to commit") || stdout.contains("nothing to commit")
}

fn resolve_pathspecs(repo_root: &Path, paths: &[String]) -> Result<Vec<String>> {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        out.push(pathspec_from_input(repo_root, p)?);
    }
    Ok(out)
}

fn pathspec_from_input(repo_root: &Path, rel: &str) -> Result<String> {
    let resolved = resolve_within_repo(repo_root, rel)?;
    Ok(pathspec(repo_root, &resolved))
}

fn pathspec(repo_root: &Path, absolute: &Path) -> String {
    absolute
        .strip_prefix(repo_root)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| absolute.to_string_lossy().replace('\\', "/"))
}

pub fn list_branches(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitBranchListResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;

    let mut branches: Vec<GitBranchEntry> = Vec::new();

    let current_branch = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        ["rev-parse", "--abbrev-ref", "HEAD"],
    )
    .ok()
    .flatten();
    let is_detached_head = current_branch.as_deref() == Some("HEAD");

    if let Ok(lines) = git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        [
            "branch",
            "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)",
        ],
    ) {
        for line in &lines {
            let mut parts = line.split('\0');
            let name = parts.next().unwrap_or("").to_string();
            let head_marker = parts.next().unwrap_or("");
            let upstream = parts.next().unwrap_or("").to_string();
            let is_head = head_marker == "*";
            if !name.is_empty() {
                branches.push(GitBranchEntry {
                    name,
                    kind: "local".into(),
                    worktree_path: None,
                    is_head,
                    is_detached: is_head && is_detached_head,
                    upstream: (!upstream.is_empty()).then_some(upstream),
                    has_local: false,
                });
            }
        }
    }

    // Remote-tracking branches. `origin/HEAD` is a symbolic alias for the
    // default branch, not something a user checks out, so it is filtered out.
    if let Ok(lines) = git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        ["branch", "--remotes", "--format=%(refname:short)"],
    ) {
        let local_names: std::collections::HashSet<String> = branches
            .iter()
            .filter(|b| b.kind == "local")
            .map(|b| b.name.clone())
            .collect();
        for line in &lines {
            let name = line.trim();
            // A real remote-tracking ref always has a `remote/branch` shape. A
            // slashless name is `origin/HEAD` shortened to `origin` (the remote's
            // default-branch pointer, a symref), which is not something to check out.
            if name.is_empty() || name.contains("->") || !name.contains('/') {
                continue;
            }
            if name.split('/').next_back() == Some("HEAD") {
                continue;
            }
            // Same-named locals stay listed too: the user may still want to
            // check the remote out under a different local name. has_local
            // lets the UI offer the local-branch shortcut for the default name.
            let short = name.split_once('/').map(|(_, rest)| rest).unwrap_or(name);
            branches.push(GitBranchEntry {
                name: name.to_string(),
                kind: "remote".into(),
                worktree_path: None,
                is_head: false,
                is_detached: false,
                upstream: None,
                has_local: local_names.contains(short),
            });
        }
    }

    if let Ok(lines) = git_stdout_lines(
        &repo_root.workspace,
        &repo_root.git_path,
        ["worktree", "list", "--porcelain"],
    ) {
        let mut current_worktree: Option<String> = None;
        let mut worktree_branch: Option<String> = None;
        let mut worktree_bare = false;
        let mut head_sha: Option<String> = None;
        for line in &lines {
            if let Some(rest) = line.strip_prefix("worktree ") {
                if let Some(wt_path) = current_worktree.take() {
                    if !worktree_bare {
                        push_worktree(
                            &mut branches,
                            wt_path,
                            worktree_branch.take(),
                            head_sha.take(),
                        );
                    }
                }
                current_worktree = Some(rest.trim().to_string());
                worktree_branch = None;
                worktree_bare = false;
                head_sha = None;
            } else if let Some(rest) = line.strip_prefix("HEAD ") {
                head_sha = Some(rest.trim().to_string());
            } else if let Some(rest) = line.strip_prefix("branch ") {
                let raw = rest.trim();
                worktree_branch = Some(raw.strip_prefix("refs/heads/").unwrap_or(raw).to_string());
            } else if line.starts_with("bare") {
                worktree_bare = true;
            }
        }
        if let Some(wt_path) = current_worktree.take() {
            if !worktree_bare {
                push_worktree(
                    &mut branches,
                    wt_path,
                    worktree_branch.take(),
                    head_sha.take(),
                );
            }
        }
    }

    // Prefer a branch's worktree entry over its local one, except for the current
    // branch: the main worktree is always listed, so !is_head keeps it local.
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut deduped: Vec<GitBranchEntry> = Vec::with_capacity(branches.len());
    for b in branches {
        if let Some(&existing_idx) = seen.get(&b.name) {
            let existing = &deduped[existing_idx];
            let should_replace = b.kind == "worktree"
                && existing.kind == "local"
                && existing.worktree_path.is_none()
                && !existing.is_head;
            if should_replace {
                let is_head = existing.is_head || b.is_head;
                deduped[existing_idx] = GitBranchEntry { is_head, ..b };
            } else if b.is_head && !existing.is_head {
                let mut updated = deduped[existing_idx].clone();
                updated.is_head = true;
                deduped[existing_idx] = updated;
            }
        } else {
            seen.insert(b.name.clone(), deduped.len());
            deduped.push(b);
        }
    }

    deduped.sort_by(|a, b| {
        let kind_ord = |k: &str| if k == "local" { 0u8 } else { 1u8 };
        kind_ord(&a.kind)
            .cmp(&kind_ord(&b.kind))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(GitBranchListResult { branches: deduped })
}

fn push_worktree(
    branches: &mut Vec<GitBranchEntry>,
    path: String,
    branch: Option<String>,
    head_sha: Option<String>,
) {
    let name = if let Some(ref b) = branch {
        b.clone()
    } else if let Some(ref sha) = head_sha {
        // if detached HEAD with no branch — show shortened SHA as name
        let short = if sha.len() >= 7 {
            &sha[..7]
        } else {
            sha.as_str()
        };
        format!("(detached @ {})", short)
    } else {
        return;
    };
    branches.push(GitBranchEntry {
        name,
        kind: "worktree".into(),
        worktree_path: Some(path),
        is_head: false,
        is_detached: branch.is_none(),
        upstream: None,
        has_local: false,
    });
}

/// For `origin/feature`, the local branch name to create (`feature`). Returns
/// `(short, local_exists)` only when the ref really is a remote-tracking one.
fn remote_checkout_plan(
    repo_root: &ResolvedGitDirectory,
    branch_name: &str,
) -> Option<(String, bool)> {
    let (_, short) = branch_name.split_once('/')?;
    if short.is_empty() {
        return None;
    }
    let is_remote = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        [
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{branch_name}"),
        ],
    )
    .ok()
    .flatten()
    .is_some();
    if !is_remote {
        return None;
    }
    let local_exists = git_stdout_line_opt(
        &repo_root.workspace,
        &repo_root.git_path,
        [
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{short}"),
        ],
    )
    .ok()
    .flatten()
    .is_some();
    Some((short.to_string(), local_exists))
}

pub fn checkout_branch(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    branch_name: &str,
    local_name: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if branch_name.starts_with('-') || branch_name.is_empty() {
        return Err(GitError::InvalidPath(branch_name.into()));
    }
    if let Some(name) = local_name {
        if name.trim().is_empty() || name.starts_with('-') {
            return Err(GitError::InvalidPath(name.into()));
        }
    }
    // `git checkout origin/x` lands on a detached HEAD. When the caller names a
    // remote-tracking ref, create the local branch that tracks it instead --
    // that is what picking a remote branch in the UI is asking for. The caller
    // may override the local branch name; without it, a same-named local
    // branch (which already tracks the remote) is checked out verbatim.
    let custom = local_name.filter(|n| !n.trim().is_empty());
    let output = match remote_checkout_plan(&repo_root, branch_name) {
        Some((short, local_exists)) => {
            if local_exists && custom.is_none() {
                run_git(
                    &repo_root.workspace,
                    Some(&repo_root.git_path),
                    ["checkout", &short],
                    DEFAULT_TIMEOUT_SECS,
                )?
            } else {
                let local = custom.unwrap_or(&short);
                run_git(
                    &repo_root.workspace,
                    Some(&repo_root.git_path),
                    ["checkout", "-b", local, "--track", branch_name],
                    DEFAULT_TIMEOUT_SECS,
                )?
            }
        }
        None => {
            if custom.is_some() {
                return Err(GitError::command(
                    "git checkout",
                    "a custom local name only applies to remote branches",
                ));
            }
            run_git(
                &repo_root.workspace,
                Some(&repo_root.git_path),
                ["checkout", branch_name],
                DEFAULT_TIMEOUT_SECS,
            )?
        }
    };
    ensure_success(&output, "git checkout failed")
}

// ── Multi-repo discovery ──────────────────────────────────────────────

/// Directories whose children are never scanned for git repos.
const SCAN_DENYLIST: &[&str] = &[
    "node_modules",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".git",
    ".terraform",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "vendor",
    "bower_components",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruby-lsp",
    ".svelte-kit",
    ".angular",
];

/// Maximum subdirectories to scan before giving up.
const SCAN_DIR_LIMIT: usize = 500;

pub fn scan_repos(
    registry: &WorkspaceRegistry,
    base_dir: &str,
    max_depth: u32,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitRepoHead>> {
    scan_repos_inner(registry, base_dir, max_depth, workspace).map(|(heads, _)| heads)
}

fn scan_repos_inner(
    registry: &WorkspaceRegistry,
    base_dir: &str,
    max_depth: u32,
    workspace: &WorkspaceEnv,
) -> Result<(Vec<GitRepoHead>, bool)> {
    let cwd = canonical_dir(registry, base_dir, workspace)?;
    if !registry.is_authorized(&cwd.local_path) {
        return Err(GitError::PathOutsideWorkspace(cwd.local_path));
    }
    ensure_git_available(&cwd.workspace)?;

    let depth = max_depth.clamp(1, 5) as usize;
    let mut candidates: Vec<(String, usize)> = Vec::new();
    let mut scanned = 0;
    let mut truncated = false;

    // Also check the base directory itself — it might be a git repo.
    let base_dot_git = cwd.local_path.join(".git");
    if base_dot_git.exists() {
        candidates.push((cwd.git_path.clone(), 0));
    }

    collect_git_dirs(
        &cwd.local_path,
        depth,
        &mut candidates,
        &mut scanned,
        &mut truncated,
    )?;

    log::info!(
        "git scan: {} candidate(s) under {}",
        candidates.len(),
        cwd.git_path
    );

    let mut heads: Vec<GitRepoHead> = parallel_jobs(candidates, |(git_path, _)| {
        resolve_repo_head(&cwd.workspace, &git_path)
    })?
    .into_iter()
    .flatten()
    .collect();

    log::info!("git scan: {} repo(s) resolved", heads.len());

    // Sort by repo_root so the list is stable.
    heads.sort_by(|a, b| a.repo_root.cmp(&b.repo_root));

    Ok((heads, truncated))
}

fn collect_git_dirs(
    base: &Path,
    max_depth: usize,
    out: &mut Vec<(String, usize)>,
    scanned: &mut usize,
    truncated: &mut bool,
) -> Result<()> {
    if max_depth == 0 {
        return Ok(());
    }
    let Ok(entries) = std::fs::read_dir(base) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        // Skip hidden and denylist directories.
        if name_str.starts_with('.') || SCAN_DENYLIST.contains(&name_str.as_ref()) {
            continue;
        }

        if ft.is_dir() {
            if *scanned >= SCAN_DIR_LIMIT {
                *truncated = true;
                break;
            }
            *scanned += 1;
            let git_path = crate::modules::fs::to_canon(entry.path());
            let git_child = entry.path().join(".git");
            if git_child.exists() {
                out.push((git_path, max_depth));
            } else {
                collect_git_dirs(&entry.path(), max_depth - 1, out, scanned, truncated)?;
            }
        }
    }
    Ok(())
}

fn resolve_repo_head(workspace: &WorkspaceEnv, repo_root: &str) -> Option<GitRepoHead> {
    match git_stdout_line_opt(workspace, repo_root, ["rev-parse", "--abbrev-ref", "HEAD"]) {
        Ok(Some(head)) => {
            let is_detached = head == "HEAD";
            Some(GitRepoHead {
                repo_root: repo_root.to_string(),
                branch: if is_detached {
                    "(detached)".to_string()
                } else {
                    head
                },
                is_detached,
            })
        }
        Ok(None) => {
            log::warn!("git scan: rev-parse returned empty for {}", repo_root);
            None
        }
        Err(err) => {
            log::warn!("git scan: rev-parse failed for {}: {}", repo_root, err);
            None
        }
    }
}

/// Fetch multiple repos in parallel. Each repo reports its own result.
pub fn workspace_snapshot(
    registry: &WorkspaceRegistry,
    base_dir: &str,
    max_depth: u32,
    workspace: &WorkspaceEnv,
) -> Result<GitWorkspaceSnapshot> {
    let (heads, truncated) = scan_repos_inner(registry, base_dir, max_depth, workspace)?;
    let root = canonical_dir(registry, base_dir, workspace)?.git_path;

    let mut repos: Vec<GitMultiRepoEntry> = Vec::with_capacity(heads.len());
    let mut total_changed = 0u32;

    for head in heads {
        // Resolve full repo info with upstream, then status.
        let (repo, status_result) = {
            let cwd = canonical_dir(registry, &head.repo_root, workspace);
            match cwd {
                Ok(cwd) => {
                    let _ = registry.authorize(&cwd.local_path);
                    let repo = repo_info_for_root(&cwd).ok();
                    let status = match repo.as_ref() {
                        Some(_) => status_inner(&cwd).ok(),
                        None => None,
                    };
                    (repo, status)
                }
                Err(_) => (None, None),
            }
        };

        if let Some(ref s) = status_result {
            total_changed = total_changed.saturating_add(s.changed_files.len() as u32);
        }

        let has_status = status_result.is_some();
        repos.push(GitMultiRepoEntry {
            repo_root: head.repo_root.clone(),
            branch: head.branch.clone(),
            upstream: repo.as_ref().and_then(|r| r.upstream.clone()),
            is_detached: head.is_detached,
            status: status_result,
            error: if has_status {
                None
            } else {
                Some("could not read repository status".to_string())
            },
        });
    }

    Ok(GitWorkspaceSnapshot {
        root,
        repos,
        total_changed,
        truncated,
    })
}

/// Extracted head/upstream resolution shared by resolve_repo and workspace_snapshot.
fn repo_info_for_root(cwd: &ResolvedGitDirectory) -> Result<GitRepoInfo> {
    let head = match git_stdout_lines(
        &cwd.workspace,
        &cwd.git_path,
        ["rev-parse", "--abbrev-ref", "HEAD"],
    )?
    .into_iter()
    .next()
    {
        Some(h) => h,
        None => git_stdout_line_opt(
            &cwd.workspace,
            &cwd.git_path,
            ["symbolic-ref", "--short", "HEAD"],
        )?
        .ok_or(GitError::CommandFailed {
            context: "failed to resolve HEAD",
            detail: String::new(),
        })?,
    };

    let upstream = git_stdout_line_opt(
        &cwd.workspace,
        &cwd.git_path,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;

    Ok(GitRepoInfo {
        repo_root: cwd.git_path.clone(),
        branch: head.clone(),
        upstream,
        is_detached: head == "HEAD",
    })
}

// ── Multi-repo fetch ───────────────────────────────────────────────────

/// Fetch multiple repos in parallel. Each repo reports its own result.
pub fn multi_fetch(
    registry: &WorkspaceRegistry,
    repo_roots: &[String],
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitFetchResult>> {
    if repo_roots.is_empty() {
        return Ok(Vec::new());
    }

    // Validate all roots first.
    let mut resolved: Vec<ResolvedGitDirectory> = Vec::with_capacity(repo_roots.len());
    for root in repo_roots {
        let r = authorized_repo_root(registry, root, workspace)?;
        ensure_git_available(&r.workspace)?;
        resolved.push(r);
    }

    let mut results = parallel_jobs(resolved, |r| {
        let root = r.git_path;
        let workspace = r.workspace;
        match run_git(
            &workspace,
            Some(&root),
            ["fetch", "--prune"],
            NETWORK_TIMEOUT_SECS,
        ) {
            Ok(output) if output.exit_code == Some(0) => GitFetchResult {
                repo_root: root,
                ok: true,
                error: None,
            },
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let detail = if !stderr.is_empty() {
                    stderr
                } else {
                    "fetch exited with non-zero status".to_string()
                };
                GitFetchResult {
                    repo_root: root,
                    ok: false,
                    error: Some(detail),
                }
            }
            Err(e) => GitFetchResult {
                repo_root: root,
                ok: false,
                error: Some(e.to_string()),
            },
        }
    })?;
    results.sort_by(|a, b| a.repo_root.cmp(&b.repo_root));
    Ok(results)
}
