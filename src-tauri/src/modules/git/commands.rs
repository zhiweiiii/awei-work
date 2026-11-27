use tauri::{AppHandle, Manager};

use crate::modules::git::operations;
use crate::modules::git::types::{
    DiscardEntry, GitBranchListResult, GitCloneOptions, GitCommitFileChange,
    GitCommitMessageGatewayModel, GitCommitMessageModel, GitCommitResult, GitCompareResult,
    GitConfigUserResult, GitDiffContentResult, GitDiffResult, GitFetchResult, GitLogEntry,
    GitLogFilterOptions, GitMergeResult, GitPanelSnapshot, GitPreCommitChecksResult,
    GitPushOptions, GitPushResult, GitRebaseResult, GitRemoteEntry, GitRepoHead, GitRepoInfo,
    GitStatusSnapshot, GitTagCreateOptions, GitWorkspaceSnapshot,
};
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

async fn blocking<F, T>(app: AppHandle, f: F) -> Result<T, String>
where
    F: FnOnce(&WorkspaceRegistry) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<WorkspaceRegistry>();
        f(&registry)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_generate_commit_message(
    repo_roots: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    model: Option<GitCommitMessageModel>,
    gateway_model: Option<GitCommitMessageGatewayModel>,
    app: AppHandle,
) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let handle = app.clone();
    blocking(app, move |registry| {
        super::commit_message::generate(
            &handle,
            registry,
            repo_roots,
            &workspace,
            model.unwrap_or_default(),
            gateway_model,
        )
    })
    .await
}

#[tauri::command]
pub async fn git_resolve_repo(
    cwd: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Option<GitRepoInfo>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::resolve_repo(r, &cwd, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_panel_snapshot(
    cwd: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitPanelSnapshot, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::panel_snapshot(r, &cwd, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_status(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitStatusSnapshot, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::status(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_diff(
    repo_root: String,
    path: Option<String>,
    staged: bool,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::diff(r, &repo_root, path.as_deref(), staged, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_diff_content(
    repo_root: String,
    path: String,
    staged: bool,
    original_path: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffContentResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::diff_content(
            r,
            &repo_root,
            &path,
            staged,
            original_path.as_deref(),
            &workspace,
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_stage(
    repo_root: String,
    paths: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::stage(r, &repo_root, &paths, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(
    repo_root: String,
    paths: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::unstage(r, &repo_root, &paths, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_discard(
    repo_root: String,
    entries: Vec<DiscardEntry>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::discard(r, &repo_root, &entries, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_commit(
    repo_root: String,
    message: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitCommitResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::commit(r, &repo_root, &message, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_fetch(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::fetch(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_pull_ff_only(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::pull_ff_only(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_push(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitPushResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::push(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_log(
    repo_root: String,
    limit: Option<u32>,
    before_sha: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<GitLogEntry>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::log(
            r,
            &repo_root,
            limit.unwrap_or(30),
            before_sha.as_deref(),
            &workspace,
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_log_file(
    repo_root: String,
    path: String,
    max_count: Option<u32>,
    skip: Option<u32>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<GitLogEntry>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::log_file(r, &repo_root, &path, max_count, skip, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_show_commit(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::show_commit_diff(r, &repo_root, &sha, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_files(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<GitCommitFileChange>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::commit_files(r, &repo_root, &sha, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_file_diff(
    repo_root: String,
    sha: String,
    path: String,
    original_path: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffContentResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::commit_file_diff(
            r,
            &repo_root,
            &sha,
            &path,
            original_path.as_deref(),
            &workspace,
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_remote_url(
    repo_root: String,
    name: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let remote = name.unwrap_or_else(|| "origin".to_string());
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::remote_url(r, &repo_root, &remote, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_list_branches(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitBranchListResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::list_branches(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_checkout_branch(
    repo_root: String,
    branch: String,
    local_name: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::checkout_branch(r, &repo_root, &branch, local_name.as_deref(), &workspace)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_scan_repos(
    base_dir: String,
    max_depth: Option<u32>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<GitRepoHead>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::scan_repos(r, &base_dir, max_depth.unwrap_or(3), &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_workspace_snapshot(
    base_dir: String,
    max_depth: Option<u32>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitWorkspaceSnapshot, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::workspace_snapshot(r, &base_dir, max_depth.unwrap_or(3), &workspace)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_fetch_all(
    repo_roots: Vec<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<GitFetchResult>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::multi_fetch(r, &repo_roots, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_reword(
    repo_root: String,
    message: String,
    expected_sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitCommitResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::commit_reword(r, &repo_root, &message, &expected_sha, &workspace)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_pre_commit_checks(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitPreCommitChecksResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::pre_commit_checks(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_config_user(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitConfigUserResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::config_user(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_create_branch(
    repo_root: String,
    name: String,
    checkout: bool,
    start_point: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::create_branch(
            r,
            &repo_root,
            &name,
            checkout,
            start_point.as_deref(),
            &workspace,
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_rename_branch(
    repo_root: String,
    old_name: String,
    new_name: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::rename_branch(r, &repo_root, &old_name, &new_name, &workspace)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_delete_branch(
    repo_root: String,
    name: String,
    remote: bool,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::delete_branch(r, &repo_root, &name, remote, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn git_merge(
    repo_root: String,
    branch: String,
    ff_only: bool,
    no_ff: bool,
    squash: bool,
    message: Option<String>,
    no_commit: bool,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitMergeResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::merge(
            r,
            &repo_root,
            &branch,
            ff_only,
            no_ff,
            squash,
            message.as_deref(),
            no_commit,
            &workspace,
        )
        .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_rebase(
    repo_root: String,
    branch: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitRebaseResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::rebase(r, &repo_root, &branch, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_tag_create(
    repo_root: String,
    name: String,
    target: String,
    options: GitTagCreateOptions,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::tag_create(r, &repo_root, &name, &target, &options, &workspace)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_diff_with_ref(
    repo_root: String,
    reference: String,
    path: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::diff_with_ref(r, &repo_root, &reference, path.as_deref(), &workspace)
            .map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_compare_branches(
    repo_root: String,
    left: String,
    right: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitCompareResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::compare_branches(r, &repo_root, &left, &right, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_pull_advanced(
    repo_root: String,
    strategy: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::pull_advanced(r, &repo_root, &strategy, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_push_advanced(
    repo_root: String,
    options: GitPushOptions,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitPushResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::push_advanced(r, &repo_root, &options, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_push_up_to_commit(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::push_up_to_commit(r, &repo_root, &sha, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_remote_list(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<GitRemoteEntry>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::remote_list(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_remote_add(
    repo_root: String,
    name: String,
    url: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::remote_add(r, &repo_root, &name, &url, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_remote_remove(
    repo_root: String,
    name: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::remote_remove(r, &repo_root, &name, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_remote_set_url(
    repo_root: String,
    name: String,
    url: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::remote_set_url(r, &repo_root, &name, &url, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_clone(
    url: String,
    target_dir: String,
    options: GitCloneOptions,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::clone(r, &url, &target_dir, &options, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_fetch_unshallow(
    repo_root: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::fetch_unshallow(r, &repo_root, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_log_filtered(
    repo_root: String,
    options: GitLogFilterOptions,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<GitLogEntry>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::log_filtered(r, &repo_root, &options, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_reset(
    repo_root: String,
    mode: String,
    target: Option<String>,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::reset(r, &repo_root, &mode, target.as_deref(), &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_revert_commit(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::revert_commit(r, &repo_root, &sha, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_cherry_pick(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<(), String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::cherry_pick(r, &repo_root, &sha, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_diff_range(
    repo_root: String,
    from: String,
    to: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::diff_range(r, &repo_root, &from, &to, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_diff_commit_vs_worktree(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<GitDiffResult, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::diff_commit_vs_worktree(r, &repo_root, &sha, &workspace).map_err(Into::into)
    })
    .await
}

#[tauri::command]
pub async fn git_branches_containing(
    repo_root: String,
    sha: String,
    workspace: Option<WorkspaceEnv>,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    blocking(app, move |r| {
        operations::branches_containing(r, &repo_root, &sha, &workspace).map_err(Into::into)
    })
    .await
}
