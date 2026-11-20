use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use super::errors::{GitError, Result};
use super::process::{ensure_success, run_git};
use super::types::{DEFAULT_TIMEOUT_SECS, NETWORK_TIMEOUT_SECS};
use super::utils::ResolvedGitDirectory;

fn running() -> &'static Mutex<HashSet<PathBuf>> {
    static RUNNING: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

struct PullGuard(PathBuf);

impl Drop for PullGuard {
    fn drop(&mut self) {
        if let Ok(mut paths) = running().lock() {
            paths.remove(&self.0);
        }
    }
}

fn git(repo: &ResolvedGitDirectory, args: &[&str], timeout: u64) -> Result<String> {
    let output = run_git(&repo.workspace, Some(&repo.git_path), args, timeout)?;
    ensure_success(&output, "git pull")?;
    if output.truncated {
        return Err(GitError::command(
            "git pull",
            "Git 输出超出读取上限，操作已停止",
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn value(repo: &ResolvedGitDirectory, args: &[&str]) -> Result<String> {
    Ok(git(repo, args, DEFAULT_TIMEOUT_SECS)?.trim().to_string())
}

fn identity(repo: &ResolvedGitDirectory) -> Result<(String, String, String)> {
    Ok((
        value(repo, &["symbolic-ref", "--quiet", "HEAD"])?,
        value(repo, &["rev-parse", "--verify", "HEAD"])?,
        value(repo, &["rev-parse", "--symbolic-full-name", "@{upstream}"])?,
    ))
}

fn stash_for(repo: &ResolvedGitDirectory, marker: &str) -> Result<Option<String>> {
    let list = git(
        repo,
        &["stash", "list", "-n", "32", "--format=%H%x00%gs"],
        DEFAULT_TIMEOUT_SECS,
    )?;
    Ok(list.lines().find_map(|line| {
        let (oid, message) = line.split_once('\0')?;
        message.ends_with(marker).then(|| oid.to_string())
    }))
}

pub(super) fn fast_forward(repo: &ResolvedGitDirectory) -> Result<()> {
    {
        let mut paths = running()
            .lock()
            .map_err(|_| GitError::command("git pull", "拉取状态不可用"))?;
        if !paths.insert(repo.local_path.clone()) {
            return Err(GitError::command("git pull", "该仓库正在拉取，请稍后重试"));
        }
    }
    let _guard = PullGuard(repo.local_path.clone());
    let operations = git(
        repo,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "MERGE_HEAD",
            "--git-path",
            "rebase-merge",
            "--git-path",
            "rebase-apply",
            "--git-path",
            "CHERRY_PICK_HEAD",
            "--git-path",
            "REVERT_HEAD",
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if operations
        .lines()
        .any(|path| std::path::Path::new(path).exists())
    {
        return Err(GitError::command(
            "git pull",
            "仓库有未完成的合并、变基或挑选提交，请先处理",
        ));
    }
    let before = identity(repo)?;
    git(repo, &["fetch", "--prune"], NETWORK_TIMEOUT_SECS)?;
    if identity(repo)? != before {
        return Err(GitError::command(
            "git pull",
            "分支、HEAD 或上游已变化，未修改本地文件",
        ));
    }
    let target = value(repo, &["rev-parse", "--verify", "@{upstream}"])?;
    let range = format!("{}...{target}", before.1);
    let counts = value(repo, &["rev-list", "--left-right", "--count", &range])?;
    let counts: Vec<u64> = counts
        .split_whitespace()
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()
        .map_err(|_| GitError::command("git pull", "无法读取分支领先、落后数量"))?;
    let [ahead, behind] = counts.as_slice() else {
        return Err(GitError::command("git pull", "分支比较结果不完整"));
    };
    if *behind == 0 {
        return Ok(());
    }
    if *ahead > 0 {
        return Err(GitError::command(
            "git pull",
            "本地与上游已分叉，请先选择合并或变基",
        ));
    }
    let conflicts = git(
        repo,
        &["diff", "--name-only", "--diff-filter=U", "-z"],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if !conflicts.is_empty() {
        return Err(GitError::command(
            "git pull",
            "本地存在未解决的冲突，未保存或拉取",
        ));
    }
    let status = git(
        repo,
        &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
        DEFAULT_TIMEOUT_SECS,
    )?;
    let backup = if status.is_empty() {
        None
    } else {
        let marker = format!(
            "awei-work pull backup {}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let saved = git(
            repo,
            &["stash", "push", "--include-untracked", "--message", &marker],
            DEFAULT_TIMEOUT_SECS,
        );
        let backup = stash_for(repo, &marker).map_err(|error| {
            GitError::command(
                "git pull",
                format!("本地备份查询失败，未拉取；请在 git stash list 查找 {marker}。{error}"),
            )
        })?;
        if let Err(error) = saved {
            return Err(GitError::command(
                "git pull",
                format!(
                    "保存本地修改失败，未拉取。备份：{}。{error}",
                    backup.as_deref().unwrap_or("未创建，请检查工作区")
                ),
            ));
        }
        let oid = backup.ok_or_else(|| {
            GitError::command(
                "git pull",
                "未确认本地备份，已停止；请检查工作区和 git stash list",
            )
        })?;
        log::info!("git pull: local backup retained stash={oid}");
        Some(oid)
    };
    let pulled = (|| {
        if identity(repo)? != before {
            return Err(GitError::command(
                "git pull",
                "分支、HEAD 或上游已变化，已停止",
            ));
        }
        if backup.is_some()
            && !git(
                repo,
                &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
                DEFAULT_TIMEOUT_SECS,
            )?
            .is_empty()
        {
            return Err(GitError::command(
                "git pull",
                "保存后工作区仍有改动，已停止拉取",
            ));
        }
        git(
            repo,
            &["merge", "--ff-only", "--no-autostash", &target],
            DEFAULT_TIMEOUT_SECS,
        )?;
        Ok(())
    })();
    let Some(oid) = backup else {
        return pulled;
    };
    let after = identity(repo);
    let same_branch = after.as_ref().is_ok_and(|after| {
        after.0 == before.0 && after.2 == before.2 && (after.1 == before.1 || after.1 == target)
    });
    if !same_branch {
        return Err(GitError::command("git pull", format!(
            "分支或 HEAD 已变化，未向新状态恢复本地修改。备份保留：{oid}，请通过 git stash list 核对"
        )));
    }
    let restored = git(
        repo,
        &["stash", "apply", "--index", &oid],
        DEFAULT_TIMEOUT_SECS,
    );
    if let Err(error) = restored {
        let phase = if pulled.is_ok() {
            "远程已拉取，但本地修改恢复未完成"
        } else {
            "拉取失败，本地修改恢复也未完成"
        };
        return Err(GitError::command("git pull", format!(
            "{phase}，未继续提交或推送。备份保留：{oid}，请处理当前冲突或核对 git stash list。{error}{}",
            pulled.err().map(|error| format!("\n拉取错误：{error}")).unwrap_or_default()
        )));
    }
    log::info!("git pull: local changes and index restored; backup retained stash={oid}");
    pulled
}
