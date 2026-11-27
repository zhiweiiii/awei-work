import type { Tab } from "@/modules/tabs";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import { useEffect, useMemo, useRef } from "react";
import { selectLiveTerminals } from "./lib/liveTerminals";
import { leafIds } from "./lib/panes";
import { PaneTreeView } from "./PaneTreeView";
import type { TerminalPaneHandle } from "./TerminalPane";

type Props = {
  spaces: readonly SpaceMeta[];
  tabs: Tab[];
  activeId: number;
  /** Register/unregister handle by leaf id (not tab id). */
  registerHandle: (leafId: number, handle: TerminalPaneHandle | null) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
  onFocusLeaf: (tabId: number, leafId: number) => void;
};

type Bundle = {
  setRef: (h: TerminalPaneHandle | null) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
};

export function TerminalStack({
  spaces,
  tabs,
  activeId,
  registerHandle,
  onCwd,
  onExit,
  onFocusLeaf,
}: Props) {
  const terminals = useMemo(() => selectLiveTerminals(tabs), [tabs]);

  const registerRef = useRef(registerHandle);
  const cwdRef = useRef(onCwd);
  const exitRef = useRef(onExit);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);
  useEffect(() => {
    cwdRef.current = onCwd;
  }, [onCwd]);
  useEffect(() => {
    exitRef.current = onExit;
  }, [onExit]);

  const bundles = useRef(new Map<number, Bundle>());
  const getBundle = (leafId: number): Bundle => {
    let b = bundles.current.get(leafId);
    if (!b) {
      b = {
        setRef: (h) => registerRef.current(leafId, h),
        onCwd: (id, cwd) => cwdRef.current(id, cwd),
        onExit: (id, code) => exitRef.current(id, code),
      };
      bundles.current.set(leafId, b);
    }
    return b;
  };

  useEffect(() => {
    const live = new Set<number>();
    for (const t of terminals)
      for (const id of leafIds(t.paneTree)) live.add(id);
    for (const id of bundles.current.keys()) {
      if (!live.has(id)) bundles.current.delete(id);
    }
  }, [terminals]);

  return (
    <div className="relative h-full w-full">
      {terminals.map((t) => {
        const space = spaces.find((space) => space.id === t.spaceId);
        if (!space) return null;
        const tabVisible = t.id === activeId;
        return (
          <div
            key={t.id}
            data-terminal-tab={t.id}
            className="absolute inset-0"
            style={{
              visibility: tabVisible ? "visible" : "hidden",
              pointerEvents: tabVisible ? "auto" : "none",
            }}
            aria-hidden={!tabVisible}
          >
            <PaneTreeView
              workspace={space.env}
              node={t.paneTree}
              tabVisible={tabVisible}
              activeLeafId={t.activeLeafId}
              blocks={t.blocks ?? false}
              gatewayRoutes={t.gatewayRoutes}
              onFocusLeaf={(leafId) => onFocusLeaf(t.id, leafId)}
              getBundle={getBundle}
            />
          </div>
        );
      })}
    </div>
  );
}
