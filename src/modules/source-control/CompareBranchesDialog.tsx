import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { type GitLogEntry, native } from "@/lib/native";
import { GitCompareIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback } from "react";
import { useAsyncQuery } from "@/modules/command-palette/hooks/useAsyncQuery";
import { LOCAL_WORKSPACE, workspaceScopeKey } from "@/modules/workspace";
/** Two-column commit comparison: commits only in each branch of the pair. */
export function CompareBranchesDialog({
  open,
  onOpenChange,
  repoRoot,
  repoName,
  left,
  right,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoRoot: string;
  repoName: string;
  left: string;
  right: string;
}) {
  const workspace = LOCAL_WORKSPACE;
  const run = useCallback(
    async () => [
      await native.gitCompareBranches(repoRoot, left, right, workspace),
    ],
    [repoRoot, left, right],
  );
  const {
    results,
    error,
    loading: busy,
    retry,
  } = useAsyncQuery({
    enabled: open,
    term: "",
    minLength: 0,
    debounceMs: 0,
    run,
    scopeKey: JSON.stringify([
      repoRoot,
      left,
      right,
      workspaceScopeKey(workspace),
    ]),
  });
  const result = results[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex gap-1.75">
            <HugeiconsIcon icon={GitCompareIcon} size={16} strokeWidth={1.75} />
            比较分支
          </DialogTitle>
          <DialogDescription>
            {left} 与 {right}（在 {repoName} 中）。
          </DialogDescription>
        </DialogHeader>
        {busy ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            比较中…
          </div>
        ) : error ? (
          <div className="grid gap-2 py-6 text-center">
            <div className="px-4 text-xs text-destructive">{error}</div>
            <div className="flex justify-center">
              <Button variant="ghost" size="sm" onClick={retry}>
                重试
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <CommitColumn
              title={`仅存在于 ${left}`}
              commits={result?.leftOnly ?? []}
            />
            <CommitColumn
              title={`仅存在于 ${right}`}
              commits={result?.rightOnly ?? []}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CommitColumn({
  title,
  commits,
}: {
  title: string;
  commits: GitLogEntry[];
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/40 bg-muted/30">
      <div className="border-b border-border/40 px-2 py-1 text-[10px] font-medium text-muted-foreground">
        {title}
      </div>
      {commits.length === 0 ? (
        <div className="px-2 py-3 text-[10.5px] text-muted-foreground/60">
          无提交
        </div>
      ) : (
        <ul className="max-h-64 overflow-y-auto p-1">
          {commits.map((commit) => (
            <li
              key={commit.sha}
              className="flex items-baseline gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent/40"
            >
              <code className="shrink-0 font-mono text-[9.5px] text-muted-foreground">
                {commit.shortSha}
              </code>
              <span className="truncate text-[11px]">{commit.subject}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
