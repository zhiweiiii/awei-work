import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import type { GitBranchEntry } from "@/lib/native";
import {
  CloudDownloadIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitCompareIcon,
  GitMergeIcon,
  MoreVerticalIcon,
  RotateClockwiseIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const ITEM_CLASS =
  "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[11px]";

/**
 * Operations menu for the currently checked out branch of the repo page:
 * pull, merge, rebase, compare and a working-tree diff. Merge/rebase/compare
 * pick their target branch from a submenu of the other local branches.
 */
export function BranchActionsMenu({
  currentBranch,
  branches,
  busy,
  onPull,
  onMerge,
  onRebase,
  onCompare,
  onDiff,
}: {
  currentBranch: string | null;
  branches: GitBranchEntry[];
  busy: boolean;
  onPull: () => void;
  onMerge: (target: string) => void;
  onRebase: (target: string) => void;
  onCompare: (target: string) => void;
  onDiff: () => void;
}) {
  const targets = branches
    .filter((b) => b.kind !== "remote" && b.name !== currentBranch)
    .map((b) => b.name);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-5 rounded"
          title="分支操作"
          disabled={busy}
        >
          {busy ? (
            <Spinner className="size-3" />
          ) : (
            <HugeiconsIcon icon={MoreVerticalIcon} size={11} strokeWidth={2} />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={4}
        className="min-w-44 rounded-xl border border-border/40 bg-popover/90 p-1 shadow-lg backdrop-blur-md"
      >
        <DropdownMenuItem
          disabled={busy || !currentBranch}
          onSelect={(e) => {
            e.preventDefault();
            onPull();
          }}
          className={ITEM_CLASS}
        >
          <HugeiconsIcon
            icon={CloudDownloadIcon}
            size={12}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
          拉取 (fast-forward)
        </DropdownMenuItem>
        <BranchPickerSub
          label="合并…"
          icon={GitMergeIcon}
          targets={targets}
          busy={busy}
          onPick={onMerge}
        />
        <BranchPickerSub
          label="变基到…"
          icon={RotateClockwiseIcon}
          targets={targets}
          busy={busy}
          onPick={onRebase}
        />
        <BranchPickerSub
          label="比较…"
          icon={GitCompareIcon}
          targets={targets}
          busy={busy}
          onPick={onCompare}
        />
        <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />
        <DropdownMenuItem
          disabled={busy || !currentBranch}
          onSelect={(e) => {
            e.preventDefault();
            onDiff();
          }}
          className={ITEM_CLASS}
        >
          <HugeiconsIcon
            icon={FileDiffIcon}
            size={12}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
          与工作区比较
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BranchPickerSub({
  label,
  icon,
  targets,
  busy,
  onPick,
}: {
  label: string;
  icon: typeof GitMergeIcon;
  targets: string[];
  busy: boolean;
  onPick: (target: string) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        disabled={busy || targets.length === 0}
        className={ITEM_CLASS}
      >
        <HugeiconsIcon
          icon={icon}
          size={12}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        sideOffset={8}
        className="max-h-56 min-w-36 overflow-y-auto rounded-xl border border-border/40 bg-popover/90 p-1 shadow-lg backdrop-blur-md"
      >
        {targets.map((name) => (
          <DropdownMenuItem
            disabled={busy}
            key={name}
            onSelect={(e) => {
              e.preventDefault();
              onPick(name);
            }}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-[11px]"
          >
            <HugeiconsIcon
              icon={GitBranchIcon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate">{name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
