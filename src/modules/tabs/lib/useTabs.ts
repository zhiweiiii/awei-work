import { pathIdentity } from "@/lib/pathIdentity";
import { moveProjectTabs } from "./moveProject";
import { parkProjectTabs } from "./parkProject";
import type { AgentResume } from "@/modules/spaces/lib/projectRestore";
import { isMarkdownPath } from "@/lib/utils";
import {
  findLeafCwd,
  hasLeaf,
  leafIds,
  nextLeafId,
  type PaneBounds,
  type PaneDirection,
  type PaneNode,
  removeLeaf,
  type SplitDir,
  setLeafCwd as setLeafCwdInTree,
  siblingLeafOf,
  splitLeaf,
  swapLeafInDirection,
} from "@/modules/terminal/lib/panes";
import { disposeSession } from "@/modules/terminal/lib/useTerminalSession";
import { useCallback, useEffect, useRef, useState } from "react";

// Matches the renderer slot pool size — over this we'd evict an active leaf.
export const MAX_PANES_PER_TAB = 4;

type TabBase = {
  spaceId: string;
  /** Restored from disk, not yet activated: rendered as a placeholder, not mounted. */
  cold?: boolean;
  /** The terminal tab this file tab belongs to; drives per-terminal caps. */
  ownerTabId?: number;
};

export type TerminalTab = TabBase & {
  parked?: boolean;
  openedAt?: number;
  lastUsedAt?: number;
  lastAgentSession?: AgentResume;
  autoResume?: boolean;
  id: number;
  kind: "terminal";
  title: string;
  cwd?: string;
  paneTree: PaneNode;
  activeLeafId: number;
  blocks?: boolean;
  /** AI agent cannot read buffer / context of this terminal. */
  private?: boolean;
  /** User-set label that overrides the cwd-derived name. Survives cd. */
  customTitle?: string;
};

export type EditorTab = TabBase & {
  id: number;
  kind: "editor";
  title: string;
  path: string;
  dirty: boolean;
  /**
   * True while the tab is in the transient "preview" state — opened by a
   * single-click in the explorer and not yet pinned by the user. A preview tab
   * is replaced by the next single-click rather than accumulating.
   */
  preview: boolean;
  overrideLanguage?: string | null;
};

export type PreviewTab = TabBase & {
  id: number;
  kind: "preview";
  title: string;
  url: string;
};

export type MarkdownTab = TabBase & {
  id: number;
  kind: "markdown";
  title: string;
  path: string;
};

export type GitDiffTab = TabBase & {
  id: number;
  kind: "git-diff";
  title: string;
  path: string;
  repoRoot: string;
  mode: "-" | "+";
  originalPath: string | null;
  preview: boolean;
};

export type GitHistoryTab = TabBase & {
  id: number;
  kind: "git-history";
  title: string;
  repoRoot: string;
};

export type GitCommitFileDiffTab = TabBase & {
  id: number;
  kind: "git-commit-file";
  title: string;
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

export type Tab =
  | TerminalTab
  | EditorTab
  | PreviewTab
  | MarkdownTab
  | GitDiffTab
  | GitHistoryTab
  | GitCommitFileDiffTab;

export type TabPatch = Partial<{
  title: string;
  cwd: string;
  path: string;
  dirty: boolean;
  url: string;
  /** Empty string resets a terminal tab to its cwd-derived name. */
  customTitle: string;
  overrideLanguage: string | null;
  /** Only honored on git tab kinds (git-history). */
  repoRoot: string;
}>;

export type GitDiffOpenInput = {
  path: string;
  repoRoot: string;
  mode: "-" | "+";
  originalPath?: string | null;
  title?: string;
};

export type OpenFileTabOptions = {
  spaceId?: string;
  activate?: boolean;
  /** The terminal tab this file is opened from; drives the per-terminal cap. */
  ownerTabId?: number;
};

export function planMarkdownTabOpen(
  tabs: Tab[],
  path: string,
  spaceId: string,
  allocId: () => number,
  ownerTabId?: number,
): { tabs: Tab[]; tabId: number } {
  const pathKey = pathIdentity(path);
  // Dedupe across BOTH views: an editor (raw) tab holding the same file must
  // not spawn a second rendered tab for the same document — the rendered tab
  // is found first, then the raw editor tab, which flips that tab to
  // rendered instead.
  const existing = tabs.find(
    (tab) =>
      tab.kind === "markdown" &&
      tab.spaceId === spaceId &&
      tab.ownerTabId === ownerTabId &&
      pathIdentity(tab.path) === pathKey,
  );
  if (existing) return { tabs, tabId: existing.id };
  const rawExisting = tabs.find(
    (tab): tab is Extract<Tab, { kind: "editor" }> =>
      tab.kind === "editor" &&
      tab.spaceId === spaceId &&
      tab.ownerTabId === ownerTabId &&
      pathIdentity(tab.path) === pathKey,
  );
  if (rawExisting) {
    // An editor tab with unsaved changes must not be flipped to the rendered
    // view (the preview cannot show unsaved edits); keep the editor tab.
    if (rawExisting.dirty) return { tabs, tabId: rawExisting.id };
    const converted: MarkdownTab = {
      id: rawExisting.id,
      kind: "markdown",
      spaceId: rawExisting.spaceId,
      cold: rawExisting.cold,
      title: rawExisting.title,
      path: rawExisting.path,
      ownerTabId: rawExisting.ownerTabId,
    };
    return {
      tabs: tabs.map((tab) => (tab.id === rawExisting.id ? converted : tab)),
      tabId: rawExisting.id,
    };
  }

  const tabId = allocId();
  return {
    tabs: [
      ...tabs,
      {
        id: tabId,
        kind: "markdown",
        spaceId,
        title: basename(path),
        path,
        ...(ownerTabId !== undefined && { ownerTabId }),
      },
    ],
    tabId,
  };
}

export function planFileTabOpen(
  tabs: Tab[],
  path: string,
  pin: boolean,
  spaceId: string,
  allocId: () => number,
  ownerTabId?: number,
): { tabs: Tab[]; tabId: number } {
  if (pin) {
    const existing = tabs.find(
      (tab) =>
        tab.kind === "editor" &&
        tab.spaceId === spaceId &&
        tab.ownerTabId === ownerTabId &&
        pathIdentity(tab.path) === pathIdentity(path),
    );
    if (existing?.kind === "editor") {
      return {
        tabs: existing.preview
          ? tabs.map((tab) =>
              tab.id === existing.id ? { ...tab, preview: false } : tab,
            )
          : tabs,
        tabId: existing.id,
      };
    }

    const tabId = allocId();
    return {
      tabs: [
        ...tabs,
        {
          id: tabId,
          kind: "editor",
          spaceId,
          title: basename(path),
          path,
          dirty: false,
          preview: false,
          ...(ownerTabId !== undefined && { ownerTabId }),
        },
      ],
      tabId,
    };
  }

  const persistent = tabs.find(
    (tab) =>
      tab.kind === "editor" &&
      tab.spaceId === spaceId &&
      tab.ownerTabId === ownerTabId &&
      pathIdentity(tab.path) === pathIdentity(path) &&
      !tab.preview,
  );
  if (persistent) return { tabs, tabId: persistent.id };

  const existingPreview = tabs.find(
    (tab) =>
      tab.kind === "editor" &&
      tab.spaceId === spaceId &&
      tab.ownerTabId === ownerTabId &&
      pathIdentity(tab.path) === pathIdentity(path) &&
      tab.preview,
  );
  if (existingPreview) return { tabs, tabId: existingPreview.id };

  const previewIndex = tabs.findIndex(
    (tab) =>
      tab.kind === "editor" &&
      tab.spaceId === spaceId &&
      tab.ownerTabId === ownerTabId &&
      tab.preview &&
      !tab.dirty,
  );
  const tabId = allocId();
  const tab: EditorTab = {
    id: tabId,
    kind: "editor",
    spaceId,
    title: basename(path),
    path,
    dirty: false,
    preview: true,
    ...(ownerTabId !== undefined && { ownerTabId }),
  };
  if (previewIndex === -1) return { tabs: [...tabs, tab], tabId };

  const next = [...tabs];
  next[previewIndex] = tab;
  return { tabs: next, tabId };
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url || "preview";
  }
}

export const DEFAULT_SPACE_ID = "default";

// Returns the tab at position `idx` within the given space, or undefined when
// idx is out of range or no matching space tab exists.
export function pickTabBySpaceIndex(
  tabs: Tab[],
  idx: number,
  spaceId: string,
): Tab | undefined {
  const pool = tabs.filter((t) => t.spaceId === spaceId);
  return pool[idx];
}

// Next active after close, scoped to the closing tab's space. null = last tab of
// its space, which callers treat as "refuse to close".
export function nextActiveInSpace(
  tabs: Tab[],
  closingId: number,
): number | null {
  const closing = tabs.find((t) => t.id === closingId);
  if (!closing) return null;
  const sameSpace = tabs.filter((t) => t.spaceId === closing.spaceId);
  if (sameSpace.length <= 1) return null;
  if (closing.kind !== "terminal" && closing.ownerTabId !== undefined) {
    const siblings = sameSpace.filter(
      (tab) => tab.kind !== "terminal" && tab.ownerTabId === closing.ownerTabId,
    );
    const siblingIndex = siblings.findIndex((tab) => tab.id === closingId);
    const neighbor = siblings[siblingIndex - 1] ?? siblings[siblingIndex + 1];
    if (neighbor) return neighbor.id;
    const owner = sameSpace.find(
      (tab) => tab.kind === "terminal" && tab.id === closing.ownerTabId,
    );
    if (owner) return owner.id;
  }
  const idx = sameSpace.findIndex((t) => t.id === closingId);
  return (sameSpace[idx - 1] ?? sameSpace[idx + 1]).id;
}

// Reordering changes position, never space ownership.
export function reorderTabsByGap(
  tabs: Tab[],
  fromId: number,
  toGapIndex: number,
  scope: "space" | "all" = "space",
): Tab[] {
  const moved = tabs.find((t) => t.id === fromId);
  if (!moved) return tabs;
  const sameSpace =
    scope === "all" ? tabs : tabs.filter((t) => t.spaceId === moved.spaceId);
  const spaceFrom = sameSpace.findIndex((t) => t.id === fromId);
  let spaceTarget = toGapIndex > spaceFrom ? toGapIndex - 1 : toGapIndex;
  spaceTarget = Math.max(0, Math.min(spaceTarget, sameSpace.length - 1));
  if (spaceTarget === spaceFrom) return tabs;
  const anchor = sameSpace[spaceTarget];
  const next = tabs.filter((t) => t.id !== fromId);
  const anchorIdx = next.findIndex((t) => t.id === anchor.id);
  const insertIdx = spaceTarget > spaceFrom ? anchorIdx + 1 : anchorIdx;
  next.splice(insertIdx, 0, moved);
  return next;
}

export function planGitDiffOpen(
  tabs: Tab[],
  input: GitDiffOpenInput,
  spaceId: string,
  pin: boolean,
  allocId: () => number,
  ownerTabId?: number,
): { tabs: Tab[]; targetId: number } {
  const title = input.title ?? `${basename(input.path)} (${input.mode})`;
  const originalPath = input.originalPath ?? null;
  const matches = (tab: Tab): tab is GitDiffTab =>
    tab.kind === "git-diff" &&
    tab.spaceId === spaceId &&
    tab.ownerTabId === ownerTabId &&
    pathIdentity(tab.repoRoot) === pathIdentity(input.repoRoot) &&
    pathIdentity(`${tab.repoRoot}/${tab.path}`) ===
      pathIdentity(`${input.repoRoot}/${input.path}`) &&
    tab.mode === input.mode;
  const matchingTabs = tabs.filter(matches);
  const existing = matchingTabs.find((tab) => !tab.preview) ?? matchingTabs[0];

  if (existing) {
    const preview = pin ? false : existing.preview;
    if (
      existing.title === title &&
      existing.originalPath === originalPath &&
      existing.preview === preview
    ) {
      return { tabs, targetId: existing.id };
    }
    return {
      tabs: tabs.map((tab) =>
        tab.id === existing.id
          ? { ...existing, title, originalPath, preview }
          : tab,
      ),
      targetId: existing.id,
    };
  }

  const id = allocId();
  const tab = {
    id,
    kind: "git-diff",
    spaceId,
    ...(ownerTabId !== undefined && { ownerTabId }),
    title,
    path: input.path,
    repoRoot: input.repoRoot,
    mode: input.mode,
    originalPath,
    preview: !pin,
  } satisfies GitDiffTab;

  if (pin) return { tabs: [...tabs, tab], targetId: id };

  const previewIndex = tabs.findIndex(
    (candidate) =>
      candidate.kind === "git-diff" &&
      candidate.spaceId === spaceId &&
      candidate.ownerTabId === ownerTabId &&
      candidate.preview,
  );
  if (previewIndex === -1) return { tabs: [...tabs, tab], targetId: id };

  const next = [...tabs];
  next[previewIndex] = tab;
  return { tabs: next, targetId: id };
}

export function planCommitHistoryOpen(
  tabs: Tab[],
  input: { repoRoot: string; branch?: string | null },
  spaceId: string,
  allocId: () => number,
  ownerTabId?: number,
): { tabs: Tab[]; targetId: number } {
  const existing = tabs.find(
    (tab) =>
      tab.kind === "git-history" &&
      tab.spaceId === spaceId &&
      tab.ownerTabId === ownerTabId &&
      pathIdentity(tab.repoRoot) === pathIdentity(input.repoRoot),
  );
  const title = input.branch ? `History · ${input.branch}` : "Git History";
  if (existing) {
    if (existing.title === title) return { tabs, targetId: existing.id };
    return {
      tabs: tabs.map((tab) =>
        tab.id === existing.id ? { ...existing, title } : tab,
      ),
      targetId: existing.id,
    };
  }

  const id = allocId();
  return {
    tabs: [
      ...tabs,
      {
        id,
        kind: "git-history",
        spaceId,
        ...(ownerTabId !== undefined && { ownerTabId }),
        title,
        repoRoot: input.repoRoot,
      } satisfies GitHistoryTab,
    ],
    targetId: id,
  };
}

function coldTerminalTab(
  tabId: number,
  leafId: number,
  spaceId: string,
  cwd?: string,
): TerminalTab {
  return {
    id: tabId,
    kind: "terminal",
    spaceId,
    cold: true,
    title: cwd ? basename(cwd) : "shell",
    cwd,
    paneTree: { kind: "leaf", id: leafId, cwd },
    activeLeafId: leafId,
  };
}

// Plans the removal of a deleted space's tabs while keeping the invariant that
// the now-active `fallbackSpaceId` always has at least one tab (a cold one is
// spawned when it would be left empty). Returns null when nothing to remove.
export function planSpaceRemoval(
  tabs: Tab[],
  currentActiveId: number,
  spaceId: string,
  fallbackSpaceId: string,
  fallbackCwd: string | undefined,
  allocId: () => number,
): { tabs: Tab[]; disposeLeafIds: number[]; activeId: number } | null {
  const removed = tabs.filter((t) => t.spaceId === spaceId);
  if (removed.length === 0) return null;
  const disposeLeafIds = removed
    .filter((t) => t.kind === "terminal")
    .flatMap((t) => leafIds((t as TerminalTab).paneTree));
  let next = tabs.filter((t) => t.spaceId !== spaceId);
  let activeId = currentActiveId;
  if (!next.some((t) => t.spaceId === fallbackSpaceId)) {
    const tabId = allocId();
    next = [
      ...next,
      coldTerminalTab(tabId, allocId(), fallbackSpaceId, fallbackCwd),
    ];
    activeId = tabId;
  } else if (!next.some((t) => t.id === currentActiveId)) {
    const inFallback = next.filter((t) => t.spaceId === fallbackSpaceId);
    activeId = inFallback[inFallback.length - 1].id;
  }
  return { tabs: next, disposeLeafIds, activeId };
}

export function useTabs(initial?: Partial<TerminalTab>) {
  const [tabs, setTabsState] = useState<Tab[]>(() => {
    const tabId = 1;
    const leafId = 2;
    return [
      {
        id: tabId,
        kind: "terminal",
        spaceId: DEFAULT_SPACE_ID,
        cold: true,
        title: initial?.title ?? "shell",
        cwd: initial?.cwd,
        paneTree: { kind: "leaf", id: leafId, cwd: initial?.cwd },
        activeLeafId: leafId,
      },
    ];
  });
  const [activeId, setActiveIdState] = useState(1);
  // Gates warming until boot resolves the restore, so no shell spawns before it.
  const [booted, setBooted] = useState(false);
  const nextIdRef = useRef(3);
  const activeSpaceIdRef = useRef(DEFAULT_SPACE_ID);
  const tabsRef = useRef(tabs);
  const lastOpenedAt = useRef(0);
  const activeIdRef = useRef(activeId);
  // The terminal tab the user is currently working in — the owner for files
  // opened from the explorer/search while that tab is active. Seeded with the
  // initial terminal so files opened before any tab switch still get an owner.
  const activeTerminalIdRef = useRef<number | undefined>(
    tabs.find((x) => x.kind === "terminal")?.id,
  );

  const updateOwner = useCallback((nextTabs: Tab[], nextActiveId: number) => {
    const active = nextTabs.find((tab) => tab.id === nextActiveId);
    const candidate =
      active?.kind === "terminal"
        ? active.id
        : (active?.ownerTabId ?? activeTerminalIdRef.current);
    const owner = nextTabs.find(
      (tab) =>
        tab.id === candidate &&
        tab.kind === "terminal" &&
        tab.spaceId === active?.spaceId,
    );
    activeTerminalIdRef.current = owner?.id;
  }, []);

  const setTabs = useCallback(
    (update: Tab[] | ((current: Tab[]) => Tab[])) => {
      let next =
        typeof update === "function" ? update(tabsRef.current) : update;
      if (next === tabsRef.current) return;
      let latest = Math.max(Date.now(), lastOpenedAt.current);
      for (const tab of next) {
        if (tab.kind === "terminal" && tab.openedAt !== undefined)
          latest = Math.max(latest, tab.openedAt);
      }
      const missing = next
        .filter((tab) => tab.kind === "terminal" && tab.openedAt === undefined)
        .sort((a, b) => a.id - b.id);
      if (missing.length) {
        const timestamps = new Map(missing.map((tab) => [tab.id, ++latest]));
        next = next.map((tab) => {
          const openedAt = timestamps.get(tab.id);
          return openedAt === undefined ? tab : { ...tab, openedAt };
        });
      }
      lastOpenedAt.current = latest;
      tabsRef.current = next;
      updateOwner(next, activeIdRef.current);
      setTabsState(next);
    },
    [updateOwner],
  );

  const setActiveId = useCallback(
    (update: number | ((current: number) => number)) => {
      const next =
        typeof update === "function" ? update(activeIdRef.current) : update;
      activeIdRef.current = next;
      updateOwner(tabsRef.current, next);
      setActiveIdState(next);
    },
    [updateOwner],
  );

  // Activating a cold tab warms it: one choke point for every activation path.
  useEffect(() => {
    if (!booted) return;
    setTabs((curr) => {
      const t = curr.find((x) => x.id === activeId);
      if (!t || (t.kind === "terminal" && t.parked)) return curr;
      const ownerId = t.kind === "terminal" ? t.id : t.ownerTabId;
      const now = Date.now();
      return curr.map((x) =>
        x.id === activeId || (x.kind === "terminal" && x.id === ownerId)
          ? {
              ...x,
              ...(x.id === activeId && { cold: false }),
              ...(x.kind === "terminal" &&
                x.id === ownerId && { lastUsedAt: now }),
            }
          : x,
      );
    });
  }, [activeId, booted, setTabs]);

  const activateProject = useCallback(
    (id: number) => {
      if (
        !tabsRef.current.some((tab) => tab.id === id && tab.kind === "terminal")
      )
        return;
      setTabs((current) =>
        current.map((tab) =>
          tab.id === id && tab.kind === "terminal"
            ? {
                ...tab,
                parked: false,
                cold: false,
                lastUsedAt: Date.now(),
                ...(tab.parked && { autoResume: false }),
              }
            : tab,
        ),
      );
      setActiveId(id);
    },
    [setTabs, setActiveId],
  );

  const parkProject = useCallback(
    async (id: number) => {
      const project = tabsRef.current.find((tab) => tab.id === id);
      if (project?.kind !== "terminal" || project.parked) return;
      const leaves = leafIds(project.paneTree);
      setTabs((current) =>
        parkProjectTabs(current, id, () => nextIdRef.current++),
      );
      const active = tabsRef.current.find(
        (tab) => tab.id === activeIdRef.current,
      );
      if (
        active?.id === id ||
        (active?.ownerTabId === id && active.spaceId === project.spaceId)
      ) {
        const fallback = [...tabsRef.current]
          .reverse()
          .find(
            (tab) =>
              tab.kind === "terminal" &&
              tab.id !== id &&
              tab.spaceId === project.spaceId &&
              !tab.parked,
          );
        setActiveId(fallback?.id ?? id);
      }
      await Promise.all(leaves.map(disposeSession));
    },
    [setTabs, setActiveId],
  );

  const allocId = useCallback(() => nextIdRef.current++, []);

  const markBooted = useCallback(() => setBooted(true), []);

  const setActiveSpaceForNewTabs = useCallback((spaceId: string) => {
    activeSpaceIdRef.current = spaceId;
    const owner = tabsRef.current.find(
      (tab) =>
        tab.id === activeTerminalIdRef.current &&
        tab.kind === "terminal" &&
        tab.spaceId === spaceId,
    );
    activeTerminalIdRef.current = owner?.id;
  }, []);

  const replaceTabs = useCallback(
    (next: Tab[], nextActiveId: number) => {
      setTabs(next);
      setActiveId(nextActiveId);
    },
    [setTabs, setActiveId],
  );

  const removeTabsForSpace = useCallback(
    (spaceId: string, fallbackSpaceId: string, fallbackCwd?: string) => {
      let toDispose: number[] = [];
      setTabs((curr) => {
        const plan = planSpaceRemoval(
          curr,
          activeIdRef.current,
          spaceId,
          fallbackSpaceId,
          fallbackCwd,
          () => nextIdRef.current++,
        );
        if (!plan) return curr;
        toDispose = plan.disposeLeafIds;
        setActiveId(plan.activeId);
        return plan.tabs;
      });
      for (const lid of toDispose) disposeSession(lid);
    },
    [setTabs, setActiveId],
  );

  const newTab = useCallback(
    (cwd?: string) => {
      const tabId = nextIdRef.current++;
      const leafId = nextIdRef.current++;
      setTabs((t) => [
        ...t,
        {
          id: tabId,
          kind: "terminal",
          spaceId: activeSpaceIdRef.current,
          title: "shell",
          cwd,
          paneTree: { kind: "leaf", id: leafId, cwd },
          activeLeafId: leafId,
        },
      ]);
      setActiveId(tabId);
      return tabId;
    },
    [setTabs, setActiveId],
  );

  const newBlockTab = useCallback(
    (cwd?: string) => {
      const tabId = nextIdRef.current++;
      const leafId = nextIdRef.current++;
      setTabs((t) => [
        ...t,
        {
          id: tabId,
          kind: "terminal",
          spaceId: activeSpaceIdRef.current,
          title: "blocks",
          cwd,
          paneTree: { kind: "leaf", id: leafId, cwd },
          activeLeafId: leafId,
          blocks: true,
        },
      ]);
      setActiveId(tabId);
      return tabId;
    },
    [setTabs, setActiveId],
  );

  useEffect(() => {
    if (!import.meta.env?.DEV || typeof window === "undefined") return;
    (
      window as unknown as { __teraxNewBlockTab?: (cwd?: string) => number }
    ).__teraxNewBlockTab = newBlockTab;
  }, [newBlockTab]);

  const newPrivateTab = useCallback(
    (cwd?: string) => {
      const tabId = nextIdRef.current++;
      const leafId = nextIdRef.current++;
      setTabs((t) => [
        ...t,
        {
          id: tabId,
          kind: "terminal",
          spaceId: activeSpaceIdRef.current,
          title: "private",
          cwd,
          paneTree: { kind: "leaf", id: leafId, cwd },
          activeLeafId: leafId,
          private: true,
        },
      ]);
      setActiveId(tabId);
      return tabId;
    },
    [setTabs, setActiveId],
  );

  /** Single-leaf terminal tab; returns the leaf so callers can type into it. */
  const newCommandTab = useCallback(
    (cwd?: string, title = "shell") => {
      const tabId = nextIdRef.current++;
      const leafId = nextIdRef.current++;
      setTabs((t) => [
        ...t,
        {
          id: tabId,
          kind: "terminal",
          spaceId: activeSpaceIdRef.current,
          title,
          customTitle: title,
          cwd,
          paneTree: { kind: "leaf", id: leafId, cwd },
          activeLeafId: leafId,
        },
      ]);
      setActiveId(tabId);
      return { tabId, leafId };
    },
    [setTabs, setActiveId],
  );

  /**
   * Opens a file in an editor tab.
   *
   * - `pin = true` (default) — opens or activates a **persistent** tab.
   *   If the path is currently in the preview slot it is promoted in-place.
   *   Use this for programmatic opens (AI diff, New File dialog, etc.).
   * - `pin = false` uses this project's preview slot, never another owner's.
   */
  const openFileTab = useCallback(
    (path: string, pin = true, options: OpenFileTabOptions = {}) => {
      const targetSpaceId = options.spaceId ?? activeSpaceIdRef.current;
      const candidateOwner = options.ownerTabId ?? activeTerminalIdRef.current;
      const ownerTabId = tabsRef.current.some(
        (tab) =>
          tab.id === candidateOwner &&
          tab.kind === "terminal" &&
          tab.spaceId === targetSpaceId,
      )
        ? candidateOwner
        : undefined;
      const activate = options.activate ?? true;
      const plan = planFileTabOpen(
        tabsRef.current,
        path,
        pin,
        targetSpaceId,
        () => nextIdRef.current++,
        ownerTabId,
      );
      setTabs(plan.tabs);
      if (activate) setActiveId(plan.tabId);
      return plan.tabId;
    },
    [setTabs, setActiveId],
  );

  /**
   * Promotes a preview tab to a persistent one. Called on double-click of the
   * tab title in the tab bar. Dirty editor tabs also auto-promote.
   */
  const pinTab = useCallback(
    (id: number) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== id) return t;
          if ((t.kind === "editor" || t.kind === "git-diff") && t.preview) {
            return { ...t, preview: false };
          }
          return t;
        }),
      );
    },
    [setTabs],
  );

  const newPreviewTab = useCallback(
    (url: string) => {
      const id = nextIdRef.current++;
      setTabs((t) => [
        ...t,
        {
          id,
          kind: "preview",
          spaceId: activeSpaceIdRef.current,
          ...(activeTerminalIdRef.current !== undefined && {
            ownerTabId: activeTerminalIdRef.current,
          }),
          title: titleFromUrl(url),
          url,
        },
      ]);
      setActiveId(id);
      return id;
    },
    [setTabs, setActiveId],
  );

  const newMarkdownTab = useCallback(
    (path: string, ownerTabId?: number) => {
      const curr = tabsRef.current;
      const candidateOwner = ownerTabId ?? activeTerminalIdRef.current;
      const owner = curr.some(
        (tab) =>
          tab.id === candidateOwner &&
          tab.kind === "terminal" &&
          tab.spaceId === activeSpaceIdRef.current,
      )
        ? candidateOwner
        : undefined;
      const plan = planMarkdownTabOpen(
        curr,
        path,
        activeSpaceIdRef.current,
        () => nextIdRef.current++,
        owner,
      );
      if (plan.tabs !== curr) {
        setTabs(plan.tabs);
      }
      setActiveId(plan.tabId);
      return plan.tabId;
    },
    [setTabs, setActiveId],
  );

  const setOverrideLanguage = useCallback(
    (id: number, lang: string | null) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== id || t.kind !== "editor") return t;
          return {
            ...t,
            overrideLanguage: lang,
          };
        }),
      );
    },
    [setTabs],
  );

  const setMarkdownView = useCallback(
    (id: number, mode: "rendered" | "raw") => {
      setTabs((curr) =>
        curr.map((t) => {
          if (
            t.id !== id ||
            !isMarkdownPath((t as { path?: string }).path ?? "")
          )
            return t;
          if (mode === "raw" && t.kind === "markdown") {
            return {
              ...t,
              kind: "editor" as const,
              dirty: false,
              preview: false,
              overrideLanguage:
                (t as { overrideLanguage?: string | null }).overrideLanguage ??
                null,
            };
          }
          if (mode === "rendered" && t.kind === "editor") {
            if (t.dirty) return t;
            return {
              id: t.id,
              kind: "markdown" as const,
              spaceId: t.spaceId,
              cold: t.cold,
              title: t.title,
              path: t.path,
              ownerTabId: t.ownerTabId,
              overrideLanguage: t.overrideLanguage ?? null,
            };
          }
          return t;
        }),
      );
    },
    [setTabs],
  );

  const openGitDiffTab = useCallback(
    (input: GitDiffOpenInput, pin = false) => {
      const curr = tabsRef.current;
      const plan = planGitDiffOpen(
        curr,
        input,
        activeSpaceIdRef.current,
        pin,
        () => nextIdRef.current++,
        activeTerminalIdRef.current,
      );
      if (plan.tabs !== curr) {
        setTabs(plan.tabs);
      }
      setActiveId(plan.targetId);
      return plan.targetId;
    },
    [setTabs, setActiveId],
  );

  const openCommitHistoryTab = useCallback(
    (input: { repoRoot: string; branch?: string | null }) => {
      const curr = tabsRef.current;
      const plan = planCommitHistoryOpen(
        curr,
        input,
        activeSpaceIdRef.current,
        () => nextIdRef.current++,
        activeTerminalIdRef.current,
      );
      if (plan.tabs !== curr) {
        setTabs(plan.tabs);
      }
      setActiveId(plan.targetId);
      return plan.targetId;
    },
    [setTabs, setActiveId],
  );

  const openCommitFileDiffTab = useCallback(
    (input: {
      repoRoot: string;
      sha: string;
      shortSha: string;
      subject: string;
      path: string;
      originalPath: string | null;
    }) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t) =>
          t.kind === "git-commit-file" &&
          t.spaceId === activeSpaceIdRef.current &&
          t.ownerTabId === activeTerminalIdRef.current &&
          pathIdentity(t.repoRoot) === pathIdentity(input.repoRoot) &&
          t.sha === input.sha &&
          t.path === input.path,
      );
      const title = `${basename(input.path)} @ ${input.shortSha}`;
      if (existing) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id
            ? {
                ...t,
                title,
                subject: input.subject,
                originalPath: input.originalPath,
              }
            : t,
        );
        setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }
      const id = nextIdRef.current++;
      const nextTabs = [
        ...curr,
        {
          id,
          kind: "git-commit-file",
          spaceId: activeSpaceIdRef.current,
          ...(activeTerminalIdRef.current !== undefined && {
            ownerTabId: activeTerminalIdRef.current,
          }),
          title,
          repoRoot: input.repoRoot,
          sha: input.sha,
          shortSha: input.shortSha,
          subject: input.subject,
          path: input.path,
          originalPath: input.originalPath,
        } satisfies GitCommitFileDiffTab,
      ];
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [setTabs, setActiveId],
  );

  const closeTab = useCallback(
    (
      id: number,
      canClose?: (tab: Tab, tabs: readonly Tab[], activeId: number) => boolean,
    ): boolean => {
      let toDispose: number[] = [];
      let closed = false;
      setTabs((curr) => {
        const target = curr.find((t) => t.id === id);
        if (
          !target ||
          (canClose && !canClose(target, curr, activeIdRef.current))
        )
          return curr;
        const fallback =
          nextActiveInSpace(curr, id) ??
          (target.kind === "terminal" ? 0 : null);
        if (fallback === null) return curr;
        closed = true;
        if (target?.kind === "terminal") {
          toDispose = leafIds(target.paneTree);
        }
        let next = curr.filter((t) => t.id !== id);
        // Keep owned windows but detach them rather than retaining a ghost owner.
        if (target?.kind === "terminal") {
          next = next.map((t) =>
            t.ownerTabId === id ? { ...t, ownerTabId: undefined } : t,
          );
        }
        setActiveId((active) => (id === active ? fallback : active));
        return next;
      });
      for (const lid of toDispose) disposeSession(lid);
      return closed;
    },
    [setTabs, setActiveId],
  );

  const updateTab = useCallback(
    (id: number, patch: TabPatch) => {
      setTabs((t) =>
        t.map((x) => {
          if (x.id !== id) return x;
          if (x.kind === "terminal") {
            return {
              ...x,
              ...(patch.title !== undefined && { title: patch.title }),
              ...(patch.cwd !== undefined && { cwd: patch.cwd }),
              ...(patch.customTitle !== undefined && {
                customTitle:
                  patch.customTitle === "" ? undefined : patch.customTitle,
              }),
            };
          }
          if (x.kind === "preview") {
            return {
              ...x,
              ...(patch.title !== undefined && { title: patch.title }),
              ...(patch.url !== undefined && {
                url: patch.url,
                title: patch.title ?? titleFromUrl(patch.url),
              }),
            };
          }
          if (x.kind === "markdown") {
            return {
              ...x,
              ...(patch.path !== undefined && { path: patch.path }),
              ...(patch.title !== undefined && { title: patch.title }),
            };
          }
          if (x.kind === "git-history") {
            return {
              ...x,
              ...(patch.title !== undefined && { title: patch.title }),
              ...(patch.repoRoot !== undefined && { repoRoot: patch.repoRoot }),
            };
          }
          // editor tab: auto-promote from preview the moment the file becomes dirty.
          const autoPin =
            patch.dirty === true && (x as EditorTab).preview
              ? { preview: false }
              : {};
          return {
            ...x,
            ...autoPin,
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.dirty !== undefined && { dirty: patch.dirty }),
            ...(patch.path !== undefined && { path: patch.path }),
            ...(patch.overrideLanguage !== undefined && {
              overrideLanguage: patch.overrideLanguage,
            }),
          };
        }),
      );
    },
    [setTabs],
  );

  const selectByIndex = useCallback(
    (idx: number, spaceId?: string) => {
      const t = spaceId ? pickTabBySpaceIndex(tabs, idx, spaceId) : tabs[idx];
      if (t?.kind === "terminal") activateProject(t.id);
      else if (t) setActiveId(t.id);
    },
    [tabs, setActiveId, activateProject],
  );

  /** Update a leaf's cwd; mirror to the tab's `cwd` when the leaf is active.
   * Bails out without setTabs when nothing actually changed — shell integration
   * re-emits OSC 7 on every prompt, including empty Enters, so this fires at
   * keystroke rate. Always-setTabs there cascades a paneTree re-render across
   * every open tab. */
  const setLeafCwd = useCallback(
    (leafId: number, cwd: string) => {
      setTabs((curr) => {
        let changed = false;
        const next = curr.map((t) => {
          if (t.kind !== "terminal" || !hasLeaf(t.paneTree, leafId)) return t;
          const paneTree = setLeafCwdInTree(t.paneTree, leafId, cwd);
          const isActive = t.activeLeafId === leafId;
          const cwdChanged = isActive && t.cwd !== cwd;
          if (paneTree === t.paneTree && !cwdChanged) return t;
          changed = true;
          return { ...t, paneTree, ...(cwdChanged && { cwd }) };
        });
        return changed ? next : curr;
      });
    },
    [setTabs],
  );

  const focusPane = useCallback(
    (tabId: number, leafId: number) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          if (!hasLeaf(t.paneTree, leafId)) return t;
          if (t.activeLeafId === leafId) return t;
          const cwd = findLeafCwd(t.paneTree, leafId);
          return {
            ...t,
            activeLeafId: leafId,
            ...(cwd !== undefined && { cwd }),
          };
        }),
      );
    },
    [setTabs],
  );

  const focusNextPaneInTab = useCallback(
    (tabId: number, delta: 1 | -1) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const next = nextLeafId(t.paneTree, t.activeLeafId, delta);
          if (next === t.activeLeafId) return t;
          const cwd = findLeafCwd(t.paneTree, next);
          return {
            ...t,
            activeLeafId: next,
            ...(cwd !== undefined && { cwd }),
          };
        }),
      );
    },
    [setTabs],
  );

  const swapActivePaneInDirection = useCallback(
    (tabId: number, direction: PaneDirection, bounds?: PaneBounds[]) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          const paneTree = swapLeafInDirection(
            t.paneTree,
            t.activeLeafId,
            direction,
            bounds,
          );
          return paneTree === t.paneTree ? t : { ...t, paneTree };
        }),
      );
    },
    [setTabs],
  );

  /** Split the active leaf of `tabId` along `dir`. Returns the new leaf id. */
  const splitActivePane = useCallback(
    (tabId: number, dir: SplitDir): number | null => {
      let newLeafId: number | null = null;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal" || t.blocks) return t;
          if (leafIds(t.paneTree).length >= MAX_PANES_PER_TAB) return t;
          const splitId = nextIdRef.current++;
          const leafId = nextIdRef.current++;
          newLeafId = leafId;
          const paneTree = splitLeaf(
            t.paneTree,
            t.activeLeafId,
            splitId,
            leafId,
            dir,
            t.cwd,
          );
          return { ...t, paneTree, activeLeafId: leafId };
        }),
      );
      return newLeafId;
    },
    [setTabs],
  );

  const closePaneByLeaf = useCallback(
    (leafId: number): void => {
      let didRemove = false;
      setTabs((curr) => {
        const tab = curr.find(
          (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
        );
        if (tab?.kind !== "terminal") return curr;
        const newTree = removeLeaf(tab.paneTree, leafId);
        if (newTree === null) {
          const fallback = nextActiveInSpace(curr, tab.id);
          if (fallback === null) return curr;
          const next = curr
            .filter((x) => x.id !== tab.id)
            .map((item) =>
              item.ownerTabId === tab.id
                ? { ...item, ownerTabId: undefined }
                : item,
            );
          setActiveId((active) => (active === tab.id ? fallback : active));
          didRemove = true;
          return next;
        }
        const remaining = leafIds(newTree);
        let newActive = tab.activeLeafId;
        if (tab.activeLeafId === leafId) {
          const sib = siblingLeafOf(tab.paneTree, leafId);
          newActive = sib && remaining.includes(sib) ? sib : remaining[0];
        }
        didRemove = true;
        return curr.map((x) =>
          x.id === tab.id
            ? {
                ...x,
                paneTree: newTree,
                activeLeafId: newActive,
                cwd: findLeafCwd(newTree, newActive) ?? tab.cwd,
              }
            : x,
        );
      });
      if (didRemove) disposeSession(leafId);
    },
    [setTabs, setActiveId],
  );

  const closeActivePane = useCallback(
    (tabId: number): boolean => {
      let closedTab = false;
      let removedLeaf: number | null = null;
      setTabs((curr) => {
        const t = curr.find((x) => x.id === tabId);
        if (t?.kind !== "terminal") return curr;
        const target = t.activeLeafId;
        const newTree = removeLeaf(t.paneTree, target);
        if (newTree === null) {
          const fallback = nextActiveInSpace(curr, tabId);
          if (fallback === null) return curr;
          const next = curr
            .filter((x) => x.id !== tabId)
            .map((item) =>
              item.ownerTabId === tabId
                ? { ...item, ownerTabId: undefined }
                : item,
            );
          setActiveId((active) => (active === tabId ? fallback : active));
          closedTab = true;
          removedLeaf = target;
          return next;
        }
        const remaining = leafIds(newTree);
        const sib = siblingLeafOf(t.paneTree, target);
        const newActive = sib && remaining.includes(sib) ? sib : remaining[0];
        removedLeaf = target;
        return curr.map((x) =>
          x.id === tabId
            ? {
                ...x,
                paneTree: newTree,
                activeLeafId: newActive,
                cwd: findLeafCwd(newTree, newActive) ?? t.cwd,
              }
            : x,
        );
      });
      if (removedLeaf !== null) disposeSession(removedLeaf);
      return closedTab;
    },
    [setTabs, setActiveId],
  );

  const resetWorkspace = useCallback(
    (cwd?: string) => {
      const tabId = nextIdRef.current++;
      const leafId = nextIdRef.current++;
      let toDispose: number[] = [];
      setTabs((curr) => {
        toDispose = curr.flatMap((t) =>
          t.kind === "terminal" ? leafIds(t.paneTree) : [],
        );
        return [
          {
            id: tabId,
            kind: "terminal",
            spaceId: activeSpaceIdRef.current,
            title: "shell",
            cwd,
            paneTree: { kind: "leaf", id: leafId, cwd },
            activeLeafId: leafId,
          },
        ];
      });
      setActiveId(tabId);
      for (const lid of toDispose) disposeSession(lid);
    },
    [setTabs, setActiveId],
  );

  const reorderTabByGap = useCallback(
    (fromId: number, toGapIndex: number, scope: "space" | "all" = "space") => {
      setTabs((prev) => reorderTabsByGap(prev, fromId, toGapIndex, scope));
    },
    [setTabs],
  );

  const moveProject = useCallback(
    (id: number, spaceId: string, beforeId: number | null) => {
      setTabs((current) => moveProjectTabs(current, id, spaceId, beforeId));
    },
    [setTabs],
  );

  return {
    tabs,
    activeId,
    setActiveId,
    allocId,
    booted,
    replaceTabs,
    reorderTabByGap,
    moveProject,
    parkProject,
    activateProject,
    removeTabsForSpace,
    markBooted,
    setActiveSpaceForNewTabs,
    setOverrideLanguage,
    newTab,
    newBlockTab,
    newCommandTab,
    newPrivateTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    newMarkdownTab,
    setMarkdownView,
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
  };
}
