import { useGroupDeleteGuard } from "@/app/hooks/useGroupDeleteGuard";
import { useLaunchFiles } from "@/app/hooks/useLaunchFiles";
import { useProjectAgentRestore } from "@/app/hooks/useProjectAgentRestore";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { agentFileRef } from "@/lib/agentRef";
import {
  headerProjects,
  useRunningProjects,
} from "@/modules/spaces/lib/projectTabs";
import { consumeLaunchCommand, getLaunchDir } from "@/lib/launchDir";
import { native } from "@/lib/native";
import { useZoom } from "@/lib/useZoom";
import { isMarkdownPath } from "@/lib/utils";
import { CommandPalette, createCommandItems } from "@/modules/command-palette";
import type { GitDiffPaneHandle } from "@/modules/editor";
import {
  type EditorPaneHandle,
  NewEditorDialog,
  useApplyEditorFontSize,
  useEditorFileSync,
} from "@/modules/editor";
import { bridgeNativeFileEvents } from "@/modules/events";
import { FileExplorer, type FileExplorerHandle } from "@/modules/explorer";
import { explorerFileState } from "@/modules/explorer/lib/openFileState";
import { FileHistoryDialog } from "@/modules/git-history";
import type { GitHistoryPaneHandle } from "@/modules/git-history/GitHistoryPane";
import { Header, SessionHistoryMenu } from "@/modules/header";
import { setLspNavigator } from "@/modules/lsp";
import type { MarkdownPreviewPaneHandle } from "@/modules/markdown/MarkdownPreviewPane";
import type { PreviewPaneHandle } from "@/modules/preview";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type ShortcutHandlers,
  type ShortcutId,
  shouldDisablePaneSwapShortcut,
  useGlobalShortcuts,
} from "@/modules/shortcuts";
import type { SidebarViewId } from "@/modules/sidebar";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useSidebarPanel,
} from "@/modules/sidebar";
import {
  CloneRepositoryDialog,
  RemoteManagerDialog,
  RepoBranchSelector,
  SourceControlPanel,
  useRepositoryTargeting,
  useSourceControlContext,
} from "@/modules/source-control";
import {
  GroupSwitcher,
  useSpacePersistence,
  useSpaces,
  useSpacesBoot,
} from "@/modules/spaces";
import { StatusBar } from "@/modules/statusbar";
import { WindowBar } from "@/modules/statusbar/WindowBar";
import { canEvictWindow } from "@/modules/statusbar/lib/windowTabs";
import {
  TabSwitcherHud,
  useTabSwitcher,
  useTabs,
  useWindowTitle,
  useWorkspaceCwd,
} from "@/modules/tabs";
import {
  DEFAULT_SPACE_ID,
  type Tab,
  type TerminalTab,
} from "@/modules/tabs/lib/useTabs";
import {
  clearFocusedTerminal,
  disposeSession,
  findLeafCwd,
  hasLeaf,
  leafCwd,
  leafIds,
  leafWorkspace,
  navigateFocusedBlocks,
  type PaneBounds,
  pasteToLeaf,
  ptyIdForLeaf,
  submitToLeaf,
  type TerminalPaneHandle,
  useAgentActivityStore,
  useTerminalFileDrop,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import { ThemeProvider, useThemeFileEditing } from "@/modules/theme";
import { UpdaterDialog } from "@/modules/updater";
import {
  useWorkspaceEnvStore,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "@/modules/workspace";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { CloseDialogs } from "./components/CloseDialogs";
import { SelectionAskButton } from "./components/SelectionAskButton";
import { useSelectionAsk } from "./components/useSelectionAsk";
import {
  TOGGLE_BLOCK_INPUT_EVENT,
  WorkspaceInputBar,
} from "./components/WorkspaceInputBar";
import { WorkspaceSurface } from "./components/WorkspaceSurface";
import { useAppCloseGuard } from "./hooks/useAppCloseGuard";
import { useWebTerminalSync } from "./hooks/useWebTerminalSync";

function HeaderTabs({
  active,
  sourceControlChanged,
  onSelect,
}: {
  active: SidebarViewId | null;
  sourceControlChanged: number;
  onSelect: (id: SidebarViewId) => void;
}) {
  const tabs: { id: SidebarViewId; label: string; badge?: number }[] = [
    { id: "explorer", label: "文件" },
    {
      id: "source-control",
      label: "版本",
      badge: sourceControlChanged,
    },
  ];
  return (
    <>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onSelect(t.id)}
          className={
            active === t.id
              ? "rounded-md bg-foreground/[0.08] px-1.5 py-0.5 text-[10.5px] font-medium text-foreground"
              : "rounded-md px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
          }
        >
          {t.label}
          {t.badge && t.badge > 0 ? (
            <span className="ml-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[8px] font-bold leading-none text-primary-foreground">
              {t.badge > 99 ? "99+" : t.badge}
            </span>
          ) : null}
        </button>
      ))}
    </>
  );
}

import { useTabCloseGuards } from "./hooks/useTabCloseGuards";
import { useWorkspaceSwitcher } from "./hooks/useWorkspaceSwitcher";

export default function App() {
  const {
    tabs,
    activeId,
    setActiveId,
    allocId,
    booted,
    replaceTabs,
    moveProject,
    removeTabsForSpace,
    markBooted,
    setActiveSpaceForNewTabs,
    newTab,
    newBlockTab,
    newCommandTab,
    newPrivateTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    newMarkdownTab,
    setMarkdownView,
    setOverrideLanguage,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
    closeTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
    focusPane,
    focusNextPaneInTab,
    swapActivePaneInDirection,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    resetWorkspace,
  } = useTabs(getLaunchDir() ? { cwd: getLaunchDir() } : undefined);

  // Mirror `tabs` into a ref so callbacks scheduled with `setTimeout`
  // (e.g. cdInNewTab) read the latest pane state instead of a stale closure.
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);

  const activeTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    return t && t.kind === "terminal" ? t : null;
  }, [tabs, activeId]);
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const previewRefs = useRef<Map<number, PreviewPaneHandle>>(new Map());
  const markdownRefs = useRef<Map<number, MarkdownPreviewPaneHandle>>(
    new Map(),
  );
  const gitDiffRefs = useRef<Map<number, GitDiffPaneHandle>>(new Map());
  const gitHistoryRefs = useRef<Map<number, GitHistoryPaneHandle>>(new Map());
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  useApplyEditorFontSize();
  const terminalPathDropTarget = useTerminalFileDrop();
  const explorerRef = useRef<FileExplorerHandle>(null);

  // Drives session disposal off the pane tree, not React lifecycles —
  // split/unsplit re-mount components but the leaf is still live.
  const liveLeavesRef = useRef<Set<number>>(new Set());

  const clearWorkspaceState = useCallback(() => {
    for (const id of liveLeavesRef.current) disposeSession(id);
    terminalRefs.current.clear();
    editorRefs.current.clear();
    previewRefs.current.clear();
  }, []);

  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);
  const { home, launchCwd, launchCwdResolved, adoptWorkspaceEnv } =
    useWorkspaceSwitcher({
      tabsRef,
      workspaceEnv,
      setWorkspaceEnv,
      resetWorkspace,
      clearWorkspaceState,
    });

  const activeSpaceId = useSpaces((s) => s.activeId);
  const spacesHydrated = useSpaces((s) => s.hydrated);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
    activeIdRef.current = activeId;
  }, [tabs, activeId]);
  const sourceControlSpaceId = activeSpaceId ?? DEFAULT_SPACE_ID;

  useSpacesBoot({
    ready: launchCwdResolved,
    launchCwd,
    home,
    allocId,
    replaceTabs,
    markBooted,
    setActiveSpaceForNewTabs,
    adoptWorkspaceEnv,
  });

  const flushSpaces = useSpacePersistence({
    tabs,
    activeId,
    activeSpaceId: activeSpaceId ?? DEFAULT_SPACE_ID,
    enabled: spacesHydrated,
  });

  // One process-wide fs watch feeds every panel through the event bus; the
  // bridge is subscribed here for the app's lifetime.
  useEffect(() => bridgeNativeFileEvents(), []);

  // Per-space memory of the terminal tab last focused there. Switching groups
  // should land back on the shell you were working in, so file tabs are never
  // the restore target even when one sits last in tab order.
  const lastTerminalBySpaceRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal")
      lastTerminalBySpaceRef.current.set(t.spaceId, t.id);
  }, [activeId]);

  const prevSpaceRef = useRef(activeSpaceId);
  useEffect(() => {
    if (!spacesHydrated || !activeSpaceId) return;
    setActiveSpaceForNewTabs(activeSpaceId);
    const prev = prevSpaceRef.current;
    prevSpaceRef.current = activeSpaceId;
    if (prev === null || prev === activeSpaceId) return;
    const meta = useSpaces
      .getState()
      .spaces.find((s) => s.id === activeSpaceId);
    if (meta) void adoptWorkspaceEnv(meta.env);
    const inSpace = tabsRef.current.filter((t) => t.spaceId === activeSpaceId);
    if (inSpace.length === 0) return;
    // Keep the active tab if it already belongs to the newly active space (a
    // cross-space jump set it explicitly).
    if (inSpace.some((t) => t.id === activeId)) return;
    // Otherwise: the terminal last focused here, then this space's last
    // terminal, and only if it has none at all fall back to its last tab.
    const remembered = lastTerminalBySpaceRef.current.get(activeSpaceId);
    const target =
      inSpace.find((t) => t.id === remembered && t.kind === "terminal") ??
      [...inSpace].reverse().find((t) => t.kind === "terminal") ??
      inSpace[inSpace.length - 1];
    setActiveId(target.id);
  }, [
    activeSpaceId,
    activeId,
    spacesHydrated,
    setActiveSpaceForNewTabs,
    setActiveId,
    adoptWorkspaceEnv,
  ]);

  const spaceTabs = useMemo(
    () => tabs.filter((t) => t.spaceId === (activeSpaceId ?? DEFAULT_SPACE_ID)),
    [tabs, activeSpaceId],
  );

  const runningProjects = useRunningProjects(tabs);

  // ALL terminal tabs across every group: the phone's switcher lists every
  // group's terminals, not just the currently active group's.
  const allTerminalTabs = useMemo(
    () => tabs.filter((t) => t.kind === "terminal"),
    [tabs],
  );

  // Sync the desktop's command-line tabs to the web layer (phone list) and
  // react to the phone asking to activate a terminal.
  useWebTerminalSync({
    terminalTabs: allTerminalTabs,
    activeId,
    activateTab: (id, leafId, spaceId) => {
      useSpaces.getState().setActive(spaceId);
      setActiveSpaceForNewTabs(spaceId);
      setActiveId(id);
      focusPane(id, leafId);
    },
  });

  const {
    sidebarRef,
    sidebarWidthRef,
    sidebarView,
    sidebarOpen,
    initialSidebarCollapsed,
    persistSidebarView,
    persistSidebarCollapsed,
    toggleSidebar,
    cycleSidebarView,
    openSidebarView,
    persistSidebarWidth,
    toggleExplorerFocus,
  } = useSidebarPanel(explorerRef);

  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteInitialMode, setPaletteInitialMode] = useState<
    "commands" | "content"
  >("commands");
  const openCommandPalette = useCallback(
    (mode: "commands" | "content" = "commands") => {
      setPaletteInitialMode(mode);
      setCommandPaletteOpen(true);
    },
    [],
  );

  const activeTab = tabs.find((t) => t.id === activeId);
  useProjectAgentRestore(tabs, booted);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isBlockTab = activeTerminalTab?.blocks === true;

  useThemeFileEditing({ tabsRef, openFileTab });

  // One source of truth for the side panels: the command line (terminal tab)
  // they all follow. 文件 / 版本 / 窗口 switch together with it.
  const {
    currentTerminalTab: currentOwnerTab,
    explorerRoot,
    inheritedCwdForNewTab,
  } = useWorkspaceCwd(activeTab, tabs, launchCwd ?? home);
  const currentOwnerTabId = currentOwnerTab?.id ?? null;
  const headerTabs = useMemo(
    () => headerProjects(tabs, runningProjects, currentOwnerTabId),
    [tabs, runningProjects, currentOwnerTabId],
  );

  useWindowTitle(activeTab, explorerRoot);

  const disposeTab = useCallback(
    (
      id: number,
      canClose?: (tab: Tab, tabs: readonly Tab[], activeId: number) => boolean,
    ) => {
      if (!closeTab(id, canClose)) return;
      // Terminal-leaf-keyed maps (terminalRefs) are pruned by the effect
      // below as the pane tree changes; only the tab-id-keyed handles need
      // explicit cleanup here.
      editorRefs.current.delete(id);
      previewRefs.current.delete(id);
    },
    [closeTab],
  );

  const windowScopeRef = useRef({
    spaceId: sourceControlSpaceId,
    ownerId: currentOwnerTabId,
  });
  windowScopeRef.current = {
    spaceId: sourceControlSpaceId,
    ownerId: currentOwnerTabId,
  };
  const closeOverflowWindows = useCallback(
    (spaceId: string, ownerId: number | null, ids: number[]) => {
      const scope = windowScopeRef.current;
      if (scope.spaceId !== spaceId || scope.ownerId !== ownerId) return;
      for (const id of ids) {
        disposeTab(id, (tab, latest, active) =>
          canEvictWindow(tab, latest, active, spaceId, ownerId),
        );
      }
    },
    [disposeTab],
  );

  const {
    pendingCloseTab,
    pendingTerminalCloseTab,
    pendingDeleteTabs,
    handleClose,
    confirmClose,
    cancelClose,
    confirmTerminalClose,
    cancelTerminalClose,
    confirmDeleteClose,
    cancelDeleteClose,
    handlePathDeleted,
  } = useTabCloseGuards({ tabs, disposeTab });

  const { pendingAppClose, confirmAppClose, cancelAppClose, prepareUpdate } =
    useAppCloseGuard(tabsRef, flushSpaces);

  useEffect(() => {
    const live = new Set<number>();
    for (const t of tabs) {
      if (t.kind === "terminal") {
        for (const id of leafIds(t.paneTree)) live.add(id);
      }
    }
    for (const id of liveLeavesRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
  }, [tabs]);

  useEffect(() => {
    const tab = tabsRef.current.find((t) => t.id === activeId);
    if (tab?.kind !== "terminal") return;
    const ptyIds = leafIds(tab.paneTree).flatMap((leafId) => {
      const ptyId = ptyIdForLeaf(leafId);
      return ptyId === null ? [] : [ptyId];
    });
    useAgentActivityStore.getState().acknowledgeAttention(ptyIds);
  }, [activeId]);

  // Most-recently-used tab ids, most recent first, pruned to live tabs. Drives
  // the Ctrl+Tab quick switcher so it cycles by recency, not strip order.
  const mruRef = useRef<number[]>([activeId]);
  useEffect(() => {
    mruRef.current = [
      activeId,
      ...mruRef.current.filter((id) => id !== activeId),
    ];
  }, [activeId]);
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id));
    mruRef.current = mruRef.current.filter((id) => live.has(id));
  }, [tabs]);

  const getSwitcherOrder = useCallback(() => {
    const space = activeSpaceId ?? DEFAULT_SPACE_ID;
    const inSpace = tabsRef.current
      .filter((t) => t.spaceId === space)
      .map((t) => t.id);
    const present = new Set(inSpace);
    const ordered = mruRef.current.filter((id) => present.has(id));
    for (const id of inSpace) if (!ordered.includes(id)) ordered.push(id);
    return [activeId, ...ordered.filter((id) => id !== activeId)];
  }, [activeId, activeSpaceId]);

  const { state: switcherState, step: stepSwitcher } = useTabSwitcher({
    getOrder: getSwitcherOrder,
    onCommit: (id) => {
      if (tabsRef.current.some((t) => t.id === id)) setActiveId(id);
    },
  });

  const captureActiveSelection = useCallback((): string | null => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t) return null;
    if (t.kind === "terminal") {
      const lid = t.activeLeafId;
      return terminalRefs.current.get(lid)?.getSelection() ?? null;
    }
    if (t.kind === "editor") {
      return editorRefs.current.get(activeId)?.getSelection() ?? null;
    }
    if (t.kind === "markdown") {
      // Rendered markdown preview is plain selectable HTML.
      const sel = window.getSelection();
      return sel && !sel.isCollapsed ? sel.toString() : null;
    }
    // A diff is a CodeMirror too, so a selection in it is worth just as much to
    // the agent. `sendSelectionToClaude` has always known how to resolve a git
    // tab's path; this is the half that was missing.
    if (t.kind === "git-diff" || t.kind === "git-commit-file") {
      return gitDiffRefs.current.get(activeId)?.getSelection() ?? null;
    }
    return null;
  }, [tabs, activeId]);

  // Pick the terminal leaf to receive a selection. With several Claude Code
  // panes open, the right one is whichever runs in the directory that contains
  // the file — the deepest matching cwd wins, so a nested repo beats its parent.
  const findClaudeLeaf = useCallback(
    (filePath?: string | null): number | null => {
      const { agents } = useAgentActivityStore.getState();
      const isAgentLeaf = (leafId: number) => {
        const ptyId = ptyIdForLeaf(leafId);
        return ptyId !== null && !!agents[ptyId];
      };

      const norm = (p: string) =>
        p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

      // Only the command line the user is looking at. Searching every tab
      // meant "send to agent" could land in a pane on the other side of the
      // app, out of sight, and the old fallback to the active terminal sent
      // the text to a plain shell that would try to RUN it.
      const ownerTab = tabsRef.current.find(
        (t) => t.kind === "terminal" && t.id === currentOwnerTabId,
      );
      const agentLeaves: number[] = [];
      if (ownerTab?.kind === "terminal") {
        for (const leafId of leafIds(ownerTab.paneTree)) {
          if (isAgentLeaf(leafId)) agentLeaves.push(leafId);
        }
      }

      if (agentLeaves.length === 0) return null;
      if (agentLeaves.length === 1) return agentLeaves[0];

      // Several agents: match on cwd containing the file.
      if (filePath) {
        const file = norm(filePath);
        let best: { leafId: number; depth: number } | null = null;
        for (const leafId of agentLeaves) {
          const cwd = leafCwd(leafId);
          if (!cwd) continue;
          const root = norm(cwd);
          if (file === root || file.startsWith(`${root}/`)) {
            const depth = root.split("/").length;
            if (!best || depth > best.depth) best = { leafId, depth };
          }
        }
        if (best) return best.leafId;
      }

      // No cwd match — prefer the pane the user is already in.
      if (activeLeafId !== null && agentLeaves.includes(activeLeafId)) {
        return activeLeafId;
      }
      return agentLeaves[0];
    },
    [activeLeafId, currentOwnerTabId],
  );

  /**
   * Hand a whole file to the agent running in this command line, as an `@`
   * mention: that is the reference syntax both Claude Code and opencode
   * expand into an actual attachment. A bare path was only text the model had
   * to notice and then spend a Read call on.
   *
   * `@` resolves against the pane's cwd, so the path is made relative to it;
   * a file outside that root has no `@` form and falls back to the absolute
   * path, which the agent can still read.
   */
  const handleAttachFileToAgent = useCallback(
    (path: string) => {
      const leafId = findClaudeLeaf(path);
      if (leafId === null) {
        toast.error("请先打开 agent", {
          description:
            "在当前命令行里启动 Claude Code、Codex 或 OpenCode 后再发送。",
        });
        return;
      }
      if (pasteToLeaf(leafId, `${agentFileRef(path, leafCwd(leafId))} `)) {
        const tab = tabsRef.current.find(
          (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
        );
        if (tab) {
          setActiveId(tab.id);
          focusPane(tab.id, leafId);
        }
      } else {
        toast.error("该 agent 所在的命令行已关闭");
      }
    },
    [findClaudeLeaf, setActiveId, focusPane],
  );

  /** Hand arbitrary text to the agent in this command line, for callers that
   *  build their own payload (the commit panel's "write me a message"). */
  const sendTextToAgent = useCallback(
    (text: string): boolean => {
      const leafId = findClaudeLeaf(null);
      if (leafId === null) {
        toast.error("请先打开 agent", {
          description: "在当前命令行里启动 Claude Code 或 opencode 后再发送。",
        });
        return false;
      }
      if (!pasteToLeaf(leafId, text)) {
        toast.error("该 agent 所在的命令行已关闭");
        return false;
      }
      const tab = tabsRef.current.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (tab) {
        setActiveId(tab.id);
        focusPane(tab.id, leafId);
      }
      return true;
    },
    [findClaudeLeaf, setActiveId, focusPane],
  );

  const sendSelectionToClaude = useCallback(
    (targetLeafId?: number) => {
      const selection = captureActiveSelection();
      if (!selection?.trim()) return;

      // Resolve the source file first — it both labels the block and decides
      // which Claude Code pane receives it. Git tabs carry a repo-relative path,
      // so join them onto their repo root to get something absolute.
      let filePath: string | null = null;
      if (activeTab?.kind === "editor" || activeTab?.kind === "markdown") {
        filePath = activeTab.path;
      } else if (
        activeTab?.kind === "git-diff" ||
        activeTab?.kind === "git-commit-file"
      ) {
        filePath = /^([A-Za-z]:|\/|\\)/.test(activeTab.path)
          ? activeTab.path
          : `${activeTab.repoRoot.replace(/[\\/]+$/, "")}/${activeTab.path.replace(/^[\\/]+/, "")}`;
      }

      // An explicit multi-agent target wins; otherwise pick the best pane.
      const leafId = targetLeafId ?? findClaudeLeaf(filePath);
      if (leafId === null) {
        toast.error("请先打开 agent", {
          description: "在当前命令行里启动 Claude Code 或 opencode 后再发送。",
        });
        return;
      }

      // Label the block with its file and line range so the agent can locate it.
      // Pasted without a trailing CR so the user can add a question first.
      let location = filePath;
      if (
        location &&
        (activeTab?.kind === "editor" || activeTab?.kind === "markdown")
      ) {
        const range = editorRefs.current.get(activeId)?.getSelectionRange?.();
        if (range) {
          location +=
            range.startLine === range.endLine
              ? `:${range.startLine}`
              : `:${range.startLine}-${range.endLine}`;
        }
      }

      const header = location ? `${location}\n` : "";
      const body = `${header}\`\`\`\n${selection.trimEnd()}\n\`\`\`\n`;

      if (pasteToLeaf(leafId, body)) {
        const tab = tabsRef.current.find(
          (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
        );
        if (tab) {
          setActiveId(tab.id);
          focusPane(tab.id, leafId);
        }
        toast.success("已发送到 agent，补充问题后回车");
      } else {
        toast.error("该 agent 所在的命令行已关闭");
      }
    },
    [
      captureActiveSelection,
      findClaudeLeaf,
      activeTab,
      activeId,
      setActiveId,
      focusPane,
    ],
  );

  const {
    popup: selectionAskPopup,
    setPopup: setSelectionAskPopup,
    send: sendSelection,
  } = useSelectionAsk({
    captureActiveSelection,
    onSend: sendSelectionToClaude,
  });

  const openNewTab = useCallback(() => {
    newTab(inheritedCwdForNewTab());
  }, [newTab, inheritedCwdForNewTab]);

  const openNewPrivateTab = useCallback(() => {
    newPrivateTab(inheritedCwdForNewTab());
  }, [newPrivateTab, inheritedCwdForNewTab]);

  const openNewBlockTab = useCallback(() => {
    newBlockTab(inheritedCwdForNewTab());
  }, [newBlockTab, inheritedCwdForNewTab]);

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setActiveId(tabId);
    },
    [newTab, setActiveId],
  );

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      // Explorer clicks keep separate windows; capacity eviction is handled by WindowBar.
      if (isMarkdownPath(path))
        newMarkdownTab(path, currentOwnerTabId ?? undefined);
      else
        openFileTab(path, pin ?? true, {
          ownerTabId: currentOwnerTabId ?? undefined,
        });
    },
    [openFileTab, newMarkdownTab, currentOwnerTabId],
  );

  const openLaunchFiles = useCallback(
    (paths: string[]) => {
      for (const path of paths) handleOpenFile(path, true);
    },
    [handleOpenFile],
  );

  useLaunchFiles(booted, openLaunchFiles);

  // Cold start: `--run` opens one terminal tab in the launch dir and types the
  // command. Gated on `booted` for the same reason as launch files above, and
  // drained once so a dev-mode remount can't run the command twice.
  useEffect(() => {
    if (!booted) return;
    void (async () => {
      const command = await consumeLaunchCommand();
      if (!command) return;
      const { leafId } = newCommandTab(getLaunchDir());
      await whenSessionReady(leafId);
      if (!writeToSession(leafId, `${command}\r`)) {
        console.error(
          "[awei-work] launch terminal closed before --run could start",
        );
      }
    })();
  }, [booted, newCommandTab]);

  const handlePathRenamed = useCallback(
    (from: string, to: string, workspace: WorkspaceEnv) => {
      const previous = from.replace(/\\/g, "/").replace(/\/+$/, "");
      const next = to.replace(/\\/g, "/").replace(/\/+$/, "");
      const scope = workspaceScopeKey(workspace);
      const spaceIds = new Set(
        useSpaces
          .getState()
          .spaces.filter((space) => workspaceScopeKey(space.env) === scope)
          .map((space) => space.id),
      );
      for (const t of tabsRef.current) {
        if (!spaceIds.has(t.spaceId)) continue;
        if (t.kind !== "editor" && t.kind !== "markdown") continue;
        const current = t.path.replace(/\\/g, "/");
        const currentKey =
          workspace.kind === "local" ? current.toLowerCase() : current;
        const previousKey =
          workspace.kind === "local" ? previous.toLowerCase() : previous;
        if (currentKey === previousKey) {
          const i = next.lastIndexOf("/");
          updateTab(t.id, {
            path: next,
            title: i === -1 ? next : next.slice(i + 1),
          });
        } else if (currentKey.startsWith(`${previousKey}/`)) {
          const suffix = current.slice(previous.length);
          const newPath = `${next}${suffix}`;
          const i = newPath.lastIndexOf("/");
          updateTab(t.id, {
            path: newPath,
            title: i === -1 ? newPath : newPath.slice(i + 1),
          });
        }
      }
    },
    [updateTab],
  );

  // The cwd of the command line the side panels follow; falls back to the
  // active terminal leaf's cwd for the leaf-level detail (e.g. split panes).
  const activeTerminalLeafCwd =
    activeTab?.kind === "terminal"
      ? (findLeafCwd(activeTab.paneTree, activeTab.activeLeafId) ??
        activeTab.cwd ??
        null)
      : null;

  const {
    activePath: explorerActiveFilePath,
    openPaths: explorerOpenFilePaths,
  } = useMemo(
    () =>
      explorerFileState(
        tabs,
        sourceControlSpaceId,
        currentOwnerTabId,
        activeId,
      ),
    [tabs, sourceControlSpaceId, currentOwnerTabId, activeId],
  );
  const isRepositoryContextCurrent = useCallback(
    (spaceId: string, workspaceKey: string) => {
      const currentSpaceId = useSpaces.getState().activeId ?? DEFAULT_SPACE_ID;
      const currentWorkspaceKey = workspaceScopeKey(
        useWorkspaceEnvStore.getState().env,
      );
      return spaceId === currentSpaceId && workspaceKey === currentWorkspaceKey;
    },
    [],
  );
  const openSourceControl = useCallback(() => {
    openSidebarView("source-control");
  }, [openSidebarView]);
  const [remoteManagerOpen, setRemoteManagerOpen] = useState(false);
  const [cloneRepositoryOpen, setCloneRepositoryOpen] = useState(false);
  // File-history dialog target; null keeps the dialog closed.
  const [fileHistory, setFileHistory] = useState<{
    repoRoot: string;
    path: string;
  } | null>(null);
  const {
    repositoryTarget: sourceControlRepositoryTarget,
    openInSourceControl: handleOpenRepositoryInSourceControl,
    openGitHistory: handleOpenGitHistoryForPath,
    followActiveContext: handleFollowRepositoryContext,
  } = useRepositoryTargeting({
    spaceId: sourceControlSpaceId,
    workspaceKey: workspaceScopeKey(workspaceEnv),
    isContextCurrent: isRepositoryContextCurrent,
    openSourceControl,
    openCommitHistoryTab,
  });
  const handleOpenFileHistory = useCallback(async (path: string) => {
    const repo = await native.gitResolveRepo(path).catch(() => null);
    if (!repo) {
      toast.info("No Git repository contains this file.");
      return;
    }
    const relative = path
      .slice(repo.repoRoot.length)
      .replace(/^[\\/]+/, "")
      .replace(/\\/g, "/");
    setFileHistory({ repoRoot: repo.repoRoot, path: relative });
  }, []);
  const {
    sourceControl,
    multiRepo,
    toggleSourceControl,
    openGitGraphFromContext,
  } = useSourceControlContext({
    activeTab,
    tabs,
    activeTerminalLeafCwd: currentOwnerTab?.cwd ?? null,
    explorerRoot,
    launchCwd,
    launchCwdResolved,
    home,
    sidebarView,
    repositoryTarget: sourceControlRepositoryTarget,
    cycleSidebarView,
    openCommitHistoryTab,
  });
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );
  const agentKeyPassthrough = usePreferencesStore((s) => s.agentKeyPassthrough);
  // Switch which repo an open history tab shows without opening a new tab; the
  // pane reloads off the changed repoRoot and the title follows the branch.
  const handleSwitchHistoryRepo = useCallback(
    (tabId: number, repoRoot: string, branch: string | null) => {
      updateTab(tabId, {
        repoRoot,
        title: branch ? `History · ${branch}` : "Git History",
      });
    },
    [updateTab],
  );
  // Decorations take every repo's snapshot: each file is colored by whichever
  // repo contains it. The active repo's snapshot already rides inside
  // repoStatusEntries when multi-repo; the merge only matters for the
  // single-repo case where the scan found nothing but the context resolved one.
  const explorerGitStatuses = useMemo(() => {
    const entries = multiRepo.repoStatusEntries.map((e) => e.status);
    const active = sourceControl.status;
    if (!active || entries.some((s) => s.repoRoot === active.repoRoot)) {
      return entries;
    }
    return [active, ...entries];
  }, [multiRepo.repoStatusEntries, sourceControl.status]);

  const openPreviewTab = useCallback(
    (url: string) => {
      const id = newPreviewTab(url);
      // Focus the address bar if the URL is empty so the user can type.
      if (!url) {
        setTimeout(() => previewRefs.current.get(id)?.focusAddressBar(), 0);
      }
      return id;
    },
    [newPreviewTab],
  );

  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (t?.kind !== "terminal") return;
      splitActivePane(activeId, dir);
    },
    [activeId, splitActivePane],
  );

  const livePaneBounds = useCallback((tabId: number): PaneBounds[] => {
    const tab = document.querySelector<HTMLElement>(
      `[data-terminal-tab="${tabId}"]`,
    );
    if (!tab) return [];
    return [...tab.querySelectorAll<HTMLElement>("[data-pane-leaf]")].flatMap(
      (element) => {
        const id = Number(element.dataset.paneLeaf);
        if (!Number.isFinite(id)) return [];
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return [{ id, left, right, top, bottom }];
      },
    );
  }, []);

  const swapActivePane = useCallback(
    (direction: "left" | "right" | "up" | "down") => {
      swapActivePaneInDirection(activeId, direction, livePaneBounds(activeId));
    },
    [activeId, livePaneBounds, swapActivePaneInDirection],
  );

  const handleCloseTabOrPane = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal" && leafIds(t.paneTree).length > 1) {
      closeActivePane(activeId);
      return;
    }
    void handleClose(activeId);
  }, [activeId, closeActivePane, handleClose]);

  const [zenMode, setZenMode] = useState(false);

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "commandPalette.open": () => openCommandPalette("commands"),
      "commandPalette.content": () => openCommandPalette("content"),
      "tab.new": openNewTab,
      "tab.newBlock": openNewBlockTab,
      "tab.newPrivate": openNewPrivateTab,
      "tab.newPreview": () => openPreviewTab(""),
      "tab.newEditor": () => setNewEditorOpen(true),
      "tab.close": handleCloseTabOrPane,
      "tab.next": () => stepSwitcher(1),
      "tab.prev": () => stepSwitcher(-1),
      "tab.selectByIndex": (e) =>
        selectByIndex(
          parseInt(e.key, 10) - 1,
          activeSpaceId ?? DEFAULT_SPACE_ID,
        ),
      "pane.splitRight": () => splitActivePaneInActiveTab("row"),
      "pane.splitDown": () => splitActivePaneInActiveTab("col"),
      "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
      "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
      "pane.swapLeft": () => swapActivePane("left"),
      "pane.swapRight": () => swapActivePane("right"),
      "pane.swapUp": () => swapActivePane("up"),
      "pane.swapDown": () => swapActivePane("down"),
      "pane.source": toggleSourceControl,
      "terminal.clear": () => {
        clearFocusedTerminal();
      },
      "terminal.toggleInput": () =>
        window.dispatchEvent(new CustomEvent(TOGGLE_BLOCK_INPUT_EVENT)),
      "blocks.prev": () => navigateFocusedBlocks(-1),
      "blocks.next": () => navigateFocusedBlocks(1),
      "search.focus": () => {
        const kind = activeTab?.kind;
        if (kind === "editor") {
          editorRefs.current.get(activeId)?.openSearch();
        } else if (kind === "markdown") {
          markdownRefs.current.get(activeId)?.openSearch();
        } else if (kind === "terminal" && activeLeafId !== null) {
          terminalRefs.current.get(activeLeafId)?.openSearch();
        } else if (kind === "git-diff" || kind === "git-commit-file") {
          gitDiffRefs.current.get(activeId)?.openSearch();
        } else if (kind === "git-history") {
          gitHistoryRefs.current.get(activeId)?.openSearch();
        } else if (kind === "preview") {
          previewRefs.current.get(activeId)?.focusFrame();
        }
      },
      "selection.sendToAgent": () => sendSelectionToClaude(),
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "explorer.focus": toggleExplorerFocus,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "view.zenMode": () => setZenMode((v) => !v),
      "editor.undo": () => editorRefs.current.get(activeId)?.undo(),
      "editor.redo": () => editorRefs.current.get(activeId)?.redo(),
    }),
    [
      activeId,
      activeTab,
      activeLeafId,
      openCommandPalette,
      stepSwitcher,
      handleCloseTabOrPane,
      openNewTab,
      openNewBlockTab,
      openNewPrivateTab,
      openPreviewTab,
      activeSpaceId,
      selectByIndex,
      splitActivePaneInActiveTab,
      focusNextPaneInTab,
      swapActivePane,
      toggleSourceControl,
      sendSelectionToClaude,
      toggleSidebar,
      toggleExplorerFocus,
      zoomIn,
      zoomOut,
      zoomReset,
    ],
  );

  /**
   * Shortcuts handed to a focused agent instead of being acted on here. Kept
   * explicit: releasing everything would leave no way to open a new tab or the
   * command palette while an agent is running, and releasing nothing is the
   * behaviour being fixed. Ctrl+P and Ctrl+T are the ones opencode and Claude
   * Code bind; their Shift variants go with them so the pair behaves alike.
   */
  const AGENT_OWNED_SHORTCUTS: ReadonlySet<ShortcutId> = useMemo(
    () =>
      new Set<ShortcutId>([
        "commandPalette.open",
        "commandPalette.content",
        "tab.new",
        "tab.newBlock",
      ]),
    [],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      // A running agent binds these itself, and the global handler captures on
      // window and calls preventDefault, so they never reached it: pressing
      // Ctrl+P inside opencode opened awei-work's command palette instead. Giving
      // them up is scoped as tightly as possible - the key must be one the
      // agents actually use, the focus must be inside a terminal, and that
      // pane must have an agent running right now (OSC detection, not "is this
      // an alt screen": a pager is alt-screen too and wants none of these).
      if (agentKeyPassthrough && AGENT_OWNED_SHORTCUTS.has(id)) {
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        if ((target as HTMLElement | null)?.closest?.(".xterm")) {
          const leafId = activeTerminalTab?.activeLeafId ?? null;
          const ptyId = leafId === null ? null : ptyIdForLeaf(leafId);
          const { agents } = useAgentActivityStore.getState();
          if (ptyId !== null && agents[ptyId]) return true;
        }
      }
      const terminalPaneCount =
        activeTab?.kind === "terminal"
          ? leafIds(activeTab.paneTree).length
          : null;
      if (shouldDisablePaneSwapShortcut(id, terminalPaneCount)) return true;
      if (id === "editor.undo" || id === "editor.redo") {
        return activeTab?.kind !== "editor";
      }
      if (id === "selection.sendToAgent") {
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        if (!inTerminal) return false;
        const sel = captureActiveSelection();
        return !sel?.trim();
      }
      if (id === "terminal.clear") {
        // Only intercept ⌘K while a terminal is focused; elsewhere let the key
        // fall through (we never preventDefault when disabled).
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        return !(target as HTMLElement | null)?.closest?.(".xterm");
      }
      if (
        id === "terminal.toggleInput" ||
        id === "blocks.prev" ||
        id === "blocks.next"
      ) {
        return !(activeTab?.kind === "terminal" && activeTab.blocks === true);
      }
      if (id === "sidebar.toggle") {
        // Ctrl+B is also Claude Code's "run in background" key. While a terminal
        // is focused, let Ctrl+B reach the shell/Claude instead of toggling the
        // sidebar. Ctrl+Shift+B (second binding) still toggles it from anywhere.
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        // Only defer the plain (no-shift) Ctrl/⌘+B binding; the Shift variant
        // is the always-on toggle and is never claimed by the terminal.
        return inTerminal && !e.shiftKey;
      }
      return false;
    },
    [
      agentKeyPassthrough,
      AGENT_OWNED_SHORTCUTS,
      activeTerminalTab,
      activeTab,
      captureActiveSelection,
    ],
  );

  useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });

  const registerTerminalHandle = useCallback(
    (leafId: number, h: TerminalPaneHandle | null) => {
      if (h) terminalRefs.current.set(leafId, h);
      else terminalRefs.current.delete(leafId);
    },
    [],
  );

  const registerEditorHandle = useCallback(
    (id: number, h: EditorPaneHandle | null) => {
      if (h) {
        editorRefs.current.set(id, h);
        const pending = pendingEditorNavigation.current.get(id);
        if (pending != null) {
          pendingEditorNavigation.current.delete(id);
          if (pending.line === undefined) h.focus();
          else h.gotoLine(pending.line, { focus: pending.focus });
        }
      } else {
        editorRefs.current.delete(id);
      }
    },
    [],
  );

  const registerPreviewHandle = useCallback(
    (id: number, h: PreviewPaneHandle | null) => {
      if (h) previewRefs.current.set(id, h);
      else previewRefs.current.delete(id);
    },
    [],
  );

  const registerMarkdownHandle = useCallback(
    (id: number, h: MarkdownPreviewPaneHandle | null) => {
      if (h) markdownRefs.current.set(id, h);
      else markdownRefs.current.delete(id);
    },
    [],
  );

  const registerGitDiffHandle = useCallback(
    (id: number, h: GitDiffPaneHandle | null) => {
      if (h) gitDiffRefs.current.set(id, h);
      else gitDiffRefs.current.delete(id);
    },
    [],
  );

  const registerGitHistoryHandle = useCallback(
    (id: number, h: GitHistoryPaneHandle | null) => {
      if (h) gitHistoryRefs.current.set(id, h);
      else gitHistoryRefs.current.delete(id);
    },
    [],
  );

  const handlePreviewUrl = useCallback(
    (id: number, url: string) => updateTab(id, { url }),
    [updateTab],
  );

  const authorizedCwds = useRef(new Set<string>());
  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string) => {
      setLeafCwd(leafId, cwd);
      const workspace = leafWorkspace(leafId);
      if (!workspace || !cwd) return;
      const key = `${workspaceScopeKey(workspace)}\0${cwd}`;
      if (!authorizedCwds.current.has(key)) {
        if (authorizedCwds.current.size >= 512) authorizedCwds.current.clear();
        authorizedCwds.current.add(key);
        native.workspaceAuthorize(cwd, workspace).catch(() => {
          authorizedCwds.current.delete(key);
        });
      }
    },
    [setLeafCwd],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      const all = tabsRef.current;
      const tab = all.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (tab?.kind !== "terminal") return;
      // Last pane of the last tab: quit instead of respawning a shell.
      if (leafIds(tab.paneTree).length === 1 && all.length === 1) {
        void getCurrentWindow().close();
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf],
  );

  const handleEditorDirty = useCallback(
    (id: number, dirty: boolean) => updateTab(id, { dirty }),
    [updateTab],
  );

  const handleRenameTab = useCallback(
    (id: number, title: string) => updateTab(id, { customTitle: title.trim() }),
    [updateTab],
  );

  // The command line's cwd — follows the active file's owner, not just the
  // active terminal tab, so the status bar / new groups stay in context.
  const activeCwd =
    activeTerminalLeafCwd ?? currentOwnerTab?.cwd ?? explorerRoot;

  // ── Group (space) management ────────────────────────────────────────
  const handleCreateGroup = useCallback(
    (name: string) => {
      const { create, setActive } = useSpaces.getState();
      const meta = create({
        name,
        root: activeCwd ?? home ?? null,
        env: workspaceEnv,
      });
      setActiveSpaceForNewTabs(meta.id);
      newTab(activeCwd ?? undefined);
      setActive(meta.id);
    },
    [activeCwd, home, workspaceEnv, newTab, setActiveSpaceForNewTabs],
  );

  const handleRenameGroup = useCallback((id: string, name: string) => {
    useSpaces.getState().rename(id, name);
  }, []);

  const handleDeleteGroup = useCallback(
    (id: string) => {
      const spaces = useSpaces.getState().spaces;
      if (spaces.length <= 1 || !spaces.some((space) => space.id === id))
        return;
      const nextSpaceId = useSpaces.getState().remove(id);
      if (!nextSpaceId) return;
      const root = useSpaces
        .getState()
        .spaces.find((s) => s.id === nextSpaceId)?.root;
      removeTabsForSpace(id, nextSpaceId, root ?? undefined);
    },
    [removeTabsForSpace],
  );

  const {
    pendingGroupDelete,
    requestGroupDelete,
    cancelGroupDelete,
    confirmGroupDelete,
  } = useGroupDeleteGuard(tabsRef, handleDeleteGroup);

  // Clicking a side-panel button or a group tab leaves keyboard focus on that
  // control, so the arrow keys then drive the button row instead of the
  // terminal or the editor. Hand focus back to whatever the main view is.
  const focusMainView = useCallback(() => {
    // Deferred: the same click also changes the active tab, and the target
    // pane may not be mounted until after that render lands.
    setTimeout(() => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
      if (!tab) return;
      if (tab.kind === "terminal") {
        terminalRefs.current.get(tab.activeLeafId)?.focus();
        return;
      }
      editorRefs.current.get(tab.id)?.focus();
    }, 0);
  }, []);

  const handleMoveProject = useCallback(
    (id: number, spaceId: string, beforeId: number | null) => {
      const current = tabsRef.current.find((tab) => tab.id === id);
      if (current?.kind !== "terminal") return;
      const state = useSpaces.getState();
      const source = state.spaces.find((space) => space.id === current.spaceId);
      const target = state.spaces.find((space) => space.id === spaceId);
      if (!source || !target) return;
      if (workspaceScopeKey(source.env) !== workspaceScopeKey(target.env)) {
        toast.error("不能在不同运行环境之间移动项目", {
          description: "本机与 WSL、不同 WSL 发行版的终端不能直接迁移。",
        });
        return;
      }
      const active = tabsRef.current.find((tab) => tab.id === activeId);
      moveProject(id, spaceId, beforeId);
      if (
        active?.id === id ||
        (active?.ownerTabId === id && active.spaceId === source.id)
      ) {
        state.setActive(spaceId);
        setActiveSpaceForNewTabs(spaceId);
      }
    },
    [activeId, moveProject, setActiveSpaceForNewTabs],
  );

  const handleSelectProject = useCallback(
    (project: TerminalTab) => {
      const current = tabsRef.current.find(
        (tab) => tab.id === project.id && tab.spaceId === project.spaceId,
      );
      if (current?.kind !== "terminal") return;
      useSpaces.getState().setActive(current.spaceId);
      setActiveSpaceForNewTabs(current.spaceId);
      setActiveId(current.id);
      focusMainView();
    },
    [setActiveId, setActiveSpaceForNewTabs, focusMainView],
  );

  const spacesList = useSpaces((s) => s.spaces);
  useEditorFileSync({
    tabs,
    spaces: spacesList,
    tabsRef,
    editorRefs,
    markdownRefs,
  });

  const commandPaletteItems = useMemo(
    () =>
      commandPaletteOpen
        ? createCommandItems({
            tabs,
            activeId,
            searchRoot: explorerRoot,
            explorerRoot,
            home,
            openNewTab,
            openNewBlock: openNewBlockTab,
            openNewPrivate: openNewPrivateTab,
            openNewEditor: () => setNewEditorOpen(true),
            openNewPreview: () => openPreviewTab(""),
            openGitGraph: openGitGraphFromContext,
            toggleSourceControl,
            closeActiveTabOrPane: handleCloseTabOrPane,
            splitPaneRight: () => splitActivePaneInActiveTab("row"),
            splitPaneDown: () => splitActivePaneInActiveTab("col"),
            focusSearch: () => explorerRef.current?.focusSearch(),
            focusExplorerSearch: () => explorerRef.current?.focusSearch(),
            toggleSidebar,
            openSettings: () => void openSettingsWindow(),
            openKeyboardShortcuts: () => void openSettingsWindow("shortcuts"),
          })
        : [],
    [
      commandPaletteOpen,
      tabs,
      activeId,
      explorerRoot,
      home,
      openNewTab,
      openNewBlockTab,
      openNewPrivateTab,
      openPreviewTab,
      openGitGraphFromContext,
      toggleSourceControl,
      handleCloseTabOrPane,
      splitActivePaneInActiveTab,
      toggleSidebar,
    ],
  );

  const pendingEditorNavigation = useRef<
    Map<number, { line?: number; focus: boolean }>
  >(new Map());
  const openContentHit = useCallback(
    (path: string, line: number) => {
      const id = openFileTab(path, true, {
        ownerTabId: currentOwnerTabId ?? undefined,
      });
      if (id == null) return;
      const h = editorRefs.current.get(id);
      if (h) h.gotoLine(line);
      else pendingEditorNavigation.current.set(id, { line, focus: true });
    },
    [openFileTab, currentOwnerTabId],
  );

  useEffect(() => {
    setLspNavigator({ openFile: openContentHit });
    return () => setLspNavigator(null);
  }, [openContentHit]);

  /** Runs a command in the terminal on screen. Resuming a past conversation is
   *  a command the user picked, so it is submitted rather than just inserted. */
  const runInActiveTerminal = useMemo(
    () =>
      isTerminalTab && activeLeafId !== null
        ? (cmd: string) => {
            submitToLeaf(activeLeafId, cmd);
            terminalRefs.current.get(activeLeafId)?.focus();
          }
        : null,
    [isTerminalTab, activeLeafId],
  );

  const insertHistoryCommand = useMemo(
    () =>
      isTerminalTab && activeLeafId !== null
        ? (cmd: string) => {
            writeToSession(activeLeafId, cmd);
            terminalRefs.current.get(activeLeafId)?.focus();
          }
        : null,
    [isTerminalTab, activeLeafId],
  );

  return (
    <ThemeProvider>
      <TooltipProvider>
        <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          {!zenMode && (
            <Header
              tabs={headerTabs}
              activeId={activeId}
              activeOwnerTabId={currentOwnerTabId}
              onSelect={(id) => {
                const project = tabsRef.current.find((tab) => tab.id === id);
                if (project?.kind === "terminal") handleSelectProject(project);
              }}
              onNew={openNewTab}
              onNewBlock={openNewBlockTab}
              onNewPrivate={openNewPrivateTab}
              onNewPreview={() => openPreviewTab("")}
              onNewEditor={() => setNewEditorOpen(true)}
              onNewGitGraph={openGitGraphFromContext}
              onClose={handleClose}
              onPin={pinTab}
              onRename={handleRenameTab}
              onOverrideLanguage={setOverrideLanguage}
              headerRight={
                <SessionHistoryMenu
                  cwd={activeCwd}
                  onRun={runInActiveTerminal}
                />
              }
              groupSwitcher={
                <GroupSwitcher
                  spaces={spacesList}
                  projects={allTerminalTabs}
                  activeProjectId={currentOwnerTabId ?? activeId}
                  runningProjectIds={runningProjects}
                  onSelectProject={handleSelectProject}
                  onRenameProject={handleRenameTab}
                  onCloseProject={handleClose}
                  onMoveProject={handleMoveProject}
                  activeId={activeSpaceId}
                  onCreate={handleCreateGroup}
                  onRename={handleRenameGroup}
                  onDelete={(id) => void requestGroupDelete(id)}
                />
              }
              headerTabs={
                <HeaderTabs
                  active={sidebarOpen ? sidebarView : null}
                  sourceControlChanged={
                    multiRepo.repos.length > 0
                      ? multiRepo.aggregatedChanges
                      : sourceControl.changedCount
                  }
                  onSelect={(id) => {
                    focusMainView();
                    if (sidebarView === id && sidebarOpen) {
                      sidebarRef.current?.collapse();
                    } else {
                      persistSidebarView(id as SidebarViewId);
                      if (!sidebarOpen) {
                        sidebarRef.current?.resize(
                          `${sidebarWidthRef.current}px`,
                        );
                      }
                      if (id === "source-control") {
                        void multiRepo.scanRepos().then(() => {
                          sourceControl.refresh({ remote: "always" });
                        });
                      }
                    }
                  }}
                />
              }
            />
          )}

          <main className="zoom-content flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1"
              onLayoutChanged={(_, { isUserInteraction }) => {
                const width = sidebarRef.current?.getSize().inPixels ?? 0;
                persistSidebarWidth(width, isUserInteraction);
              }}
            >
              <ResizablePanel
                id="sidebar"
                panelRef={sidebarRef}
                defaultSize={
                  initialSidebarCollapsed
                    ? "0px"
                    : `${sidebarWidthRef.current}px`
                }
                minSize={`${SIDEBAR_MIN_WIDTH}px`}
                maxSize={`${SIDEBAR_MAX_WIDTH}px`}
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  persistSidebarCollapsed(size.inPixels <= 0);
                }}
              >
                <div className="flex h-full min-h-0 flex-col border-r border-border/60 bg-card">
                  <div
                    key={sidebarView}
                    className="min-h-0 flex-1 terax-panel-in"
                  >
                    {sidebarView === "explorer" ? (
                      <FileExplorer
                        ref={explorerRef}
                        rootPath={explorerRoot}
                        gitStatuses={
                          explorerGitDecorations ? explorerGitStatuses : null
                        }
                        activeFilePath={explorerActiveFilePath}
                        openFilePaths={explorerOpenFilePaths}
                        onOpenFile={handleOpenFile}
                        onOpenSearchHit={openContentHit}
                        onPathRenamed={handlePathRenamed}
                        onPathDeleted={handlePathDeleted}
                        onRevealInTerminal={cdInNewTab}
                        onOpenInSourceControl={
                          handleOpenRepositoryInSourceControl
                        }
                        onOpenGitHistory={handleOpenGitHistoryForPath}
                        onOpenFileHistory={handleOpenFileHistory}
                        onAttachToAgent={handleAttachFileToAgent}
                        pathDropTarget={terminalPathDropTarget}
                      />
                    ) : (
                      <SourceControlPanel
                        open={sidebarOpen}
                        sourceControl={sourceControl}
                        onSendToAgent={sendTextToAgent}
                        repos={multiRepo.repos}
                        repoStatusEntries={multiRepo.repoStatusEntries}
                        applyRepoStatus={multiRepo.applyRepoStatus}
                        refreshRepoStatus={multiRepo.refreshRepoStatus}
                        refreshAllRepoStatuses={
                          multiRepo.refreshAllRepoStatuses
                        }
                        syncProgress={multiRepo.syncProgress}
                        onDismissSyncProgress={multiRepo.clearSyncProgress}
                        buildPushPlan={multiRepo.buildPushPlan}
                        pushAllAdvanced={multiRepo.pushAllAdvanced}
                        onManageRemotes={() => setRemoteManagerOpen(true)}
                        onCloneRepository={() => setCloneRepositoryOpen(true)}
                        onOpenDiff={openGitDiffTab}
                        onOpenGitGraph={openGitGraphFromContext}
                        onOpenFile={handleOpenFile}
                        onNavigateToPath={cdInNewTab}
                        repositoryTarget={sourceControlRepositoryTarget}
                        onFollowRepositoryContext={
                          handleFollowRepositoryContext
                        }
                        headerExtra={
                          <RepoBranchSelector
                            repos={multiRepo.repos}
                            activeRepo={multiRepo.activeRepo}
                            activeBranch={
                              multiRepo.summary.status?.branch ?? null
                            }
                            onChangeRepo={multiRepo.setActiveRepo}
                            onRescan={multiRepo.scanRepos}
                            onCheckedOut={() =>
                              void multiRepo.summary.refresh({
                                remote: "never",
                                force: true,
                              })
                            }
                            onOpenPath={cdInNewTab}
                          />
                        }
                      />
                    )}
                  </div>
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="workspace" defaultSize="78%" minSize="30%">
                <div className="flex h-full min-h-0 flex-col">
                  <div className="relative min-h-0 flex-1">
                    <WorkspaceSurface
                      spaces={spacesList}
                      tabs={tabs}
                      activeId={activeId}
                      activeTab={activeTab}
                      registerTerminalHandle={registerTerminalHandle}
                      onCwd={handleTerminalCwd}
                      onExit={handleLeafExit}
                      onFocusLeaf={handleFocusLeaf}
                      registerEditorHandle={registerEditorHandle}
                      onEditorDirtyChange={handleEditorDirty}
                      onEditorCloseTab={disposeTab}
                      registerPreviewHandle={registerPreviewHandle}
                      onPreviewUrlChange={handlePreviewUrl}
                      registerMarkdownHandle={registerMarkdownHandle}
                      registerGitDiffHandle={registerGitDiffHandle}
                      onAttachToAgent={handleAttachFileToAgent}
                      registerGitHistoryHandle={registerGitHistoryHandle}
                      onOpenCommitFile={openCommitFileDiffTab}
                      gitHistoryRepos={multiRepo.repos}
                      onSwitchGitHistoryRepo={handleSwitchHistoryRepo}
                      onSetMarkdownView={setMarkdownView}
                      onOpenMarkdownPath={handleOpenFile}
                    />
                  </div>

                  <WorkspaceInputBar
                    isBlockTab={isBlockTab}
                    isTerminalTab={isTerminalTab}
                    activeLeafId={activeLeafId}
                    cwd={activeCwd}
                    home={home}
                  />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>

          {!zenMode && (
            <StatusBar
              windowBar={
                <WindowBar
                  key={`${sourceControlSpaceId}:${currentOwnerTabId ?? "unowned"}`}
                  tabs={tabs}
                  spaceId={sourceControlSpaceId}
                  project={currentOwnerTab}
                  activeId={activeId}
                  onSelect={(id) => {
                    const scope = windowScopeRef.current;
                    const target = tabsRef.current.find((tab) => tab.id === id);
                    if (!target || target.spaceId !== scope.spaceId) return;
                    if (
                      target.kind === "terminal"
                        ? target.id !== scope.ownerId
                        : (target.ownerTabId ?? null) !== scope.ownerId
                    )
                      return;
                    setActiveId(id);
                    focusMainView();
                  }}
                  onClose={handleClose}
                  onOverflow={closeOverflowWindows}
                />
              }
              onOpenSettings={() => void openSettingsWindow()}
              activeLeafId={activeLeafId}
            />
          )}

          <Toaster position="bottom-right" />

          {selectionAskPopup && (
            <SelectionAskButton
              x={selectionAskPopup.x}
              y={selectionAskPopup.y}
              onSend={sendSelection}
              onDismiss={() => setSelectionAskPopup(null)}
            />
          )}

          {switcherState && (
            <TabSwitcherHud tabs={spaceTabs} state={switcherState} />
          )}

          <CommandPalette
            open={commandPaletteOpen}
            onOpenChange={setCommandPaletteOpen}
            initialMode={paletteInitialMode}
            commandItems={commandPaletteItems}
            workspaceRoot={explorerRoot}
            onOpenContentHit={openContentHit}
            insertCommand={insertHistoryCommand}
          />

          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => openFileTab(path)}
          />

          <RemoteManagerDialog
            open={remoteManagerOpen}
            onOpenChange={setRemoteManagerOpen}
            repoRoot={multiRepo.activeRepo}
            onAdd={multiRepo.addRemote}
            onRemove={multiRepo.removeRemote}
            onSetUrl={multiRepo.setRemoteUrl}
          />

          <CloneRepositoryDialog
            open={cloneRepositoryOpen}
            onOpenChange={setCloneRepositoryOpen}
            defaultTargetDir={explorerRoot ?? home ?? null}
            onClone={multiRepo.cloneRepository}
            onCloned={() => {
              void multiRepo.scanRepos().then(() => {
                sourceControl.refresh({ remote: "never" });
              });
            }}
          />

          <FileHistoryDialog
            open={fileHistory !== null}
            onOpenChange={(open) => {
              if (!open) setFileHistory(null);
            }}
            repoRoot={fileHistory?.repoRoot ?? ""}
            path={fileHistory?.path ?? ""}
            onOpenCommitFile={(input) => {
              setFileHistory(null);
              openCommitFileDiffTab(input);
            }}
          />

          <UpdaterDialog beforeInstall={prepareUpdate} />

          <CloseDialogs
            tabs={tabs}
            pendingGroupDelete={pendingGroupDelete}
            onCancelGroupDelete={cancelGroupDelete}
            onConfirmGroupDelete={confirmGroupDelete}
            pendingCloseTab={pendingCloseTab}
            onCancelClose={cancelClose}
            onConfirmClose={confirmClose}
            pendingTerminalCloseTab={pendingTerminalCloseTab}
            onCancelTerminalClose={cancelTerminalClose}
            onConfirmTerminalClose={confirmTerminalClose}
            pendingDeleteTabs={pendingDeleteTabs}
            onCancelDeleteClose={cancelDeleteClose}
            onConfirmDeleteClose={confirmDeleteClose}
            pendingAppClose={pendingAppClose}
            onCancelAppClose={cancelAppClose}
            onConfirmAppClose={confirmAppClose}
          />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );
}
