import { useCallback, useEffect, useRef } from "react";
import type { Tab } from "@/modules/tabs";
import { errorToast } from "@/lib/errorToast";
import { isSerializableTab, serializeTabs } from "./serialize";
import { flushStore, saveActiveId, saveSpacesList, saveState } from "./store";
import { useSpaces } from "./useSpaces";
import { useAgentActivityStore } from "@/modules/terminal/lib/agentActivity";
import type { AgentResume } from "@/modules/spaces/lib/projectRestore";
import {
  hasProjectAgent,
  projectSessionSnapshot,
} from "@/modules/spaces/lib/projectSessionSnapshot";

const DEBOUNCE_MS = 3000;

type Snapshot = { tabs: Tab[]; activeId: number; activeSpaceId: string };

type Params = Snapshot & {
  /** Gate writes until boot hydration finished, so restore never round-trips. */
  enabled: boolean;
  onAgentSnapshot: (tabs: Tab[]) => void;
};

type LastWrite = { json: string; activeTabIndex: number };

export function useSpacePersistence({
  tabs,
  activeId,
  activeSpaceId,
  enabled,
  onAgentSnapshot,
}: Params) {
  const last = useRef<Map<string, LastWrite>>(new Map());
  const agents = useAgentActivityStore((state) => state.agents);
  const phases = useAgentActivityStore((state) => state.phases);
  const seeded = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Snapshot>({ tabs, activeId, activeSpaceId });
  const sessions = useRef(new Map<number, AgentResume | null>());
  const flushQueue = useRef<Promise<void>>(Promise.resolve());
  latest.current = { tabs, activeId, activeSpaceId };

  // Seed each space's last-known active index from disk so the first flush
  // preserves it for spaces the user never opens (empty json forces one write
  // with the correct index rather than clobbering it to 0).
  if (enabled && !seeded.current) {
    seeded.current = true;
    for (const [id, idx] of Object.entries(
      useSpaces.getState().initialActiveIndex,
    )) {
      last.current.set(id, { json: "", activeTabIndex: idx });
    }
  }

  const flushSnapshot = useCallback(
    async (snap: Snapshot) => {
      const capturedTabs = await projectSessionSnapshot(
        snap.tabs,
        sessions.current,
      );
      onAgentSnapshot(capturedTabs);
      const groups = new Map<string, Tab[]>();
      for (const space of useSpaces.getState().spaces) groups.set(space.id, []);
      for (const t of capturedTabs) {
        const arr = groups.get(t.spaceId);
        if (arr) arr.push(t);
      }

      const writes: Promise<void>[] = [];
      for (const [spaceId, group] of groups) {
        const serialized = serializeTabs(group);
        const prev = last.current.get(spaceId);
        let activeTabIndex = prev?.activeTabIndex ?? 0;
        if (spaceId === snap.activeSpaceId) {
          const idx = group
            .filter(isSerializableTab)
            .findIndex((t) => t.id === snap.activeId);
          if (idx >= 0) activeTabIndex = idx;
        }
        const json = JSON.stringify(serialized);
        activeTabIndex = Math.min(
          activeTabIndex,
          Math.max(0, serialized.length - 1),
        );
        if (
          prev &&
          prev.json === json &&
          prev.activeTabIndex === activeTabIndex
        ) {
          continue;
        }
        writes.push(
          saveState(spaceId, { tabs: serialized, activeTabIndex }).then(() => {
            last.current.set(spaceId, { json, activeTabIndex });
          }),
        );
      }
      await Promise.all(writes);
      await flushStore();
    },
    [onAgentSnapshot],
  );

  const flush = useCallback(
    (snap: Snapshot) => {
      const operation = flushQueue.current.then(() => flushSnapshot(snap));
      flushQueue.current = operation.catch(() => {});
      return operation;
    },
    [flushSnapshot],
  );

  // Capture newly started sessions without waiting for the periodic checkpoint.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Agent transitions trigger identity capture after the CLI creates its record.
  useEffect(() => {
    if (!enabled || !hasProjectAgent(latest.current.tabs)) return;
    const checkpoint = setTimeout(() => {
      void flush(latest.current).catch((error) =>
        errorToast("保存会话恢复信息失败", error),
      );
    }, 1000);
    return () => clearTimeout(checkpoint);
  }, [agents, phases, enabled, flush]);

  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      if (!hasProjectAgent(latest.current.tabs)) return;
      void flush(latest.current).catch((error) =>
        errorToast("保存会话恢复信息失败", error),
      );
    }, 15000);
    return () => clearInterval(interval);
  }, [enabled, flush]);

  useEffect(() => {
    if (!enabled) return;
    const snap: Snapshot = { tabs, activeId, activeSpaceId };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flush(snap).catch((error) => errorToast("保存工作区失败", error));
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [tabs, activeId, activeSpaceId, enabled, flush]);

  useEffect(() => {
    if (!enabled) return;
    const onHidden = () => {
      if (document.visibilityState === "hidden")
        void flush(latest.current).catch((error) =>
          errorToast("保存工作区失败", error),
        );
    };
    const onLeave = () => {
      void flush(latest.current).catch((error) =>
        errorToast("保存工作区失败", error),
      );
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("blur", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("beforeunload", onLeave);
      onLeave();
    };
  }, [enabled, flush]);

  return useCallback(async () => {
    if (!enabled) return;
    await saveSpacesList(useSpaces.getState().spaces);
    await saveActiveId(useSpaces.getState().activeId);
    await flush(latest.current);
  }, [enabled, flush]);
}
