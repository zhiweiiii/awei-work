import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  currentWorkspaceScopeKey,
  LOCAL_WORKSPACE,
  workspaceScopeKey,
} from "@/modules/workspace";
import { parentDir } from "@/modules/explorer/lib/watch";

type Options = {
  rootPath: string | null;
  isDir: (path: string) => boolean | undefined;
  onCopied: (destDir: string) => void;
};

function dirAt(
  x: number,
  y: number,
  rootPath: string | null,
  isDir: (p: string) => boolean | undefined,
): string | null {
  const dpr = window.devicePixelRatio || 1;
  const lx = x / dpr;
  const ly = y / dpr;
  const el = document.elementFromPoint(lx, ly) as HTMLElement | null;
  if (!el) return null;
  const row = el.closest<HTMLElement>("[data-fs-path]");
  if (row) {
    const p = row.getAttribute("data-fs-path") as string;
    return isDir(p) ? p : parentDir(p);
  }
  if (el.closest("[data-explorer-drop]")) return rootPath;
  return null;
}

// Accepts files dropped from the OS onto an explorer folder (copy, not move),
// via Tauri's native drag-drop. One webview-level listener; ignores drops that
// land outside the explorer (the terminal handles its own).
export function useExplorerFileDrop({ rootPath, isDir, onCopied }: Options) {
  const workspace = LOCAL_WORKSPACE;
  const scopeKey = workspaceScopeKey(workspace);
  const [targetDir, setTargetDir] = useState<string | null>(null);
  const optsRef = useRef({ rootPath, isDir, onCopied, workspace, scopeKey });
  optsRef.current = { rootPath, isDir, onCopied, workspace, scopeKey };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (disposed) return;
        const p = e.payload;
        const { rootPath, isDir, onCopied, workspace, scopeKey } =
          optsRef.current;
        if (currentWorkspaceScopeKey() !== scopeKey) return;
        if (p.type === "enter" || p.type === "over") {
          setTargetDir(dirAt(p.position.x, p.position.y, rootPath, isDir));
          return;
        }
        if (p.type === "leave") {
          setTargetDir(null);
          return;
        }
        if (p.type === "drop") {
          const dir = dirAt(p.position.x, p.position.y, rootPath, isDir);
          setTargetDir(null);
          if (!dir || p.paths.length === 0) return;
          void invoke("fs_copy", {
            sources: p.paths,
            destDir: dir,
            workspace,
          })
            .then(() => {
              if (
                !disposed &&
                optsRef.current.rootPath === rootPath &&
                optsRef.current.scopeKey === scopeKey &&
                currentWorkspaceScopeKey() === scopeKey
              )
                onCopied(dir);
            })
            .catch((err) => toast.error(`Copy failed: ${String(err)}`));
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) =>
        console.error("[awei-work] explorer drop listen failed:", err),
      );

    return () => {
      disposed = true;
      setTargetDir(null);
      unlisten?.();
    };
  }, []);

  return { externalTargetDir: targetDir };
}
