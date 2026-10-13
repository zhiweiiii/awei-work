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
    if (tab.kind !== "terminal" || tab.cold) continue;
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
        (tab.id === selectedProjectId || runningIds.has(tab.id)),
    )
    .sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0) || a.id - b.id);
}
