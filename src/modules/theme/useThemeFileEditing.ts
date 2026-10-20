import { type RefObject, useEffect, useRef } from "react";
import { errorToast } from "@/lib/errorToast";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useAppEvent } from "@/modules/events";
import { setThemeId as persistThemeId } from "@/modules/settings/store";
import type { Tab } from "@/modules/tabs";
import { LOCAL_WORKSPACE, workspaceScopeKey } from "@/modules/workspace";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import { listCustomThemes, saveCustomTheme } from "./customThemes";
import {
  isThemeFilePath,
  onThemeEdit,
  parseThemeFile,
  starterTheme,
  themeFilePath,
  writeThemeFile,
} from "./themeFiles";

type Params = {
  tabsRef: RefObject<Tab[]>;
  openFileTab: (path: string) => void;
};

/**
 * A custom theme is materialized to a real file and edited in the code editor.
 * Saving it re-ingests into the runtime store + applies live; the edit request
 * channel opens (or creates) the theme file for editing.
 */
export function useThemeFileEditing({ tabsRef, openFileTab }: Params) {
  const ingestRequests = useRef(new Map<string, object>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ingestRequests.current.clear();
    };
  }, []);
  useAppEvent("fs:written", (payload) => {
    if (payload.source !== "editor") return;
    if (!isThemeFilePath(payload.path)) return;
    const workspace = payload.workspace ?? LOCAL_WORKSPACE;
    const key = JSON.stringify([workspaceScopeKey(workspace), payload.path]);
    const request = {};
    ingestRequests.current.set(key, request);
    void (async () => {
      try {
        const res = await invoke<{ kind: string; content?: string }>(
          "fs_read_file",
          {
            path: payload.path,
            workspace,
          },
        );
        if (!mounted.current || ingestRequests.current.get(key) !== request)
          return;
        if (res.kind !== "text" || typeof res.content !== "string") return;
        const parsed = parseThemeFile(res.content);
        if (!parsed.ok) {
          console.warn("[awei-work] theme not applied:", parsed.error);
          return;
        }
        await saveCustomTheme(parsed.theme);
      } catch (e) {
        console.warn("[awei-work] theme ingest failed:", e);
      } finally {
        if (ingestRequests.current.get(key) === request)
          ingestRequests.current.delete(key);
      }
    })();
  });

  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | undefined;
    let request = 0;
    const releaseSpaces = useSpaces.subscribe((state, previous) => {
      if (state.activeId !== previous.activeId) request++;
    });
    void onThemeEdit((req) => {
      const id = ++request;
      const spaceId = useSpaces.getState().activeId;
      const current = () =>
        alive && id === request && useSpaces.getState().activeId === spaceId;
      void (async () => {
        if (!req || (req.action !== "create" && req.action !== "edit"))
          throw new Error("Invalid theme edit request");
        const theme =
          req.action === "create"
            ? starterTheme()
            : (await listCustomThemes()).find((t) => t.id === req.id);
        if (!theme || !current()) return;
        if (req.action === "create") await saveCustomTheme(theme);
        if (!current()) return;
        const path = await themeFilePath(theme.id);
        if (!current()) return;
        const open = tabsRef.current.some(
          (t) => t.kind === "editor" && t.path === path,
        );
        if (!open) {
          const exists = await invoke("fs_stat", {
            path,
            workspace: LOCAL_WORKSPACE,
          })
            .then(() => true)
            .catch(() => false);
          if (!current()) return;
          if (!exists) await writeThemeFile(theme);
        }
        if (!current()) return;
        await persistThemeId(theme.id);
        if (!current()) return;
        openFileTab(path);
        await getCurrentWebviewWindow().setFocus();
      })().catch((error) => {
        if (alive) errorToast("打开主题文件失败", error);
      });
    })
      .then((fn) => {
        if (alive) unsub = fn;
        else fn();
      })
      .catch((error) => {
        if (alive) errorToast("注册主题编辑监听失败", error);
      });
    return () => {
      alive = false;
      releaseSpaces();
      unsub?.();
    };
  }, [openFileTab, tabsRef]);
}
