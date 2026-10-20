import {
  type GitFetchResult,
  type GitLogEntry,
  type GitRepoHead,
  type GitStatusSnapshot,
  native as nativeCommands,
} from "@/lib/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  currentWorkspaceScopeKey,
  LOCAL_WORKSPACE,
  workspaceScopeKey,
} from "@/modules/workspace";
import { errorToast } from "@/lib/errorToast";
import { toast } from "sonner";
import {
  isRejectedPushError,
  parseUpstreamRemote,
  type PushTagsMode,
  pushTagsValue,
} from "./remoteHelpers";
import { useRepoList } from "./useRepoList";
import {
  repoDisplayName,
  type RepoStatusEntry,
  useRepoStatuses,
} from "./useRepoStatuses";
import {
  canFastForward,
  type SourceControlRemoteAction,
  type SourceControlSummary,
  useSourceControl,
} from "./useSourceControl";

/** Every repo that failed, one per line, so the toast copy action yields
 *  all of them. They used to go to the console, out of the user reach. */
function failureDetail(
  failed: { repoRoot: string; error?: unknown }[],
): string {
  return failed
    .map(
      (f) =>
        `${f.repoRoot}: ${typeof f.error === "string" ? f.error : String(f.error)}`,
    )
    .join("\n");
}

// Push-preview bounds: patches for more than this many commits would turn the
// confirmation dialog into a wall of text, and a single patch beyond this size
// is truncated.
const PUSH_PREVIEW_MAX_COMMITS = 6;
const PUSH_PREVIEW_CHAR_LIMIT = 24_000;

/** Per-repo phase while a Sync is walking the workspace. */
export type RepoSyncPhase =
  | { kind: "pending" }
  | { kind: "fetching" }
  | { kind: "pulling"; commits: number }
  | { kind: "pulled"; commits: number }
  | { kind: "up-to-date" }
  | { kind: "no-upstream" }
  | { kind: "diverged" }
  | { kind: "failed"; error: string };

export type RepoSyncItem = {
  repoRoot: string;
  name: string;
  phase: RepoSyncPhase;
};

export type SyncProgress = {
  running: boolean;
  items: RepoSyncItem[];
};

/** One commit's patch, fetched for the push preview. */
export type PushPlanCommitDiff = {
  sha: string;
  shortSha: string;
  subject: string;
  diffText: string;
  truncated: boolean;
};

/** One repo's share of a pending push, shown in the confirmation dialog. */
export type PushPlanEntry = {
  repoRoot: string;
  name: string;
  branch: string;
  upstream: string;
  ahead: number;
  /** Commits the upstream is ahead by, when the push would need force. */
  behind?: number;
  /** Remote the push targets; defaults to the branch's upstream remote. */
  remote?: string;
  commits: GitLogEntry[];
  /** Patches of the newest commits (bounded), so the preview shows content. */
  diffs: PushPlanCommitDiff[];
  /** Commits without a fetched patch (`ahead - diffs.length`). */
  moreCommits: number;
};

export type PushPlan = {
  entries: PushPlanEntry[];
  /** Repos left out, with the reason, so the dialog can say why. */
  skipped: { name: string; reason: string }[];
};

export type PullStrategy =
  | "merge"
  | "rebase"
  | "ff-only"
  | "squash"
  | "no-commit";

export type PushAdvancedOptions = {
  force: boolean;
  noVerify: boolean;
  tags: PushTagsMode;
};

/** Repos the remote refused (rejected / non-fast-forward), force-worthy. */
export type PushAllResult = {
  rejected: { repoRoot: string; error: string }[];
  failed: { repoRoot: string; error: string }[];
};

export type GitRemoteEntry = { name: string; url: string };

export type CloneOptions = {
  shallow?: boolean;
  recurseSubmodules?: boolean;
};

type MultiRepoSourceControl = {
  /** All discovered repos in the workspace. */
  repos: GitRepoHead[];
  /** Currently selected repo root (name). */
  activeRepo: string | null;
  /** Switch to a different repo by its root path. */
  setActiveRepo: (root: string) => void;
  /** The source-control summary for the active repo (single-repo compatible). */
  summary: SourceControlSummary;
  /** Sum of changed files across all repos (aggregate badge number). */
  aggregatedChanges: number;
  /** Every repo with changes, ready for grouped listing and decorations. */
  repoStatusEntries: RepoStatusEntry[];
  /** Optimistically update one repo's snapshot. */
  applyRepoStatus: (
    repoRoot: string,
    updater: (status: GitStatusSnapshot) => GitStatusSnapshot,
  ) => void;
  /** Re-read a single repo's snapshot. */
  refreshRepoStatus: (repoRoot: string) => Promise<void>;
  /** Re-read every non-active repo's snapshot. */
  refreshAllRepoStatuses: () => Promise<void>;
  /** Fetch all repos. Results are reported via toast. */
  fetchAll: () => Promise<GitFetchResult[]>;
  /** Fetch + fast-forward pull, one repo at a time. */
  syncAll: () => Promise<void>;
  /** Live per-repo state of the running (or last) sync; null before the first. */
  syncProgress: SyncProgress | null;
  /** Dismiss the progress list. */
  clearSyncProgress: () => void;
  /** Inspect every repo and list what a push would send. Read-only. */
  buildPushPlan: () => Promise<PushPlan>;
  /** Push the planned repos one at a time; progress lands in syncProgress. */
  pushAll: (plan: PushPlan) => Promise<void>;
  /**
   * Push with options (force), one repo at a time. Repos the
   * remote refused come back in the result so the UI can offer a force retry.
   */
  pushAllAdvanced: (
    plan: PushPlan,
    options: PushAdvancedOptions,
  ) => Promise<PushAllResult>;
  /** Push the given commit and everything before it to the upstream. */
  pushUpToCommit: (repoRoot: string, sha: string) => Promise<void>;
  /** List a repo's remotes. */
  listRemotes: (repoRoot: string) => Promise<GitRemoteEntry[]>;
  /** Register a new remote. */
  addRemote: (repoRoot: string, name: string, url: string) => Promise<void>;
  /** Remove a remote. */
  removeRemote: (repoRoot: string, name: string) => Promise<void>;
  /** Point a remote at a different URL. */
  setRemoteUrl: (repoRoot: string, name: string, url: string) => Promise<void>;
  /** Clone a repository into a directory. */
  cloneRepository: (
    url: string,
    targetDir: string,
    options?: CloneOptions,
  ) => Promise<void>;
  /** Manually trigger a repo scan. */
  scanRepos: () => Promise<void>;
  /** Whether a scan or batch operation is in progress. */
  isLoading: boolean;
};

/**
 * Orchestrates multi-repo git state for the Source Control panel.
 *
 * Builds on `useRepoList` (discovery) and `useSourceControl` (per-repo
 * operations). When repos.length <= 1 degrades to single-repo behavior.
 */
export function useMultiRepoSourceControl(
  contextPath: string | null,
  scanRoot: string | null,
): MultiRepoSourceControl {
  const workspaceKey = workspaceScopeKey(LOCAL_WORKSPACE);
  const contextKey = `${workspaceKey}\0${scanRoot ?? ""}`;
  const contextRef = useRef({ key: contextKey });
  if (contextRef.current.key !== contextKey)
    contextRef.current = { key: contextKey };
  const context = contextRef.current;
  const mountedRef = useRef(false);
  const batchBusyRef = useRef(false);
  const summaryBusyRef = useRef<SourceControlRemoteAction | null>(null);
  const [batchBusy, setBatchBusy] = useState<SourceControlRemoteAction | null>(
    null,
  );
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const ensureCurrent = useCallback(() => {
    if (
      !mountedRef.current ||
      contextRef.current !== context ||
      currentWorkspaceScopeKey() !== workspaceKey
    )
      throw new Error("Workspace changed; remaining Git operations cancelled");
  }, [context, workspaceKey]);
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
  const runBatch = useCallback(
    async <T>(
      action: SourceControlRemoteAction,
      operation: () => Promise<T>,
    ): Promise<T> => {
      ensureCurrent();
      if (batchBusyRef.current || summaryBusyRef.current)
        throw new Error("Another Git batch operation is running");
      batchBusyRef.current = true;
      setBatchBusy(action);
      try {
        const result = await operation();
        ensureCurrent();
        return result;
      } finally {
        batchBusyRef.current = false;
        if (mountedRef.current) setBatchBusy(null);
      }
    },
    [ensureCurrent],
  );
  const {
    repos,
    activeRepo,
    setActiveRepo,
    scan,
    isLoading: scanLoading,
  } = useRepoList(scanRoot);

  // Derive the context-appropriate repo root for the single-repo summary.
  // When multi-repo: first entry whose root contains contextPath, else
  // the user-selected active repo, else the first entry.
  const effectiveRepoRoot = useMemo(() => {
    if (!repos.length) return null;
    // Membership check matters on a workspace switch: activeRepo still holds
    // the previous project's selection until the scan lands, and trusting it
    // pointed the whole panel at a repo the new workspace does not contain.
    if (activeRepo && repos.some((r) => r.repoRoot === activeRepo)) {
      return activeRepo;
    }
    // Find the repo that contains the current context path.
    if (contextPath) {
      const normalized = contextPath.replace(/\\/g, "/");
      const match = repos
        .filter((r) => {
          const root = r.repoRoot.replace(/\\/g, "/").replace(/\/$/, "");
          return normalized === root || normalized.startsWith(`${root}/`);
        })
        .sort((a, b) => b.repoRoot.length - a.repoRoot.length)[0];
      if (match) return match.repoRoot;
    }
    // Nothing contains the context, which is the normal shape of a workspace
    // that holds several repos without being one itself (tpaas-v4/*). Falling
    // through to "no repo" left panelState !== "ready", and the panel renders
    // its whole change area behind that — so every repo's changes disappeared.
    // Anchor on the first repo instead: the list shows them all regardless, and
    // branch/push get a target.
    return repos[0].repoRoot;
  }, [repos, activeRepo, contextPath]);

  // When repos exist but none match the context, show "no repo" state.
  const inMultiRepoMode = repos.length > 0;
  const effectiveEnabled = !inMultiRepoMode || effectiveRepoRoot !== null;

  // Single-repo summary driven by the effective repo root.
  const summary = useSourceControl(
    contextPath,
    effectiveEnabled,
    effectiveRepoRoot,
  );
  summaryBusyRef.current = summary.busyAction;

  // Every repo's snapshot. The active repo's one comes from `summary`; the
  // rest are fetched here so the aggregate badge, the grouped change list and
  // the explorer decorations all read the same numbers.
  const {
    heads: currentRepoHeads,
    entries: repoStatusEntries,
    applyStatus: applyRepoStatus,
    refreshRepo: refreshRepoStatus,
    refreshAll: refreshAllRepoStatuses,
  } = useRepoStatuses(
    repos,
    inMultiRepoMode,
    effectiveRepoRoot,
    summary.status,
  );

  const aggregatedChanges = useMemo(
    () =>
      repoStatusEntries.reduce(
        (sum, entry) => sum + entry.status.changedFiles.length,
        0,
      ),
    [repoStatusEntries],
  );

  const fetchAll = useCallback(async (): Promise<GitFetchResult[]> => {
    const roots = repos.map((r) => r.repoRoot);
    if (!roots.length) return [];
    try {
      const results = await native.gitFetchAll(roots);
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        toast.success(`Fetched ${results.length} repos`);
      } else if (failed.length < results.length) {
        errorToast(
          `Fetched ${results.length - failed.length}/${results.length} repos; ${failed.length} failed`,
          failureDetail(failed),
        );
      } else {
        errorToast(
          `Fetch failed for all ${results.length} repos`,
          failureDetail(failed),
        );
      }
      // Refresh status after batch fetch.
      await summary.refresh({ remote: "never" });
      ensureCurrent();
      await refreshAllRepoStatuses();
      return results;
    } catch (error) {
      errorToast("Batch fetch failed", error);
      return [];
    }
  }, [repos, summary, native, ensureCurrent, refreshAllRepoStatuses]);

  // Sync = fetch, then fast-forward pull where the fetch revealed new commits.
  // Repos are walked one at a time on purpose: running them together would put
  // several credential prompts and remote connections in flight at once, and a
  // failure part-way would leave no way to tell how far it got.
  const [syncProgress, setProgress] = useState<SyncProgress | null>(null);
  const progressContextRef = useRef(context);
  const setSyncProgress = useCallback(
    (value: React.SetStateAction<SyncProgress | null>) => {
      if (
        !mountedRef.current ||
        contextRef.current !== context ||
        currentWorkspaceScopeKey() !== workspaceKey
      )
        return;
      progressContextRef.current = context;
      setProgress(value);
    },
    [context, workspaceKey],
  );
  const autoClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A different repository scope must cancel the previous progress timer.
  useEffect(
    () => () => {
      if (autoClearRef.current) clearTimeout(autoClearRef.current);
      autoClearRef.current = null;
    },
    [contextKey],
  );

  const clearSyncProgress = useCallback(() => {
    if (autoClearRef.current) {
      clearTimeout(autoClearRef.current);
      autoClearRef.current = null;
    }
    setSyncProgress(null);
  }, [setSyncProgress]);

  const runPullWalk = useCallback(
    async (strategy: PullStrategy): Promise<{ failed: number }> => {
      const targets = repos.map((r) => ({
        repoRoot: r.repoRoot,
        name: repoDisplayName(r.repoRoot),
      }));
      if (!targets.length) return { failed: 0 };
      if (autoClearRef.current) {
        clearTimeout(autoClearRef.current);
        autoClearRef.current = null;
      }

      const setPhase = (repoRoot: string, phase: RepoSyncPhase) =>
        setSyncProgress((current) =>
          current
            ? {
                ...current,
                items: current.items.map((item) =>
                  item.repoRoot === repoRoot ? { ...item, phase } : item,
                ),
              }
            : current,
        );

      setSyncProgress({
        running: true,
        items: targets.map((t) => ({ ...t, phase: { kind: "pending" } })),
      });

      let pulled = 0;
      let failed = 0;
      // One repo at a time: concurrent runs would put several credential
      // prompts and remote connections in flight, and the progress list would
      // stop meaning "this is what it is doing right now".
      for (const target of targets) {
        ensureCurrent();
        setPhase(target.repoRoot, { kind: "fetching" });
        try {
          await native.gitFetch(target.repoRoot);
          const status = await native.gitStatus(target.repoRoot);
          if (!status.upstream) {
            setPhase(target.repoRoot, { kind: "no-upstream" });
          } else if (strategy === "ff-only") {
            // Preserves the original sync behavior: fast-forward only, diverged
            // branches stay out.
            if (canFastForward(status)) {
              const commits = status.behind;
              setPhase(target.repoRoot, { kind: "pulling", commits });
              await native.gitPullAdvanced(target.repoRoot, strategy);
              setPhase(target.repoRoot, { kind: "pulled", commits });
              pulled++;
            } else if (status.ahead > 0 && status.behind > 0) {
              failed++;
              setPhase(target.repoRoot, { kind: "diverged" });
            } else {
              setPhase(target.repoRoot, { kind: "up-to-date" });
            }
          } else if (status.behind > 0) {
            // merge/rebase/squash/no-commit can resolve a diverged branch, so
            // they pull whenever the remote actually moved.
            const commits = status.behind;
            setPhase(target.repoRoot, { kind: "pulling", commits });
            await native.gitPullAdvanced(target.repoRoot, strategy);
            setPhase(target.repoRoot, { kind: "pulled", commits });
            pulled++;
          } else {
            setPhase(target.repoRoot, { kind: "up-to-date" });
          }
        } catch (error) {
          failed++;
          setPhase(target.repoRoot, {
            kind: "failed",
            error: typeof error === "string" ? error : String(error),
          });
        }
      }

      setSyncProgress((current) =>
        current ? { ...current, running: false } : current,
      );
      await summary.refresh({ remote: "never" });
      ensureCurrent();
      await refreshAllRepoStatuses();
      // A clean run needs no follow-up; anything worth reading stays until the
      // user dismisses it.
      if (failed === 0 && pulled === 0) {
        autoClearRef.current = setTimeout(() => {
          autoClearRef.current = null;
          setSyncProgress(null);
        }, 2500);
      }
      return { failed };
    },
    [
      repos,
      summary,
      native,
      ensureCurrent,
      refreshAllRepoStatuses,
      setSyncProgress,
    ],
  );

  // Sync = fetch, then fast-forward pull where the fetch revealed new commits.
  // The "ff-only" strategy makes this identical to the original sync behavior.
  const syncAll = useCallback(async (): Promise<void> => {
    const { failed } = await runPullWalk("ff-only");
    if (failed)
      throw new Error(`Sync failed or diverged in ${failed} repositories`);
  }, [runPullWalk]);

  // Read-only survey: what would a push actually send, per repo. Runs before
  // the confirmation dialog so the user approves a concrete list, not a verb.
  const buildPushPlan = useCallback(async (): Promise<PushPlan> => {
    const entries: PushPlanEntry[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const repo of repos) {
      ensureCurrent();
      const name = repoDisplayName(repo.repoRoot);
      try {
        const status = await native.gitStatus(repo.repoRoot);
        if (!status.upstream) {
          skipped.push({ name, reason: "No upstream" });
          continue;
        }
        if (status.ahead === 0) {
          skipped.push({ name, reason: "Nothing to push" });
          continue;
        }
        if (status.behind > 0) {
          skipped.push({ name, reason: "Diverged — pull first" });
          continue;
        }
        const commits = await native.gitLogFiltered(repo.repoRoot, {
          branch: "@{upstream}..HEAD",
          maxCount: Math.min(status.ahead, 200),
        });
        // Patches for the newest commits so the confirmation dialog shows the
        // actual content of the push, not just subject lines. Failures degrade
        // to "no patch" rather than blocking the whole plan.
        const diffTargets = commits.slice(0, PUSH_PREVIEW_MAX_COMMITS);
        const diffResults = await Promise.all(
          diffTargets.map(async (c) => {
            try {
              const { diffText, truncated } = await native.gitShowCommit(
                repo.repoRoot,
                c.sha,
              );
              const overLimit = diffText.length > PUSH_PREVIEW_CHAR_LIMIT;
              return {
                sha: c.sha,
                shortSha: c.shortSha,
                subject: c.subject,
                diffText: overLimit
                  ? diffText.slice(0, PUSH_PREVIEW_CHAR_LIMIT)
                  : diffText,
                truncated: truncated || overLimit,
              };
            } catch {
              return {
                sha: c.sha,
                shortSha: c.shortSha,
                subject: c.subject,
                diffText: "",
                truncated: false,
              };
            }
          }),
        );
        entries.push({
          repoRoot: repo.repoRoot,
          name,
          branch: status.branch,
          upstream: status.upstream,
          ahead: status.ahead,
          behind: status.behind,
          remote: parseUpstreamRemote(status.upstream) ?? undefined,
          commits,
          diffs: diffResults,
          moreCommits: Math.max(0, status.ahead - diffResults.length),
        });
      } catch (error) {
        skipped.push({
          name,
          reason: typeof error === "string" ? error : String(error),
        });
      }
    }
    ensureCurrent();
    return { entries, skipped };
  }, [repos, native, ensureCurrent]);

  const validatePushEntry = useCallback(
    async (entry: PushPlanEntry) => {
      if (!repos.some((repo) => repo.repoRoot === entry.repoRoot))
        throw new Error("Push plan no longer belongs to this workspace");
      const status = await native.gitStatus(entry.repoRoot);
      if (
        status.branch !== entry.branch ||
        status.upstream !== entry.upstream ||
        status.ahead !== entry.ahead ||
        status.behind !== (entry.behind ?? 0)
      )
        throw new Error("Branch or upstream changed; review a new push plan");
      if (entry.commits.length) {
        const [head] = await native.gitLog(entry.repoRoot, { limit: 1 });
        if (head?.sha !== entry.commits[0].sha)
          throw new Error("Commits changed; review a new push plan");
      }
    },
    [repos, native],
  );

  const pushAll = useCallback(
    async (plan: PushPlan): Promise<void> => {
      if (plan.entries.length === 0) return;
      if (autoClearRef.current) {
        clearTimeout(autoClearRef.current);
        autoClearRef.current = null;
      }
      const setPhase = (repoRoot: string, phase: RepoSyncPhase) =>
        setSyncProgress((current) =>
          current
            ? {
                ...current,
                items: current.items.map((item) =>
                  item.repoRoot === repoRoot ? { ...item, phase } : item,
                ),
              }
            : current,
        );

      setSyncProgress({
        running: true,
        items: plan.entries.map((e) => ({
          repoRoot: e.repoRoot,
          name: e.name,
          phase: { kind: "pending" },
        })),
      });

      // Same reasoning as sync: one repo at a time keeps credential prompts
      // serialised and the progress list truthful.
      for (const entry of plan.entries) {
        ensureCurrent();
        setPhase(entry.repoRoot, { kind: "pulling", commits: entry.ahead });
        try {
          await validatePushEntry(entry);
          await native.gitPush(entry.repoRoot);
          setPhase(entry.repoRoot, { kind: "pulled", commits: entry.ahead });
        } catch (error) {
          setPhase(entry.repoRoot, {
            kind: "failed",
            error: typeof error === "string" ? error : String(error),
          });
        }
      }
      setSyncProgress((current) =>
        current ? { ...current, running: false } : current,
      );
      await summary.refresh({ remote: "never" });
      ensureCurrent();
      await refreshAllRepoStatuses();
    },
    [
      summary,
      native,
      ensureCurrent,
      refreshAllRepoStatuses,
      setSyncProgress,
      validatePushEntry,
    ],
  );

  const pushAllAdvanced = useCallback(
    async (
      plan: PushPlan,
      options: PushAdvancedOptions,
    ): Promise<PushAllResult> => {
      const rejected: PushAllResult["rejected"] = [];
      const failed: PushAllResult["failed"] = [];
      if (plan.entries.length === 0) return { rejected, failed };
      if (autoClearRef.current) {
        clearTimeout(autoClearRef.current);
        autoClearRef.current = null;
      }
      const setPhase = (repoRoot: string, phase: RepoSyncPhase) =>
        setSyncProgress((current) =>
          current
            ? {
                ...current,
                items: current.items.map((item) =>
                  item.repoRoot === repoRoot ? { ...item, phase } : item,
                ),
              }
            : current,
        );

      setSyncProgress({
        running: true,
        items: plan.entries.map((e) => ({
          repoRoot: e.repoRoot,
          name: e.name,
          phase: { kind: "pending" },
        })),
      });

      for (const entry of plan.entries) {
        ensureCurrent();
        const targetRemote = entry.remote;
        const upstreamRemote = parseUpstreamRemote(entry.upstream);
        if (targetRemote && upstreamRemote && targetRemote !== upstreamRemote) {
          const error = `Push to "${targetRemote}" is not supported: this build pushes to the tracking remote "${upstreamRemote}"`;
          failed.push({ repoRoot: entry.repoRoot, error });
          setPhase(entry.repoRoot, {
            kind: "failed",
            error,
          });
          continue;
        }
        setPhase(entry.repoRoot, { kind: "pulling", commits: entry.ahead });
        try {
          await validatePushEntry(entry);
          await native.gitPushAdvanced(entry.repoRoot, {
            force: options.force,
            noVerify: options.noVerify,
            tags: pushTagsValue(options.tags),
          });
          setPhase(entry.repoRoot, { kind: "pulled", commits: entry.ahead });
        } catch (error) {
          const message = typeof error === "string" ? error : String(error);
          failed.push({ repoRoot: entry.repoRoot, error: message });
          setPhase(entry.repoRoot, { kind: "failed", error: message });
          if (isRejectedPushError(message)) {
            rejected.push({ repoRoot: entry.repoRoot, error: message });
          }
        }
      }
      setSyncProgress((current) =>
        current ? { ...current, running: false } : current,
      );
      await summary.refresh({ remote: "never" });
      ensureCurrent();
      await refreshAllRepoStatuses();
      return { rejected, failed };
    },
    [
      summary,
      native,
      ensureCurrent,
      refreshAllRepoStatuses,
      setSyncProgress,
      validatePushEntry,
    ],
  );

  const pushUpToCommit = useCallback(
    async (repoRoot: string, sha: string): Promise<void> => {
      await native.gitPushUpToCommit(repoRoot, sha);
      await summary.refresh({ remote: "never" });
      ensureCurrent();
      await refreshAllRepoStatuses();
    },
    [summary, native, ensureCurrent, refreshAllRepoStatuses],
  );

  const listRemotes = useCallback(
    async (repoRoot: string): Promise<GitRemoteEntry[]> => {
      return native.gitRemoteList(repoRoot);
    },
    [native],
  );

  const addRemote = useCallback(
    async (repoRoot: string, name: string, url: string): Promise<void> => {
      await native.gitRemoteAdd(repoRoot, name, url);
    },
    [native],
  );

  const removeRemote = useCallback(
    async (repoRoot: string, name: string): Promise<void> => {
      await native.gitRemoteRemove(repoRoot, name);
    },
    [native],
  );

  const setRemoteUrl = useCallback(
    async (repoRoot: string, name: string, url: string): Promise<void> => {
      await native.gitRemoteSetUrl(repoRoot, name, url);
    },
    [native],
  );

  const cloneRepository = useCallback(
    async (
      url: string,
      targetDir: string,
      options?: CloneOptions,
    ): Promise<void> => {
      await native.gitClone(url, targetDir, options);
    },
    [native],
  );

  // The panel drives everything through the summary, so route "sync" here when
  // there is more than one repo instead of threading a second handler down.
  // Batch walks cannot set the underlying summary's busyAction, so their own
  // flag is merged in below; without it, commit/stage could run concurrently
  // with a fetch or push walk.
  const runRemoteAction = useCallback<SourceControlSummary["runRemoteAction"]>(
    async (mode = "contextual") => {
      if (batchBusyRef.current)
        return {
          ok: false,
          action: null,
          error: "Another Git batch operation is running",
        };
      if (repos.length <= 1) return summary.runRemoteAction(mode);
      if (mode === "sync") {
        try {
          await runBatch("fetch", syncAll);
          return { ok: true, action: "fetch" };
        } catch (error) {
          return { ok: false, action: "fetch", error: String(error) };
        }
      }
      if (mode === "push") {
        // Commit & Push lands here: the active repo's summary would only push
        // itself, silently leaving the other committed repos unpushed.
        try {
          return await runBatch("push", async () => {
            const failures: string[] = [];
            for (const repo of repos) {
              ensureCurrent();
              try {
                const status = await native.gitStatus(repo.repoRoot);
                if (!status.upstream || status.ahead === 0) continue;
                if (status.behind > 0) {
                  failures.push(
                    `${repoDisplayName(repo.repoRoot)}: diverged from upstream`,
                  );
                  continue;
                }
                await native.gitPushAdvanced(repo.repoRoot, {});
              } catch (error) {
                failures.push(
                  `${repoDisplayName(repo.repoRoot)}: ${
                    typeof error === "string" ? error : String(error)
                  }`,
                );
              }
            }
            await summary.refresh({ remote: "never" });
            ensureCurrent();
            await refreshAllRepoStatuses();
            return failures.length === 0
              ? { ok: true, action: "push" }
              : { ok: false, action: "push", error: failures.join("; ") };
          });
        } catch (error) {
          return { ok: false, action: "push", error: String(error) };
        }
      }
      return summary.runRemoteAction(mode);
    },
    [
      repos,
      summary,
      syncAll,
      runBatch,
      native,
      ensureCurrent,
      refreshAllRepoStatuses,
    ],
  );

  const wrappedSummary = useMemo<SourceControlSummary>(
    () => ({
      ...summary,
      busyAction: batchBusy ?? summary.busyAction,
      runRemoteAction,
    }),
    [summary, runRemoteAction, batchBusy],
  );

  return {
    repos: currentRepoHeads,
    activeRepo: effectiveRepoRoot,
    setActiveRepo,
    summary: wrappedSummary,
    aggregatedChanges,
    repoStatusEntries,
    applyRepoStatus,
    refreshRepoStatus,
    refreshAllRepoStatuses,
    fetchAll: () => runBatch("fetch", fetchAll),
    syncAll: () => runBatch("fetch", syncAll),
    syncProgress: progressContextRef.current === context ? syncProgress : null,
    clearSyncProgress,
    buildPushPlan: () => runBatch("push", buildPushPlan),
    pushAll: (plan) => runBatch("push", () => pushAll(plan)),
    pushAllAdvanced: (plan, options) =>
      runBatch("push", () => pushAllAdvanced(plan, options)),
    pushUpToCommit: (repoRoot, sha) =>
      runBatch("push", () => pushUpToCommit(repoRoot, sha)),
    listRemotes,
    addRemote: (repoRoot, name, url) =>
      runBatch("push", () => addRemote(repoRoot, name, url)),
    removeRemote: (repoRoot, name) =>
      runBatch("push", () => removeRemote(repoRoot, name)),
    setRemoteUrl: (repoRoot, name, url) =>
      runBatch("push", () => setRemoteUrl(repoRoot, name, url)),
    cloneRepository: (url, targetDir, options) =>
      runBatch("fetch", () => cloneRepository(url, targetDir, options)),
    scanRepos: scan,
    isLoading: scanLoading || summary.isLoading || batchBusy !== null,
  };
}
