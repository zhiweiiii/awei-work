import { type GitRepoHead, native } from "@/lib/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { LOCAL_WORKSPACE, workspaceScopeKey } from "@/modules/workspace";

// Per-project repo selections kept in memory; older projects fall off.
const SELECTION_MEMORY_LIMIT = 16;

type UseRepoListResult = {
  repos: GitRepoHead[];
  activeRepo: string | null;
  setActiveRepo: (root: string) => void;

  scan: () => Promise<void>;
  isLoading: boolean;
};

/**
 * Discovers git repos under a base directory and tracks the user's
 * currently selected repo within the list.
 *
 * Scans only when `basePath` changes (debounced) or `scan()` is called.
 * If exactly one repo is found it is auto-selected.
 */
export function useRepoList(basePath: string | null): UseRepoListResult {
  const env = LOCAL_WORKSPACE;
  const key = `${workspaceScopeKey(env)}:${basePath ?? ""}`;
  const contextRef = useRef(key);
  contextRef.current = key;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scanTokenRef.current++;
    };
  }, []);
  const [repos, setRepos] = useState<GitRepoHead[]>([]);
  const [activeRepo, setActiveRepoState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const resultKeyRef = useRef<string | null>(null);
  const lastPathRef = useRef<string | null>(null);
  const activeRepoRef = useRef<string | null>(activeRepo);
  activeRepoRef.current = activeRepo;
  // Scans race whenever workspaces are switched quickly: without a token the
  // slower scan of the workspace you left can land last and repopulate the
  // panel with its repos.
  const scanTokenRef = useRef(0);
  // A deliberate repo pick is per project, so it is remembered against the
  // path it was made in rather than carried across the switch. Bounded: a long
  // session must not accumulate an entry per directory ever visited.
  const selectionByPathRef = useRef(new Map<string, string>());

  const rememberSelection = (path: string, root: string) => {
    const map = selectionByPathRef.current;
    map.delete(path);
    map.set(path, root);
    while (map.size > SELECTION_MEMORY_LIMIT) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };

  const doScan = useCallback(async (path: string, scanKey: string) => {
    if (!mountedRef.current || scanKey !== contextRef.current) return;
    const token = ++scanTokenRef.current;
    setIsLoading(true);
    try {
      const heads = await native.gitScanRepos(path, 1);
      if (
        !mountedRef.current ||
        scanKey !== contextRef.current ||
        token !== scanTokenRef.current
      )
        return;
      resultKeyRef.current = scanKey;
      setRepos(heads);
      if (heads.length === 1) {
        setActiveRepoState(heads[0].repoRoot);
      } else if (heads.length === 0) {
        // Leaving the selection set would keep the old project's repo on
        // screen with no entry in the list backing it.
        setActiveRepoState(null);
      } else {
        const remembered = selectionByPathRef.current.get(scanKey);
        const keep =
          remembered && heads.some((h) => h.repoRoot === remembered)
            ? remembered
            : activeRepoRef.current &&
                heads.some((h) => h.repoRoot === activeRepoRef.current)
              ? activeRepoRef.current
              : heads[0].repoRoot;
        setActiveRepoState(keep);
      }
    } catch (err) {
      if (
        !mountedRef.current ||
        scanKey !== contextRef.current ||
        token !== scanTokenRef.current
      )
        return;
      console.warn("[awei-work] repo scan failed:", err);
      resultKeyRef.current = scanKey;
      setRepos([]);
      setActiveRepoState(null);
    } finally {
      if (
        mountedRef.current &&
        scanKey === contextRef.current &&
        token === scanTokenRef.current
      )
        setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Clear on null/empty path.
    if (!basePath) {
      scanTokenRef.current++;
      setRepos([]);
      setActiveRepoState(null);
      lastPathRef.current = null;
      setIsLoading(false);
      return;
    }

    // Same path — skip re-scan.
    if (key === lastPathRef.current) return;
    lastPathRef.current = key;

    resultKeyRef.current = null;
    setRepos([]);
    setActiveRepoState(null);

    // Fire scan immediately — 500ms debounce is too slow for initial detection.
    void doScan(basePath, key);
    return () => {
      scanTokenRef.current++;
      lastPathRef.current = null;
    };
  }, [basePath, key, doScan]);

  const scan = async () => {
    if (!basePath) return;
    await doScan(basePath, key);
  };

  const setActiveRepo = (root: string) => {
    if (contextRef.current === key && repos.some((h) => h.repoRoot === root)) {
      setActiveRepoState(root);
      if (basePath) rememberSelection(key, root);
    }
  };

  const current = resultKeyRef.current === key;
  return {
    repos: current ? repos : [],
    activeRepo: current ? activeRepo : null,
    setActiveRepo,
    scan,
    isLoading,
  };
}
