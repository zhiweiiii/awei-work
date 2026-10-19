import type { PaneNode } from "@/modules/terminal/lib/panes";
import type { Tab } from "./useTabs";

export function parkProjectTabs(
  tabs: Tab[],
  id: number,
  allocId: () => number,
): Tab[] {
  const project = tabs.find((tab) => tab.id === id);
  if (project?.kind !== "terminal" || project.parked) return tabs;
  let activeLeafId = project.activeLeafId;
  const renew = (node: PaneNode): PaneNode => {
    const nextId = allocId();
    if (node.kind === "split")
      return { ...node, id: nextId, children: node.children.map(renew) };
    if (node.id === project.activeLeafId) activeLeafId = nextId;
    return { kind: "leaf", id: nextId, cwd: node.cwd };
  };
  const paneTree = renew(project.paneTree);
  return tabs.map((tab) =>
    tab.id === id
      ? {
          ...project,
          paneTree,
          activeLeafId,
          parked: true,
          cold: true,
          autoResume: false,
          lastAgentSession: undefined,
        }
      : tab,
  );
}
