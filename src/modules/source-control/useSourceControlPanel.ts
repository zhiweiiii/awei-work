import {
  type GitChangedFile,
  type GitCommitResult,
  type GitDiscardEntry,
  type GitRepoHead,
  type GitRepoInfo,
  type GitStatusSnapshot,
  native as nativeCommands,
} from "@/lib/native";
import {
  invalidateDiff,
  invalidateRepoDiffs,
  workingDiffKey,
} from "@/modules/editor/lib/diffCache";
import {
  currentWorkspaceScopeKey,
  LOCAL_WORKSPACE,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "@/modules/workspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PushPlan } from "./useMultiRepoSourceControl";
import { type RepoStatusEntry, repoDisplayName } from "./useRepoStatuses";
import type { SourceControlSummary } from "./useSourceControl";

type PanelState = "closed" | "loading" | "no-repo" | "ready" | "error";
type DiffMode = "+" | "-";
type SelectionTransition = "none" | "moved-group" | "reset";

/** Lets the commit flow hand the final push over to the preview dialog. */
export type PushPreviewBridge = {
  buildPushPlan?: () => Promise<PushPlan>;
  /** Open (or close) the push preview with the given plan. */
  onPreviewPush: (plan: PushPlan | null) => void;
};

const RECONCILE_DEBOUNCE_MS = 180;

export type DiffSelection = {
  repoRoot: string;
  path: string;
  mode: DiffMode;
};

export type SourceControlEntry = {
  key: string;
  path: string;
  mode: DiffMode;
  indexStatus: string;
  worktreeStatus: string;
  statusLabel: string;
  statusCode: string;
  originalPath: string | null;
  untracked: boolean;
};

export type CheckState = "checked" | "indeterminate" | "unchecked";

/** One row per changed file (flat list) — merges the staged/unstaged split. */
export type SourceControlFileEntry = {
  key: string;
  /** Which repo the file belongs to; drives staging and diff in multi-repo. */
  repoRoot: string;
  path: string;
  originalPath: string | null;
  statusCode: string;
  statusLabel: string;
  checkState: CheckState;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
};

/** One repo's slice of the change list, rendered under a group header. */
export type RepoFileGroup = {
  repoRoot: string;
  name: string;
  files: SourceControlFileEntry[];
};

export type PendingDiscard = {
  scope: "single" | "all";
  count: number;
  label: string;
};

export type SourceControlPanelAction = (
  key: string,
  work: (workspace: WorkspaceEnv, ensureCurrent: () => void) => Promise<void>,
) => Promise<boolean>;

type SourceControlPanelState = {
  runAction: SourceControlPanelAction;
  isCurrent: () => boolean;
  panelState: PanelState;
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  selected: DiffSelection | null;
  commitMessage: string;
  actionBusy: string | null;
  statusError: string | null;
  actionError: string | null;
  remoteError: string | null;
  actionMessage: string | null;
  stagedEntries: SourceControlEntry[];
  unstagedEntries: SourceControlEntry[];
  fileEntries: SourceControlFileEntry[];
  /** Per-repo grouping for the change list; empty unless multi-repo. */
  repoGroups: RepoFileGroup[];
  headerCheckState: CheckState;
  allClean: boolean;
  canPush: boolean;
  pushHint: string | null;
  selectionTransition: SelectionTransition;
  stagedEmptyText: string;
  unstagedEmptyText: string;
  pendingDiscard: PendingDiscard | null;
  setCommitMessage: (value: string) => void;
  commitAndPush: () => Promise<void>;
  preCommitWarnings: string[] | null;
  confirmPreCommitWarnings: () => Promise<void>;
  cancelPreCommitWarnings: () => void;
  /** Active repo root when the last commit succeeded, enabling Reword. */
  rewordTarget: string | null;
  rewordOpen: boolean;
  rewordMessage: string;
  setRewordMessage: (value: string) => void;
  openReword: () => void;
  cancelReword: () => void;
  confirmReword: () => Promise<void>;
  refresh: () => Promise<void>;
  selectEntry: (entry: SourceControlEntry) => Promise<void>;
  selectFile: (entry: SourceControlFileEntry) => Promise<void>;
  stageEntry: (entry: SourceControlEntry) => Promise<void>;
  unstageEntry: (entry: SourceControlEntry) => Promise<void>;
  toggleStageFile: (entry: SourceControlFileEntry) => Promise<void>;
  toggleAll: () => Promise<void>;
  requestDiscardEntry: (entry: SourceControlEntry) => void;
  requestDiscardFile: (entry: SourceControlFileEntry) => void;
  requestDiscardAll: () => void;
  confirmPendingDiscard: () => Promise<void>;
  cancelPendingDiscard: () => void;
  stageAllEntries: () => Promise<void>;
  unstageAllEntries: () => Promise<void>;
  commit: () => Promise<void>;
  push: () => Promise<void>;
};

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown source control error";
}

function normalizeStatusCode(status: string): string {
  const code = status.trim().toUpperCase();
  switch (code) {
    case "?":
      return "U";
    case "A":
      return "A";
    case "M":
      return "M";
    case "D":
      return "D";
    case "R":
    case "C":
      return "R";
    case "U":
      return "U";
    default:
      return code || "M";
  }
}

function statusCodeForMode(mode: DiffMode, file: GitChangedFile): string {
  if (mode === "-" && file.untracked) return "U";
  const primary = mode === "+" ? file.indexStatus : file.worktreeStatus;
  const fallback = mode === "+" ? file.worktreeStatus : file.indexStatus;
  return normalizeStatusCode(primary !== " " ? primary : fallback);
}

function makeEntry(
  path: string,
  mode: DiffMode,
  file: GitChangedFile,
): SourceControlEntry {
  return {
    key: `${mode}:${path}`,
    path,
    mode,
    indexStatus: file.indexStatus,
    worktreeStatus: file.worktreeStatus,
    statusLabel: file.statusLabel,
    statusCode: statusCodeForMode(mode, file),
    originalPath: file.originalPath,
    untracked: file.untracked,
  };
}

function sameSelection(
  a: DiffSelection | null,
  b: DiffSelection | null,
): boolean {
  return (
    !!a &&
    !!b &&
    a.repoRoot === b.repoRoot &&
    a.path === b.path &&
    a.mode === b.mode
  );
}

function optimisticStage(
  status: GitStatusSnapshot,
  paths: Set<string>,
): GitStatusSnapshot {
  let changed = false;
  const next = status.changedFiles.map((file) => {
    if (!paths.has(file.path)) return file;
    if (file.staged && !file.unstaged) return file;
    changed = true;
    const wt =
      file.worktreeStatus !== " " ? file.worktreeStatus : file.indexStatus;
    return {
      ...file,
      indexStatus: wt,
      worktreeStatus: " ",
      staged: true,
      unstaged: false,
      untracked: false,
    };
  });
  if (!changed) return status;
  return { ...status, changedFiles: next };
}

function optimisticUnstage(
  status: GitStatusSnapshot,
  paths: Set<string>,
): GitStatusSnapshot {
  let changed = false;
  const next: GitChangedFile[] = [];
  for (const file of status.changedFiles) {
    if (!paths.has(file.path)) {
      next.push(file);
      continue;
    }
    if (!file.staged && file.unstaged) {
      next.push(file);
      continue;
    }
    changed = true;
    const idx =
      file.indexStatus !== " " ? file.indexStatus : file.worktreeStatus;
    if (idx === "R" && file.originalPath) {
      next.push({
        path: file.originalPath,
        originalPath: null,
        indexStatus: " ",
        worktreeStatus: "D",
        staged: false,
        unstaged: true,
        untracked: false,
        statusLabel: "Deleted",
      });
      next.push({
        path: file.path,
        originalPath: null,
        indexStatus: " ",
        worktreeStatus: "?",
        staged: false,
        unstaged: true,
        untracked: true,
        statusLabel: "Untracked",
      });
      continue;
    }
    next.push({
      ...file,
      originalPath: null,
      indexStatus: " ",
      worktreeStatus: idx === "A" ? "?" : idx,
      staged: false,
      unstaged: true,
      untracked: idx === "A",
    });
  }
  if (!changed) return status;
  return { ...status, changedFiles: next };
}

function optimisticDiscard(
  status: GitStatusSnapshot,
  paths: Set<string>,
): GitStatusSnapshot {
  let changed = false;
  const next: GitChangedFile[] = [];
  for (const file of status.changedFiles) {
    if (!paths.has(file.path)) {
      next.push(file);
      continue;
    }
    if (file.staged) {
      changed = true;
      next.push({
        ...file,
        worktreeStatus: " ",
        unstaged: false,
        untracked: false,
      });
    } else {
      changed = true;
    }
  }
  if (!changed) return status;
  return { ...status, changedFiles: next };
}

export type RepoStatusBundle = {
  entries: RepoStatusEntry[];
  applyStatus: (
    repoRoot: string,
    updater: (status: GitStatusSnapshot) => GitStatusSnapshot,
  ) => void;
  refreshRepo: (repoRoot: string) => Promise<void>;
  refreshAll: () => Promise<void>;
};

const NOOP_REPO_STATUSES: RepoStatusBundle = {
  entries: [],
  applyStatus: () => {},
  refreshRepo: async () => {},
  refreshAll: async () => {},
};

function entriesForStatus(
  repoRoot: string,
  snapshot: GitStatusSnapshot,
): SourceControlFileEntry[] {
  const seen = new Set<string>();
  const out: SourceControlFileEntry[] = [];
  for (const file of snapshot.changedFiles) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    const checkState: CheckState =
      file.staged && file.unstaged
        ? "indeterminate"
        : file.staged
          ? "checked"
          : "unchecked";
    const statusCode = file.unstaged
      ? statusCodeForMode("-", file)
      : statusCodeForMode("+", file);
    out.push({
      // Paths repeat across repos, so the row key has to carry the repo too.
      key: `${repoRoot}\u0000${file.path}`,
      repoRoot,
      path: file.path,
      originalPath: file.originalPath,
      statusCode,
      statusLabel: file.statusLabel,
      checkState,
      staged: file.staged,
      unstaged: file.unstaged,
      untracked: file.untracked,
    });
  }
  return out;
}

export function useSourceControlPanel(
  isOpen: boolean,
  summary: SourceControlSummary,
  onOpenDiff:
    | ((input: {
        path: string;
        repoRoot: string;
        mode: DiffMode;
        originalPath: string | null;
        title?: string;
      }) => void)
    | null,
  repos: GitRepoHead[] = [],
  repoStatuses: RepoStatusBundle = NOOP_REPO_STATUSES,
  pushPreview?: PushPreviewBridge,
): SourceControlPanelState {
  const workspace = LOCAL_WORKSPACE;
  const contextKey = JSON.stringify([
    workspaceScopeKey(workspace),
    summary.contextPath,
    summary.repo?.repoRoot,
    summary.status?.branch,
  ]);
  const contextRef = useRef({ key: contextKey });
  if (contextRef.current.key !== contextKey)
    contextRef.current = { key: contextKey };
  const context = contextRef.current;
  const mountedRef = useRef(true);
  const actionBusyRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const isCurrent = useCallback(
    () =>
      mountedRef.current &&
      contextRef.current === context &&
      currentWorkspaceScopeKey() === workspaceScopeKey(workspace),
    [context],
  );
  const ensureCurrent = useCallback(() => {
    if (!isCurrent())
      throw new Error(
        "Workspace or branch changed; remaining Git operations cancelled",
      );
  }, [isCurrent]);
  const native = useMemo(
    () =>
      new Proxy(nativeCommands, {
        get(target, property: keyof typeof nativeCommands) {
          const command = target[property];
          return async (...args: unknown[]) => {
            ensureCurrent();
            const result = await (
              command as (...args: unknown[]) => Promise<unknown>
            )(...args);
            ensureCurrent();
            return result;
          };
        },
      }),
    [ensureCurrent],
  );
  const [panelState, setPanelState] = useState<PanelState>("closed");
  const [repo, setRepo] = useState<GitRepoInfo | null>(null);
  const [status, setStatus] = useState<GitStatusSnapshot | null>(null);
  const [selected, setSelected] = useState<DiffSelection | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const commitMessageRef = useRef(commitMessage);
  commitMessageRef.current = commitMessage;
  const [localActionBusy, setLocalActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [selectionTransition, setSelectionTransition] =
    useState<SelectionTransition>("none");
  const [pendingDiscard, setPendingDiscard] = useState<
    | {
        scope: "single";
        repoRoot: string;
        entry: SourceControlEntry;
      }
    | { scope: "all"; repoRoot: string; entries: SourceControlEntry[] }
    | null
  >(null);
  const [preCommitWarnings, setPreCommitWarnings] = useState<string[] | null>(
    null,
  );
  const [pendingCommitAndPush, setPendingCommitAndPush] = useState(false);
  const [rewordTarget, setRewordTarget] = useState<string | null>(null);
  const [rewordOpen, setRewordOpen] = useState(false);
  const [rewordMessage, setRewordMessage] = useState("");
  const selectedRef = useRef<DiffSelection | null>(null);
  const reconcileTimerRef = useRef(0);
  const repoRootRef = useRef<string | null>(null);
  const branchRef = useRef<string | null>(null);
  const rewordShaRef = useRef<string | null>(null);
  const pendingDiscardScopeRef = useRef(context);
  const warningScopeRef = useRef(context);
  const rewordScopeRef = useRef(context);
  const stagedSignature = useMemo(
    () =>
      JSON.stringify([
        summary.status?.changedFiles.filter((file) => file.staged),
        repoStatuses.entries.map((entry) => [
          entry.repoRoot,
          entry.status.changedFiles.filter((file) => file.staged),
        ]),
      ]),
    [summary.status, repoStatuses.entries],
  );
  const commitSignature = useMemo(
    () => ({ context, commitMessage, stagedSignature }),
    [context, commitMessage, stagedSignature],
  );
  const warningSignatureRef = useRef<typeof commitSignature | null>(null);

  const runAction = useCallback(
    async (
      key: string,
      work: (
        workspace: WorkspaceEnv,
        ensureCurrent: () => void,
      ) => Promise<void>,
    ) => {
      if (actionBusyRef.current || summary.busyAction || !isCurrent())
        return false;
      actionBusyRef.current = true;
      setLocalActionBusy(key);
      setActionError(null);
      try {
        await work(workspace, ensureCurrent);
        ensureCurrent();
        return true;
      } catch (error) {
        if (isCurrent()) setActionError(normalizeError(error));
        return false;
      } finally {
        actionBusyRef.current = false;
        if (isCurrent()) setLocalActionBusy(null);
      }
    },
    [summary.busyAction, isCurrent, ensureCurrent],
  );

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const stagedEntries = useMemo(
    () =>
      (status?.changedFiles ?? [])
        .filter((file) => file.staged)
        .map((file) => makeEntry(file.path, "+", file)),
    [status],
  );

  const unstagedEntries = useMemo(
    () =>
      (status?.changedFiles ?? [])
        .filter((file) => file.unstaged)
        .map((file) => makeEntry(file.path, "-", file)),
    [status],
  );

  // Every repo in the workspace, so the change list is not limited to whichever
  // one the selector happens to point at. Statuses are owned by the multi-repo
  // layer (useMultiRepoSourceControl) so the badge, the list and the explorer
  // decorations all read the same numbers.
  const multiRepo = repos.length > 1;
  const {
    entries: repoStatusEntries,
    applyStatus: applyOtherStatus,
    refreshRepo: refreshOtherRepo,
    refreshAll: refreshOtherRepos,
  } = repoStatuses;

  const activeRepoRoot = repo?.repoRoot ?? null;

  const repoGroups = useMemo<RepoFileGroup[]>(() => {
    if (!multiRepo) return [];
    return repoStatusEntries.map((entry) => ({
      repoRoot: entry.repoRoot,
      name: entry.name,
      files: entriesForStatus(entry.repoRoot, entry.status),
    }));
  }, [multiRepo, repoStatusEntries]);

  const fileEntries = useMemo<SourceControlFileEntry[]>(() => {
    if (multiRepo) return repoGroups.flatMap((g) => g.files);
    if (!status || !activeRepoRoot) return [];
    return entriesForStatus(activeRepoRoot, status);
  }, [multiRepo, repoGroups, status, activeRepoRoot]);

  const headerCheckState = useMemo<CheckState>(() => {
    if (fileEntries.length === 0) return "unchecked";
    const allChecked = fileEntries.every((e) => e.checkState === "checked");
    if (allChecked) return "checked";
    const anyStaged = fileEntries.some((e) => e.staged);
    return anyStaged ? "indeterminate" : "unchecked";
  }, [fileEntries]);

  // Must read the aggregate, not the active repo: with the panel anchored on
  // repos[0], a clean first repo made this true and the whole list collapsed
  // into the "nothing to commit" hint while other repos had changes waiting.
  const allClean = fileEntries.length === 0;
  const canPush = !!status?.upstream && status.behind === 0;
  const pushHint = useMemo(() => {
    if (!status) return null;
    if (!status.upstream) {
      return "Configure or publish this branch in the terminal to enable push in this iteration.";
    }
    if (status.behind > 0) {
      return "Pull remote changes before pushing local commits.";
    }
    if (status.ahead === 0) {
      return `No local commits to push to ${status.upstream}.`;
    }
    return `Pushes to ${status.upstream}.`;
  }, [status]);
  const stagedEmptyText = "No staged changes";
  const unstagedEmptyText = "No unstaged changes";

  const cancelReconcile = useCallback(() => {
    if (reconcileTimerRef.current) {
      window.clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = 0;
    }
  }, []);

  const scheduleReconcile = useCallback(() => {
    cancelReconcile();
    reconcileTimerRef.current = window.setTimeout(() => {
      reconcileTimerRef.current = 0;
      void summary.refresh({ remote: "never" });
    }, RECONCILE_DEBOUNCE_MS);
  }, [cancelReconcile, summary]);

  useEffect(() => () => cancelReconcile(), [cancelReconcile]);

  const openSelection = useCallback(
    (
      sel: DiffSelection,
      repoRoot: string,
      file: GitChangedFile | undefined,
    ) => {
      onOpenDiff?.({
        path: sel.path,
        repoRoot,
        mode: sel.mode,
        originalPath: file?.originalPath ?? null,
      });
    },
    [onOpenDiff],
  );

  const refresh = useCallback(async () => {
    if (!isOpen) {
      setPanelState("closed");
      setSelectionTransition("none");
      return;
    }
    if (summary.repo) invalidateRepoDiffs(summary.repo.repoRoot);
    await summary.refresh({ remote: "never" });
  }, [isOpen, summary]);

  useEffect(() => {
    if (!isOpen) {
      setPanelState("closed");
      setSelectionTransition("none");
      return;
    }
    if (summary.isLoading && !summary.hasRepo && !summary.status) {
      setPanelState("loading");
      return;
    }
    if (!summary.hasRepo) {
      setRepo(null);
      setStatus(null);
      setSelected(null);
      setPanelState("no-repo");
      setSelectionTransition("none");
      if (repoRootRef.current !== null) {
        repoRootRef.current = null;
        branchRef.current = null;
        setRewordTarget(null);
      }
      return;
    }
    if (summary.localError && !summary.status) {
      setRepo(summary.repo);
      setStatus(null);
      setSelected(null);
      setPanelState("error");
      setSelectionTransition("none");
      return;
    }
    if (!summary.repo || !summary.status) {
      if (summary.isLoading) {
        setPanelState("loading");
      }
      return;
    }

    setRepo(summary.repo);
    setStatus(summary.status);
    setPanelState("ready");

    if (repoRootRef.current !== summary.repo.repoRoot) {
      repoRootRef.current = summary.repo.repoRoot;
      setRewordTarget(null);
    }
    if (branchRef.current !== summary.status.branch) {
      branchRef.current = summary.status.branch;
      setRewordTarget(null);
    }

    const current = selectedRef.current;
    const selectionStatus =
      current?.repoRoot === summary.repo.repoRoot
        ? summary.status
        : repoStatusEntries.find(
            (entry) => entry.repoRoot === current?.repoRoot,
          )?.status;
    const exists =
      !!current &&
      !!selectionStatus &&
      selectionStatus.changedFiles.some((file) => {
        if (file.path !== current.path) return false;
        return current.mode === "+" ? file.staged : file.unstaged;
      });

    if (!exists && current) {
      const samePathOtherMode = selectionStatus?.changedFiles.find(
        (file) =>
          file.path === current.path &&
          (current.mode === "+" ? file.unstaged : file.staged),
      );
      if (samePathOtherMode) {
        const moved: DiffSelection = {
          repoRoot: current.repoRoot,
          path: samePathOtherMode.path,
          mode: current.mode === "+" ? "-" : "+",
        };
        setSelected(moved);
        setSelectionTransition("moved-group");
      } else {
        setSelected(null);
        setSelectionTransition("reset");
      }
    } else {
      setSelectionTransition("none");
    }
  }, [
    isOpen,
    summary.hasRepo,
    summary.isLoading,
    summary.localError,
    summary.repo,
    summary.status,
    repoStatusEntries,
  ]);

  const selectEntry = useCallback(
    async (entry: SourceControlEntry) => {
      if (!repo) return;
      const nextSelection: DiffSelection = {
        repoRoot: repo.repoRoot,
        path: entry.path,
        mode: entry.mode,
      };
      if (sameSelection(selected, nextSelection)) {
        setActionError(null);
        setActionMessage(null);
        setSelectionTransition("none");
        return;
      }
      setSelected(nextSelection);
      setActionError(null);
      setActionMessage(null);
      setSelectionTransition("none");
      const file = status?.changedFiles.find((c) => c.path === entry.path);
      openSelection(nextSelection, repo.repoRoot, file);
    },
    [openSelection, repo, selected, status],
  );

  const runMutation = useCallback(
    async (
      busyKey: string,
      optimistic: ((status: GitStatusSnapshot) => GitStatusSnapshot) | null,
      ipc: () => Promise<void>,
      affected: string[],
      // Defaults to the active repo so every single-repo caller is unchanged.
      targetRepoRoot?: string,
    ) => {
      const root = targetRepoRoot ?? repo?.repoRoot;
      if (!root || summary.busyAction || actionBusyRef.current || !isCurrent())
        return false;
      actionBusyRef.current = true;
      const isActive = root === repo?.repoRoot;
      try {
        setLocalActionBusy(busyKey);
        setActionMessage(null);
        setActionError(null);
        if (optimistic) {
          if (isActive) summary.applyStatus(optimistic);
          else applyOtherStatus(root, optimistic);
        }
        for (const path of affected) {
          invalidateDiff(workingDiffKey(root, path, "+"));
          invalidateDiff(workingDiffKey(root, path, "-"));
        }
        await ipc();
        // Only the active repo has the debounced reconcile behind it; a
        // secondary repo has to be re-read directly or its optimistic state
        // would be the last word.
        if (isActive) scheduleReconcile();
        else await refreshOtherRepo(root);
        return isCurrent();
      } catch (error) {
        if (!isCurrent()) return false;
        setActionError(normalizeError(error));
        if (isActive) {
          cancelReconcile();
          await summary.refresh({ remote: "never" }).catch(() => {});
        } else {
          await refreshOtherRepo(root).catch(() => {});
        }
        return false;
      } finally {
        actionBusyRef.current = false;
        if (isCurrent()) setLocalActionBusy(null);
      }
    },
    [
      applyOtherStatus,
      cancelReconcile,
      refreshOtherRepo,
      repo,
      scheduleReconcile,
      summary,
      isCurrent,
    ],
  );

  const stageEntry = useCallback(
    async (entry: SourceControlEntry) => {
      if (!repo) return;
      const paths = new Set([entry.path]);
      await runMutation(
        `stage:${entry.path}`,
        (s) => optimisticStage(s, paths),
        () => native.gitStage(repo.repoRoot, [entry.path]),
        [entry.path],
      );
    },
    [repo, runMutation, native],
  );

  const unstageEntry = useCallback(
    async (entry: SourceControlEntry) => {
      if (!repo) return;
      const paths = new Set([entry.path]);
      await runMutation(
        `unstage:${entry.path}`,
        (s) => optimisticUnstage(s, paths),
        () => native.gitUnstage(repo.repoRoot, [entry.path]),
        [entry.path],
      );
    },
    [repo, runMutation, native],
  );

  const requestDiscardEntry = useCallback(
    (entry: SourceControlEntry) => {
      if (!repo || summary.busyAction || actionBusyRef.current || !isCurrent())
        return;
      setActionError(null);
      pendingDiscardScopeRef.current = context;
      setPendingDiscard({ scope: "single", repoRoot: repo.repoRoot, entry });
    },
    [repo, summary.busyAction, context, isCurrent],
  );

  const requestDiscardAll = useCallback(() => {
    if (
      !repo ||
      summary.busyAction ||
      actionBusyRef.current ||
      !isCurrent() ||
      unstagedEntries.length === 0
    )
      return;
    setActionError(null);
    pendingDiscardScopeRef.current = context;
    setPendingDiscard({
      scope: "all",
      repoRoot: repo.repoRoot,
      entries: unstagedEntries,
    });
  }, [repo, summary.busyAction, unstagedEntries, context, isCurrent]);

  const cancelPendingDiscard = useCallback(() => {
    setPendingDiscard(null);
  }, []);

  const confirmPendingDiscard = useCallback(async () => {
    if (
      !repo ||
      !pendingDiscard ||
      !isCurrent() ||
      pendingDiscardScopeRef.current !== context ||
      actionBusyRef.current
    )
      return;
    const list =
      pendingDiscard.scope === "single"
        ? [pendingDiscard.entry]
        : pendingDiscard.entries;
    const discardRepoRoot = pendingDiscard.repoRoot;
    const entries: GitDiscardEntry[] = list.map((entry) => ({
      path: entry.path,
      untracked: entry.untracked,
    }));
    const paths = new Set(list.map((entry) => entry.path));
    const succeeded = await runMutation(
      pendingDiscard.scope === "single"
        ? `discard:${list[0].path}`
        : "discard:all",
      (s) => optimisticDiscard(s, paths),
      () => native.gitDiscard(discardRepoRoot, entries),
      [...paths],
      discardRepoRoot,
    );
    if (succeeded && isCurrent()) setPendingDiscard(null);
  }, [pendingDiscard, repo, runMutation, isCurrent, context, native]);

  // Select-all spans every repo in multi-repo mode, one repo per call so each
  // gets its own optimistic update and reconcile.
  const stageAllEntries = useCallback(async () => {
    if (multiRepo) {
      for (const group of repoGroups) {
        const paths = new Set(
          group.files.filter((f) => f.unstaged).map((f) => f.path),
        );
        if (paths.size === 0) continue;
        await runMutation(
          `stage:all:${group.repoRoot}`,
          (s) => optimisticStage(s, paths),
          () => native.gitStage(group.repoRoot, [...paths]),
          [...paths],
          group.repoRoot,
        );
      }
      return;
    }
    if (!repo || unstagedEntries.length === 0) return;
    const paths = new Set(unstagedEntries.map((entry) => entry.path));
    await runMutation(
      "stage:all",
      (s) => optimisticStage(s, paths),
      () => native.gitStage(repo.repoRoot, [...paths]),
      [...paths],
    );
  }, [multiRepo, repo, repoGroups, runMutation, unstagedEntries, native]);

  const unstageAllEntries = useCallback(async () => {
    if (multiRepo) {
      for (const group of repoGroups) {
        const paths = new Set(
          group.files.filter((f) => f.staged).map((f) => f.path),
        );
        if (paths.size === 0) continue;
        await runMutation(
          `unstage:all:${group.repoRoot}`,
          (s) => optimisticUnstage(s, paths),
          () => native.gitUnstage(group.repoRoot, [...paths]),
          [...paths],
          group.repoRoot,
        );
      }
      return;
    }
    if (!repo || stagedEntries.length === 0) return;
    const paths = new Set(stagedEntries.map((entry) => entry.path));
    await runMutation(
      "unstage:all",
      (s) => optimisticUnstage(s, paths),
      () => native.gitUnstage(repo.repoRoot, [...paths]),
      [...paths],
    );
  }, [multiRepo, repo, repoGroups, runMutation, stagedEntries, native]);

  const selectFile = useCallback(
    async (entry: SourceControlFileEntry) => {
      const root = entry.repoRoot || repo?.repoRoot;
      if (!root) return;
      const mode: DiffMode = entry.unstaged ? "-" : "+";
      const nextSelection: DiffSelection = {
        repoRoot: root,
        path: entry.path,
        mode,
      };
      if (sameSelection(selected, nextSelection)) {
        setActionError(null);
        setActionMessage(null);
        setSelectionTransition("none");
        return;
      }
      setSelected(nextSelection);
      setActionError(null);
      setActionMessage(null);
      setSelectionTransition("none");
      const source =
        root === repo?.repoRoot
          ? status
          : (repoStatusEntries.find((e) => e.repoRoot === root)?.status ??
            null);
      const file = source?.changedFiles.find((c) => c.path === entry.path);
      openSelection(nextSelection, root, file);
    },
    [openSelection, repo, repoStatusEntries, selected, status],
  );

  const toggleStageFile = useCallback(
    async (entry: SourceControlFileEntry) => {
      const root = entry.repoRoot || repo?.repoRoot;
      if (!root) return;
      const paths = new Set([entry.path]);
      if (entry.checkState === "checked") {
        await runMutation(
          `unstage:${entry.key}`,
          (s) => optimisticUnstage(s, paths),
          () => native.gitUnstage(root, [entry.path]),
          [entry.path],
          root,
        );
      } else {
        await runMutation(
          `stage:${entry.key}`,
          (s) => optimisticStage(s, paths),
          () => native.gitStage(root, [entry.path]),
          [entry.path],
          root,
        );
      }
    },
    [repo, runMutation, native],
  );

  const toggleAll = useCallback(async () => {
    if (headerCheckState === "checked") await unstageAllEntries();
    else await stageAllEntries();
  }, [headerCheckState, stageAllEntries, unstageAllEntries]);

  const requestDiscardFile = useCallback(
    (entry: SourceControlFileEntry) => {
      if (!repo || summary.busyAction || actionBusyRef.current || !isCurrent())
        return;
      setActionError(null);
      pendingDiscardScopeRef.current = context;
      setPendingDiscard({
        scope: "single",
        repoRoot: entry.repoRoot || repo.repoRoot,
        entry: {
          key: `-:${entry.path}`,
          path: entry.path,
          mode: "-",
          indexStatus: " ",
          worktreeStatus: entry.statusCode,
          statusLabel: entry.statusLabel,
          statusCode: entry.statusCode,
          originalPath: entry.originalPath,
          untracked: entry.untracked,
        },
      });
    },
    [repo, summary.busyAction, context, isCurrent],
  );

  const executeCommit = useCallback(
    async (andPush: boolean, skipChecks: boolean) => {
      if (summary.busyAction) return;
      // Busy state goes up BEFORE the async pre-commit checks so the Commit
      // button flips to "Committing…" on the very click, not after the check
      // IPC round-trip (which can take a while with hooks installed).
      const busyKey = andPush ? "commit-and-push" : "commit";
      setLocalActionBusy(busyKey);
      setActionMessage(null);
      setActionError(null);

      const targets = multiRepo
        ? repoGroups
            .filter((group) => group.files.some((file) => file.staged))
            .map((group) => ({ repoRoot: group.repoRoot, name: group.name }))
        : repo && stagedEntries.length > 0
          ? [{ repoRoot: repo.repoRoot, name: repoDisplayName(repo.repoRoot) }]
          : [];
      if (!commitMessage.trim()) {
        setActionError("Enter a commit message.");
        setLocalActionBusy(null);
        return;
      }
      if (targets.length === 0) {
        setLocalActionBusy(null);
        return;
      }

      if (!skipChecks) {
        try {
          const checks = await Promise.all(
            targets.map((target) => native.gitPreCommitChecks(target.repoRoot)),
          );
          const warnings = [
            ...new Set(
              checks.flatMap((check, index) =>
                multiRepo
                  ? check.warnings.map(
                      (warning) => `${targets[index].name}: ${warning}`,
                    )
                  : check.warnings,
              ),
            ),
          ];
          if (warnings.length > 0) {
            warningScopeRef.current = context;
            warningSignatureRef.current = commitSignature;
            // The confirmation dialog re-invokes runCommit with skipChecks;
            // until then nothing is running, so release the busy state.
            setLocalActionBusy(null);
            setPendingCommitAndPush(andPush);
            setPreCommitWarnings(warnings);
            return;
          }
        } catch (error) {
          throw new Error(
            `Could not complete pre-commit checks: ${normalizeError(error)}`,
          );
        }
      }

      // Pull before committing, and only commit if every repo came back clean.
      // Committing first and discovering the remote had moved leaves a local
      // commit that cannot be pushed, which is the state this button exists to
      // avoid. Fast-forward only on purpose: it either applies cleanly or it
      // declines, and a merge started under a dirty tree is not something to
      // begin on the user's behalf.
      //
      // Runs after the pre-commit checks so the warning dialog, which
      // re-invokes this with skipChecks, does not pull twice.
      if (andPush) {
        const pullFailed: string[] = [];
        for (const target of targets) {
          try {
            const before = await native.gitStatus(target.repoRoot);
            // No upstream means nothing to pull from; the push step reports it.
            if (!before.upstream) continue;
            await native.gitFetch(target.repoRoot);
            const fresh = await native.gitStatus(target.repoRoot);
            if (fresh.behind === 0) continue;
            if (fresh.ahead > 0) {
              pullFailed.push(
                `${target.name}: 本地领先 ${fresh.ahead}、落后 ${fresh.behind}，已分叉，请先手动合并或变基`,
              );
              continue;
            }
            await native.gitPullFfOnly(target.repoRoot);
            invalidateRepoDiffs(target.repoRoot);
          } catch (error) {
            pullFailed.push(`${target.name}: ${normalizeError(error)}`);
          }
        }
        if (pullFailed.length > 0) {
          setActionError(`拉取失败，未提交。${pullFailed.join("; ")}`);
          await summary.refresh({ remote: "never" });
          setLocalActionBusy(null);
          return;
        }
      }

      setRewordTarget(null);
      const done: string[] = [];
      const failed: { name: string; error: string }[] = [];
      try {
        const effectiveMessage = commitMessage.trim();
        // Sequential: a shared commit message still means N independent commits,
        // and stopping mid-way has to leave a legible record of how far it got.
        for (const target of targets) {
          try {
            const result: GitCommitResult = await native.gitCommit(
              target.repoRoot,
              effectiveMessage,
            );
            invalidateRepoDiffs(target.repoRoot);
            if (!multiRepo) rewordShaRef.current = result.commitSha;
            done.push(`${target.name} ${result.commitSha.slice(0, 7)}`);
          } catch (error) {
            failed.push({ name: target.name, error: normalizeError(error) });
          }
        }
        let pushError: string | null = null;
        let pushed = false;
        if (andPush && failed.length === 0) {
          // When a push-preview bridge exists, hand the final push to the
          // preview dialog instead of pushing on the same click.
          if (pushPreview?.buildPushPlan) {
            try {
              const plan = await pushPreview.buildPushPlan();
              ensureCurrent();
              if (plan.entries.length > 0) {
                pushPreview.onPreviewPush(plan);
              } else if (plan.skipped.length > 0) {
                pushError =
                  "Committed, but no push plan is available. Review the skipped repositories.";
              }
            } catch (error) {
              ensureCurrent();
              pushError = `Committed, but could not prepare push confirmation: ${normalizeError(error)}`;
            }
          }
          if (!pushPreview?.buildPushPlan && !multiRepo) {
            const pushResult = await summary.runRemoteAction("push");
            ensureCurrent();
            pushed = pushResult.ok;
            if (!pushResult.ok)
              pushError =
                pushResult.error ?? "Commit completed, but push did not run";
          } else if (!pushPreview?.buildPushPlan) {
            pushError =
              "Committed, but batch push confirmation is unavailable. Review a new push plan.";
          }
        }
        if (failed.length === 0) {
          if (commitMessageRef.current === commitMessage) setCommitMessage("");
          if (!multiRepo && targets.length === 1) {
            rewordScopeRef.current = context;
            setRewordTarget(targets[0].repoRoot);
          }
        }
        if (done.length > 0) {
          const base =
            targets.length === 1
              ? `Committed ${done[0]}`
              : `Committed ${done.length}/${targets.length} repos: ${done.join(", ")}`;
          const message = base;
          setActionMessage(
            andPush && pushed
              ? `${message} and pushed${
                  summary.status?.upstream
                    ? ` to ${summary.status.upstream}`
                    : ""
                }`
              : message,
          );
        }
        if (failed.length > 0) {
          setActionError(failed.map((f) => `${f.name}: ${f.error}`).join("; "));
        }
        if (pushError) setActionError(pushError);
        await summary.refresh({ remote: "never" });
        if (multiRepo) await refreshOtherRepos();
      } finally {
        setLocalActionBusy(null);
      }
    },
    [
      commitMessage,
      multiRepo,
      pushPreview,
      refreshOtherRepos,
      repo,
      repoGroups,
      stagedEntries,
      summary,
      native,
      ensureCurrent,
      context,
      commitSignature,
    ],
  );

  const runCommit = useCallback(
    async (andPush: boolean, skipChecks: boolean) => {
      if (actionBusyRef.current || summary.busyAction || !isCurrent()) return;
      actionBusyRef.current = true;
      try {
        await executeCommit(andPush, skipChecks);
      } catch (error) {
        if (isCurrent()) setActionError(normalizeError(error));
      } finally {
        actionBusyRef.current = false;
        if (isCurrent()) setLocalActionBusy(null);
      }
    },
    [executeCommit, summary.busyAction, isCurrent],
  );

  const commit = useCallback(async () => {
    await runCommit(false, false);
  }, [runCommit]);

  const commitAndPush = useCallback(async () => {
    await runCommit(true, false);
  }, [runCommit]);

  const confirmPreCommitWarnings = useCallback(async () => {
    if (
      !preCommitWarnings ||
      warningScopeRef.current !== context ||
      !isCurrent()
    )
      return;
    setPreCommitWarnings(null);
    await runCommit(
      pendingCommitAndPush,
      warningSignatureRef.current === commitSignature,
    );
  }, [
    pendingCommitAndPush,
    runCommit,
    preCommitWarnings,
    context,
    isCurrent,
    commitSignature,
  ]);

  const cancelPreCommitWarnings = useCallback(() => {
    setPreCommitWarnings(null);
    setPendingCommitAndPush(false);
  }, []);

  const openReword = useCallback(() => {
    if (
      !rewordTarget ||
      summary.busyAction ||
      actionBusyRef.current ||
      rewordScopeRef.current !== context ||
      !isCurrent()
    )
      return;
    setRewordMessage("");
    setActionError(null);
    setRewordOpen(true);
  }, [rewordTarget, summary.busyAction, context, isCurrent]);

  const cancelReword = useCallback(() => {
    setRewordOpen(false);
    setRewordMessage("");
  }, []);

  const confirmReword = useCallback(async () => {
    if (
      !rewordTarget ||
      !rewordShaRef.current ||
      summary.busyAction ||
      actionBusyRef.current ||
      !isCurrent() ||
      rewordScopeRef.current !== context
    )
      return;
    const message = rewordMessage.trim();
    if (!message) return;
    const expectedSha = rewordShaRef.current;
    actionBusyRef.current = true;
    setLocalActionBusy("reword");
    setActionError(null);
    try {
      const [head] = await native.gitLog(rewordTarget, { limit: 1 });
      if (head?.sha !== rewordShaRef.current)
        throw new Error(
          "The latest commit changed; review it again before rewording",
        );
      const result = await native.gitCommitReword(
        rewordTarget,
        message,
        expectedSha,
      );
      rewordShaRef.current = result.commitSha;
      invalidateRepoDiffs(rewordTarget);
      setRewordOpen(false);
      setRewordMessage("");
      setActionMessage("Reworded the commit message");
      await summary.refresh({ remote: "never" });
      if (multiRepo) await refreshOtherRepos();
    } catch (error) {
      if (isCurrent()) setActionError(normalizeError(error));
    } finally {
      actionBusyRef.current = false;
      if (isCurrent()) setLocalActionBusy(null);
    }
  }, [
    multiRepo,
    refreshOtherRepos,
    rewordMessage,
    rewordTarget,
    summary,
    native,
    isCurrent,
    context,
  ]);

  const push = useCallback(async () => {
    if (!repo) return;
    setActionMessage(null);
    await runAction("push", async (_workspace, ensureCurrent) => {
      const result = await summary.runRemoteAction("push");
      ensureCurrent();
      if (!result.ok) throw new Error(result.error ?? "Push did not run");
      setActionMessage(
        status?.upstream ? `Pushed to ${status.upstream}` : "Push completed",
      );
    });
  }, [repo, status?.upstream, summary, runAction]);

  const pendingDiscardView = useMemo<PendingDiscard | null>(() => {
    if (!pendingDiscard) return null;
    if (pendingDiscard.scope === "single") {
      return {
        scope: "single",
        count: 1,
        label: pendingDiscard.entry.path,
      };
    }
    return {
      scope: "all",
      count: pendingDiscard.entries.length,
      label: `${pendingDiscard.entries.length} unstaged ${
        pendingDiscard.entries.length === 1 ? "file" : "files"
      }`,
    };
  }, [pendingDiscard]);

  return {
    runAction,
    isCurrent,
    panelState,
    repo,
    status,
    selected,
    commitMessage,
    actionBusy: localActionBusy ?? summary.busyAction,
    statusError: summary.localError,
    actionError,
    remoteError: summary.lastRemoteError,
    actionMessage,
    stagedEntries,
    unstagedEntries,
    fileEntries,
    repoGroups,
    headerCheckState,
    allClean,
    canPush,
    pushHint,
    selectionTransition,
    stagedEmptyText,
    unstagedEmptyText,
    pendingDiscard:
      pendingDiscardScopeRef.current === context ? pendingDiscardView : null,
    setCommitMessage,
    commitAndPush,
    preCommitWarnings:
      warningScopeRef.current === context ? preCommitWarnings : null,
    confirmPreCommitWarnings,
    cancelPreCommitWarnings,
    rewordTarget: rewordScopeRef.current === context ? rewordTarget : null,
    rewordOpen: rewordScopeRef.current === context && rewordOpen,
    rewordMessage,
    setRewordMessage,
    openReword,
    cancelReword,
    confirmReword,
    refresh,
    selectEntry,
    selectFile,
    stageEntry,
    unstageEntry,
    toggleStageFile,
    toggleAll,
    requestDiscardEntry,
    requestDiscardFile,
    requestDiscardAll,
    confirmPendingDiscard,
    cancelPendingDiscard,
    stageAllEntries,
    unstageAllEntries,
    commit,
    push,
  };
}
