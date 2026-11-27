import { invoke } from "@tauri-apps/api/core";
import type { AgentResume } from "@/modules/spaces/lib/projectRestore";
import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import { findLeafCwd, leafIds } from "@/modules/terminal/lib/panes";
import { ptyIdForLeaf } from "@/modules/terminal/lib/useTerminalSession";
import { useAgentActivityStore } from "@/modules/terminal/lib/agentActivity";

function eligibleProjects(tabs: readonly Tab[]): TerminalTab[] {
  return tabs.filter(
    (tab): tab is TerminalTab =>
      tab.kind === "terminal" && !tab.private && !tab.parked,
  );
}

export function hasProjectAgent(tabs: Tab[]): boolean {
  const agents = useAgentActivityStore.getState().agents;
  return eligibleProjects(tabs).some((tab) =>
    leafIds(tab.paneTree).some((leaf) => {
      const id = ptyIdForLeaf(leaf);
      return (
        id !== null && ["claude", "codex", "agy"].includes(agents[id] ?? "")
      );
    }),
  );
}

export async function projectSessionSnapshot(
  tabs: Tab[],
  saved: Map<number, AgentResume | null>,
): Promise<Tab[]> {
  const projects = eligibleProjects(tabs);
  const liveIds = new Set(projects.flatMap((tab) => leafIds(tab.paneTree)));
  for (const id of saved.keys()) if (!liveIds.has(id)) saved.delete(id);
  const agents = useAgentActivityStore.getState().agents;
  await Promise.all(
    projects.flatMap((tab) =>
      leafIds(tab.paneTree).map(async (leaf) => {
        const ptyId = ptyIdForLeaf(leaf);
        const agent = ptyId === null ? undefined : agents[ptyId];
        if (ptyId === null || !["claude", "codex", "agy"].includes(agent ?? ""))
          return;
        const cwd = findLeafCwd(tab.paneTree, leaf) ?? tab.cwd;
        if (!cwd) return;
        try {
          const result = await invoke<AgentResume | null>("pty_agent_session", {
            id: ptyId,
            cwd,
          });
          if (
            ptyIdForLeaf(leaf) !== ptyId ||
            useAgentActivityStore.getState().agents[ptyId] !== agent
          )
            return;
          if (
            result &&
            (result.lastUserMessageAt ?? 0) >=
              (saved.get(leaf)?.lastUserMessageAt ?? 0)
          )
            saved.set(leaf, result);
        } catch (error) {
          console.warn("[awei-work] Agent session checkpoint failed:", error);
        }
      }),
    ),
  );
  return tabs.map((tab) => {
    if (tab.kind !== "terminal" || tab.private || tab.parked) return tab;
    const candidates = leafIds(tab.paneTree)
      .flatMap((leaf) => {
        const resume = saved.get(leaf);
        return resume ? [{ leaf, resume }] : [];
      })
      .sort(
        (a, b) =>
          (b.resume.lastUserMessageAt ?? 0) - (a.resume.lastUserMessageAt ?? 0),
      );
    const latest = candidates[0];
    const at = latest?.resume.lastUserMessageAt ?? 0;
    if (latest && at > 0 && at >= (tab.lastAgentMessageAt ?? 0))
      return {
        ...tab,
        activeLeafId: latest.leaf,
        lastAgentSession: latest.resume,
        lastAgentMessageAt: at,
      };
    if (!tab.lastAgentSession && latest)
      return {
        ...tab,
        activeLeafId: latest.leaf,
        lastAgentSession: latest.resume,
      };
    return tab;
  });
}
