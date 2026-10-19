import { useCallback, useEffect, useRef, useState } from "react";
import { leafHasForegroundProcess, leafIds } from "@/modules/terminal";
import { nextActiveInSpace, type Tab } from "@/modules/tabs";
import { useSpaces } from "@/modules/spaces";
import { workspaceScopeKey, type WorkspaceEnv } from "@/modules/workspace";

type Params = {
  tabs: Tab[];
  disposeTab: (id: number) => void;
};

/**
 * Guards tab closing: dirty editors and terminals with a live foreground
 * process route through a confirmation dialog instead of closing immediately.
 * Owns the three pending-close states the dialogs render from.
 */
export function useTabCloseGuards({ tabs, disposeTab }: Params) {
  const latestTabs = useRef(tabs);
  latestTabs.current = tabs;
  const checking = useRef(new Set<number>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
  const [pendingTerminalCloseTab, setPendingTerminalCloseTab] = useState<
    number | null
  >(null);
  const [pendingDeleteTabs, setPendingDeleteTabs] = useState<number[] | null>(
    null,
  );

  const handleClose = useCallback(
    async (id: number) => {
      if (checking.current.has(id)) return;
      const t = latestTabs.current.find((x) => x.id === id);
      if (
        !t ||
        (t.kind !== "terminal" &&
          nextActiveInSpace(latestTabs.current, id) === null)
      )
        return;
      if (t?.kind === "editor" && t.dirty) {
        setPendingCloseTab(id);
        return;
      }
      if (t?.kind === "terminal") {
        const leaves = leafIds(t.paneTree);
        checking.current.add(id);
        let checks: boolean[];
        try {
          checks = await Promise.all(
            leaves.map((leaf) =>
              leafHasForegroundProcess(leaf).catch(() => true),
            ),
          );
        } finally {
          checking.current.delete(id);
        }
        if (!mounted.current) return;
        const current = latestTabs.current.find((tab) => tab.id === id);
        if (current?.kind !== "terminal") return;
        if (checks.some(Boolean) || current.paneTree !== t.paneTree) {
          setPendingTerminalCloseTab(id);
          return;
        }
      }
      disposeTab(id);
    },
    [disposeTab],
  );

  const confirmClose = useCallback(() => {
    if (pendingCloseTab !== null) {
      disposeTab(pendingCloseTab);
      setPendingCloseTab(null);
    }
  }, [pendingCloseTab, disposeTab]);

  const cancelClose = useCallback(() => {
    setPendingCloseTab(null);
  }, []);

  const confirmTerminalClose = useCallback(() => {
    if (pendingTerminalCloseTab !== null) disposeTab(pendingTerminalCloseTab);
    setPendingTerminalCloseTab(null);
  }, [pendingTerminalCloseTab, disposeTab]);

  const cancelTerminalClose = useCallback(() => {
    setPendingTerminalCloseTab(null);
  }, []);

  const confirmDeleteClose = useCallback(() => {
    if (pendingDeleteTabs !== null) {
      for (const id of pendingDeleteTabs) disposeTab(id);
      setPendingDeleteTabs(null);
    }
  }, [pendingDeleteTabs, disposeTab]);

  const cancelDeleteClose = useCallback(() => {
    setPendingDeleteTabs(null);
  }, []);

  const handlePathDeleted = useCallback(
    (path: string, workspace: WorkspaceEnv) => {
      const deleted = path.replace(/\\/g, "/").replace(/\/+$/, "");
      const dirty: number[] = [];
      const scope = workspaceScopeKey(workspace);
      const spaceIds = new Set(
        useSpaces
          .getState()
          .spaces.filter((space) => workspaceScopeKey(space.env) === scope)
          .map((space) => space.id),
      );
      for (const t of latestTabs.current) {
        if (!spaceIds.has(t.spaceId)) continue;
        if (t.kind !== "editor" && t.kind !== "markdown") continue;
        const current = t.path.replace(/\\/g, "/");
        if (current !== deleted && !current.startsWith(`${deleted}/`)) continue;
        if (t.kind === "editor" && t.dirty) {
          dirty.push(t.id);
        } else {
          disposeTab(t.id);
        }
      }
      if (dirty.length > 0) setPendingDeleteTabs(dirty);
    },
    [disposeTab],
  );

  return {
    pendingCloseTab,
    pendingTerminalCloseTab,
    pendingDeleteTabs,
    handleClose,
    confirmClose,
    cancelClose,
    confirmTerminalClose,
    cancelTerminalClose,
    confirmDeleteClose,
    cancelDeleteClose,
    handlePathDeleted,
  };
}
