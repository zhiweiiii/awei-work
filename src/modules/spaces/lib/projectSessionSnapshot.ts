import { invoke } from "@tauri-apps/api/core";
import {
  recentProjects,
  type AgentResume,
} from "@/modules/spaces/lib/projectRestore";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { findLeafCwd } from "@/modules/terminal/lib/panes";
import { ptyIdForLeaf } from "@/modules/terminal/lib/useTerminalSession";
import { useAgentActivityStore } from "@/modules/terminal/lib/agentActivity";

export function hasProjectAgent(tabs: Tab[], activeId: number): boolean {
  const agents = useAgentActivityStore.getState().agents;
  return recentProjects(tabs, activeId).some((tab) => {
    const id = ptyIdForLeaf(tab.activeLeafId);
    return id !== null && (agents[id] === "claude" || agents[id] === "codex");
  });
}

export async function projectSessionSnapshot(
  tabs: Tab[],
  activeId: number,
  saved: Map<number, AgentResume | null>,
): Promise<Tab[]> {
  const liveIds = new Set(
    tabs
      .filter((tab) => tab.kind === "terminal" && !tab.private && !tab.parked)
      .map((tab) => (tab.kind === "terminal" ? tab.activeLeafId : -1)),
  );
  for (const id of saved.keys()) if (!liveIds.has(id)) saved.delete(id);
  const agents = useAgentActivityStore.getState().agents;
  await Promise.all(
    recentProjects(tabs, activeId).map(async (tab) => {
      const ptyId = ptyIdForLeaf(tab.activeLeafId);
      const agent = ptyId === null ? undefined : agents[ptyId];
      if (ptyId === null || (agent !== "claude" && agent !== "codex")) return;
      const cwd = findLeafCwd(tab.paneTree, tab.activeLeafId) ?? tab.cwd;
      if (!cwd) return;
      const result = await invoke<AgentResume | null>("pty_agent_session", {
        id: ptyId,
        cwd,
      });
      if (
        ptyIdForLeaf(tab.activeLeafId) !== ptyId ||
        useAgentActivityStore.getState().agents[ptyId] !== agent
      )
        return;
      saved.set(tab.activeLeafId, result);
    }),
  );
  return tabs.map((tab) =>
    tab.kind === "terminal" && !tab.parked && saved.has(tab.activeLeafId)
      ? { ...tab, lastAgentSession: saved.get(tab.activeLeafId) ?? undefined }
      : tab,
  );
}
