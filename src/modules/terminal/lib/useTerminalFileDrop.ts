import {
  formatNativePathsForLeaf,
  formatPathsForLeaf,
  pasteIntoLeaf,
} from "@/modules/terminal/lib/rendererPool";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";
import { useTerminalDropStore } from "./dropStore";

export type TerminalPathDropTarget = {
  updateTarget: (clientX: number, clientY: number) => boolean;
  dropPath: (path: string, clientX: number, clientY: number) => boolean;
  clearTarget: () => void;
};

type TerminalPathDropDeps = {
  leafIdAtPoint: (clientX: number, clientY: number) => number | null;
  paste: (leafId: number, text: string) => boolean;
  setTarget: (leafId: number | null) => void;
  formatPaths?: (leafId: number, paths: string[]) => string | null;
};

function leafIdAt(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y);
  const leafEl = el?.closest<HTMLElement>("[data-pane-leaf]");
  if (!leafEl) return null;
  const id = Number(leafEl.dataset.paneLeaf);
  return Number.isFinite(id) ? id : null;
}

export function createTerminalPathDropTarget({
  leafIdAtPoint,
  paste,
  setTarget,
  formatPaths = formatPathsForLeaf,
}: TerminalPathDropDeps): TerminalPathDropTarget {
  return {
    updateTarget(clientX, clientY) {
      const leafId = leafIdAtPoint(clientX, clientY);
      setTarget(leafId);
      return leafId !== null;
    },
    dropPath(path, clientX, clientY) {
      setTarget(null);
      const leafId = leafIdAtPoint(clientX, clientY);
      if (leafId === null) return false;
      const text = formatPaths(leafId, [path]);
      return text !== null && paste(leafId, text);
    },
    clearTarget() {
      setTarget(null);
    },
  };
}

const terminalPathDropTarget = createTerminalPathDropTarget({
  leafIdAtPoint: leafIdAt,
  paste: pasteIntoLeaf,
  setTarget: (leafId) => useTerminalDropStore.getState().setTarget(leafId),
});

/** Wires native OS file drops into the terminal pane under the cursor: shows a
 * drop overlay on that pane while dragging, and bracketed-pastes the
 * shell-quoted path(s) on drop. Drops outside any terminal leaf are ignored. */
export function useTerminalFileDrop(): TerminalPathDropTarget {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const setTarget = useTerminalDropStore.getState().setTarget;

    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (disposed) return;
        const p = e.payload;
        const dpr = window.devicePixelRatio || 1;
        if (p.type === "enter" || p.type === "over") {
          setTarget(leafIdAt(p.position.x / dpr, p.position.y / dpr));
          return;
        }
        if (p.type === "leave") {
          setTarget(null);
          return;
        }
        if (p.type === "drop") {
          setTarget(null);
          if (!p.paths.length) return;
          const leafId = leafIdAt(p.position.x / dpr, p.position.y / dpr);
          if (leafId !== null) {
            void formatNativePathsForLeaf(leafId, p.paths).then((text) => {
              if (!disposed && text !== null) pasteIntoLeaf(leafId, text);
            });
          }
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) =>
        console.error("[awei-work] drag-drop listen failed:", err),
      );

    return () => {
      disposed = true;
      setTarget(null);
      unlisten?.();
    };
  }, []);

  return terminalPathDropTarget;
}
