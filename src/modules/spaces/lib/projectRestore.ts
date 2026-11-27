import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import { setLeafCwd } from "@/modules/terminal/lib/panes";

export type AgentResume = {
  agent: "claude" | "codex" | "agy";
  id: string;
  cwd: string;
  lastUserMessageAt?: number;
};
export const RESTORE_PROJECT_LIMIT = 5;

export async function hydrateProjectMessageTimes(
  tabs: Tab[],
  read: (saved: AgentResume) => Promise<number | null>,
): Promise<Tab[]> {
  const pending = tabs.filter(
    (tab): tab is TerminalTab =>
      tab.kind === "terminal" &&
      !tab.private &&
      !tab.parked &&
      Boolean(tab.lastAgentSession) &&
      tab.lastAgentMessageAt === undefined,
  );
  const times = new Map<number, number>();
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      for (;;) {
        const tab = pending.shift();
        if (!tab?.lastAgentSession) return;
        try {
          const at =
            tab.lastAgentSession.lastUserMessageAt ??
            (await read(tab.lastAgentSession));
          if (at !== null && Number.isSafeInteger(at) && at > 0)
            times.set(tab.id, at);
        } catch (error) {
          console.warn("[awei-work] Saved agent activity unavailable:", error);
        }
      }
    }),
  );
  return tabs.map((tab) =>
    times.has(tab.id) ? { ...tab, lastAgentMessageAt: times.get(tab.id) } : tab,
  );
}

export function isAgentResume(value: unknown): value is AgentResume {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    (item.agent === "claude" ||
      item.agent === "codex" ||
      item.agent === "agy") &&
    typeof item.id === "string" &&
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(item.id) &&
    typeof item.cwd === "string" &&
    (item.lastUserMessageAt === undefined ||
      (typeof item.lastUserMessageAt === "number" &&
        Number.isSafeInteger(item.lastUserMessageAt) &&
        item.lastUserMessageAt > 0)) &&
    item.cwd.length > 0 &&
    item.cwd.length <= 32768 &&
    !/[\x00-\x1f]/.test(item.cwd)
  );
}

export function recentProjects(tabs: readonly Tab[]): TerminalTab[] {
  return tabs
    .filter(
      (tab): tab is TerminalTab =>
        tab.kind === "terminal" &&
        !tab.private &&
        !tab.parked &&
        Boolean(tab.lastAgentSession) &&
        (tab.lastAgentMessageAt ?? 0) > 0,
    )
    .sort(
      (a, b) =>
        (b.lastAgentMessageAt ?? 0) - (a.lastAgentMessageAt ?? 0) ||
        b.id - a.id,
    )
    .slice(0, RESTORE_PROJECT_LIMIT);
}

export function prepareProjectRestore(tabs: Tab[]): Tab[] {
  const ids = new Set(recentProjects(tabs).map((tab) => tab.id));
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

export function mergeProjectAgentSnapshot(
  tabs: Tab[],
  captured: readonly Tab[],
): Tab[] {
  const byId = new Map(captured.map((tab) => [tab.id, tab]));
  let changed = false;
  const next = tabs.map((tab) => {
    const snapshot = byId.get(tab.id);
    if (
      tab.kind !== "terminal" ||
      tab.private ||
      tab.parked ||
      snapshot?.kind !== "terminal" ||
      tab.paneTree !== snapshot.paneTree ||
      tab.spaceId !== snapshot.spaceId ||
      !snapshot.lastAgentSession
    )
      return tab;
    if ((snapshot.lastAgentMessageAt ?? 0) < (tab.lastAgentMessageAt ?? 0))
      return tab;
    if (
      tab.lastAgentMessageAt === snapshot.lastAgentMessageAt &&
      tab.lastAgentSession?.agent === snapshot.lastAgentSession.agent &&
      tab.lastAgentSession?.id === snapshot.lastAgentSession.id &&
      tab.lastAgentSession?.cwd === snapshot.lastAgentSession.cwd
    )
      return tab;
    changed = true;
    return {
      ...tab,
      lastAgentMessageAt: snapshot.lastAgentMessageAt,
      lastAgentSession: snapshot.lastAgentSession,
    };
  });
  return changed ? next : tabs;
}
