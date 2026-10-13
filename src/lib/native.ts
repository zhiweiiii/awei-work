import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";

export type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
  gitignored: boolean;
};

export type CommandOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
};

export type GitRepoInfo = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  isDetached: boolean;
};

export type GitChangedFile = {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  statusLabel: string;
};

export type GitStatusSnapshot = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  isDetached: boolean;
  truncated: boolean;
  changedFiles: GitChangedFile[];
};

export type GitDiffResult = {
  diffText: string;
  truncated: boolean;
};

export type GitDiffContentResult = {
  originalContent: string;
  modifiedContent: string;
  isBinary: boolean;
  fallbackPatch: string;
  truncated: boolean;
};

export type GitCommitResult = {
  commitSha: string;
  summary: string;
};

export type GitPushResult = {
  remote: string | null;
  branch: string | null;
  pushed: boolean;
};

export type GitLogEntry = {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  timestampSecs: number;
  parents: string[];
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type GitCommitFileChange = {
  path: string;
  originalPath: string | null;
  status: string;
  statusLabel: string;
  added: number;
  removed: number;
  isBinary: boolean;
};

export type GitPanelSnapshot = {
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
};

export type GitRepoHead = {
  repoRoot: string;
  branch: string;
  isDetached: boolean;
};

export type GitFetchResult = {
  repoRoot: string;
  ok: boolean;
  error?: string;
};

export type GitMultiRepoEntry = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  isDetached: boolean;
  status: GitStatusSnapshot | null;
  error?: string;
};

export type GitWorkspaceSnapshot = {
  root: string;
  repos: GitMultiRepoEntry[];
  totalChanged: number;
  truncated: boolean;
};

export type GitDiscardEntry = {
  path: string;
  untracked: boolean;
};

export type GitBranchEntry = {
  name: string;
  kind: "local" | "worktree" | "remote";
  worktreePath: string | null;
  isHead: boolean;
  isDetached: boolean;
  upstream?: string | null;
  hasLocal: boolean;
};

export type GitBranchListResult = {
  branches: GitBranchEntry[];
};

export type PreCommitChecks = {
  warnings: string[];
};

export type GitConfigUser = {
  name: string | null;
  email: string | null;
};

export type GitMergeResult = {
  merged: boolean;
  upToDate: boolean;
  conflicts: boolean;
  message: string;
};

export type GitRebaseResult = {
  ok: boolean;
  conflict: boolean;
  message: string;
};

export type GitCompareResult = {
  leftOnly: GitLogEntry[];
  rightOnly: GitLogEntry[];
};

export type GitRemoteEntry = {
  name: string;
  url: string;
};

export type GitTagCreateOptions = {
  annotated?: boolean;
  message?: string | null;
  force?: boolean;
};

export type GitPushOptions = {
  force?: boolean;
  noVerify?: boolean;
  tags?: string | null;
  remote?: string | null;
};

export type GitCloneOptions = {
  shallow?: boolean;
  recurseSubmodules?: boolean;
};

export type GitLogFilterOptions = {
  branch?: string | null;
  author?: string | null;
  since?: string | null;
  until?: string | null;
  noMerges?: boolean;
  maxCount?: number | null;
  skip?: number | null;
};

export type GitCreateBranchOptions = {
  checkout?: boolean;
  startPoint?: string | null;
};

export type GitDeleteBranchOptions = {
  remote?: boolean;
};

export type GitMergeOptions = {
  ffOnly?: boolean;
  noFF?: boolean;
  squash?: boolean;
  message?: string | null;
  noCommit?: boolean;
};

export type ResetMode = "soft" | "mixed" | "hard";

export type WebStatus = {
  running: boolean;
  port: number;
  connections: number;
  failed_logins: number;
};

export const native = {
  workspaceCurrentDir: () => invoke<string>("workspace_current_dir"),
  workspaceAuthorize: (
    path: string,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<string>("workspace_authorize", {
      path,
      workspace,
    }),
  readFile: (path: string) =>
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    }),
  writeFile: (path: string, content: string) =>
    invoke<void>("fs_write_file", {
      path,
      content,
      workspace: currentWorkspaceEnv(),
    }),
  canonicalize: (path: string) =>
    invoke<string>("fs_canonicalize", {
      path,
      workspace: currentWorkspaceEnv(),
    }),
  createFile: (path: string) =>
    invoke<void>("fs_create_file", { path, workspace: currentWorkspaceEnv() }),
  createDir: (path: string) =>
    invoke<void>("fs_create_dir", { path, workspace: currentWorkspaceEnv() }),
  runCommand: (
    command: string,
    cwd?: string | null,
    timeoutSecs?: number,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<CommandOutput>("shell_run_command", {
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace,
    }),

  gitResolveRepo: (
    cwd: string,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitRepoInfo | null>("git_resolve_repo", {
      cwd,
      workspace,
    }),
  gitPanelSnapshot: (cwd: string) =>
    invoke<GitPanelSnapshot>("git_panel_snapshot", {
      cwd,
      workspace: currentWorkspaceEnv(),
    }),
  gitStatus: (repoRoot: string) =>
    invoke<GitStatusSnapshot>("git_status", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitDiff: (
    repoRoot: string,
    path: string | null,
    staged: boolean,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitDiffResult>("git_diff", {
      repoRoot,
      path,
      staged,
      workspace,
    }),
  gitDiffContent: (
    repoRoot: string,
    path: string,
    staged: boolean,
    originalPath?: string | null,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitDiffContentResult>("git_diff_content", {
      repoRoot,
      path,
      staged,
      originalPath: originalPath ?? null,
      workspace,
    }),
  gitStage: (repoRoot: string, paths: string[]) =>
    invoke<void>("git_stage", {
      repoRoot,
      paths,
      workspace: currentWorkspaceEnv(),
    }),
  gitUnstage: (repoRoot: string, paths: string[]) =>
    invoke<void>("git_unstage", {
      repoRoot,
      paths,
      workspace: currentWorkspaceEnv(),
    }),
  gitDiscard: (repoRoot: string, entries: GitDiscardEntry[]) =>
    invoke<void>("git_discard", {
      repoRoot,
      entries,
      workspace: currentWorkspaceEnv(),
    }),
  gitCommit: (repoRoot: string, message: string) =>
    invoke<GitCommitResult>("git_commit", {
      repoRoot,
      message,
      workspace: currentWorkspaceEnv(),
    }),
  gitFetch: (repoRoot: string) =>
    invoke<void>("git_fetch", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitPullFfOnly: (
    repoRoot: string,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<void>("git_pull_ff_only", {
      repoRoot,
      workspace,
    }),
  gitPush: (repoRoot: string) =>
    invoke<GitPushResult>("git_push", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitLog: (
    repoRoot: string,
    options?: { limit?: number; beforeSha?: string },
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitLogEntry[]>("git_log", {
      repoRoot,
      limit: options?.limit ?? null,
      beforeSha: options?.beforeSha ?? null,
      workspace,
    }),
  gitLogFile: (
    repoRoot: string,
    path: string,
    options?: { maxCount?: number; skip?: number },
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitLogEntry[]>("git_log_file", {
      repoRoot,
      path,
      maxCount: options?.maxCount ?? null,
      skip: options?.skip ?? null,
      workspace,
    }),
  gitShowCommit: (repoRoot: string, sha: string) =>
    invoke<GitDiffResult>("git_show_commit", {
      repoRoot,
      sha,
      workspace: currentWorkspaceEnv(),
    }),
  gitCommitFiles: (
    repoRoot: string,
    sha: string,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitCommitFileChange[]>("git_commit_files", {
      repoRoot,
      sha,
      workspace,
    }),
  gitCommitFileDiff: (
    repoRoot: string,
    sha: string,
    path: string,
    originalPath?: string | null,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitDiffContentResult>("git_commit_file_diff", {
      repoRoot,
      sha,
      path,
      originalPath: originalPath ?? null,
      workspace,
    }),
  gitRemoteUrl: (
    repoRoot: string,
    name?: string,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<string | null>("git_remote_url", {
      repoRoot,
      name: name ?? null,
      workspace,
    }),
  gitListBranches: (
    repoRoot: string,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitBranchListResult>("git_list_branches", {
      repoRoot,
      workspace,
    }),
  gitCheckoutBranch: (
    repoRoot: string,
    branch: string,
    localName?: string,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<void>("git_checkout_branch", {
      repoRoot,
      branch,
      localName: localName ?? null,
      workspace,
    }),
  gitScanRepos: (baseDir: string, maxDepth?: number) =>
    invoke<GitRepoHead[]>("git_scan_repos", {
      baseDir,
      maxDepth: maxDepth ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  gitWorkspaceSnapshot: (baseDir: string, maxDepth?: number) =>
    invoke<GitWorkspaceSnapshot>("git_workspace_snapshot", {
      baseDir,
      maxDepth: maxDepth ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  gitFetchAll: (repoRoots: string[]) =>
    invoke<GitFetchResult[]>("git_fetch_all", {
      repoRoots,
      workspace: currentWorkspaceEnv(),
    }),
  gitCommitReword: (repoRoot: string, message: string, expectedSha: string) =>
    invoke<GitCommitResult>("git_commit_reword", {
      repoRoot,
      message,
      expectedSha,
      workspace: currentWorkspaceEnv(),
    }),
  gitPreCommitChecks: (repoRoot: string) =>
    invoke<PreCommitChecks>("git_pre_commit_checks", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitConfigUser: (repoRoot: string) =>
    invoke<GitConfigUser>("git_config_user", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitCreateBranch: (
    repoRoot: string,
    name: string,
    options?: GitCreateBranchOptions,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<void>("git_create_branch", {
      repoRoot,
      name,
      checkout: options?.checkout ?? false,
      startPoint: options?.startPoint ?? null,
      workspace,
    }),
  gitRenameBranch: (
    repoRoot: string,
    oldName: string,
    newName: string,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<void>("git_rename_branch", {
      repoRoot,
      oldName,
      newName,
      workspace,
    }),
  gitDeleteBranch: (
    repoRoot: string,
    name: string,
    options?: GitDeleteBranchOptions,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<void>("git_delete_branch", {
      repoRoot,
      name,
      remote: options?.remote ?? false,
      workspace,
    }),
  gitMerge: (
    repoRoot: string,
    branch: string,
    options?: GitMergeOptions,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitMergeResult>("git_merge", {
      repoRoot,
      branch,
      ffOnly: options?.ffOnly ?? false,
      noFF: options?.noFF ?? false,
      squash: options?.squash ?? false,
      message: options?.message ?? null,
      noCommit: options?.noCommit ?? false,
      workspace,
    }),
  gitRebase: (
    repoRoot: string,
    branch: string,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitRebaseResult>("git_rebase", {
      repoRoot,
      branch,
      workspace,
    }),
  gitTagCreate: (
    repoRoot: string,
    name: string,
    target: string,
    options?: GitTagCreateOptions,
  ) =>
    invoke<void>("git_tag_create", {
      repoRoot,
      name,
      target,
      options: {
        annotated: options?.annotated ?? false,
        message: options?.message ?? null,
        force: options?.force ?? false,
      },
      workspace: currentWorkspaceEnv(),
    }),
  gitDiffWithRef: (
    repoRoot: string,
    ref: string,
    path?: string | null,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitDiffResult>("git_diff_with_ref", {
      repoRoot,
      reference: ref,
      path: path ?? null,
      workspace,
    }),
  gitCompareBranches: (
    repoRoot: string,
    left: string,
    right: string,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitCompareResult>("git_compare_branches", {
      repoRoot,
      left,
      right,
      workspace,
    }),
  gitPullAdvanced: (repoRoot: string, strategy: string) =>
    invoke<void>("git_pull_advanced", {
      repoRoot,
      strategy,
      workspace: currentWorkspaceEnv(),
    }),
  gitPushAdvanced: (repoRoot: string, options?: GitPushOptions) =>
    invoke<GitPushResult>("git_push_advanced", {
      repoRoot,
      options: {
        force: options?.force ?? false,
        noVerify: options?.noVerify ?? false,
        tags: options?.tags ?? null,
        remote: options?.remote ?? null,
      },
      workspace: currentWorkspaceEnv(),
    }),
  gitPushUpToCommit: (repoRoot: string, sha: string) =>
    invoke<void>("git_push_up_to_commit", {
      repoRoot,
      sha,
      workspace: currentWorkspaceEnv(),
    }),
  gitRemoteList: (
    repoRoot: string,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitRemoteEntry[]>("git_remote_list", {
      repoRoot,
      workspace,
    }),
  gitRemoteAdd: (repoRoot: string, name: string, url: string) =>
    invoke<void>("git_remote_add", {
      repoRoot,
      name,
      url,
      workspace: currentWorkspaceEnv(),
    }),
  gitRemoteRemove: (repoRoot: string, name: string) =>
    invoke<void>("git_remote_remove", {
      repoRoot,
      name,
      workspace: currentWorkspaceEnv(),
    }),
  gitRemoteSetUrl: (repoRoot: string, name: string, url: string) =>
    invoke<void>("git_remote_set_url", {
      repoRoot,
      name,
      url,
      workspace: currentWorkspaceEnv(),
    }),
  gitClone: (url: string, targetDir: string, options?: GitCloneOptions) =>
    invoke<void>("git_clone", {
      url,
      targetDir,
      options: {
        shallow: options?.shallow ?? false,
        recurseSubmodules: options?.recurseSubmodules ?? false,
      },
      workspace: currentWorkspaceEnv(),
    }),
  gitFetchUnshallow: (repoRoot: string) =>
    invoke<void>("git_fetch_unshallow", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitLogFiltered: (
    repoRoot: string,
    options?: GitLogFilterOptions,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitLogEntry[]>("git_log_filtered", {
      repoRoot,
      options: {
        branch: options?.branch ?? null,
        author: options?.author ?? null,
        since: options?.since ?? null,
        until: options?.until ?? null,
        noMerges: options?.noMerges ?? false,
        maxCount: options?.maxCount ?? null,
        skip: options?.skip ?? null,
      },
      workspace,
    }),
  gitReset: (repoRoot: string, mode: ResetMode, target?: string | null) =>
    invoke<void>("git_reset", {
      repoRoot,
      mode,
      target: target ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  gitRevertCommit: (repoRoot: string, sha: string) =>
    invoke<void>("git_revert_commit", {
      repoRoot,
      sha,
      workspace: currentWorkspaceEnv(),
    }),
  gitCherryPick: (repoRoot: string, sha: string) =>
    invoke<void>("git_cherry_pick", {
      repoRoot,
      sha,
      workspace: currentWorkspaceEnv(),
    }),
  gitDiffRange: (repoRoot: string, from: string, to: string) =>
    invoke<GitDiffResult>("git_diff_range", {
      repoRoot,
      from,
      to,
      workspace: currentWorkspaceEnv(),
    }),
  gitDiffCommitVsWorktree: (
    repoRoot: string,
    sha: string,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<GitDiffResult>("git_diff_commit_vs_worktree", {
      repoRoot,
      sha,
      workspace,
    }),
  gitBranchesContaining: (
    repoRoot: string,
    sha: string,
    workspace: WorkspaceEnv = currentWorkspaceEnv(),
  ) =>
    invoke<string[]>("git_branches_containing", {
      repoRoot,
      sha,
      workspace,
    }),
  webStatus: () => invoke<WebStatus>("web_status"),
};
