use serde::{Deserialize, Serialize};

pub(crate) const DEFAULT_TIMEOUT_SECS: u64 = 30;
pub(crate) const NETWORK_TIMEOUT_SECS: u64 = 120;
pub(crate) const MAX_TIMEOUT_SECS: u64 = 180;
pub(crate) const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) const MIN_GIT_VERSION: &str = "2.23";

#[derive(Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitCommitMessageModel {
    #[default]
    Luna,
    CodexDefault,
    ClaudeDefault,
    Gateway,
}

#[derive(Deserialize)]
pub struct GitCommitMessageGatewayModel {
    pub provider: crate::modules::gateway::config::Provider,
    pub model: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub repo_root: String,
    pub branch: String,
    pub upstream: Option<String>,
    pub is_detached: bool,
}

/// Lightweight repo summary for multi-repo discovery.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoHead {
    pub repo_root: String,
    pub branch: String,
    pub is_detached: bool,
}

impl From<GitRepoInfo> for GitRepoHead {
    fn from(info: GitRepoInfo) -> Self {
        Self {
            repo_root: info.repo_root,
            branch: info.branch,
            is_detached: info.is_detached,
        }
    }
}

/// Result of a single fetch in a batch operation.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFetchResult {
    pub repo_root: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One repo's worth of info + status in a multi-repo snapshot.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitMultiRepoEntry {
    pub repo_root: String,
    pub branch: String,
    pub upstream: Option<String>,
    pub is_detached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<GitStatusSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Aggregated snapshot of all discovered repos under a workspace root.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceSnapshot {
    pub root: String,
    pub repos: Vec<GitMultiRepoEntry>,
    pub total_changed: u32,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub status_label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusSnapshot {
    pub repo_root: String,
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub is_detached: bool,
    pub truncated: bool,
    pub changed_files: Vec<GitChangedFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPanelSnapshot {
    pub repo: Option<GitRepoInfo>,
    pub status: Option<GitStatusSnapshot>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardEntry {
    pub path: String,
    pub untracked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub diff_text: String,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffContentResult {
    pub original_content: String,
    pub modified_content: String,
    pub is_binary: bool,
    pub fallback_patch: String,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub commit_sha: String,
    pub summary: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFileChange {
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
    pub status_label: String,
    pub added: u32,
    pub removed: u32,
    pub is_binary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub author_email: String,
    pub timestamp_secs: i64,
    pub parents: Vec<String>,
    pub subject: String,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushResult {
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub pushed: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchEntry {
    pub name: String,
    pub kind: String, // "local" | "worktree" | "remote"
    pub worktree_path: Option<String>,
    pub is_head: bool,
    pub is_detached: bool,
    /// Local entries only: the remote branch this local one tracks, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    /// Remote entries only: a local branch with the same short name exists.
    pub has_local: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchListResult {
    pub branches: Vec<GitBranchEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPreCommitChecksResult {
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConfigUserResult {
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitMergeResult {
    pub merged: bool,
    pub up_to_date: bool,
    pub conflicts: bool,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRebaseResult {
    pub ok: bool,
    pub conflict: bool,
    pub message: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GitTagCreateOptions {
    pub annotated: bool,
    pub message: Option<String>,
    pub force: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCompareResult {
    pub left_only: Vec<GitLogEntry>,
    pub right_only: Vec<GitLogEntry>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GitPushOptions {
    pub force: bool,
    pub no_verify: bool,
    pub tags: Option<String>,
    pub remote: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteEntry {
    pub name: String,
    pub url: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GitCloneOptions {
    pub shallow: bool,
    pub recurse_submodules: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GitLogFilterOptions {
    pub all: bool,
    pub branch: Option<String>,
    pub author: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub no_merges: bool,
    pub max_count: Option<u32>,
    pub skip: Option<u32>,
}

pub(crate) struct GitOutput {
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) timed_out: bool,
    pub(crate) truncated: bool,
}

pub(crate) enum TextSource {
    Missing,
    Binary,
    Text(String),
}

impl TextSource {
    pub(crate) fn into_text(self) -> String {
        match self {
            TextSource::Text(text) => text,
            TextSource::Missing | TextSource::Binary => String::new(),
        }
    }
}
