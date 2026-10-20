import { native } from "@/lib/native";
import { errorToast } from "@/lib/errorToast";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs";
import { isLeaf, type PaneNode } from "@/modules/terminal/lib/panes";
import { LOCAL_WORKSPACE } from "@/modules/workspace";
import { useEffect, useRef } from "react";
import { freshTerminalTab, hydrateTabs } from "./serialize";
import {
  loadAll,
  type SpaceMeta,
  newSpaceId,
  saveActiveId,
  saveSpacesList,
} from "./store";
import { useSpaces } from "./useSpaces";
import { prepareProjectRestore } from "@/modules/spaces/lib/projectRestore";

type Params = {
  ready: boolean;
  launchCwd: string | null;
  home: string | null;
  allocId: () => number;
  replaceTabs: (tabs: Tab[], activeId: number) => void;
  markBooted: () => void;
  setActiveSpaceForNewTabs: (id: string) => void;
};

function uniqueCwds(tabs: Tab[]): string[] {
  const set = new Set<string>();
  const walk = (n: PaneNode) => {
    if (isLeaf(n)) {
      if (n.cwd) set.add(n.cwd);
      return;
    }
    for (const c of n.children) walk(c);
  };
  for (const t of tabs) if (t.kind === "terminal") walk(t.paneTree);
  return [...set];
}

export function useSpacesBoot({
  ready,
  launchCwd,
  home,
  allocId,
  replaceTabs,
  markBooted,
  setActiveSpaceForNewTabs,
}: Params) {
  const done = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;

    void (async () => {
      try {
        // Existing spaces also need live preference hydration.
        await usePreferencesStore
          .getState()
          .init()
          .catch((error) => errorToast("加载设置失败", error));

        const { spaces, activeId, states } = await loadAll();
        if (!mounted.current) return;

        if (spaces.length === 0) {
          const env = LOCAL_WORKSPACE;
          const root = launchCwd ?? home;
          const initialId = newSpaceId();
          const meta: SpaceMeta = {
            id: initialId,
            name: "Default",
            root,
            env,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await saveSpacesList([meta]);
          await saveActiveId(initialId);
          if (!mounted.current) return;
          setActiveSpaceForNewTabs(initialId);
          useSpaces.getState().hydrate([meta], initialId);
          const tab = freshTerminalTab(initialId, root, allocId);
          replaceTabs([tab], tab.id);
          return;
        }

        const restored: Tab[] = [];
        for (const space of spaces) {
          const st = states.get(space.id);
          if (!st) continue;
          restored.push(...hydrateTabs(st.tabs, space.id, allocId));
        }

        const active =
          activeId && spaces.some((s) => s.id === activeId)
            ? activeId
            : spaces[0].id;
        setActiveSpaceForNewTabs(active);

        if (
          !states.has(active) &&
          !restored.some((t) => t.spaceId === active)
        ) {
          const cwd = home ?? launchCwd;
          restored.push(freshTerminalTab(active, cwd, allocId));
        }

        await Promise.allSettled(
          uniqueCwds(restored).map((cwd) => native.workspaceAuthorize(cwd)),
        );
        if (!mounted.current) return;

        const initialActiveIndex: Record<string, number> = {};
        for (const [id, st] of states)
          initialActiveIndex[id] = st.activeTabIndex;
        useSpaces.getState().hydrate(spaces, active, initialActiveIndex);

        const inActive = restored.filter((t) => t.spaceId === active);
        const idx = states.get(active)?.activeTabIndex ?? 0;
        const activeTab = inActive[idx] ?? inActive[0];
        replaceTabs(
          prepareProjectRestore(restored, activeTab?.id ?? 0),
          activeTab?.id ?? 0,
        );
      } catch (e) {
        console.error("[awei-work] spaces boot failed:", e);
        if (mounted.current) errorToast("加载工作区失败，原始数据已保留", e);
      } finally {
        if (mounted.current) markBooted();
      }
    })();
  }, [
    ready,
    launchCwd,
    home,
    allocId,
    replaceTabs,
    markBooted,
    setActiveSpaceForNewTabs,
  ]);
}
