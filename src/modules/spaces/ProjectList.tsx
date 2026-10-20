import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { labelFor } from "@/modules/tabs/lib/tabLabel";
import type { TerminalTab } from "@/modules/tabs/lib/useTabs";
import {
  Cancel01Icon,
  PencilEdit02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type PointerEvent, useCallback, useRef, useState } from "react";
import type { ProjectDropTarget } from "./lib/useProjectDrag";

type Props = {
  projects: TerminalTab[];
  activeId: number | null;
  runningIds: ReadonlySet<number>;
  onSelect: (tab: TerminalTab) => void;
  onRename: (id: number, name: string) => void;
  onClose: (id: number) => void;
  onDragStart: (id: number, event: PointerEvent<HTMLElement>) => void;
  draggingId: number | null;
  dropTarget: ProjectDropTarget | null;
  isDragging: () => boolean;
};

export function ProjectList({ projects, ...props }: Props) {
  return projects.length ? (
    projects.map((project) => (
      <ProjectRow key={project.id} project={project} {...props} />
    ))
  ) : (
    <div className="px-2 py-4 text-center text-xs text-muted-foreground">
      此分组暂无项目
    </div>
  );
}

function ProjectRow({
  project,
  activeId,
  runningIds,
  onSelect,
  onRename,
  onClose,
  onDragStart,
  draggingId,
  dropTarget,
  isDragging,
}: Omit<Props, "projects"> & { project: TerminalTab }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const editing = useRef(false);
  const dropAfter =
    dropTarget?.projectId === project.id ? dropTarget.after : null;
  const focusInput = useCallback((input: HTMLInputElement | null) => {
    input?.focus();
  }, []);
  const name = labelFor(project);
  const commit = () => {
    if (!editing.current) return;
    editing.current = false;
    onRename(project.id, draft.trim());
    setRenaming(false);
  };
  if (renaming)
    return (
      <div className="px-2 py-1">
        <input
          ref={focusInput}
          aria-label="项目名称"
          className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              editing.current = false;
              setRenaming(false);
            }
          }}
          onBlur={commit}
        />
      </div>
    );
  return (
    <DropdownMenuItem
      data-project-drop-space={project.spaceId}
      data-project-drop-id={project.id}
      onPointerDown={(event) => onDragStart(project.id, event)}
      onSelect={(event) => {
        if (isDragging()) event.preventDefault();
        else onSelect(project);
      }}
      title={project.cwd ?? name}
      className={cn(
        "group/project flex touch-none cursor-grab gap-2 rounded-lg px-2 py-1.5 text-xs",
        draggingId === project.id && "cursor-grabbing opacity-50",
        activeId === project.id && "bg-accent",
        dropAfter === false && "shadow-[inset_0_2px_0_var(--primary)]",
        dropAfter === true && "shadow-[inset_0_-2px_0_var(--primary)]",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate">{name}</span>
        {project.cwd ? (
          <span className="truncate text-[10px] text-muted-foreground">
            {project.cwd}
          </span>
        ) : null}
      </span>
      {runningIds.has(project.id) ? (
        <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400">
          Agent
        </span>
      ) : null}
      {activeId === project.id ? (
        <HugeiconsIcon icon={Tick02Icon} size={12} />
      ) : null}
      <button
        type="button"
        aria-label={`重命名项目 ${name}`}
        title="重命名项目"
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          editing.current = true;
          setDraft(name);
          setRenaming(true);
        }}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
      >
        <HugeiconsIcon icon={PencilEdit02Icon} size={11} />
      </button>
      <button
        type="button"
        aria-label={`彻底关闭项目 ${name}`}
        title="彻底关闭项目"
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClose(project.id);
        }}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive focus-visible:ring-1 focus-visible:ring-ring"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={11} />
      </button>
    </DropdownMenuItem>
  );
}
