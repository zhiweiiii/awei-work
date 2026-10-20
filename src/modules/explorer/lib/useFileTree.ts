import { pathIdentity } from "@/lib/pathIdentity";
import { useAppEvent } from "@/modules/events";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  currentWorkspaceEnv,
  currentWorkspaceScopeKey,
  LOCAL_WORKSPACE,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { parentDir, watchAdd } from "./watch";

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
  gitignored: boolean;
};

type ChildrenState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; entries: DirEntry[] }
  | { status: "error"; message: string };

type TreeState = Record<string, ChildrenState>;

export type PendingCreate = {
  parentPath: string;
  kind: "file" | "dir";
};

export function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/")) return `${parent}${name}`;
  return `${parent}/${name}`;
}

export function dirname(path: string): string {
  return parentDir(path);
}

function validEntryName(name: string): boolean {
  return name !== "." && name !== ".." && !/[\\/\x00-\x1f]/.test(name);
}

const EXPANSION_CACHE_LIMIT = 8;
const CHAIN_LIMIT = 32;
const expansionCache = new Map<string, string[]>();

function rememberExpansion(root: string, expanded: Set<string>): void {
  expansionCache.delete(root);
  if (expanded.size > 0) expansionCache.set(root, [...expanded]);
  while (expansionCache.size > EXPANSION_CACHE_LIMIT) {
    const oldest = expansionCache.keys().next().value;
    if (oldest === undefined) break;
    expansionCache.delete(oldest);
  }
}

function recallExpansion(root: string): string[] {
  const v = expansionCache.get(root);
  if (!v) return [];
  expansionCache.delete(root);
  expansionCache.set(root, v);
  return v;
}

function isUnder(key: string, root: string): boolean {
  return key === root || key.startsWith(root.endsWith("/") ? root : `${root}/`);
}

// mtime/size are ignored on purpose: the tree never renders them, so a watcher
// refetch that only bumps mtime (saving a file) must not count as a change.
function sameDirListing(a: DirEntry[], b: DirEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].name !== b[i].name ||
      a[i].kind !== b[i].kind ||
      a[i].gitignored !== b[i].gitignored
    )
      return false;
  }
  return true;
}

type Options = {
  onPathRenamed?: (from: string, to: string, workspace: WorkspaceEnv) => void;
  onPathDeleted?: (path: string, workspace: WorkspaceEnv) => void;
};

export function useFileTree(rootPath: string | null, options?: Options) {
  const env = LOCAL_WORKSPACE;
  const scopeKey = workspaceScopeKey(env);
  const scopeRef = useRef({ root: rootPath, key: scopeKey, epoch: 0 });
  if (scopeRef.current.root !== rootPath || scopeRef.current.key !== scopeKey)
    scopeRef.current = {
      root: rootPath,
      key: scopeKey,
      epoch: scopeRef.current.epoch + 1,
    };
  const mountedRef = useRef(true);
  const renderScope = scopeRef.current;
  const mutationScopeCurrent = useCallback(
    () =>
      mountedRef.current &&
      scopeRef.current === renderScope &&
      currentWorkspaceScopeKey() === scopeKey,
    [renderScope, scopeKey],
  );
  const requestsRef = useRef(new Map<string, number>());
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scopeRef.current.epoch++;
    };
  }, []);
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const showHiddenRef = useRef(showHidden);
  const gitDecorations = usePreferencesStore((s) => s.explorerGitDecorations);
  const gitDecorationsRef = useRef(gitDecorations);
  const [nodes, setNodes] = useState<TreeState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(
    null,
  );
  const [renaming, setRenaming] = useState<string | null>(null);

  const expandedRef = useRef(expanded);
  const nodesRef = useRef(nodes);
  const watchedRef = useRef<Map<string, () => void>>(new Map());

  showHiddenRef.current = showHidden;

  gitDecorationsRef.current = gitDecorations;

  const updateExpanded = useCallback(
    (update: Set<string> | ((previous: Set<string>) => Set<string>)) => {
      const next =
        typeof update === "function" ? update(expandedRef.current) : update;
      expandedRef.current = next;
      setExpanded(next);
    },
    [],
  );
  const updateNodes = useCallback(
    (update: TreeState | ((previous: TreeState) => TreeState)) => {
      const next =
        typeof update === "function" ? update(nodesRef.current) : update;
      nodesRef.current = next;
      setNodes(next);
    },
    [],
  );

  const addWatch = useCallback((path: string) => {
    if (watchedRef.current.has(path)) return;
    watchedRef.current.set(path, watchAdd([path]));
  }, []);

  const removeWatch = useCallback((path: string) => {
    watchedRef.current.get(path)?.();
    watchedRef.current.delete(path);
  }, []);

  const fetchChildren = useCallback(
    async (path: string) => {
      const scope = scopeRef.current;
      if (
        !mountedRef.current ||
        !scope.root ||
        currentWorkspaceScopeKey() !== scope.key ||
        !isUnder(path, scope.root)
      )
        return false;
      const epoch = scope.epoch;
      const request = (requestsRef.current.get(path) ?? 0) + 1;
      requestsRef.current.set(path, request);
      const current = () =>
        mountedRef.current &&
        currentWorkspaceScopeKey() === scope.key &&
        scopeRef.current.epoch === epoch &&
        requestsRef.current.get(path) === request;
      if (nodesRef.current[path]?.status !== "loaded") {
        updateNodes((s) => ({ ...s, [path]: { status: "loading" } }));
      }
      try {
        const entries = await invoke<DirEntry[]>("fs_read_dir", {
          path,
          showHidden: showHiddenRef.current,
          gitDecorations: gitDecorationsRef.current,
          workspace: currentWorkspaceEnv(),
        });

        if (!current()) return false;
        const prev = nodesRef.current[path];
        if (
          prev?.status === "loaded" &&
          sameDirListing(prev.entries, entries)
        ) {
          return true;
        }

        const liveDirs = new Set(
          entries
            .filter((e) => e.kind === "dir")
            .map((e) => joinPath(path, e.name)),
        );
        const removedRoots: string[] = [];
        for (const key of Object.keys(nodesRef.current)) {
          if (dirname(key) === path && !liveDirs.has(key))
            removedRoots.push(key);
        }
        const dead = new Set<string>();
        if (removedRoots.length > 0) {
          const candidates = new Set<string>([
            ...Object.keys(nodesRef.current),
            ...expandedRef.current,
            ...watchedRef.current.keys(),
          ]);
          for (const k of candidates) {
            if (removedRoots.some((r) => isUnder(k, r))) dead.add(k);
          }
        }

        updateNodes((s) => {
          const next: TreeState = {};
          for (const [k, v] of Object.entries(s)) if (!dead.has(k)) next[k] = v;
          next[path] = { status: "loaded", entries };
          return next;
        });

        if (dead.size > 0) {
          updateExpanded((c) => {
            let changed = false;
            const n = new Set(c);
            for (const d of dead) if (n.delete(d)) changed = true;
            return changed ? n : c;
          });
          for (const d of dead) removeWatch(d);
        }
        return true;
      } catch (e) {
        if (!current()) return false;
        updateNodes((s) => ({
          ...s,
          [path]: { status: "error", message: String(e) },
        }));
        return false;
      }
    },
    [removeWatch, updateNodes, updateExpanded],
  );

  // Root change → restore the cached expansion for this root, re-scope watches,
  // and persist the outgoing root's expansion on the way out.
  useEffect(() => {
    if (!rootPath) {
      updateNodes({});
      updateExpanded(new Set());
      setPendingCreate(null);
      setRenaming(null);
      return;
    }
    setPendingCreate(null);
    setRenaming(null);

    const cacheKey = `${scopeKey}:${rootPath}`;
    requestsRef.current.clear();
    const restored = recallExpansion(cacheKey);
    updateExpanded(new Set(restored));
    updateNodes({});

    const toWatch = [rootPath, ...restored];
    void fetchChildren(rootPath);
    for (const d of restored) void fetchChildren(d);
    for (const p of toWatch) addWatch(p);

    return () => {
      scopeRef.current.epoch++;
      rememberExpansion(cacheKey, expandedRef.current);
      if (watchedRef.current.size > 0) {
        for (const release of watchedRef.current.values()) release();
        watchedRef.current.clear();
      }
    };
  }, [
    rootPath,
    scopeKey,
    fetchChildren,
    addWatch,
    updateNodes,
    updateExpanded,
  ]);

  useAppEvent("fs:changed", (payload) => {
    if (payload.workspace && workspaceScopeKey(payload.workspace) !== scopeKey)
      return;
    const current = nodesRef.current;
    if (payload.rescan) {
      for (const path of Object.keys(current)) void fetchChildren(path);
      return;
    }
    const dirs = new Set<string>();
    const loaded = new Map(
      Object.keys(current)
        .filter((path) => current[path]?.status === "loaded")
        .map((path) => [pathIdentity(path), path]),
    );
    for (const p of payload.paths) {
      const parent = dirname(p);
      const parentPath = loaded.get(pathIdentity(parent));
      const directPath = loaded.get(pathIdentity(p));
      if (parentPath) dirs.add(parentPath);
      if (directPath) dirs.add(directPath);
    }
    for (const d of dirs) void fetchChildren(d);
  });

  const listingPrefsRef = useRef({ showHidden, gitDecorations });
  useEffect(() => {
    const previous = listingPrefsRef.current;
    if (
      previous.showHidden === showHidden &&
      previous.gitDecorations === gitDecorations
    )
      return;
    listingPrefsRef.current = { showHidden, gitDecorations };
    for (const path of Object.keys(nodesRef.current)) void fetchChildren(path);
  }, [showHidden, gitDecorations, fetchChildren]);

  /* Open a directory, and keep going while each level holds nothing but the
     next directory. Without this a Java package took one click per segment,
     and the explorer could never fold a run it had not read. Bounded, because
     a pathological tree should not turn one click into unbounded IO. */
  const expandChain = useCallback(
    async (path: string) => {
      const epoch = scopeRef.current.epoch;
      let current = path;
      for (let i = 0; i < CHAIN_LIMIT; i++) {
        if (
          !(await fetchChildren(current)) ||
          scopeRef.current.epoch !== epoch ||
          !expandedRef.current.has(path)
        )
          return;
        const node = nodesRef.current[current];
        if (node?.status !== "loaded") return;
        if (node.entries.length !== 1) return;
        const only = node.entries[0];
        if (only.kind !== "dir") return;
        current = joinPath(current, only.name);
        updateExpanded((curr) => {
          if (curr.has(current)) return curr;
          const next = new Set(curr);
          next.add(current);
          return next;
        });
        addWatch(current);
      }
    },
    [fetchChildren, addWatch, updateExpanded],
  );

  const toggle = useCallback(
    (path: string) => {
      if (expandedRef.current.has(path)) {
        updateExpanded((curr) => {
          const next = new Set(curr);
          next.delete(path);
          return next;
        });
        removeWatch(path);
      } else {
        updateExpanded((curr) => {
          const next = new Set(curr);
          next.add(path);
          return next;
        });
        addWatch(path);
        void expandChain(path);
      }
    },
    [expandChain, addWatch, removeWatch, updateExpanded],
  );

  const expand = useCallback(
    (path: string) => {
      if (expandedRef.current.has(path)) return;
      updateExpanded((curr) => {
        const next = new Set(curr);
        next.add(path);
        return next;
      });
      addWatch(path);
      void fetchChildren(path);
    },
    [fetchChildren, addWatch, updateExpanded],
  );

  const refresh = useCallback(
    (path: string) => {
      void fetchChildren(path);
    },
    [fetchChildren],
  );

  // --- mutations ---

  const beginCreate = useCallback(
    (parentPath: string, kind: "file" | "dir") => {
      setRenaming(null);
      setPendingCreate({ parentPath, kind });
      // Ensure the parent is expanded so the input row is visible.
      if (rootPath && parentPath !== rootPath) {
        updateExpanded((curr) => {
          if (curr.has(parentPath)) return curr;
          const next = new Set(curr);
          next.add(parentPath);
          return next;
        });
        addWatch(parentPath);
      }
      if (!nodesRef.current[parentPath]) void fetchChildren(parentPath);
    },
    [rootPath, fetchChildren, addWatch, updateExpanded],
  );

  const cancelCreate = useCallback(() => setPendingCreate(null), []);

  const commitCreate = useCallback(
    async (name: string) => {
      if (!pendingCreate || !mutationScopeCurrent()) return false;
      const trimmed = name.trim();
      if (!trimmed) {
        setPendingCreate(null);
        return true;
      }
      if (!validEntryName(trimmed)) {
        toast.error("Enter a filename, not a path");
        return false;
      }
      const epoch = scopeRef.current.epoch;
      const path = joinPath(pendingCreate.parentPath, trimmed);
      const cmd =
        pendingCreate.kind === "dir" ? "fs_create_dir" : "fs_create_file";
      try {
        await invoke(cmd, { path, workspace: env });
        if (mountedRef.current && scopeRef.current.epoch === epoch)
          await fetchChildren(pendingCreate.parentPath);
      } catch (e) {
        toast.error(`Create failed: ${String(e)}`);
        return false;
      }
      if (mountedRef.current && scopeRef.current.epoch === epoch)
        setPendingCreate((current) =>
          current === pendingCreate ? null : current,
        );
      return true;
    },
    [pendingCreate, fetchChildren, mutationScopeCurrent],
  );

  const beginRename = useCallback((path: string) => {
    setPendingCreate(null);
    setRenaming(path);
  }, []);

  const cancelRename = useCallback(() => setRenaming(null), []);

  const commitRename = useCallback(
    async (newName: string) => {
      if (!renaming || !mutationScopeCurrent()) return false;
      const trimmed = newName.trim();
      const parent = dirname(renaming);
      const oldName = renaming.split(/[\\/]/).pop();
      if (!trimmed || trimmed === oldName) {
        setRenaming(null);
        return true;
      }
      if (!validEntryName(trimmed)) {
        toast.error("Enter a filename, not a path");
        return false;
      }
      const epoch = scopeRef.current.epoch;
      const to = joinPath(parent, trimmed);
      try {
        await invoke("fs_rename", {
          from: renaming,
          to,
          workspace: env,
        });
        options?.onPathRenamed?.(renaming, to, env);
        if (!mountedRef.current || scopeRef.current.epoch !== epoch)
          return true;
        await fetchChildren(parent);
      } catch (e) {
        toast.error(`Rename failed: ${String(e)}`);
        return false;
      }
      if (mountedRef.current && scopeRef.current.epoch === epoch)
        setRenaming((current) => (current === renaming ? null : current));
      return true;
    },
    [renaming, fetchChildren, options, mutationScopeCurrent],
  );

  const deletePath = useCallback(
    async (path: string) => {
      if (!mutationScopeCurrent()) return;
      const epoch = scopeRef.current.epoch;
      try {
        await invoke("fs_delete", { path, workspace: env });
        options?.onPathDeleted?.(path, env);
        if (!mountedRef.current || scopeRef.current.epoch !== epoch) return;
        await fetchChildren(dirname(path));
      } catch (e) {
        toast.error(`Delete failed: ${String(e)}`);
      }
    },
    [fetchChildren, options, mutationScopeCurrent],
  );

  const movePath = useCallback(
    async (from: string, toDir: string) => {
      if (!mutationScopeCurrent()) return;
      const epoch = scopeRef.current.epoch;
      const name = from.split(/[\\/]/).pop() ?? "";
      const to = joinPath(toDir, name);
      if (to === from) return;
      const target = nodesRef.current[toDir];
      if (
        target?.status === "loaded" &&
        target.entries.some((e) => e.name === name)
      ) {
        console.warn(`move skipped: "${name}" already exists in ${toDir}`);
        return;
      }
      try {
        await invoke("fs_rename", {
          from,
          to,
          workspace: env,
        });
        options?.onPathRenamed?.(from, to, env);
        if (!mountedRef.current || scopeRef.current.epoch !== epoch) return;
        await Promise.all([fetchChildren(dirname(from)), fetchChildren(toDir)]);
      } catch (e) {
        toast.error(`Move failed: ${String(e)}`);
      }
    },
    [fetchChildren, options, mutationScopeCurrent],
  );

  return {
    nodes,
    expanded,
    pendingCreate,
    renaming,
    toggle,
    expand,
    refresh,
    beginCreate,
    cancelCreate,
    commitCreate,
    beginRename,
    cancelRename,
    commitRename,
    deletePath,
    movePath,
    joinPath,
  };
}
