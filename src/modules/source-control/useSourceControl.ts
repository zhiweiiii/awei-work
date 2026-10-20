import { type GitRepoInfo, type GitStatusSnapshot, native } from "@/lib/native";
import { invalidateRepoDiffs } from "@/modules/editor/lib/diffCache";
import {
  currentWorkspaceScopeKey,
  LOCAL_WORKSPACE,
  workspaceScopeKey,
} from "@/modules/workspace";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const AUTO_FETCH_THROTTLE_MS = 5 * 60_000;
const AUTO_FETCH_LRU_LIMIT = 16;
const FOCUS_REFRESH_MIN_INTERVAL_MS = 1500;
// Skip the context-change refetch when the data is this fresh and the new path
// is still inside the loaded repo (cd-within-repo produces identical status).
const SC_STATUS_TTL_MS = 2000;

export type SourceControlRefreshMode = "auto" | "always" | "never";
export type SourceControlRemoteAction = "fetch" | "pull" | "push";
/**
 * "sync" is fetch followed by a fast-forward pull when the fetch revealed new
 * upstream commits. Plain "pull" can only run once something already told git
 * it was behind, which made pulling a two-click affair.
 */
export type SourceControlRemoteActionMode =
  | "contextual"
  | "sync"
  | SourceControlRemoteAction;

export type SourceControlRemoteActionResult = {
  ok: boolean;
  action: SourceControlRemoteAction | null;
  error?: string;
  blocked?: "diverged" | "missing-upstream" | "no-repo";
};

export type SourceControlSummary = {
  contextPath: string | null;
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  changedCount: number;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRepo: boolean;
  isLoading: boolean;
  localError: string | null;
  busyAction: SourceControlRemoteAction | null;
  lastRemoteError: string | null;
  applyStatus: (
    updater: (status: GitStatusSnapshot) => GitStatusSnapshot,
  ) => void;
  refresh: (options?: {
    remote?: SourceControlRefreshMode;
    force?: boolean;
  }) => Promise<void>;
  runRemoteAction: (
    mode?: SourceControlRemoteActionMode,
  ) => Promise<SourceControlRemoteActionResult>;
};

type SourceControlSummaryState = {
  contextPath: string | null;
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  hasRepo: boolean;
  isLoading: boolean;
  localError: string | null;
  busyAction: SourceControlRemoteAction | null;
  lastRemoteError: string | null;
};

type RefreshableSourceControlState = Pick<
  SourceControlSummaryState,
  | "contextPath"
  | "repo"
  | "status"
  | "hasRepo"
  | "isLoading"
  | "localError"
  | "lastRemoteError"
>;

type InflightRefresh = {
  contextKey: string;
  mode: SourceControlRefreshMode;
  promise: Promise<void>;
};

// The explicit repo root belongs in the key: on a project switch the context
// path moves a beat before the repo scan resolves the new root, so a refresh
// still aimed at the previous repo would otherwise dedupe the one aimed at
// the new one and leave the panel on the old branch.
function sourceControlContextKey(
  workspaceKey: string,
  contextPath: string | null,
  repoRoot: string | null,
): string {
  return `${workspaceKey}\0${contextPath ?? ""}\0${repoRoot ?? ""}`;
}

function normalizedContextPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
}

export function repositoryContainsContext(
  repoRoot: string | null,
  contextPath: string | null,
): boolean {
  if (!repoRoot || !contextPath) return false;
  let root = normalizedContextPath(repoRoot);
  let context = normalizedContextPath(contextPath);
  const windowsPaths =
    (/^[A-Za-z]:\//.test(root) && /^[A-Za-z]:\//.test(context)) ||
    (root.startsWith("//") && context.startsWith("//"));
  if (windowsPaths) {
    root = root.toLowerCase();
    context = context.toLowerCase();
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return context === root || context.startsWith(prefix);
}

export function beginSourceControlRefresh<
  T extends RefreshableSourceControlState,
>(current: T, contextPath: string, reuseCurrentRepository: boolean): T {
  return {
    ...current,
    contextPath,
    repo: reuseCurrentRepository ? current.repo : null,
    status: reuseCurrentRepository ? current.status : null,
    hasRepo: reuseCurrentRepository ? current.hasRepo : false,
    isLoading: true,
    localError: null,
    lastRemoteError: reuseCurrentRepository ? current.lastRemoteError : null,
  };
}

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown source control error";
}

/** True when a fast-forward pull would actually move the branch. */
export function canFastForward(
  status: Pick<GitStatusSnapshot, "upstream" | "ahead" | "behind"> | null,
): boolean {
  if (!status?.upstream) return false;
  return status.behind > 0 && status.ahead === 0;
}

function getContextualAction(
  status: GitStatusSnapshot | null,
): SourceControlRemoteAction | null {
  if (!status?.upstream) return null;
  if (status.ahead > 0 && status.behind > 0) return null;
  if (status.behind > 0) return "pull";
  if (status.ahead > 0) return "push";
  return "fetch";
}

function touchAutoFetch(map: Map<string, number>, key: string): void {
  map.delete(key);
  map.set(key, Date.now());
  while (map.size > AUTO_FETCH_LRU_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function useSourceControl(
  contextPath: string | null,
  enabled?: boolean,
  repoRoot?: string | null,
): SourceControlSummary {
  const _enabled = enabled ?? true;
  const workspaceEnv = LOCAL_WORKSPACE;
  const workspaceKey = workspaceScopeKey(workspaceEnv);
  const [state, setState] = useState<SourceControlSummaryState>({
    contextPath: null,
    repo: null,
    status: null,
    hasRepo: false,
    isLoading: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
  });
  const mountedRef = useRef(true);
  const remoteBusyRef = useRef(false);
  const loadedWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current++;
      inflightRef.current = null;
    };
  }, []);
  const stateRef = useRef(state);
  const requestIdRef = useRef(0);
  const inflightRef = useRef<InflightRefresh | null>(null);
  const autoFetchByRepoRef = useRef(new Map<string, number>());
  const enabledRef = useRef(_enabled);
  const lastRefreshAtRef = useRef(0);
  const repoRootRef = useRef(repoRoot ?? null);
  const contextKey = sourceControlContextKey(
    workspaceKey,
    contextPath,
    repoRoot ?? null,
  );
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;

  stateRef.current = state;

  enabledRef.current = _enabled;

  repoRootRef.current = repoRoot ?? null;

  const applyStatus = useCallback(
    (updater: (status: GitStatusSnapshot) => GitStatusSnapshot) => {
      setState((current) => {
        if (
          contextKey !== contextKeyRef.current ||
          loadedWorkspaceRef.current !== workspaceKey ||
          !current.status
        )
          return current;
        const next = updater(current.status);
        if (next === current.status) return current;
        return { ...current, status: next };
      });
    },
    [contextKey, workspaceKey],
  );

  const doRefresh = useCallback(
    async (remoteMode: SourceControlRefreshMode): Promise<void> => {
      const refreshContextKey = contextKey;
      if (
        !mountedRef.current ||
        !enabledRef.current ||
        currentWorkspaceScopeKey() !== workspaceKey ||
        refreshContextKey !== contextKeyRef.current
      ) {
        return;
      }
      const requestId = ++requestIdRef.current;
      const isCurrentRequest = () =>
        mountedRef.current &&
        enabledRef.current &&
        currentWorkspaceScopeKey() === workspaceKey &&
        requestId === requestIdRef.current &&
        refreshContextKey === contextKeyRef.current;

      if (!contextPath) {
        if (!isCurrentRequest()) return;
        setState({
          contextPath: null,
          repo: null,
          status: null,
          hasRepo: false,
          isLoading: false,
          localError: null,
          busyAction: null,
          lastRemoteError: null,
        });
        return;
      }

      const activeRoot = stateRef.current.repo?.repoRoot ?? null;
      const explicitRoot = repoRootRef.current;
      const reusableRoot =
        explicitRoot ||
        (repositoryContainsContext(activeRoot, contextPath)
          ? activeRoot
          : null);

      // Only the repo already on screen may stay on screen while it reloads.
      // An explicit root naming a different repo means the panel moved to
      // another project, and keeping the old repo/branch/changes visible there
      // is exactly the stale render a switch must not produce.
      const reuseCurrentRepository =
        !!reusableRoot &&
        !!activeRoot &&
        normalizedContextPath(activeRoot) ===
          normalizedContextPath(reusableRoot);

      // Guarded: a request that has since been superseded must not set the
      // loading flag, or a rapid project switch could leave the panel on
      // "loading" forever (the stale request bails later without ever clearing
      // the flag it set).
      if (!isCurrentRequest()) return;
      setState((current) =>
        beginSourceControlRefresh(current, contextPath, reuseCurrentRepository),
      );

      try {
        let repo: GitRepoInfo | null;
        let status: GitStatusSnapshot | null;

        // Explicit repo root: skip panel_snapshot and go directly to status.
        if (explicitRoot) {
          try {
            status = await native.gitStatus(explicitRoot);
            if (!isCurrentRequest()) return;
            repo = {
              repoRoot: explicitRoot,
              branch: status.branch,
              upstream: status.upstream,
              isDetached: status.isDetached,
            };
          } catch {
            if (!isCurrentRequest()) return;
            setState((current) => ({
              ...current,
              repo: null,
              status: null,
              hasRepo: false,
              isLoading: false,
              localError: null,
            }));
            return;
          }
        } else if (reusableRoot) {
          try {
            status = await native.gitStatus(reusableRoot);
            if (!isCurrentRequest()) return;
            repo = {
              repoRoot: reusableRoot,
              branch: status.branch,
              upstream: status.upstream,
              isDetached: status.isDetached,
            };
          } catch {
            if (!isCurrentRequest()) return;
            const snapshot = await native.gitPanelSnapshot(contextPath);
            if (!isCurrentRequest()) return;
            if (!snapshot.repo) {
              setState((current) => ({
                ...current,
                repo: null,
                status: null,
                hasRepo: false,
                isLoading: false,
                localError: null,
              }));
              return;
            }
            repo = snapshot.repo;
            status = snapshot.status ?? null;
          }
        } else {
          const snapshot = await native.gitPanelSnapshot(contextPath);
          if (!isCurrentRequest()) return;
          if (!snapshot.repo) {
            setState((current) => ({
              ...current,
              repo: null,
              status: null,
              hasRepo: false,
              isLoading: false,
              localError: null,
            }));
            return;
          }
          repo = snapshot.repo;
          status = snapshot.status ?? null;
        }

        if (!repo) {
          setState((current) => ({
            ...current,
            repo: null,
            status: null,
            hasRepo: false,
            isLoading: false,
            localError: null,
          }));
          return;
        }

        let nextRemoteError =
          loadedWorkspaceRef.current === workspaceKey
            ? stateRef.current.lastRemoteError
            : null;
        const shouldAutoFetch =
          repo.upstream &&
          !remoteBusyRef.current &&
          remoteMode !== "never" &&
          (remoteMode === "always" ||
            Date.now() - (autoFetchByRepoRef.current.get(repo.repoRoot) ?? 0) >=
              AUTO_FETCH_THROTTLE_MS);

        if (shouldAutoFetch) {
          try {
            await native.gitFetch(repo.repoRoot);
            touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
            nextRemoteError = null;
            if (!isCurrentRequest()) return;
            status = await native.gitStatus(repo.repoRoot);
            if (!isCurrentRequest()) return;
          } catch (error) {
            nextRemoteError = normalizeError(error);
          }
        }

        if (!isCurrentRequest()) return;
        // The working tree was just re-read, so any cached working-tree diff is
        // now potentially stale — a file edited twice shows the first diff
        // otherwise, because the cache key has no content or revision in it.
        loadedWorkspaceRef.current = workspaceKey;
        invalidateRepoDiffs(repo.repoRoot);
        setState((current) => ({
          ...current,
          repo,
          status,
          hasRepo: true,
          isLoading: false,
          localError: null,
          lastRemoteError: nextRemoteError,
        }));
      } catch (error) {
        if (!isCurrentRequest()) return;
        setState((current) => ({
          ...current,
          repo: null,
          hasRepo: false,
          status: null,
          isLoading: false,
          localError: normalizeError(error),
        }));
      } finally {
        if (isCurrentRequest()) {
          lastRefreshAtRef.current = Date.now();
        }
      }
    },
    [contextKey, contextPath, workspaceKey],
  );

  const refresh = useCallback(
    async (options?: {
      remote?: SourceControlRefreshMode;
      force?: boolean;
    }) => {
      const remoteMode = options?.remote ?? "never";
      const inflight = inflightRef.current;
      if (!options?.force && inflight?.contextKey === contextKey) {
        const cur = inflight.mode;
        const upgrade =
          (cur === "never" && remoteMode !== "never") ||
          (cur === "auto" && remoteMode === "always");
        if (!upgrade) return inflight.promise;
      }
      const run = doRefresh(remoteMode).finally(() => {
        if (inflightRef.current?.promise === run) {
          inflightRef.current = null;
        }
      });
      inflightRef.current = { contextKey, mode: remoteMode, promise: run };
      return run;
    },
    [contextKey, doRefresh],
  );

  const runRemoteAction = useCallback(
    async (
      mode: SourceControlRemoteActionMode = "contextual",
    ): Promise<SourceControlRemoteActionResult> => {
      if (
        !mountedRef.current ||
        !enabledRef.current ||
        currentWorkspaceScopeKey() !== workspaceKey ||
        contextKey !== contextKeyRef.current ||
        remoteBusyRef.current
      )
        return {
          ok: false,
          action: null,
          error:
            "A Git action is already running or this context is no longer available",
        };
      const { repo, status } = stateRef.current;
      if (
        !repo ||
        !status ||
        loadedWorkspaceRef.current !== workspaceKey ||
        (repoRootRef.current
          ? normalizedContextPath(repo.repoRoot) !==
            normalizedContextPath(repoRootRef.current)
          : !repositoryContainsContext(repo.repoRoot, contextPath))
      ) {
        return { ok: false, action: null, blocked: "no-repo" };
      }
      if (!status.upstream) {
        return { ok: false, action: null, blocked: "missing-upstream" };
      }

      const action = mode === "contextual" ? getContextualAction(status) : mode;
      if (!action) {
        return { ok: false, action: null, blocked: "diverged" };
      }

      remoteBusyRef.current = true;
      // Sync drives the fetch button, so report it as one for the spinner.
      setState((current) => ({
        ...current,
        busyAction: action === "sync" ? "fetch" : action,
      }));
      const actionContextKey = contextKey;
      const isCurrentContext = () =>
        mountedRef.current &&
        enabledRef.current &&
        currentWorkspaceScopeKey() === workspaceKey &&
        actionContextKey === contextKeyRef.current;
      const ensureCurrent = () => {
        if (!isCurrentContext())
          throw new Error(
            "Workspace changed; remaining Git actions were cancelled",
          );
      };

      let performed: SourceControlRemoteAction =
        action === "sync" ? "fetch" : action;
      try {
        if (action === "fetch") {
          await native.gitFetch(repo.repoRoot);
          ensureCurrent();
          touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
        } else if (action === "pull") {
          await native.gitFetch(repo.repoRoot);
          ensureCurrent();
          touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
          await native.gitPullFfOnly(repo.repoRoot);
          ensureCurrent();
        } else if (action === "sync") {
          await native.gitFetch(repo.repoRoot);
          ensureCurrent();
          touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
          // Re-read after fetching: the pre-fetch snapshot cannot know whether
          // upstream moved, which is the whole reason pull was gated before.
          const fresh = await native.gitStatus(repo.repoRoot);
          ensureCurrent();
          if (canFastForward(fresh)) {
            await native.gitPullFfOnly(repo.repoRoot);
            ensureCurrent();
            performed = "pull";
          } else if (fresh.ahead > 0 && fresh.behind > 0) {
            // Leave the merge decision to the user, same as the pull button.
            if (isCurrentContext()) await refresh({ remote: "never" });
            return { ok: false, action: "pull", blocked: "diverged" };
          }
        } else {
          await native.gitPush(repo.repoRoot);
          ensureCurrent();
        }
        if (isCurrentContext()) {
          setState((current) => ({ ...current, lastRemoteError: null }));
          await refresh({ remote: "never" });
        }
        return { ok: true, action: performed };
      } catch (error) {
        const message = normalizeError(error);
        if (isCurrentContext()) {
          setState((current) => ({ ...current, lastRemoteError: message }));
          await refresh({ remote: "never" }).catch(() => {});
        }
        return { ok: false, action: performed, error: message };
      } finally {
        remoteBusyRef.current = false;
        if (mountedRef.current)
          setState((current) => ({ ...current, busyAction: null }));
      }
    },
    [refresh, contextKey, contextPath, workspaceKey],
  );

  useEffect(() => {
    if (!_enabled) {
      requestIdRef.current++;
      setState({
        contextPath: null,
        repo: null,
        status: null,
        hasRepo: false,
        isLoading: false,
        localError: null,
        busyAction: null,
        lastRemoteError: null,
      });
      return;
    }
    setState((current) => ({ ...current, lastRemoteError: null }));
    const root = stateRef.current.repo?.repoRoot;
    // Moving to a different repo is the urgent case — a terminal / project
    // switch. Deferring it to requestIdleCallback (up to 600ms) made the panel
    // lag a beat behind the active window, and a busy webview could leave it on
    // the previous repo's status. Refresh immediately; the idle scheduling
    // below is only for the same-repo freshness check.
    if (!repositoryContainsContext(root ?? null, contextPath)) {
      void refresh({ remote: "never" });
      return;
    }
    const run = () => {
      const fresh = Date.now() - lastRefreshAtRef.current < SC_STATUS_TTL_MS;
      // An explicit repoRoot (the multi-repo selector) is a hard target: when it
      // names a different repo than the one loaded, the freshness short-circuit
      // must not win, or picking a repo would swap the name while the branch and
      // change list kept showing the previous one.
      const explicitRoot = repoRootRef.current;
      const rootMatches =
        !explicitRoot ||
        (!!root &&
          normalizedContextPath(root) === normalizedContextPath(explicitRoot));
      if (fresh && rootMatches && stateRef.current.hasRepo) {
        setState((current) =>
          current.contextPath === contextPath
            ? current
            : { ...current, contextPath },
        );
        return;
      }
      void refresh({ remote: "never" });
    };
    const idle =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(run, { timeout: 600 })
        : (window.setTimeout(run, 0) as unknown as number);
    return () => {
      if (typeof window.cancelIdleCallback === "function") {
        try {
          window.cancelIdleCallback(idle as number);
        } catch {
          /* noop */
        }
      } else {
        window.clearTimeout(idle as number);
      }
    };
  }, [refresh, contextPath, _enabled]);

  useEffect(() => {
    if (!_enabled) return;
    let timer = 0;
    // lastRefreshAtRef moves on *every* refresh, including the context-change
    // one that fires when the terminal cd's. Dropping the focus refresh when it
    // lands inside that window meant a refresh that raced the agent's writes
    // could be the last one to run — which is why the change list updated only
    // sometimes. Wait the window out instead of giving up on the refresh.
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        timer = 0;
        const elapsed = Date.now() - lastRefreshAtRef.current;
        if (elapsed < FOCUS_REFRESH_MIN_INTERVAL_MS) {
          schedule(FOCUS_REFRESH_MIN_INTERVAL_MS - elapsed);
          return;
        }
        void refresh({ remote: "never" });
      }, delay);
    };
    const onFocus = () => {
      if (!alive) return;
      if (timer) window.clearTimeout(timer);
      schedule(400);
    };
    // The DOM focus event only fires when the *document* regains focus, which
    // an OS-level window switch does not reliably produce inside the webview —
    // so alt-tabbing back from an agent's terminal left the change list stale.
    // onFocusChanged is the window-level signal; both feed the same throttle,
    // so firing twice costs nothing.
    window.addEventListener("focus", onFocus);
    let alive = true;
    let unlistenWindow: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) onFocus();
      })
      .then((un) => {
        if (alive) unlistenWindow = un;
        else un();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlistenWindow?.();
      window.removeEventListener("focus", onFocus);
      if (timer) window.clearTimeout(timer);
    };
  }, [refresh, _enabled]);

  return useMemo<SourceControlSummary>(() => {
    const matches =
      _enabled &&
      loadedWorkspaceRef.current === workspaceKey &&
      state.repo !== null &&
      (repoRoot
        ? normalizedContextPath(state.repo.repoRoot) ===
          normalizedContextPath(repoRoot)
        : repositoryContainsContext(state.repo.repoRoot, contextPath));
    const visible =
      matches || state.repo === null
        ? state
        : { ...state, repo: null, status: null, hasRepo: false };
    return {
      contextPath: visible.contextPath,
      repo: visible.repo,
      status: visible.status,
      changedCount: visible.status?.changedFiles.length ?? 0,
      upstream: visible.status?.upstream ?? visible.repo?.upstream ?? null,
      ahead: visible.status?.ahead ?? 0,
      behind: visible.status?.behind ?? 0,
      hasRepo: visible.hasRepo,
      isLoading: visible.isLoading,
      localError: visible.localError,
      busyAction: visible.busyAction,
      lastRemoteError: visible.lastRemoteError,
      applyStatus,
      refresh,
      runRemoteAction,
    };
  }, [
    state,
    applyStatus,
    refresh,
    runRemoteAction,
    _enabled,
    workspaceKey,
    repoRoot,
    contextPath,
  ]);
}
