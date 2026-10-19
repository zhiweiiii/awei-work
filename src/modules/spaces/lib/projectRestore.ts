import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import { setLeafCwd } from "@/modules/terminal/lib/panes";

export type AgentResume = {
  agent: "claude" | "codex";
  id: string;
  cwd: string;
};
export const RESTORE_PROJECT_LIMIT = 5;

export function isAgentResume(value: unknown): value is AgentResume {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    (item.agent === "claude" || item.agent === "codex") &&
    typeof item.id === "string" &&
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(item.id) &&
    typeof item.cwd === "string" &&
    item.cwd.length > 0 &&
    item.cwd.length <= 32768 &&
    !/[\x00-\x1f]/.test(item.cwd)
  );
}

export function recentProjects(
  tabs: readonly Tab[],
  activeId?: number,
): TerminalTab[] {
  const active = tabs.find((tab) => tab.id === activeId);
  const activeProject =
    active?.kind === "terminal" ? active.id : active?.ownerTabId;
  return tabs
    .filter(
      (tab): tab is TerminalTab =>
        tab.kind === "terminal" && !tab.private && !tab.parked,
    )
    .sort(
      (a, b) =>
        (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
        Number(b.id === activeProject) - Number(a.id === activeProject) ||
        b.id - a.id,
    )
    .slice(0, RESTORE_PROJECT_LIMIT);
}

export function prepareProjectRestore(tabs: Tab[], activeId: number): Tab[] {
  const ids = new Set(recentProjects(tabs, activeId).map((tab) => tab.id));
  return tabs.map((tab) =>
    tab.kind === "terminal" && ids.has(tab.id)
      ? {
          ...tab,
          cold: false,
          autoResume: Boolean(tab.lastAgentSession),
          ...(tab.lastAgentSession && {
            cwd: tab.lastAgentSession.cwd,
            paneTree: setLeafCwd(
              tab.paneTree,
              tab.activeLeafId,
              tab.lastAgentSession.cwd,
            ),
          }),
        }
      : tab,
  );
}
