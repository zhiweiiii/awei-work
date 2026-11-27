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
  spaces: readonly { id: string }[] = [],
): TerminalTab[] {
  const spaceIndex = new Map(spaces.map((space, index) => [space.id, index]));
  const rankOf = (spaceId: string) =>
    spaceIndex.get(spaceId) ?? Number.MAX_SAFE_INTEGER;
  return tabs
    .filter(
      (tab): tab is TerminalTab =>
        tab.kind === "terminal" &&
        !tab.parked &&
        (tab.id === selectedProjectId || runningIds.has(tab.id)),
    )
    .sort((a, b) => {
      if (a.spaceId !== b.spaceId) {
        const rankDiff = rankOf(a.spaceId) - rankOf(b.spaceId);
        if (rankDiff !== 0) return rankDiff;
        return a.spaceId.localeCompare(b.spaceId);
      }
      const aManual = a.headerOrder !== undefined;
      const bManual = b.headerOrder !== undefined;
      if (aManual && bManual && a.headerOrder !== b.headerOrder) {
        return (a.headerOrder as number) - (b.headerOrder as number);
      }
      if (aManual !== bManual) return aManual ? -1 : 1;
      return (a.openedAt ?? 0) - (b.openedAt ?? 0) || a.id - b.id;
    });
}

export function headerGroupBounds(
  visible: readonly TerminalTab[],
  tabId: number,
): { start: number; end: number; spaceId: string } | null {
  const index = visible.findIndex((tab) => tab.id === tabId);
  if (index < 0) return null;
  const { spaceId } = visible[index];
  let start = index;
  while (start > 0 && visible[start - 1].spaceId === spaceId) start--;
  let end = index + 1;
  while (end < visible.length && visible[end].spaceId === spaceId) end++;
  return { start, end, spaceId };
}

export function reorderHeaderProjectsByGap(
  tabs: Tab[],
  visible: readonly TerminalTab[],
  fromId: number,
  gap: number,
): Tab[] {
  const from = visible.findIndex((tab) => tab.id === fromId);
  if (from < 0 || !Number.isInteger(gap)) return tabs;
  const bounds = headerGroupBounds(visible, fromId);
  if (!bounds || gap < bounds.start || gap > bounds.end) return tabs;
  const localFrom = from - bounds.start;
  const localGap = gap - bounds.start;
  const localTo = localGap > localFrom ? localGap - 1 : localGap;
  if (localFrom === localTo) return tabs;

  const groupVisible = visible.slice(bounds.start, bounds.end);
  const ordered = [...groupVisible];
  const [moved] = ordered.splice(localFrom, 1);
  ordered.splice(localTo, 0, moved);

  const orders = new Map<number, number>(
    ordered.map((tab, index) => [tab.id, index]),
  );
  let nextOrder = ordered.length;
  const hiddenOrdered = tabs
    .filter(
      (tab): tab is TerminalTab =>
        tab.kind === "terminal" &&
        tab.spaceId === bounds.spaceId &&
        !tab.parked &&
        !orders.has(tab.id) &&
        tab.headerOrder !== undefined,
    )
    .sort(
      (a, b) =>
        (a.headerOrder ?? 0) - (b.headerOrder ?? 0) ||
        (a.openedAt ?? 0) - (b.openedAt ?? 0) ||
        a.id - b.id,
    );
  for (const tab of hiddenOrdered) {
    orders.set(tab.id, nextOrder++);
  }

  return tabs.map((tab) =>
    tab.kind === "terminal" && orders.has(tab.id)
      ? { ...tab, headerOrder: orders.get(tab.id) }
      : tab,
  );
}
