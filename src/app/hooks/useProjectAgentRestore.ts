import { errorToast } from "@/lib/errorToast";
import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import { resumeAgentInLeaf } from "@/modules/terminal/lib/useTerminalSession";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import { useEffect, useRef } from "react";

export function useProjectAgentRestore(
  tabs: Tab[],
  booted: boolean,
  warmTab: (id: number) => void,
) {
  const latest = useRef(tabs);
  latest.current = tabs;
  const warmRef = useRef(warmTab);
  warmRef.current = warmTab;
  const attempted = useRef(new Set<number>());
  const queue = useRef<number[]>([]);
  const running = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!booted) return;
    const candidates = tabs
      .filter(
        (tab): tab is TerminalTab =>
          tab.kind === "terminal" &&
          !tab.parked &&
          Boolean(tab.autoResume) &&
          Boolean(tab.lastAgentSession) &&
          !attempted.current.has(tab.id),
      )
      .sort((a, b) => {
        if (Boolean(a.cold) !== Boolean(b.cold)) return a.cold ? 1 : -1;
        return (
          (b.lastAgentMessageAt ?? 0) - (a.lastAgentMessageAt ?? 0) ||
          b.id - a.id
        );
      });

    for (const tab of candidates) {
      attempted.current.add(tab.id);
      queue.current.push(tab.id);
    }

    if (running.current || queue.current.length === 0) return;
    running.current = true;

    void (async () => {
      try {
        while (mounted.current && queue.current.length > 0) {
          const tabId = queue.current.shift();
          if (tabId === undefined) break;
          const tab = latest.current.find(
            (item): item is TerminalTab =>
              item.kind === "terminal" &&
              item.id === tabId &&
              !item.parked &&
              Boolean(item.autoResume) &&
              Boolean(item.lastAgentSession),
          );
          if (!tab?.lastAgentSession) continue;
          const workspace = useSpaces
            .getState()
            .spaces.find((space) => space.id === tab.spaceId)?.env;
          if (!workspace) continue;
          const leafId = tab.activeLeafId;
          const saved = tab.lastAgentSession;
          const title = tab.title;
          if (tab.cold) warmRef.current(tab.id);
          const current = () =>
            mounted.current &&
            latest.current.some(
              (item) =>
                item.kind === "terminal" &&
                item.id === tabId &&
                !item.parked &&
                item.activeLeafId === leafId,
            );
          try {
            await resumeAgentInLeaf(leafId, saved, workspace, current);
          } catch (error) {
            if (current()) errorToast(`恢复 ${title} 的 agent 会话失败`, error);
          }
        }
      } finally {
        running.current = false;
      }
    })();
  }, [tabs, booted]);
}
