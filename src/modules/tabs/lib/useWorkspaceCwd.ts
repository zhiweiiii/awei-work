import { useCallback, useEffect, useMemo, useRef } from "react";
import { emitEvent } from "@/modules/events";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import { workspaceScopeKey } from "@/modules/workspace";
import { findLeafCwd } from "@/modules/terminal/lib/panes";
import type { Tab } from "./useTabs";

type Result = {
  /** The terminal tab whose cwd the side panels follow; null when none. */
  currentTerminalTab: Extract<Tab, { kind: "terminal" }> | null;
  /** Root for the file explorer / source control, tied to the current command line. */
  explorerRoot: string | null;
  inheritedCwdForNewTab: () => string | undefined;
};

export function useWorkspaceCwd(
  activeTab: Tab | undefined,
  tabs: Tab[],
  home: string | null,
): Result {
  const activeSpaceId = useSpaces((state) => state.activeId);
  const spaces = useSpaces((state) => state.spaces);
  const spaceId = activeTab?.spaceId ?? activeSpaceId ?? "";
  const space = spaces.find((item) => item.id === spaceId);
  const scope = JSON.stringify([
    spaceId,
    workspaceScopeKey(space?.env ?? { kind: "local" }),
  ]);
  const lastTerminalCwd = useRef(new Map<string, string>());
  const lastTerminalBySpaceRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (activeTab?.kind === "terminal") {
      const cwd =
        findLeafCwd(activeTab.paneTree, activeTab.activeLeafId) ??
        activeTab.cwd;
      if (cwd) lastTerminalCwd.current.set(scope, cwd);
      lastTerminalBySpaceRef.current.set(scope, activeTab.id);
    }
    const live = new Set(
      spaces.map((item) =>
        JSON.stringify([item.id, workspaceScopeKey(item.env)]),
      ),
    );
    for (const key of lastTerminalCwd.current.keys()) {
      if (!live.has(key)) lastTerminalCwd.current.delete(key);
    }
    for (const key of lastTerminalBySpaceRef.current.keys()) {
      if (!live.has(key)) lastTerminalBySpaceRef.current.delete(key);
    }
  }, [activeTab, scope, spaces]);

  // The command line the side panels follow: the active terminal itself, the
  // owner of the active file tab, or the last-focused terminal of the space.
  const currentTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeTab?.id);
    if (t?.kind === "terminal") return t;
    if (t && t.ownerTabId !== undefined) {
      const owner = tabs.find((x) => x.id === t.ownerTabId);
      if (owner?.kind === "terminal" && owner.spaceId === t.spaceId)
        return owner;
    }
    const remembered = lastTerminalBySpaceRef.current.get(scope);
    const candidates = tabs.filter(
      (x) => x.kind === "terminal" && x.spaceId === spaceId,
    );
    const hit =
      candidates.find((x) => x.id === remembered) ??
      candidates[candidates.length - 1] ??
      null;
    return (hit as Extract<Tab, { kind: "terminal" }> | undefined) ?? null;
  }, [tabs, activeTab, scope, spaceId]);

  const terminalCwd = currentTerminalTab
    ? (findLeafCwd(
        currentTerminalTab.paneTree,
        currentTerminalTab.activeLeafId,
      ) ?? currentTerminalTab.cwd)
    : undefined;
  const fallback = space?.root ?? home;
  const explorerRoot = useMemo<string | null>(() => {
    return terminalCwd ?? lastTerminalCwd.current.get(scope) ?? fallback;
  }, [terminalCwd, scope, fallback]);

  // Mounting initializes subscribers; only semantic context changes invalidate them.
  const firstRef = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Environment changes invalidate consumers even when cwd and terminal ID stay equal.
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    emitEvent("context:changed", {
      cwd: explorerRoot,
      terminalId: currentTerminalTab?.id ?? null,
    });
  }, [currentTerminalTab?.id, explorerRoot, scope]);

  const inheritedCwdForNewTab = useCallback((): string | undefined => {
    return (
      terminalCwd ?? lastTerminalCwd.current.get(scope) ?? fallback ?? undefined
    );
  }, [terminalCwd, scope, fallback]);

  return { currentTerminalTab, explorerRoot, inheritedCwdForNewTab };
}
