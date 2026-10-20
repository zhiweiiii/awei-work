import { type GitRepoHead, type GitStatusSnapshot, native } from "@/lib/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LOCAL_WORKSPACE, workspaceScopeKey } from "@/modules/workspace";

export type RepoStatusEntry = {
  repoRoot: string;
  name: string;
  status: GitStatusSnapshot;
};
export function repoDisplayName(repoRoot: string): string {
  const parts = repoRoot.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : repoRoot;
}
const SECONDARY_REFRESH_THROTTLE_MS = 3000;
type Snapshot = { scope: string; values: Record<string, GitStatusSnapshot> };

export function useRepoStatuses(
  repos: GitRepoHead[],
  enabled: boolean,
  activeRepoRoot: string | null,
  activeStatus: GitStatusSnapshot | null,
): {
  heads: GitRepoHead[];
  entries: RepoStatusEntry[];
  applyStatus: (
    repoRoot: string,
    updater: (status: GitStatusSnapshot) => GitStatusSnapshot,
  ) => void;
  refreshRepo: (repoRoot: string) => Promise<void>;
  refreshAll: () => Promise<void>;
} {
  const env = LOCAL_WORKSPACE;
  const scope = workspaceScopeKey(env);
  const roots = useMemo(
    () => repos.map((r) => r.repoRoot).filter((r) => r !== activeRepoRoot),
    [repos, activeRepoRoot],
  );
  const rootKey = roots.join("\u0000");
  const key = `${scope}\u0000${enabled}\u0000${rootKey}`;
  const requestsRef = useRef(new Map<string, number>());
  const contextRef = useRef({ key, roots, enabled, scope });
  if (contextRef.current.key !== key) {
    requestsRef.current.clear();
    contextRef.current = { key, roots, enabled, scope };
  }
  const [others, setOthers] = useState<Snapshot>({ scope, values: {} });
  const mountedRef = useRef(true);
  const batchRef = useRef(0);
  const lastAutoRef = useRef({ key: "", at: 0 });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      batchRef.current++;
      contextRef.current = { ...contextRef.current };
      requestsRef.current.clear();
      lastAutoRef.current = { key: "", at: 0 };
    };
  }, []);
  const nextRequest = useCallback((root: string) => {
    const request = (requestsRef.current.get(root) ?? 0) + 1;
    requestsRef.current.set(root, request);
    return request;
  }, []);
  const refreshRepo = useCallback(
    async (repoRoot: string) => {
      const context = contextRef.current;
      if (
        !mountedRef.current ||
        !context.enabled ||
        !context.roots.includes(repoRoot)
      )
        return;
      const request = nextRequest(repoRoot);
      let status: GitStatusSnapshot | undefined;
      try {
        status = await native.gitStatus(repoRoot);
      } catch {}
      if (
        !mountedRef.current ||
        contextRef.current !== context ||
        requestsRef.current.get(repoRoot) !== request
      )
        return;
      setOthers((current) => {
        const values = {
          ...(current.scope === context.scope ? current.values : {}),
        };
        if (status) values[repoRoot] = status;
        else delete values[repoRoot];
        return { scope: context.scope, values };
      });
    },
    [nextRequest],
  );
  const refreshAll = useCallback(async () => {
    const context = contextRef.current;
    if (!mountedRef.current || !context.enabled) return;
    const batch = ++batchRef.current;
    const collected = new Map<
      string,
      { request: number; status?: GitStatusSnapshot }
    >();
    for (const root of context.roots) {
      if (
        !mountedRef.current ||
        contextRef.current !== context ||
        batchRef.current !== batch
      )
        return;
      const request = nextRequest(root);
      let status: GitStatusSnapshot | undefined;
      try {
        status = await native.gitStatus(root);
      } catch {}
      collected.set(root, { request, status });
    }
    if (
      !mountedRef.current ||
      contextRef.current !== context ||
      batchRef.current !== batch
    )
      return;
    setOthers((current) => {
      const values: Record<string, GitStatusSnapshot> = {};
      for (const root of context.roots) {
        const result = collected.get(root);
        if (result && requestsRef.current.get(root) === result.request) {
          if (result.status) values[root] = result.status;
        } else if (current.scope === context.scope && current.values[root])
          values[root] = current.values[root];
      }
      return { scope: context.scope, values };
    });
  }, [nextRequest]);
  useEffect(() => {
    if (!enabled || rootKey === "") {
      batchRef.current++;
      setOthers({ scope, values: {} });
      return;
    }
    const now = Date.now();
    const previous = lastAutoRef.current;
    if (
      previous.key === key &&
      now - previous.at < SECONDARY_REFRESH_THROTTLE_MS
    )
      return;
    lastAutoRef.current = { key, at: now };
    void refreshAll();
    void activeStatus;
  }, [enabled, rootKey, scope, key, refreshAll, activeStatus]);
  const applyStatus = useCallback(
    (
      repoRoot: string,
      updater: (status: GitStatusSnapshot) => GitStatusSnapshot,
    ) => {
      const context = contextRef.current;
      if (!context.enabled || !context.roots.includes(repoRoot)) return;
      setOthers((current) => {
        if (current.scope !== context.scope || !current.values[repoRoot])
          return current;
        const existing = current.values[repoRoot];
        const next = updater(existing);
        return next === existing
          ? current
          : {
              scope: context.scope,
              values: { ...current.values, [repoRoot]: next },
            };
      });
    },
    [],
  );
  const { heads, entries } = useMemo(() => {
    const heads: GitRepoHead[] = [];
    const out: RepoStatusEntry[] = [];
    for (const repo of repos) {
      const status = !enabled
        ? null
        : repo.repoRoot === activeRepoRoot
          ? activeStatus
          : others.scope === scope
            ? others.values[repo.repoRoot]
            : null;
      const current = status?.repoRoot === repo.repoRoot ? status : null;
      heads.push(
        current &&
          (current.branch !== repo.branch ||
            current.isDetached !== repo.isDetached)
          ? { ...repo, branch: current.branch, isDetached: current.isDetached }
          : repo,
      );
      if (current?.changedFiles.length)
        out.push({
          repoRoot: repo.repoRoot,
          name: repoDisplayName(repo.repoRoot),
          status: current,
        });
    }
    return { heads, entries: out };
  }, [repos, activeRepoRoot, activeStatus, others, scope, enabled]);
  return { heads, entries, applyStatus, refreshRepo, refreshAll };
}
