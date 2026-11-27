import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import {
  CloudDownloadIcon,
  FileDiffIcon,
  GitCompareIcon,
  GitMergeIcon,
  MoreVerticalIcon,
  RotateClockwiseIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BRANCH_TARGET_LABELS,
  type BranchTargetAction,
} from "./BranchTargetDialog";

const ITEM_CLASS =
  "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[11px]";

const TARGET_ACTIONS = [
  { action: "merge", icon: GitMergeIcon },
  { action: "rebase", icon: RotateClockwiseIcon },
  { action: "compare", icon: GitCompareIcon },
] as const;

export function BranchActionsMenu({
  currentBranch,
  busy,
  onPull,
  onChooseTarget,
  onDiff,
}: {
  currentBranch: string | null;
  busy: boolean;
  onPull: () => void;
  onChooseTarget: (action: BranchTargetAction) => void;
  onDiff: () => void;
}) {
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
        {TARGET_ACTIONS.map(({ action, icon }) => (
          <DropdownMenuItem
            key={action}
            disabled={busy}
            onSelect={(event) => {
              event.preventDefault();
              onChooseTarget(action);
            }}
            className={ITEM_CLASS}
          >
            <HugeiconsIcon
              icon={icon}
              size={12}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            {BRANCH_TARGET_LABELS[action]}…
          </DropdownMenuItem>
        ))}
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
