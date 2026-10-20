import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { GitBranchEntry } from "@/lib/native";
import { native } from "@/lib/native";
import {
  Add01Icon,
  Delete02Icon,
  FolderOpenIcon,
  GitBranchIcon,
  Refresh01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorToast } from "@/lib/errorToast";
import { toast } from "sonner";
import { BranchConfirmDialog } from "./BranchConfirmDialog";
import { WorktreeDialog } from "./WorktreeDialog";
import { gitWorktreeRemove } from "./worktreeOps";
import {
  currentWorkspaceScopeKey,
  LOCAL_WORKSPACE,
  workspaceScopeKey,
} from "@/modules/workspace";

type WorktreeEntry = {
  path: string;
  branch: string;
  isMain: boolean;
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function collectWorktrees(
  branches: GitBranchEntry[],
  repoRoot: string,
): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const seen = new Set<string>([normalizePath(repoRoot)]);
  const head = branches.find((b) => b.isHead);
  entries.push({
    path: repoRoot,
    branch: head?.name || "HEAD",
    isMain: true,
  });
  for (const b of branches) {
    if (b.kind !== "worktree" || !b.worktreePath) continue;
    const key = normalizePath(b.worktreePath);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ path: b.worktreePath, branch: b.name, isMain: false });
  }
  return entries;
}

/**
 * List, create and remove linked worktrees of a repository. Worktree data
 * comes from git_list_branches; mutations shell out to `git worktree`.
 */
export function WorktreeManagerDialog({
  open,
  onOpenChange,
  repoRoot,
  repoName,
  onOpenPath,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoRoot: string;
  repoName: string;
  /** Opens a terminal at the worktree path; wired by the App layer. */
  onOpenPath?: (path: string) => void;
}) {
  const workspace = LOCAL_WORKSPACE;
  const scope = workspaceScopeKey(workspace);
  const identity = JSON.stringify([open, repoRoot, scope]);
  const identityRef = useRef(identity);
  const epochRef = useRef(0);
  if (identityRef.current !== identity) epochRef.current++;
  identityRef.current = identity;
  const epoch = epochRef.current;
  const aliveRef = useRef(false);
  const requestRef = useRef(0);
  const loadedEpochRef = useRef(-1);
  const removingEpochRef = useRef(-1);
  const busyRef = useRef(false);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      requestRef.current++;
    };
  }, []);
  const [branches, setBranches] = useState<GitBranchEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WorktreeEntry | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (
      !open ||
      !aliveRef.current ||
      identityRef.current !== identity ||
      epochRef.current !== epoch ||
      currentWorkspaceScopeKey() !== scope
    )
      return;
    const request = ++requestRef.current;
    const current = () =>
      aliveRef.current &&
      identityRef.current === identity &&
      epochRef.current === epoch &&
      requestRef.current === request &&
      currentWorkspaceScopeKey() === scope;
    if (!repoRoot) {
      loadedEpochRef.current = epoch;
      setBranches([]);
      return;
    }
    setError(null);
    try {
      const result = await native.gitListBranches(repoRoot, workspace);
      if (!current()) return;
      loadedEpochRef.current = epoch;
      setBranches(result.branches);
    } catch (e) {
      if (!current()) return;
      loadedEpochRef.current = epoch;
      setError(typeof e === "string" ? e : String(e));
      setBranches([]);
    }
  }, [repoRoot, scope, open, identity, epoch]);

  useEffect(() => {
    if (!open) return;
    setBranches(null);
    setError(null);
    setBusy(busyRef.current ? "working" : null);
    setRemoving(null);
    setCreating(false);
    void load();
    return () => {
      requestRef.current++;
    };
  }, [open, load]);

  const entries = useMemo(
    () =>
      loadedEpochRef.current === epoch && branches
        ? collectWorktrees(branches, repoRoot)
        : null,
    [branches, repoRoot, epoch],
  );

  const handleRemove = async () => {
    if (
      !removing ||
      busyRef.current ||
      !open ||
      !aliveRef.current ||
      removing.isMain ||
      removingEpochRef.current !== epoch ||
      identityRef.current !== identity ||
      currentWorkspaceScopeKey() !== scope
    )
      return;
    busyRef.current = true;
    setBusy(`remove:${removing.path}`);
    try {
      await gitWorktreeRemove(repoRoot, removing.path, true, workspace);
      if (
        !aliveRef.current ||
        identityRef.current !== identity ||
        epochRef.current !== epoch ||
        currentWorkspaceScopeKey() !== scope
      )
        return;
      toast.success(`Removed worktree at ${removing.path}`);
      setRemoving(null);
      await load();
    } catch (e) {
      if (
        aliveRef.current &&
        identityRef.current === identity &&
        epochRef.current === epoch
      )
        errorToast(`Could not remove worktree ${removing.branch}`, e);
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(null);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.75">
              <HugeiconsIcon
                icon={FolderOpenIcon}
                size={15}
                strokeWidth={1.9}
              />
              Worktrees
            </DialogTitle>
            <DialogDescription>
              Linked worktrees of {repoName}. Each one is a separate directory
              sharing the same .git.
            </DialogDescription>
          </DialogHeader>

          <div className="flex max-h-[45vh] min-h-24 flex-col gap-1 overflow-y-auto">
            {entries === null ? (
              <div className="flex items-center gap-2 px-1 py-3 text-[11px] text-muted-foreground">
                <Spinner className="size-3" />
                Loading worktrees…
              </div>
            ) : error ? (
              <div className="px-1 py-3 text-[11px] leading-snug text-destructive">
                {error}
              </div>
            ) : entries.length === 0 ? (
              <div className="px-1 py-3 text-[11px] text-muted-foreground">
                No worktrees.
              </div>
            ) : (
              entries.map((wt) => {
                const removingThis = busy === `remove:${wt.path}`;
                return (
                  <div
                    key={wt.path}
                    className="rounded-lg border border-border/50 px-2.5 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <HugeiconsIcon
                        icon={FolderOpenIcon}
                        size={13}
                        strokeWidth={1.75}
                        className="shrink-0 text-muted-foreground"
                      />
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-[11px]"
                        title={wt.path}
                      >
                        {wt.path}
                      </span>
                      {wt.isMain ? (
                        <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          main
                        </span>
                      ) : null}
                      {removingThis ? (
                        <Spinner className="size-3 shrink-0" />
                      ) : (
                        <>
                          {onOpenPath ? (
                            <button
                              type="button"
                              title="Open in terminal"
                              disabled={busy !== null}
                              onClick={() => onOpenPath(wt.path)}
                              className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <HugeiconsIcon
                                icon={TerminalIcon}
                                size={13}
                                strokeWidth={1.9}
                              />
                            </button>
                          ) : null}
                          {!wt.isMain ? (
                            <button
                              type="button"
                              title="Remove worktree"
                              disabled={busy !== null}
                              onClick={() => {
                                removingEpochRef.current = epoch;
                                setRemoving(wt);
                              }}
                              className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <HugeiconsIcon
                                icon={Delete02Icon}
                                size={13}
                                strokeWidth={1.9}
                              />
                            </button>
                          ) : null}
                        </>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <HugeiconsIcon
                        icon={GitBranchIcon}
                        size={11}
                        strokeWidth={1.75}
                        className="shrink-0 text-muted-foreground/70"
                      />
                      <span className="truncate text-[10.5px] text-muted-foreground">
                        {wt.branch}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => void load()}
            >
              <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.9} />
              Refresh
            </Button>
            <Button disabled={busy !== null} onClick={() => setCreating(true)}>
              <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
              New worktree
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BranchConfirmDialog
        open={open && removing !== null && removingEpochRef.current === epoch}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
        destructive
        busy={busy !== null}
        title="Remove worktree"
        description={
          removing ? (
            <>
              Remove the worktree for{" "}
              <code className="rounded bg-muted/60 px-1 font-mono text-[11px]">
                {removing.branch}
              </code>{" "}
              at {removing.path}? Uncommitted changes in this worktree will be
              discarded.
            </>
          ) : null
        }
        confirmLabel="Remove"
        onConfirm={() => void handleRemove()}
      />

      <WorktreeDialog
        open={open && creating}
        onOpenChange={setCreating}
        repoRoot={repoRoot}
        repoName={repoName}
        branches={branches ?? []}
        onCreated={() => void load()}
      />
    </>
  );
}
