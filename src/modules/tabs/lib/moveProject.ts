import type { Tab } from "./useTabs";

export function moveProjectTabs(
  tabs: Tab[],
  projectId: number,
  targetSpaceId: string,
  beforeProjectId: number | null,
): Tab[] {
  const project = tabs.find((tab) => tab.id === projectId);
  if (project?.kind !== "terminal" || beforeProjectId === projectId)
    return tabs;
  const before = tabs.find((tab) => tab.id === beforeProjectId);
  if (
    beforeProjectId !== null &&
    (before?.kind !== "terminal" || before.spaceId !== targetSpaceId)
  )
    return tabs;
  const belongs = (tab: Tab) =>
    tab.id === projectId ||
    (tab.kind !== "terminal" &&
      tab.ownerTabId === projectId &&
      tab.spaceId === project.spaceId);
  const moved = tabs
    .filter(belongs)
    .map((tab) =>
      tab.spaceId === targetSpaceId ? tab : { ...tab, spaceId: targetSpaceId },
    );
  const remaining = tabs.filter((tab) => !belongs(tab));
  let gap =
    beforeProjectId === null
      ? -1
      : remaining.findIndex((tab) => tab.id === beforeProjectId);
  if (gap < 0) {
    gap = remaining.length;
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (remaining[i].spaceId === targetSpaceId) {
        gap = i + 1;
        break;
      }
    }
  }
  const next = [...remaining.slice(0, gap), ...moved, ...remaining.slice(gap)];
  return next.every((tab, index) => tab === tabs[index]) ? tabs : next;
}
