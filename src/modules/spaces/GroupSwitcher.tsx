import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ProjectList } from "@/modules/spaces/ProjectList";
import type { TerminalTab } from "@/modules/tabs/lib/useTabs";
import {
  Add01Icon,
  ArrowDown01Icon,
  Delete02Icon,
  DashboardSquare01Icon,
  PencilEdit02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import type { SpaceMeta } from "./lib/store";
import { useProjectDrag } from "./lib/useProjectDrag";

type Props = {
  spaces: SpaceMeta[];
  projects: TerminalTab[];
  activeProjectId: number | null;
  runningProjectIds: ReadonlySet<number>;
  onSelectProject: (tab: TerminalTab) => void;
  onRenameProject: (id: number, name: string) => void;
  onCloseProject: (id: number) => void;
  onMoveProject: (id: number, spaceId: string, beforeId: number | null) => void;
  activeId: string | null;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
};

export function GroupSwitcher({
  spaces,
  projects,
  activeProjectId,
  runningProjectIds,
  onSelectProject,
  onRenameProject,
  onCloseProject,
  onMoveProject,
  activeId,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const editing = useRef(false);
  const selectedProject = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const drag = useProjectDrag({
    open,
    containerRef: contentRef,
    projects,
    onMove: onMoveProject,
    onExpand: (spaceId) =>
      setExpandedIds((previous) =>
        previous.has(spaceId) ? previous : new Set([...previous, spaceId]),
      ),
  });
  const focusInput = useCallback((input: HTMLInputElement | null) => {
    input?.focus();
  }, []);

  const active = spaces.find((s) => s.id === activeId);
  const label = active?.name ?? "Group";
  const projectsBySpace = useMemo(() => {
    const grouped = new Map<string, TerminalTab[]>();
    for (const project of projects) {
      const list = grouped.get(project.spaceId);
      if (list) list.push(project);
      else grouped.set(project.spaceId, [project]);
    }
    return grouped;
  }, [projects]);

  const startCreate = () => {
    editing.current = true;
    setDraft(`Group ${spaces.length + 1}`);
    setCreating(true);
    setRenamingId(null);
  };

  const startRename = (space: SpaceMeta) => {
    editing.current = true;
    setDraft(space.name);
    setRenamingId(space.id);
    setCreating(false);
  };

  const commit = () => {
    if (!editing.current) return;
    editing.current = false;
    const name = draft.trim();
    if (name) {
      if (creating) onCreate(name);
      else if (renamingId) onRename(renamingId, name);
    }
    setCreating(false);
    setRenamingId(null);
    setDraft("");
  };

  const cancel = () => {
    editing.current = false;
    setCreating(false);
    setRenamingId(null);
    setDraft("");
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) selectedProject.current = false;
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title="分组与项目"
          aria-label="分组与项目"
        >
          <HugeiconsIcon
            icon={DashboardSquare01Icon}
            size={13}
            strokeWidth={1.75}
          />
          <span className="max-w-24 truncate">{label}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={9}
            strokeWidth={2}
            className="shrink-0 opacity-60"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={contentRef}
        onDragStartCapture={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement) event.preventDefault();
        }}
        align="start"
        side="bottom"
        sideOffset={4}
        className="max-h-80 w-64 overflow-y-auto rounded-xl border border-border/40 bg-popover/90 p-1 backdrop-blur-md shadow-lg"
        onCloseAutoFocus={(event) => {
          if (selectedProject.current) event.preventDefault();
        }}
      >
        <DropdownMenuLabel className="px-2 py-1.5 text-[10.5px] text-muted-foreground">
          分组 ({spaces.length})
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />

        {spaces.map((space) => {
          const isActive = space.id === activeId;
          if (renamingId === space.id) {
            return (
              <div key={space.id} className="px-1.5 py-1">
                <input
                  ref={focusInput}
                  aria-label="Group name"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (
                      e.nativeEvent.isComposing ||
                      e.nativeEvent.keyCode === 229
                    )
                      return;
                    if (e.key === "Enter") commit();
                    else if (e.key === "Escape") cancel();
                  }}
                  onBlur={commit}
                  className="w-full rounded border border-border bg-background px-1.5 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            );
          }
          return (
            <Fragment key={space.id}>
              <DropdownMenuItem
                data-project-drop-space={space.id}
                aria-expanded={expandedIds.has(space.id)}
                aria-controls={`group-projects-${space.id}`}
                onSelect={(e) => {
                  e.preventDefault();
                  if (drag.isDragging()) return;
                  const expanding = !expandedIds.has(space.id);
                  setExpandedIds((previous) => {
                    const next = new Set(previous);
                    if (expanding) next.add(space.id);
                    else next.delete(space.id);
                    return next;
                  });
                }}
                className={cn(
                  "group/item flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs cursor-default",
                  isActive && "bg-accent text-accent-foreground",
                  drag.target?.projectId === null &&
                    drag.target.spaceId === space.id &&
                    "ring-1 ring-primary",
                )}
              >
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={10}
                  className={cn(
                    "shrink-0",
                    !expandedIds.has(space.id) && "-rotate-90",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{space.name}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {projectsBySpace.get(space.id)?.length ?? 0} 项目
                </span>
                {isActive && (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    size={12}
                    strokeWidth={2}
                    className="shrink-0 text-primary"
                  />
                )}
                <button
                  type="button"
                  title="Rename"
                  aria-label={`Rename ${space.name}`}
                  onKeyDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    startRename(space);
                  }}
                  className="shrink-0 rounded p-0.5 opacity-0 hover:bg-foreground/10 group-hover/item:opacity-60"
                >
                  <HugeiconsIcon
                    icon={PencilEdit02Icon}
                    size={11}
                    strokeWidth={1.9}
                  />
                </button>
                {spaces.length > 1 && (
                  <button
                    type="button"
                    title="Delete group"
                    aria-label={`Delete ${space.name}`}
                    onKeyDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      onDelete(space.id);
                    }}
                    className="shrink-0 rounded p-0.5 opacity-0 hover:bg-destructive/15 hover:text-destructive group-hover/item:opacity-60"
                  >
                    <HugeiconsIcon
                      icon={Delete02Icon}
                      size={11}
                      strokeWidth={1.9}
                    />
                  </button>
                )}
              </DropdownMenuItem>
              {expandedIds.has(space.id) && (
                <DropdownMenuGroup
                  data-project-drop-space={space.id}
                  id={`group-projects-${space.id}`}
                  aria-label={`${space.name} 项目`}
                  className="ml-3 border-l border-border/60 pl-1"
                >
                  <ProjectList
                    projects={projectsBySpace.get(space.id) ?? []}
                    activeId={activeProjectId}
                    runningIds={runningProjectIds}
                    onSelect={(project) => {
                      if (drag.isDragging()) return;
                      selectedProject.current = true;
                      onSelectProject(project);
                      setOpen(false);
                    }}
                    onRename={onRenameProject}
                    onClose={onCloseProject}
                    onDragStart={drag.begin}
                    draggingId={drag.draggingId}
                    dropTarget={drag.target}
                    isDragging={drag.isDragging}
                  />
                </DropdownMenuGroup>
              )}
            </Fragment>
          );
        })}

        <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />

        {creating ? (
          <div className="px-1.5 py-1">
            <input
              ref={focusInput}
              aria-label="New group name"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
                  return;
                if (e.key === "Enter") commit();
                else if (e.key === "Escape") cancel();
              }}
              onBlur={commit}
              placeholder="Group name"
              className="w-full rounded border border-border bg-background px-1.5 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        ) : (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              startCreate();
            }}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground cursor-default hover:text-foreground"
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
            <span>新建分组</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
