import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import {
  leafIds,
  ptyIdForLeaf,
  tabAgentStatus,
  useAgentActivityStore,
} from "@/modules/terminal";
import {
  Cancel01Icon,
  CheckmarkCircle01Icon,
  Clock01Icon,
  CommandLineIcon,
  ComputerTerminal02Icon,
  GitCompareIcon,
  Globe02Icon,
  IncognitoIcon,
  Message02Icon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { labelFor, splitProjectBadge } from "./lib/tabLabel";
import type { Tab, TerminalTab } from "./lib/useTabs";
import { NewTabMenu } from "./NewTabMenu";

type Props = {
  tabs: TerminalTab[];
  activeId: number;
  /**
   * When the active tab is a file, this is the terminal tab it belongs to —
   * the command line stays highlighted so file ⇄ command line read as parent
   * and child.
   */
  activeOwnerTabId?: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onClose: (id: number) => void;
  /** Set a terminal tab's custom label; empty string resets to default. */
  onRename: (id: number, title: string) => void;
  /** Move a dragged tab to a new position (insertion gap index 0..tabs.length). */
  onReorder?: (fromId: number, toGapIndex: number) => void;
  compact?: boolean;
};

export function TabBar({
  tabs,
  activeId,
  activeOwnerTabId,
  onSelect,
  onNew,
  onNewBlock,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onClose,
  onRename,
  onReorder,
  compact,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const spaces = useSpaces((state) => state.spaces);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    x: number;
    y: number;
    fromId: number;
    active: boolean;
  } | null>(null);
  const captureRef = useRef<{ element: HTMLElement; pointerId: number } | null>(
    null,
  );
  const dropGapRef = useRef<number | null>(null);
  const scrollFrame = useRef(0);
  const suppressClick = useRef(false);
  const savedUserSelectRef = useRef<string | null>(null);
  const releaseDrag = useCallback(() => {
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = 0;
    drag.current = null;
    dropGapRef.current = null;
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture?.element.hasPointerCapture(capture.pointerId))
      capture.element.releasePointerCapture(capture.pointerId);
    if (savedUserSelectRef.current !== null) {
      document.body.style.userSelect = savedUserSelectRef.current;
      savedUserSelectRef.current = null;
    }
  }, []);
  useEffect(() => releaseDrag, [releaseDrag]);
  useEffect(() => {
    if (drag.current && !tabs.some((tab) => tab.id === drag.current?.fromId)) {
      releaseDrag();
      setDraggingId(null);
      setDropGap(null);
    }
  }, [tabs, releaseDrag]);

  // Play the enter animation only for tabs opened after the first paint, never
  // the restored set and never on switch/reorder (triggers are keyed, so they
  // don't remount then). The ref is seeded with the initial ids on first render.
  const seenRef = useRef<Set<number> | null>(null);
  const firstRender = seenRef.current === null;
  let seen = seenRef.current;
  if (seen === null) {
    seen = new Set(tabs.map((t) => t.id));
    seenRef.current = seen;
  }
  useEffect(() => {
    seenRef.current = new Set(tabs.map((t) => t.id));
  }, [tabs]);

  const gapAtPoint = (clientX: number, clientY: number) => {
    const bounds = scrollRef.current?.getBoundingClientRect();
    if (
      !bounds ||
      clientX < bounds.left ||
      clientX > bounds.right ||
      clientY < bounds.top ||
      clientY > bounds.bottom
    )
      return null;
    const els = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [],
    );
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return els.length;
  };

  const endDrag = useCallback(() => {
    releaseDrag();
    setDraggingId(null);
    setDropGap(null);
  }, [releaseDrag]);

  useEffect(() => {
    const cancel = () => endDrag();
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drag.current?.active) return;
      event.preventDefault();
      event.stopPropagation();
      endDrag();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", keydown, true);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", keydown, true);
    };
  }, [endDrag]);

  const scrollDrag = () => {
    scrollFrame.current = 0;
    const current = drag.current;
    const container = scrollRef.current;
    if (!current?.active || !container) return;
    const gap = gapAtPoint(current.x, current.y);
    if (gap === null) return;
    const bounds = container.getBoundingClientRect();
    const speed =
      current.x < bounds.left + 28
        ? -10
        : current.x > bounds.right - 28
          ? 10
          : 0;
    if (!speed) return;
    const previous = container.scrollLeft;
    container.scrollLeft += speed;
    dropGapRef.current = gapAtPoint(current.x, current.y);
    setDropGap(dropGapRef.current);
    if (container.scrollLeft !== previous)
      scrollFrame.current = requestAnimationFrame(scrollDrag);
  };

  const srcIndex = tabs.findIndex((tab) => tab.id === draggingId);
  const showGap = (gap: number) =>
    draggingId !== null &&
    dropGap === gap &&
    gap !== srcIndex &&
    gap !== srcIndex + 1;

  // Horizontal wheel scroll without holding shift.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active tab visible after selection / open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll the newly active project into view when selection changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[data-tab-active="true"]');
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, activeOwnerTabId]);

  return (
    <div
      ref={scrollRef}
      onDragStartCapture={(event) => event.preventDefault()}
      onClickCapture={(event) => {
        if (!suppressClick.current || event.detail === 0) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      data-tauri-drag-region
      className="min-w-0 shrink overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex w-max items-center gap-0.5">
        <Tabs
          value={String(activeId)}
          onValueChange={(v) => onSelect(Number(v))}
        >
          <TabsList className="relative h-7 w-max gap-1 bg-transparent p-0">
            {tabs.map((t, i) => {
              // A file tab highlights its owning command line; a terminal tab
              // highlights itself.
              const isActive =
                t.id === activeId ||
                (activeOwnerTabId != null &&
                  activeId !== t.id &&
                  t.id === activeOwnerTabId);
              const isNew = !firstRender && !seen.has(t.id);
              const label = labelFor(t);
              const projectBadge = splitProjectBadge(label);
              const groupName =
                spaces.find((space) => space.id === t.spaceId)?.name ?? null;
              const projectTitle = `${label}${groupName ? ` (${groupName})` : ""}${t.private ? " (private)" : ""}`;

              // While renaming, render a non-button cell so the <input> is not
              // nested inside the trigger <button> (invalid HTML, and WebKit
              // blocks focus/selection on inputs inside buttons).
              if (editingId === t.id) {
                return (
                  <Fragment key={t.id}>
                    {showGap(i) && <DropIndicator />}
                    <div
                      data-tab-id={t.id}
                      className={cn(
                        "flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent text-xs text-foreground",
                        compact ? "px-1.5" : "px-2",
                      )}
                    >
                      <span className="inline-flex h-4 min-w-5 shrink-0 items-center justify-center rounded bg-foreground/10 px-1 text-[10px] font-medium">
                        {projectBadge.icon}
                      </span>
                      <TabRenameInput
                        initial={label}
                        onCommit={(value) => {
                          onRename(t.id, value);
                          setEditingId(null);
                        }}
                        onCancel={() => setEditingId(null)}
                      />
                    </div>
                    {i === tabs.length - 1 && showGap(tabs.length) && (
                      <DropIndicator />
                    )}
                  </Fragment>
                );
              }

              const trigger = (
                <TabsTrigger
                  value={String(t.id)}
                  data-tab-id={t.id}
                  data-tab-active={isActive ? "true" : undefined}
                  title={projectTitle}
                  aria-label={label}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || !e.isPrimary) return;
                    if (drag.current) return;
                    suppressClick.current = false;
                    if ((e.target as HTMLElement).closest("[data-no-drag]"))
                      return;
                    drag.current = {
                      pointerId: e.pointerId,
                      startX: e.clientX,
                      x: e.clientX,
                      y: e.clientY,
                      fromId: t.id,
                      active: false,
                    };
                    captureRef.current = {
                      element: e.currentTarget,
                      pointerId: e.pointerId,
                    };
                    try {
                      e.currentTarget.setPointerCapture(e.pointerId);
                    } catch {
                      endDrag();
                    }
                  }}
                  onPointerMove={(e) => {
                    if (!onReorder) return;
                    const st = drag.current;
                    if (!st || st.pointerId !== e.pointerId) return;
                    if (!(e.buttons & 1)) {
                      endDrag();
                      return;
                    }
                    st.x = e.clientX;
                    st.y = e.clientY;
                    if (!st.active) {
                      if (Math.abs(e.clientX - st.startX) < 4) return;
                      st.active = true;
                      suppressClick.current = true;
                      setDraggingId(st.fromId);
                      savedUserSelectRef.current =
                        document.body.style.userSelect;
                      document.body.style.userSelect = "none";
                    }
                    e.preventDefault();
                    const gap = gapAtPoint(e.clientX, e.clientY);
                    dropGapRef.current = gap;
                    setDropGap(gap);
                    if (!scrollFrame.current)
                      scrollFrame.current = requestAnimationFrame(scrollDrag);
                  }}
                  onPointerUp={(e) => {
                    const st = drag.current;
                    if (!st || st.pointerId !== e.pointerId) return;
                    const gap = gapAtPoint(e.clientX, e.clientY);
                    if (st.active && gap !== null) {
                      onReorder?.(st.fromId, gap);
                    } else if (!st.active) {
                      onSelect(t.id);
                    }
                    endDrag();
                  }}
                  onPointerCancel={() => endDrag()}
                  onLostPointerCapture={() => endDrag()}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      e.stopPropagation();
                      onClose(t.id);
                    }
                  }}
                  // Suppress Radix's switch-on-mousedown so a tab grabbed to
                  // drag (or a plain click) only activates on release.
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      return;
                    }
                    if (
                      e.button === 0 &&
                      !(e.target as HTMLElement).closest("[data-no-drag]")
                    ) {
                      e.preventDefault();
                    }
                  }}
                  className={cn(
                    "group relative z-[1] h-7 flex-none shrink-0 cursor-default rounded-md text-xs terax-project-tab min-w-7 justify-center gap-0",
                    isNew && "terax-tab-in",
                    isActive
                      ? cn(
                          "bg-foreground/[0.10] text-foreground shadow-sm ring-1 ring-inset ring-foreground/[0.12] data-active:bg-foreground/[0.10] dark:text-foreground dark:data-active:bg-foreground/[0.10]",
                          compact ? "ps-2! pe-1!" : "ps-2.5! pe-1.5!",
                        )
                      : "bg-foreground/[0.05] px-1.5! text-muted-foreground ring-1 ring-inset ring-foreground/[0.05] hover:bg-foreground/[0.09] hover:text-foreground/90 data-active:bg-foreground/[0.05] dark:text-muted-foreground dark:data-active:bg-foreground/[0.05]",
                    draggingId === t.id && "opacity-50",
                    onReorder && "touch-none",
                  )}
                >
                  <span
                    className={cn(
                      "flex min-w-0 items-center",
                      compact ? "max-w-48" : "max-w-72",
                    )}
                  >
                    <span className="shrink-0 font-medium">
                      {projectBadge.icon}
                    </span>
                    {projectBadge.rest ? (
                      <span
                        className="terax-project-rest"
                        data-expanded={isActive ? "true" : "false"}
                        aria-hidden={!isActive}
                      >
                        <span className="terax-project-rest-inner font-medium">
                          {projectBadge.rest}
                        </span>
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      "terax-project-close",
                      !isActive && "pointer-events-none",
                    )}
                    data-expanded={isActive ? "true" : "false"}
                    aria-hidden={!isActive}
                  >
                    <span className="terax-project-close-inner">
                      {/* biome-ignore lint/a11y/useSemanticElements: TabsTrigger already renders a button; nesting another breaks focus. */}
                      <span
                        role="button"
                        tabIndex={isActive ? 0 : -1}
                        aria-label="停止 agent 并收纳项目"
                        title="停止 agent 并收纳项目"
                        data-no-drag
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onClose(t.id);
                          }
                        }}
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onClose(t.id);
                        }}
                        className="cursor-default rounded p-0.5 opacity-60 transition-opacity hover:bg-accent hover:opacity-100"
                      >
                        <HugeiconsIcon
                          icon={Cancel01Icon}
                          size={11}
                          strokeWidth={2}
                        />
                      </span>
                    </span>
                  </span>
                </TabsTrigger>
              );

              const tabNode = (
                <ContextMenu>
                  <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
                  <ContextMenuContent
                    className="min-w-32 p-1"
                    onCloseAutoFocus={(e) => e.preventDefault()}
                  >
                    <ContextMenuItem
                      className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
                      onSelect={() => setEditingId(t.id)}
                    >
                      <HugeiconsIcon
                        icon={PencilEdit02Icon}
                        size={13}
                        strokeWidth={1.75}
                      />
                      <span className="flex-1">Rename</span>
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
                      onSelect={() => onClose(t.id)}
                    >
                      <HugeiconsIcon
                        icon={Cancel01Icon}
                        size={13}
                        strokeWidth={1.75}
                      />
                      <span className="flex-1">停止 agent 并收纳项目</span>
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );

              return (
                <Fragment key={t.id}>
                  {showGap(i) && <DropIndicator />}
                  {tabNode}
                  {i === tabs.length - 1 && showGap(tabs.length) && (
                    <DropIndicator />
                  )}
                </Fragment>
              );
            })}
          </TabsList>
        </Tabs>
        <NewTabMenu
          onNew={onNew}
          onNewBlock={onNewBlock}
          onNewPrivate={onNewPrivate}
          onNewPreview={onNewPreview}
          onNewEditor={onNewEditor}
          onNewGitGraph={onNewGitGraph}
        />
      </div>
    </div>
  );
}

function DropIndicator() {
  return (
    <span
      aria-hidden
      className="my-0.5 w-0.5 shrink-0 self-stretch rounded-full bg-primary"
    />
  );
}

function useTabAgentStatus(tab: Extract<Tab, { kind: "terminal" }>) {
  const phases = useAgentActivityStore((s) => s.phases);
  const agents = useAgentActivityStore((s) => s.agents);
  const ptyIds: number[] = [];
  for (const leaf of leafIds(tab.paneTree)) {
    const id = ptyIdForLeaf(leaf);
    if (id !== null) ptyIds.push(id);
  }
  return tabAgentStatus(phases, agents, ptyIds);
}

export function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === "editor" || tab.kind === "markdown") {
    const url =
      tab.kind === "editor" && tab.overrideLanguage
        ? fileIconUrl(`dummy.${tab.overrideLanguage}`)
        : fileIconUrl(tab.title);
    return url ? (
      <img
        key={url}
        src={url}
        alt=""
        className="size-3.5 shrink-0 object-contain"
        onError={(e) => {
          const img = e.currentTarget;
          if (img.dataset.fallback) return;
          img.dataset.fallback = "1";
          img.src = fileIconUrl("dummy.txt");
        }}
      />
    ) : null;
  }
  if (tab.kind === "preview") {
    return (
      <HugeiconsIcon
        icon={Globe02Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "terminal" && tab.private) {
    return (
      <HugeiconsIcon
        icon={IncognitoIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "git-diff" || tab.kind === "git-commit-file") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "git-history") {
    return (
      <HugeiconsIcon
        icon={Clock01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  return <TerminalTabIcon tab={tab} />;
}

function TerminalTabIcon({ tab }: { tab: Extract<Tab, { kind: "terminal" }> }) {
  const agentStatus = useTabAgentStatus(tab);
  if (agentStatus.state === "attention") {
    return (
      <HugeiconsIcon
        icon={Message02Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (agentStatus.state === "finished") {
    return (
      <HugeiconsIcon
        icon={CheckmarkCircle01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (agentStatus.state === "working" && agentStatus.agent) {
    return (
      <HugeiconsIcon
        icon={CommandLineIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={ComputerTerminal02Icon}
      size={14}
      strokeWidth={2}
      className="shrink-0"
    />
  );
}

function TabRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Guards against a trailing blur re-resolving an edit that Enter/Escape
  // already finished (Escape must never commit).
  const done = useRef(false);

  useEffect(() => {
    // Focus on the next frame so it runs after the context menu restores focus
    // to its trigger when closing; a synchronous focus would be stolen.
    const raf = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };

  // explicit = the user pressed Enter, which pins even the unchanged label. A
  // plain blur with no change must not freeze the cwd-derived default into a
  // custom title.
  const commit = (value: string, explicit: boolean) => {
    if (!explicit && value.trim() === initial.trim()) finish(onCancel);
    else finish(() => onCommit(value));
  };

  return (
    <input
      ref={ref}
      defaultValue={initial}
      aria-label="Rename tab"
      className={cn(
        "w-28 min-w-0 rounded-sm bg-background px-1 text-xs text-foreground",
        "outline-none ring-1 ring-border focus:ring-ring",
      )}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") commit(e.currentTarget.value, true);
        else if (e.key === "Escape") finish(onCancel);
      }}
      onBlur={(e) => {
        // Switching windows/apps blurs the input; keep the edit open instead
        // of resolving it on the way out.
        if (!document.hasFocus()) return;
        commit(e.currentTarget.value, false);
      }}
    />
  );
}
