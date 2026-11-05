import {
  notifyDocumentSaved,
  notifyNavigationSourceChanged,
} from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type WorkspaceEnv,
  parseWorkspaceScopeKey,
  workspaceScopeKey,
} from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  detectEol,
  type Eol,
  normalizeToLf,
  restoreEol,
} from "@/modules/editor/lib/eol";

type ReadResult =
  | { kind: "text"; content: string; size: number; mtime: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type FileStat = { size: number; mtime: number; kind: string };

/// Mirrors FORCE_MAX_READ_BYTES in src-tauri fs/file.rs.
export const FORCE_READ_LIMIT = 50 * 1024 * 1024;

export type DocumentState =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number }
  | { status: "binary"; size: number }
  | { status: "toolarge"; size: number; limit: number }
  | { status: "error"; message: string };

const LOADING_DOCUMENT: DocumentState = { status: "loading" };

type Options = {
  path: string;
  workspace: WorkspaceEnv;
  onDirtyChange?: (dirty: boolean) => void;
};

export function useDocument({ path, workspace, onDirtyChange }: Options) {
  const scopeKey = workspaceScopeKey(workspace);
  const documentWorkspace = useMemo(
    () => parseWorkspaceScopeKey(scopeKey),
    [scopeKey],
  );
  const identity = `${scopeKey}\0${path}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const mountedRef = useRef(false);
  const isCurrent = useCallback(
    () => mountedRef.current && identityRef.current === identity,
    [identity],
  );
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const loadedIdentityRef = useRef(identity);
  const [dirty, setDirty] = useState(false);

  const autoSave = usePreferencesStore((s) => s.editorAutoSave);
  const autoSaveDelay = usePreferencesStore((s) => s.editorAutoSaveDelay);

  // Track the saved buffer so we can detect changes cheaply.
  const savedRef = useRef<string>("");
  const readyRef = useRef(false);
  const bufferRef = useRef<string>("");
  const eolRef = useRef<Eol>("\n");
  const dirtyRef = useRef(false);
  const generationRef = useRef(0);
  const readRevisionRef = useRef(0);
  const saveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const updateDirty = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirty(next);
  }, []);

  const autoSaveRef = useRef({ autoSave, autoSaveDelay });
  autoSaveRef.current = { autoSave, autoSaveDelay };

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAutoSaveTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const diskMtimeRef = useRef<number | null>(null);
  const conflictRef = useRef(false);
  if (loadedIdentityRef.current !== identity && dirtyRef.current)
    conflictRef.current = true;

  const writeToDisk = useCallback(
    async (content: string, generation: number, overwrite = false) => {
      if (!isCurrent() || generation !== generationRef.current) return false;
      const mtime = await invoke<number>("fs_write_file", {
        path,
        content: restoreEol(content, eolRef.current),
        workspace: documentWorkspace,
        source: "editor",
        expectedMtime: overwrite ? null : diskMtimeRef.current,
      });
      if (!isCurrent() || generation !== generationRef.current) return false;
      readRevisionRef.current += 1;
      diskMtimeRef.current = mtime;
      conflictRef.current = false;
      savedRef.current = content;
      // Edits typed while the write was in flight must stay dirty.
      updateDirty(bufferRef.current !== content);
      if (documentWorkspace.kind === "local") notifyDocumentSaved(path);
      return true;
    },
    [path, updateDirty, documentWorkspace, isCurrent],
  );

  // False when the write was withheld because the file changed on disk
  // since load; overwriting is an explicit user action from the toast.
  const saveNow = useCallback(async (): Promise<boolean> => {
    if (!isCurrent()) return false;
    const generation = generationRef.current;
    const content = bufferRef.current;
    const perform = async () => {
      if (!isCurrent() || generation !== generationRef.current) return false;
      if (!readyRef.current) return false;
      if (content === savedRef.current) return true;
      const known = diskMtimeRef.current;
      if (known !== null) {
        const stat = await invoke<FileStat>("fs_stat", {
          path,
          workspace: documentWorkspace,
        });
        if (!isCurrent() || generation !== generationRef.current) return false;
        if (conflictRef.current || (stat && stat.mtime !== known)) {
          const name = path.split(/[\\/]/).pop() ?? path;
          toast.warning("File changed on disk", {
            id: `save-conflict:${path}`,
            description: `${name} was modified by another program while you had unsaved changes. Overwrite to keep your version.`,
            action: {
              label: "Overwrite",
              onClick: () => {
                if (!isCurrent() || generation !== generationRef.current)
                  return;
                const overwrite = () =>
                  writeToDisk(bufferRef.current, generation, true);
                const pending = saveQueueRef.current.then(overwrite, overwrite);
                saveQueueRef.current = pending;
                void pending.catch((error) =>
                  toast.error("Save failed", { description: String(error) }),
                );
              },
            },
          });
          return false;
        }
      }
      return writeToDisk(content, generation);
    };
    const pending = saveQueueRef.current.then(perform, perform);
    saveQueueRef.current = pending;
    return pending;
  }, [path, writeToDisk, documentWorkspace, isCurrent]);

  // Notify parent of dirty transitions.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  const forceRef = useRef(false);

  // Adopts a read result as the new saved baseline. `skipIfUnchanged` avoids
  // the re-render when disk already matches the buffer (self-save / duplicate
  // watcher event); initial loads must always publish a state.
  const adoptRead = useCallback(
    (res: ReadResult, skipIfUnchanged = false) => {
      loadedIdentityRef.current = identity;
      if (res.kind === "text") {
        conflictRef.current = false;
        eolRef.current = detectEol(res.content);
        diskMtimeRef.current = res.mtime;
        const content = normalizeToLf(res.content);
        if (skipIfUnchanged && readyRef.current && content === savedRef.current)
          return;
        readyRef.current = true;
        savedRef.current = content;
        bufferRef.current = content;
        updateDirty(false);
        setDoc({ status: "ready", content, size: res.size });
      } else if (res.kind === "binary") {
        readyRef.current = false;
        setDoc({ status: "binary", size: res.size });
      } else if (res.kind === "toolarge") {
        readyRef.current = false;
        setDoc({ status: "toolarge", size: res.size, limit: res.limit });
      }
    },
    [updateDirty, identity],
  );

  const readFromDisk = useCallback(
    (force: boolean) =>
      invoke<ReadResult>("fs_read_file", {
        path,
        workspace: documentWorkspace,
        force,
      }),
    [path, documentWorkspace],
  );

  // Load on path change.
  useEffect(() => {
    let cancelled = false;
    const preserveDraft = dirtyRef.current && readyRef.current;
    const previousScope = loadedIdentityRef.current.split("\0")[0];
    generationRef.current += 1;
    const revision = ++readRevisionRef.current;
    // "Open anyway" is a per-file decision; a new path starts unforced.
    forceRef.current = false;
    if (preserveDraft) {
      conflictRef.current = true;
      loadedIdentityRef.current = identity;
      setDoc((previous) =>
        previous.status === "ready"
          ? { ...previous, content: bufferRef.current }
          : previous,
      );
    } else {
      setDoc({ status: "loading" });
      savedRef.current = "";
      bufferRef.current = "";
      diskMtimeRef.current = null;
      conflictRef.current = false;
      readyRef.current = false;
      updateDirty(false);
    }

    readFromDisk(forceRef.current)
      .then((res) => {
        if (cancelled || !isCurrent() || revision !== readRevisionRef.current)
          return;
        if (preserveDraft && dirtyRef.current) {
          if (res.kind === "text") {
            diskMtimeRef.current = res.mtime;
            conflictRef.current =
              previousScope !== scopeKey ||
              normalizeToLf(res.content) !== savedRef.current;
            eolRef.current = detectEol(res.content);
          } else {
            toast.error("目标文件无法作为文本读取，未保存草稿已保留");
          }
          return;
        }
        adoptRead(res);
      })
      .catch((e) => {
        if (!cancelled && isCurrent() && revision === readRevisionRef.current) {
          if (preserveDraft)
            toast.error("读取目标文件失败，未保存草稿已保留", {
              description: String(e),
            });
          else setDoc({ status: "error", message: String(e) });
        }
      });

    return () => {
      cancelled = true;
      generationRef.current += 1;
      readRevisionRef.current += 1;
      clearAutoSaveTimer();
    };
  }, [
    readFromDisk,
    adoptRead,
    updateDirty,
    clearAutoSaveTimer,
    isCurrent,
    identity,
    scopeKey,
  ]);

  const openAnyway = useCallback(() => {
    if (!isCurrent()) return;
    const generation = generationRef.current;
    const revision = ++readRevisionRef.current;
    forceRef.current = true;
    setDoc({ status: "loading" });
    readFromDisk(true)
      .then((res) => {
        if (
          isCurrent() &&
          generation === generationRef.current &&
          revision === readRevisionRef.current
        )
          adoptRead(res);
      })
      .catch((e) => {
        if (
          isCurrent() &&
          generation === generationRef.current &&
          revision === readRevisionRef.current
        )
          setDoc({ status: "error", message: String(e) });
      });
  }, [readFromDisk, adoptRead, isCurrent]);

  // Skipped while dirty: never clobber unsaved edits. Re-checked when the
  // read resolves, since typing can start while it is in flight.
  const reload = useCallback((): boolean => {
    if (!isCurrent()) return false;
    if (dirtyRef.current) return false;
    const generation = generationRef.current;
    const revision = ++readRevisionRef.current;
    void readFromDisk(forceRef.current)
      .then((res) => {
        if (
          isCurrent() &&
          !dirtyRef.current &&
          generation === generationRef.current &&
          revision === readRevisionRef.current
        )
          adoptRead(res, true);
      })
      // Transient failures (e.g. ENOENT mid atomic-rename) must not replace
      // a healthy buffer with an error screen.
      .catch((e) => console.warn("[editor] reload failed", path, e));
    return true;
  }, [readFromDisk, adoptRead, path, isCurrent]);

  // Poll-friendly reload: stat first so a periodic sweep over the open files
  // costs one stat each instead of re-reading every buffer from disk.
  const revalidate = useCallback(async (): Promise<void> => {
    if (!isCurrent()) return;
    if (dirtyRef.current) return;
    const known = diskMtimeRef.current;
    if (known === null) return;
    const generation = generationRef.current;
    const stat = await invoke<FileStat>("fs_stat", {
      path,
      workspace: documentWorkspace,
    }).catch(() => null);
    if (
      !isCurrent() ||
      generation !== generationRef.current ||
      !stat ||
      stat.mtime === known
    )
      return;
    reload();
  }, [path, reload, documentWorkspace, isCurrent]);

  const save = useCallback(async (): Promise<boolean> => {
    clearAutoSaveTimer();
    return saveNow();
  }, [clearAutoSaveTimer, saveNow]);

  // Adopt externally formatted disk content as the saved baseline before the
  // matching editor dispatch lands, so the buffer never flashes dirty. The
  // formatter's own write must also become the known mtime, or the next save
  // would report it as an external conflict.
  // Returns the LF-normalized text the caller should dispatch.
  const adoptDiskText = useCallback(
    (diskText: string, mtime: number): string => {
      eolRef.current = detectEol(diskText);
      diskMtimeRef.current = mtime;
      const content = normalizeToLf(diskText);
      savedRef.current = content;
      updateDirty(bufferRef.current !== content);
      return content;
    },
    [updateDirty],
  );

  const onChange = useCallback(
    (next: string) => {
      if (next !== bufferRef.current && /\.xml$/i.test(path))
        notifyNavigationSourceChanged(path);
      bufferRef.current = next;
      const isDirty = next !== savedRef.current;
      readRevisionRef.current += 1;
      updateDirty(isDirty);

      clearAutoSaveTimer();

      const { autoSave: active, autoSaveDelay: delay } = autoSaveRef.current;
      if (active && isDirty) {
        timeoutRef.current = setTimeout(() => {
          saveNow().catch((e) => console.error("[autosave]", e));
        }, delay);
      }
    },
    [clearAutoSaveTimer, saveNow, updateDirty, path],
  );

  useEffect(() => {
    if (!autoSave) clearAutoSaveTimer();
  }, [autoSave, clearAutoSaveTimer]);

  return {
    doc:
      loadedIdentityRef.current === identity || dirtyRef.current
        ? doc
        : LOADING_DOCUMENT,
    dirty,
    onChange,
    save,
    reload,
    revalidate,
    adoptDiskText,
    openAnyway,
  };
}
