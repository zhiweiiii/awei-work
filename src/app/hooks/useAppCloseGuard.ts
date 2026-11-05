import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Tab } from "@/modules/tabs";
import { leafHasForegroundProcess, leafIds } from "@/modules/terminal";
import { errorToast } from "@/lib/errorToast";

async function anyTerminalBusy(tabs: Tab[]): Promise<boolean> {
  const leaves = tabs.flatMap((t) =>
    t.kind === "terminal" ? leafIds(t.paneTree) : [],
  );
  if (leaves.length === 0) return false;
  const checks = await Promise.all(leaves.map(leafHasForegroundProcess));
  return checks.some(Boolean);
}

export type AppCloseBlocker = {
  dirtyEditors: number;
  busyTerminal: boolean;
};

export function useAppCloseGuard(
  tabsRef: RefObject<Tab[]>,
  beforeClose: () => Promise<void>,
) {
  const [pendingAppClose, setPendingAppClose] =
    useState<AppCloseBlocker | null>(null);
  const forceClose = useRef(false);
  const closing = useRef(false);
  const beforeCloseRef = useRef(beforeClose);
  beforeCloseRef.current = beforeClose;
  const disposedRef = useRef(false);

  const closeSafely = useCallback(
    async (confirmed: boolean) => {
      if (closing.current || disposedRef.current) return;
      closing.current = true;
      try {
        await beforeCloseRef.current();
        if (!confirmed) {
          const busyTerminal = await anyTerminalBusy(tabsRef.current);
          const dirtyEditors = tabsRef.current.filter(
            (tab) => tab.kind === "editor" && tab.dirty,
          ).length;
          if (dirtyEditors > 0 || busyTerminal) {
            setPendingAppClose({ dirtyEditors, busyTerminal });
            return;
          }
        }
        if (disposedRef.current) return;
        await invoke("lsp_shutdown_all");
        if (disposedRef.current) return;
        forceClose.current = true;
        await getCurrentWindow().close();
      } catch (error) {
        forceClose.current = false;
        errorToast("保存工作区或关闭窗口失败，窗口已保留", error);
      } finally {
        closing.current = false;
      }
    },
    [tabsRef],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    disposedRef.current = false;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (disposed) return;
        if (forceClose.current) return;
        event.preventDefault();
        void closeSafely(false);
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      })
      .catch((error) => errorToast("注册关闭保护失败", error));
    return () => {
      disposed = true;
      disposedRef.current = true;
      unlisten?.();
    };
  }, [closeSafely]);

  const confirmAppClose = useCallback(() => {
    setPendingAppClose(null);
    void closeSafely(true);
  }, [closeSafely]);

  const cancelAppClose = useCallback(() => setPendingAppClose(null), []);

  const prepareUpdate = useCallback(async () => {
    if (closing.current || disposedRef.current)
      throw new Error("窗口正在关闭，请稍后重试更新");
    await beforeCloseRef.current();
    const busyTerminal = await anyTerminalBusy(tabsRef.current);
    const dirtyEditors = tabsRef.current.some(
      (tab) => tab.kind === "editor" && tab.dirty,
    );
    if (disposedRef.current || closing.current)
      throw new Error("窗口正在关闭，已取消更新安装");
    if (dirtyEditors || busyTerminal)
      throw new Error("请先保存所有文件并结束终端任务，再安装更新");
  }, [tabsRef]);

  return { pendingAppClose, confirmAppClose, cancelAppClose, prepareUpdate };
}
