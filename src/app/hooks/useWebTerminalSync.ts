import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import {
  applyExternalGrid,
  findLeafCwd,
  leafIds,
  ptyIdForLeaf,
  snapshotLeaf,
} from "@/modules/terminal";
import { useSpaces } from "@/modules/spaces";
import type { Tab } from "@/modules/tabs";
import { readLeafScreen } from "@/modules/terminal/lib/rendererPool";

type WebTab = {
  leaf_id: number;
  project_id: number;
  cwd: string | null;
  title: string | null;
  active: boolean;
  viewed: boolean;
  pty_id: number | null;
  space_id: string | null;
};

type WebSpace = {
  id: string;
  name: string;
};

type Params = {
  /** All terminal tabs, in the desktop's tab order. */
  terminalTabs: Tab[];
  activeId: number;
  /** Open a tab by id (activates it, which spawns the pty if cold). */
  activateTab: (id: number, leafId: number, spaceId: string) => void;
};

/**
 * Keeps the Rust web-terminal layer in sync with the desktop's command-line
 * tabs so the phone can list and attach to every terminal, including ones the
 * desktop has never opened yet. Also handles "activate this leaf" requests
 * coming from the web page.
 */
export function useWebTerminalSync({
  terminalTabs,
  activeId,
  activateTab,
}: Params) {
  const spaces = useSpaces((s) => s.spaces);
  const latest = useRef({ terminalTabs, activateTab });
  latest.current = { terminalTabs, activateTab };

  useEffect(() => {
    const tabs: WebTab[] = [];
    for (const tab of terminalTabs) {
      if (tab.kind !== "terminal") continue;
      for (const leafId of leafIds(tab.paneTree)) {
        const ptyId = ptyIdForLeaf(leafId);
        tabs.push({
          leaf_id: leafId,
          project_id: tab.id,
          cwd: findLeafCwd(tab.paneTree, leafId) ?? tab.cwd ?? null,
          title: tab.customTitle ?? tab.title ?? null,
          active: tab.id === activeId && leafId === tab.activeLeafId,
          viewed: tab.id === activeId,
          pty_id: ptyId,
          space_id: tab.spaceId,
        });
      }
    }
    void invoke("web_sync_tabs", { tabs }).catch((e) => {
      console.warn("web_sync_tabs failed:", e);
    });

    // Sync ALL groups (spaces), including empty ones, so the phone's
    // switcher shows every group — not just the ones that currently hold
    // terminals. Kept in the same effect so any tab change also refreshes
    // the group list (and a page reload always syncs both).
    const webSpaces: WebSpace[] = spaces.map((sp) => ({
      id: sp.id,
      name: sp.name,
    }));
    void invoke("web_sync_spaces", { spaces: webSpaces }).catch((e) => {
      console.warn("web_sync_spaces failed:", e);
    });
  }, [terminalTabs, activeId, spaces]);

  // The phone can claim a session while the desktop is idle, in which case
  // nothing on this side asked for a resize and only this event tells us the
  // grid moved. Without it the desktop keeps rendering at its old cols/rows
  // against a byte stream laid out for the phone's.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      const off = await listen<{ leafId: number; cols: number; rows: number }>(
        "terax:pty-resized",
        (e) => {
          if (disposed) return;
          const { leafId, cols, rows } = e.payload;
          if (typeof leafId === "number") applyExternalGrid(leafId, cols, rows);
        },
      );
      if (disposed) off();
      else unlisten = off;
    })().catch((error) =>
      console.warn("[awei-work] resize listener failed:", error),
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // A phone that attaches is seeded with this terminal's own buffer rather
  // than with a second copy of the output kept on the Rust side: the desktop
  // is the only thing that knows what this command line actually shows. The
  // server blocks on the reply, so answer even when there is nothing to send.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      const off = await listen<{ leafId: number; requestId: number }>(
        "terax:web-snapshot",
        (e) => {
          if (disposed) return;
          const { leafId, requestId } = e.payload;
          let data: string | null = null;
          try {
            data = snapshotLeaf(leafId);
          } catch (err) {
            console.warn("[awei-work] snapshotLeaf failed:", err);
          }
          void invoke("web_snapshot_reply", {
            requestId,
            data: data ?? "",
          }).catch((err) => {
            console.warn("web_snapshot_reply failed:", err);
          });
        },
      );
      if (disposed) off();
      else unlisten = off;
    })().catch((error) =>
      console.warn("[awei-work] snapshot listener failed:", error),
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      const off = await listen<number>("terax:web-activate", (e) => {
        if (disposed) return;
        const leafId = e.payload;
        const tab = latest.current.terminalTabs.find(
          (t) => t.kind === "terminal" && leafIds(t.paneTree).includes(leafId),
        );
        if (tab) latest.current.activateTab(tab.id, leafId, tab.spaceId);
      });
      if (disposed) off();
      else unlisten = off;
    })().catch((error) =>
      console.warn("[awei-work] activation listener failed:", error),
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let release: (() => void) | undefined;
    void listen<{
      requestId: number;
      targets: { leafId: number; ptyId: number }[];
    }>("awei-work:pet-choice-status", ({ payload }) => {
      void (async () => {
        const responses: {
          ptyId: number;
          awaitingChoice: boolean;
        }[] = [];
        try {
          const { hasAgentChoices } = await import("@/web/conversation");
          if (disposed) return;
          for (const target of payload.targets) {
            let awaitingChoice = false;
            if (ptyIdForLeaf(target.leafId) === target.ptyId) {
              const screen = readLeafScreen(target.leafId);
              if (screen) awaitingChoice = hasAgentChoices(screen);
            }
            responses.push({
              ptyId: target.ptyId,
              awaitingChoice,
            });
          }
        } finally {
          if (!disposed)
            await invoke("pet_choice_status_reply", {
              requestId: payload.requestId,
              responses,
            });
        }
      })().catch((error) => console.warn("pet prompt reply failed:", error));
    })
      .then((off) => {
        if (disposed) off();
        else release = off;
      })
      .catch((error) => console.warn("pet prompt listener failed:", error));
    return () => {
      disposed = true;
      release?.();
    };
  }, []);
}
