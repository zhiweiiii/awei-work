import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import {
  leafIds,
  ptyIdForLeaf,
  useAgentActivityStore,
} from "@/modules/terminal";
import { useMemo } from "react";

export function runningProjectIds(
  tabs: readonly Tab[],
  agents: Readonly<Record<number, string>>,
  ptyForLeaf: (leaf: number) => number | null,
): Set<number> {
  const running = new Set<number>();
  for (const tab of tabs) {
    if (tab.kind !== "terminal" || tab.cold || tab.parked) continue;
    if (
      leafIds(tab.paneTree).some((leaf) => {
        const pty = ptyForLeaf(leaf);
        return pty !== null && Boolean(agents[pty]);
      })
    )
      running.add(tab.id);
  }
  return running;
}

export function useRunningProjects(tabs: readonly Tab[]): Set<number> {
  const agents = useAgentActivityStore((state) => state.agents);
  return useMemo(
    () => runningProjectIds(tabs, agents, ptyIdForLeaf),
    [tabs, agents],
  );
}

export function headerProjects(
  tabs: readonly Tab[],
  runningIds: ReadonlySet<number>,
  selectedProjectId: number | null,
): TerminalTab[] {
  return tabs
    .filter(
      (tab): tab is TerminalTab =>
        tab.kind === "terminal" &&
        !tab.parked &&
        (tab.id === selectedProjectId || runningIds.has(tab.id)),
    )
    .sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0) || a.id - b.id);
}

export function reorderHeaderProjectsByGap(
  tabs: Tab[],
  visible: readonly TerminalTab[],
  fromId: number,
  gap: number,
): Tab[] {
  const from = visible.findIndex((tab) => tab.id === fromId);
  if (from < 0 || !Number.isInteger(gap) || gap < 0 || gap > visible.length)
    return tabs;
  const to = gap > from ? gap - 1 : gap;
  if (from === to) return tabs;
  const ordered = [...visible];
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  const times = new Map(
    ordered.map((tab, index) => [tab.id, visible[index].openedAt]),
  );
  return tabs.map((tab) =>
    tab.kind === "terminal" && times.has(tab.id)
      ? { ...tab, openedAt: times.get(tab.id) }
      : tab,
  );
}
