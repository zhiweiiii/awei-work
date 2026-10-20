import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { type GitBranchEntry, type GitRepoHead, native } from "@/lib/native";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  ArrowDown01Icon,
  CloudDownloadIcon,
  Delete02Icon,
  FolderGitTwoIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  PencilEdit02Icon,
  Refresh01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useRef, useState } from "react";
import { errorToast } from "@/lib/errorToast";
import { toast } from "sonner";
import { BranchActionsMenu } from "./BranchActionsMenu";
import { BranchConfirmDialog } from "./BranchConfirmDialog";
import { useRepositoryOperation } from "@/modules/source-control/useRepositoryOperation";
import {
  LOCAL_WORKSPACE,
  workspaceScopeKey,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { CompareBranchesDialog } from "./CompareBranchesDialog";
import { DeleteBranchDialog } from "./DeleteBranchDialog";
import { NewBranchDialog } from "./NewBranchDialog";
import {
  defaultLocalNameForRemote,
  RemoteCheckoutRow,
} from "./RemoteCheckoutRow";
import { RenameBranchDialog } from "./RenameBranchDialog";
import { WorkingTreeDiffDialog } from "./WorkingTreeDiffDialog";
import { WorktreeManagerDialog } from "./WorktreeManagerDialog";

type Props = {
  repos: GitRepoHead[];
  /** Repo whose branch is shown on the trigger. */
  activeRepo: string | null;
  activeBranch: string | null;
  onChangeRepo: (root: string) => void;
  onRescan?: () => void;
  /** Called after a successful checkout so the panel can reload. */
  onCheckedOut?: (repoRoot: string) => void;
  changedCount?: (root: string) => number;
  /** Opens a path in the terminal (worktree "Open in terminal"). */
  onOpenPath?: (path: string) => void;
};

type BranchDialog =
  | { kind: "new"; repoRoot: string }
  | { kind: "rename"; repoRoot: string; branch: GitBranchEntry }
  | { kind: "delete"; repoRoot: string; branch: GitBranchEntry }
  | { kind: "merge-confirm"; repoRoot: string; target: string; current: string }
  | {
      kind: "rebase-confirm";
      repoRoot: string;
      target: string;
      current: string;
    }
  | { kind: "pull-confirm"; repoRoot: string; current: string }
  | { kind: "compare"; repoRoot: string; target: string }
  | { kind: "diff"; repoRoot: string }
  | { kind: "worktrees"; repoRoot: string }
  | null;

type PendingRemote = {
  repoRoot: string;
  remote: string;
  local: string;
  hasLocal: boolean;
};

function shortName(repoRoot: string): string {
  return repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? repoRoot;
}

function currentBranchOf(branches: GitBranchEntry[]): string | null {
  return branches.find((b) => b.isHead)?.name ?? null;
}

/**
 * Repo picker with a hover flyout: hovering a repo opens its branch list to
 * the right. The flyout renders inline (radix sub content is not portaled),
 * so the outer content must not clip it: fixed height + overflow-visible
 * there, and the repo list scrolls in its own inner container instead.
 * Branches are only fetched when a repo's flyout opens.
 */
export function RepoBranchSelector(props: Props) {
  const workspace = LOCAL_WORKSPACE;
  const key = JSON.stringify([
    workspaceScopeKey(workspace),
    props.repos.map((repo) => repo.repoRoot).sort(),
  ]);
  return <ScopedRepoBranchSelector key={key} {...props} />;
}

function ScopedRepoBranchSelector({
  repos,
  activeRepo,
  activeBranch,
  onChangeRepo,
  onRescan,
  onCheckedOut,
  changedCount,
  onOpenPath,
}: Props) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<Record<string, GitBranchEntry[]>>(
    {},
  );
  const workspace = LOCAL_WORKSPACE;
  const { busy, run, isCurrent } = useRepositoryOperation(
    true,
    JSON.stringify(repos.map((repo) => repo.repoRoot).sort()),
  );
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [branchErrors, setBranchErrors] = useState<Record<string, string>>({});
  const [checkoutKey, setCheckingOut] = useState<string | null>(null);
  const checkingOut = busy ? checkoutKey : null;
  // Remote branch being checked out as a new local branch, with the editable
  // local name; null hides the naming row.
  const [pendingRemote, setPendingRemote] = useState<PendingRemote | null>(
    null,
  );
  const [dialog, setDialog] = useState<BranchDialog>(null);
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const [busyLabel, setBusyOp] = useState<string | null>(null);
  const busyOp = busy ? busyLabel : null;
  const protectedBranches = usePreferencesStore((s) => s.protectedBranches);
  const inFlight = useRef(new Map<string, symbol>());

  const loadBranches = useCallback(
    async (repoRoot: string, force = false) => {
      if (!isCurrent() || (!force && inFlight.current.has(repoRoot))) return;
      const request = Symbol();
      inFlight.current.set(repoRoot, request);
      const currentRequest = () =>
        isCurrent() && inFlight.current.get(repoRoot) === request;
      setLoading((current) => new Set(current).add(repoRoot));
      setBranchErrors((current) => {
        const next = { ...current };
        delete next[repoRoot];
        return next;
      });
      try {
        const result = await native.gitListBranches(repoRoot, workspace);
        if (currentRequest())
          setBranches((current) => ({
            ...current,
            [repoRoot]: result.branches,
          }));
      } catch (error) {
        if (currentRequest()) {
          setBranchErrors((current) => ({
            ...current,
            [repoRoot]: String(error),
          }));
          errorToast(
            `Could not list branches for ${shortName(repoRoot)}`,
            error,
          );
        }
      } finally {
        if (currentRequest()) {
          inFlight.current.delete(repoRoot);
          setLoading((current) => {
            const next = new Set(current);
            next.delete(repoRoot);
            return next;
          });
        }
      }
    },
    [isCurrent],
  );

  const checkout = useCallback(
    async (
      repoRoot: string,
      branchName: string,
      kind: "local" | "remote",
      localName?: string,
      label?: string,
    ) => {
      return run(
        (workspace) => {
          setCheckingOut(`${repoRoot}:${branchName}`);
          setBusyOp("checkout");
          return native.gitCheckoutBranch(
            repoRoot,
            branchName,
            localName,
            workspace,
          );
        },
        () => {
          setBranches((current) => {
            const next = { ...current };
            delete next[repoRoot];
            return next;
          });
          void loadBranches(repoRoot, true);
          setOpen(false);
          setPendingRemote(null);
          onChangeRepo(repoRoot);
          onCheckedOut?.(repoRoot);
          toast.success(
            kind === "remote"
              ? `Checked out ${label ?? branchName} as ${localName} in ${shortName(repoRoot)}`
              : `Switched to ${label ?? branchName} in ${shortName(repoRoot)}`,
          );
        },
        `Checkout failed in ${shortName(repoRoot)}`,
      );
    },
    [run, onChangeRepo, onCheckedOut, loadBranches],
  );

  const handleRemoteCheckout = useCallback(async () => {
    if (!pendingRemote) return;
    const { repoRoot, remote, local, hasLocal } = pendingRemote;
    const defaultName = defaultLocalNameForRemote(remote);
    if (hasLocal && local.trim() === defaultName) {
      // Same-named local exists: rust checks it out directly, no new branch.
      await checkout(repoRoot, remote, "local", undefined, defaultName);
    } else {
      await checkout(repoRoot, remote, "remote", local.trim());
    }
  }, [pendingRemote, checkout]);

  const refreshRepo = useCallback(
    (repoRoot: string) => {
      void loadBranches(repoRoot, true);
      onCheckedOut?.(repoRoot);
    },
    [loadBranches, onCheckedOut],
  );

  const checkConfirmation = useCallback(
    async (
      repoRoot: string,
      expected: string | undefined,
      workspace: WorkspaceEnv,
    ) => {
      if (!expected)
        throw new Error("Branches are not loaded; review the operation again");
      const result = await native.gitListBranches(repoRoot, workspace);
      if (!isCurrent() || currentBranchOf(result.branches) !== expected)
        throw new Error("Current branch changed; review the operation again");
    },
    [isCurrent],
  );

  const runPull = useCallback(
    async (repoRoot: string, expected?: string) => {
      return run(
        async (workspace) => {
          setCheckingOut(null);
          setBusyOp("pull");
          await checkConfirmation(repoRoot, expected, workspace);
          if (!isCurrent()) throw new Error("Workspace changed");
          await native.gitPullFfOnly(repoRoot, workspace);
        },
        () => {
          toast.success(`Pulled latest for ${shortName(repoRoot)}`);
          refreshRepo(repoRoot);
        },
        `Pull failed in ${shortName(repoRoot)}`,
        (error) => {
          errorToast("Pull failed", error);
          refreshRepo(repoRoot);
        },
      );
    },
    [run, checkConfirmation, isCurrent, refreshRepo],
  );

  const runMerge = useCallback(
    async (repoRoot: string, target: string, expected?: string) => {
      return run(
        async (workspace) => {
          setCheckingOut(null);
          setBusyOp("merge");
          await checkConfirmation(repoRoot, expected, workspace);
          if (!isCurrent()) throw new Error("Workspace changed");
          const result = await native.gitMerge(
            repoRoot,
            target,
            undefined,
            workspace,
          );
          if (!result.conflicts && !result.upToDate && !result.merged)
            throw new Error(result.message || `Merge of ${target} failed`);
          return result;
        },
        (result) => {
          if (result.conflicts)
            toast.warning(`Merge of ${target} has conflicts`, {
              description:
                "Resolve them in the terminal, then commit the merge.",
            });
          else if (result.upToDate)
            toast.info(`Already up to date with ${target}`);
          else if (result.merged)
            toast.success(`Merged ${target} in ${shortName(repoRoot)}`);
          refreshRepo(repoRoot);
        },
        `Merge failed in ${shortName(repoRoot)}`,
        (error) => {
          errorToast("Merge failed", error);
          refreshRepo(repoRoot);
        },
      );
    },
    [run, checkConfirmation, isCurrent, refreshRepo],
  );

  const runRebase = useCallback(
    async (repoRoot: string, target: string, expected?: string) => {
      return run(
        async (workspace) => {
          setCheckingOut(null);
          setBusyOp("rebase");
          await checkConfirmation(repoRoot, expected, workspace);
          if (!isCurrent()) throw new Error("Workspace changed");
          const result = await native.gitRebase(repoRoot, target, workspace);
          if (!result.ok && !result.conflict)
            throw new Error(result.message || `Rebase onto ${target} failed`);
          return result;
        },
        (result) => {
          if (result.ok)
            toast.success(`Rebased onto ${target} in ${shortName(repoRoot)}`);
          else if (result.conflict)
            toast.warning(`Rebase onto ${target} hit conflicts`, {
              description:
                "Resolve them in the terminal, then continue or abort.",
            });
          refreshRepo(repoRoot);
        },
        `Rebase failed in ${shortName(repoRoot)}`,
        (error) => {
          errorToast("Rebase failed", error);
          refreshRepo(repoRoot);
        },
      );
    },
    [run, checkConfirmation, isCurrent, refreshRepo],
  );

  const handleCreated = useCallback(
    (repoRoot: string, checkedOut: boolean) => {
      if (checkedOut) {
        setBranches((current) => {
          const next = { ...current };
          delete next[repoRoot];
          return next;
        });
        onChangeRepo(repoRoot);
        onCheckedOut?.(repoRoot);
      }
      void loadBranches(repoRoot);
    },
    [loadBranches, onChangeRepo, onCheckedOut],
  );

  const handlePull = useCallback(
    (repoRoot: string) => {
      setOpen(false);
      const current = currentBranchOf(branches[repoRoot] ?? []);
      if (current && protectedBranches.includes(current)) {
        setDialog({ kind: "pull-confirm", repoRoot, current });
      } else {
        void runPull(repoRoot, current ?? undefined);
      }
    },
    [branches, protectedBranches, runPull],
  );

  const handleMerge = useCallback(
    (repoRoot: string, target: string) => {
      setOpen(false);
      const current = currentBranchOf(branches[repoRoot] ?? []);
      if (current && protectedBranches.includes(current)) {
        setDialog({ kind: "merge-confirm", repoRoot, target, current });
      } else {
        void runMerge(repoRoot, target, current ?? undefined);
      }
    },
    [branches, protectedBranches, runMerge],
  );

  const handleRebase = useCallback(
    (repoRoot: string, target: string) => {
      setOpen(false);
      const current = currentBranchOf(branches[repoRoot] ?? []);
      if (current && protectedBranches.includes(current)) {
        setDialog({ kind: "rebase-confirm", repoRoot, target, current });
      } else {
        void runRebase(repoRoot, target, current ?? undefined);
      }
    },
    [branches, protectedBranches, runRebase],
  );

  const handleNewBranch = useCallback((repoRoot: string) => {
    setOpen(false);
    setDialog({ kind: "new", repoRoot });
  }, []);

  const handleRename = useCallback(
    (repoRoot: string, branch: GitBranchEntry) => {
      setOpen(false);
      setDialog({ kind: "rename", repoRoot, branch });
    },
    [],
  );

  const handleDelete = useCallback(
    (repoRoot: string, branch: GitBranchEntry) => {
      setOpen(false);
      setDialog({ kind: "delete", repoRoot, branch });
    },
    [],
  );

  const handleCompare = useCallback((repoRoot: string, target: string) => {
    setOpen(false);
    setDialog({ kind: "compare", repoRoot, target });
  }, []);

  const handleDiff = useCallback((repoRoot: string) => {
    setOpen(false);
    setDialog({ kind: "diff", repoRoot });
  }, []);

  const handleWorktrees = useCallback((repoRoot: string) => {
    setOpen(false);
    setDialog({ kind: "worktrees", repoRoot });
  }, []);

  if (repos.length === 0) return null;

  const activeName = activeRepo ? shortName(activeRepo) : null;
  const confirmState =
    dialog?.kind === "merge-confirm" ||
    dialog?.kind === "rebase-confirm" ||
    dialog?.kind === "pull-confirm"
      ? dialog
      : null;

  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setPendingRemote(null);
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 min-w-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            title="切换仓库或分支"
          >
            <HugeiconsIcon
              icon={FolderGitTwoIcon}
              size={14}
              strokeWidth={1.75}
            />
            <span className="max-w-28 truncate">{activeName ?? "无仓库"}</span>
            {activeBranch ? (
              <>
                <span className="shrink-0 text-muted-foreground/40">/</span>
                <span className="max-w-24 truncate text-foreground/80">
                  {activeBranch}
                </span>
              </>
            ) : null}
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={10}
              strokeWidth={2}
              className="shrink-0 opacity-60"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={4}
          className="flex h-80 w-72 flex-col overflow-visible rounded-xl border border-border/40 bg-popover/90 p-1 shadow-lg backdrop-blur-md"
          style={{ maxHeight: "none" }}
        >
          <DropdownMenuLabel className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
            <HugeiconsIcon
              icon={FolderGitTwoIcon}
              size={12}
              strokeWidth={1.75}
            />
            <span className="flex-1">仓库 ({repos.length})</span>
            {onRescan && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-5 rounded"
                title="重新扫描"
                onClick={(e) => {
                  e.stopPropagation();
                  onRescan();
                }}
              >
                <HugeiconsIcon icon={Refresh01Icon} size={11} strokeWidth={2} />
              </Button>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {repos.map((repo) => {
              const isActive = repo.repoRoot === activeRepo;
              const count = changedCount?.(repo.repoRoot);
              const repoBranches = branches[repo.repoRoot] ?? [];
              return (
                <DropdownMenuSub key={repo.repoRoot}>
                  <DropdownMenuSubTrigger
                    onPointerEnter={() => void loadBranches(repo.repoRoot)}
                    onFocus={() => void loadBranches(repo.repoRoot)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5",
                      isActive && "bg-accent text-accent-foreground",
                    )}
                  >
                    <HugeiconsIcon
                      icon={FolderGitTwoIcon}
                      size={13}
                      strokeWidth={1.75}
                      className="shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs">
                        {shortName(repo.repoRoot)}
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {repo.branch}
                      </div>
                    </div>
                    {count !== undefined && count > 0 && (
                      <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {count}
                      </span>
                    )}
                    {isActive && (
                      <HugeiconsIcon
                        icon={Tick02Icon}
                        size={13}
                        strokeWidth={2.25}
                        className="shrink-0 text-primary"
                      />
                    )}
                  </DropdownMenuSubTrigger>
                  <BranchFlyout
                    repoRoot={repo.repoRoot}
                    branches={repoBranches}
                    loading={loading.has(repo.repoRoot)}
                    error={branchErrors[repo.repoRoot]}
                    onRetry={() => void loadBranches(repo.repoRoot)}
                    checkingOut={checkingOut}
                    busyOp={busyOp}
                    pendingRemote={
                      pendingRemote?.repoRoot === repo.repoRoot
                        ? pendingRemote
                        : null
                    }
                    onPull={() => handlePull(repo.repoRoot)}
                    onMerge={(target) => handleMerge(repo.repoRoot, target)}
                    onRebase={(target) => handleRebase(repo.repoRoot, target)}
                    onCompare={(target) => handleCompare(repo.repoRoot, target)}
                    onDiff={() => handleDiff(repo.repoRoot)}
                    onNewBranch={() => handleNewBranch(repo.repoRoot)}
                    onWorktrees={() => handleWorktrees(repo.repoRoot)}
                    onSelectLocal={(name) =>
                      void checkout(repo.repoRoot, name, "local")
                    }
                    onRemoteSelect={(branch) =>
                      setPendingRemote({
                        repoRoot: repo.repoRoot,
                        remote: branch.name,
                        local: defaultLocalNameForRemote(branch.name),
                        hasLocal: branch.hasLocal,
                      })
                    }
                    onRemoteCheckout={() => void handleRemoteCheckout()}
                    onCancelRemote={() => setPendingRemote(null)}
                    onRemoteLocalChange={(value) =>
                      setPendingRemote((current) =>
                        current ? { ...current, local: value } : current,
                      )
                    }
                    onRename={(branch) => handleRename(repo.repoRoot, branch)}
                    onDelete={(branch) => handleDelete(repo.repoRoot, branch)}
                  />
                </DropdownMenuSub>
              );
            })}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <NewBranchDialog
        open={dialog?.kind === "new"}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        repoRoot={dialog?.kind === "new" ? dialog.repoRoot : ""}
        repoName={dialog?.kind === "new" ? shortName(dialog.repoRoot) : ""}
        defaultStartPoint={
          dialog?.kind === "new"
            ? (currentBranchOf(branches[dialog.repoRoot] ?? []) ?? "HEAD")
            : ""
        }
        onCreated={(checkedOut) => {
          if (dialog?.kind === "new")
            handleCreated(dialog.repoRoot, checkedOut);
        }}
      />
      <RenameBranchDialog
        open={dialog?.kind === "rename"}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        repoRoot={dialog?.kind === "rename" ? dialog.repoRoot : ""}
        repoName={dialog?.kind === "rename" ? shortName(dialog.repoRoot) : ""}
        branchName={dialog?.kind === "rename" ? dialog.branch.name : ""}
        onRenamed={() => {
          if (dialog?.kind === "rename") refreshRepo(dialog.repoRoot);
        }}
      />
      <DeleteBranchDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        repoRoot={dialog?.kind === "delete" ? dialog.repoRoot : ""}
        repoName={dialog?.kind === "delete" ? shortName(dialog.repoRoot) : ""}
        branch={dialog?.kind === "delete" ? dialog.branch : null}
        onDeleted={() => {
          if (dialog?.kind === "delete") refreshRepo(dialog.repoRoot);
        }}
      />
      <BranchConfirmDialog
        busy={busy}
        open={confirmState !== null}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        title={`受保护分支 ${confirmState?.current ?? ""}`.trim()}
        description="该分支受保护，此操作可能重写或破坏其历史。仍要继续吗？"
        confirmLabel={
          confirmState?.kind === "merge-confirm"
            ? "合并"
            : confirmState?.kind === "rebase-confirm"
              ? "变基"
              : "拉取"
        }
        onConfirm={async () => {
          if (!confirmState || busy || !isCurrent()) return;
          let completed: boolean;
          if (confirmState.kind === "merge-confirm") {
            completed = await runMerge(
              confirmState.repoRoot,
              confirmState.target,
              confirmState.current,
            );
          } else if (confirmState.kind === "rebase-confirm") {
            completed = await runRebase(
              confirmState.repoRoot,
              confirmState.target,
              confirmState.current,
            );
          } else {
            completed = await runPull(
              confirmState.repoRoot,
              confirmState.current,
            );
          }
          if (completed && isCurrent() && dialogRef.current === confirmState)
            setDialog(null);
        }}
      />
      <CompareBranchesDialog
        open={dialog?.kind === "compare"}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        repoRoot={dialog?.kind === "compare" ? dialog.repoRoot : ""}
        repoName={dialog?.kind === "compare" ? shortName(dialog.repoRoot) : ""}
        left={
          dialog?.kind === "compare"
            ? (currentBranchOf(branches[dialog.repoRoot] ?? []) ?? "HEAD")
            : ""
        }
        right={dialog?.kind === "compare" ? dialog.target : ""}
      />
      <WorkingTreeDiffDialog
        open={dialog?.kind === "diff"}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        repoRoot={dialog?.kind === "diff" ? dialog.repoRoot : ""}
        repoName={dialog?.kind === "diff" ? shortName(dialog.repoRoot) : ""}
        refName={
          dialog?.kind === "diff"
            ? (currentBranchOf(branches[dialog.repoRoot] ?? []) ?? "HEAD")
            : ""
        }
      />
      <WorktreeManagerDialog
        open={dialog?.kind === "worktrees"}
        onOpenChange={(next) => {
          if (!next) {
            if (dialog?.kind === "worktrees") {
              void loadBranches(dialog.repoRoot);
            }
            setDialog(null);
          }
        }}
        repoRoot={dialog?.kind === "worktrees" ? dialog.repoRoot : ""}
        repoName={
          dialog?.kind === "worktrees" ? shortName(dialog.repoRoot) : ""
        }
        onOpenPath={onOpenPath}
      />
    </>
  );
}

function BranchFlyout({
  repoRoot,
  branches,
  loading,
  error,
  onRetry,
  checkingOut,
  busyOp,
  pendingRemote,
  onPull,
  onMerge,
  onRebase,
  onCompare,
  onDiff,
  onNewBranch,
  onWorktrees,
  onSelectLocal,
  onRemoteSelect,
  onRemoteCheckout,
  onCancelRemote,
  onRemoteLocalChange,
  onRename,
  onDelete,
}: {
  repoRoot: string;
  branches: GitBranchEntry[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  checkingOut: string | null;
  busyOp: string | null;
  pendingRemote: PendingRemote | null;
  onPull: () => void;
  onMerge: (target: string) => void;
  onRebase: (target: string) => void;
  onCompare: (target: string) => void;
  onDiff: () => void;
  onNewBranch: () => void;
  onWorktrees: () => void;
  onSelectLocal: (branchName: string) => void;
  onRemoteSelect: (branch: GitBranchEntry) => void;
  onRemoteCheckout: () => void;
  onCancelRemote: () => void;
  onRemoteLocalChange: (value: string) => void;
  onRename: (branch: GitBranchEntry) => void;
  onDelete: (branch: GitBranchEntry) => void;
}) {
  const current = currentBranchOf(branches);
  return (
    <DropdownMenuSubContent
      sideOffset={4}
      collisionPadding={16}
      className="flex h-80 w-64 flex-col overflow-visible rounded-xl border border-border/40 bg-popover/90 p-1 shadow-lg backdrop-blur-md"
      style={{ maxHeight: "none" }}
    >
      <DropdownMenuLabel className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
        <HugeiconsIcon icon={FolderGitTwoIcon} size={12} strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate">{shortName(repoRoot)}</span>
        <BranchActionsMenu
          currentBranch={current}
          branches={branches}
          busy={busyOp !== null}
          onPull={onPull}
          onMerge={onMerge}
          onRebase={onRebase}
          onCompare={onCompare}
          onDiff={onDiff}
        />
      </DropdownMenuLabel>
      <DropdownMenuItem
        disabled={busyOp !== null}
        onSelect={(e) => {
          e.preventDefault();
          onNewBranch();
        }}
        className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs"
      >
        <HugeiconsIcon
          icon={GitBranchPlusIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        新建分支…
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={busyOp !== null}
        onSelect={(e) => {
          e.preventDefault();
          onWorktrees();
        }}
        className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs"
      >
        <HugeiconsIcon
          icon={FolderOpenIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        工作树…
      </DropdownMenuItem>
      <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && branches.length === 0 ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            加载分支中…
          </div>
        ) : null}
        {pendingRemote ? (
          <RemoteCheckoutRow
            remote={pendingRemote.remote}
            value={pendingRemote.local}
            hasLocal={pendingRemote.hasLocal}
            onChange={onRemoteLocalChange}
            busy={checkingOut !== null}
            onConfirm={onRemoteCheckout}
            onCancel={onCancelRemote}
          />
        ) : null}
        {error ? (
          <div className="px-2 py-2 text-[11px] text-destructive">
            {error}
            <Button
              size="xs"
              variant="ghost"
              onClick={onRetry}
              disabled={loading}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {(!loading || branches.length > 0) &&
          renderBranches(
            branches,
            checkingOut ?? (busyOp ? "operation" : null),
            repoRoot,
            onSelectLocal,
            onRemoteSelect,
            onRename,
            onDelete,
          )}
      </div>
    </DropdownMenuSubContent>
  );
}

function renderBranches(
  branches: GitBranchEntry[],
  checkingOut: string | null,
  repoRoot: string,
  onSelectLocal: (branchName: string) => void,
  onRemoteSelect: (branch: GitBranchEntry) => void,
  onRename: (branch: GitBranchEntry) => void,
  onDelete: (branch: GitBranchEntry) => void,
) {
  const locals = branches.filter((b) => b.kind !== "remote");
  const remotes = branches.filter((b) => b.kind === "remote");
  if (branches.length === 0) {
    return (
      <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
        无分支
      </div>
    );
  }
  return (
    <>
      {locals.length > 0 ? (
        <DropdownMenuLabel className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
          本地分支
        </DropdownMenuLabel>
      ) : null}
      {locals.map((branch) => (
        <BranchItem
          key={`l:${branch.name}`}
          branch={branch}
          busy={checkingOut === `${repoRoot}:${branch.name}`}
          blocked={checkingOut !== null}
          onSelect={() => onSelectLocal(branch.name)}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
      {remotes.length > 0 ? (
        <>
          <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />
          <DropdownMenuLabel className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
            远程分支
          </DropdownMenuLabel>
        </>
      ) : null}
      {remotes.map((branch) => (
        <BranchItem
          key={`r:${branch.name}`}
          branch={branch}
          busy={checkingOut === `${repoRoot}:${branch.name}`}
          blocked={checkingOut !== null}
          onSelect={() => onRemoteSelect(branch)}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

function BranchItem({
  branch,
  busy,
  blocked,
  onSelect,
  onRename,
  onDelete,
}: {
  branch: GitBranchEntry;
  busy: boolean;
  blocked: boolean;
  onSelect: () => void;
  onRename?: (branch: GitBranchEntry) => void;
  onDelete?: (branch: GitBranchEntry) => void;
}) {
  const remote = branch.kind === "remote";
  const showRename =
    onRename !== undefined && branch.kind === "local" && !blocked;
  const showDelete =
    onDelete !== undefined &&
    branch.kind !== "worktree" &&
    !branch.isHead &&
    !blocked;
  return (
    <DropdownMenuItem
      disabled={blocked}
      onSelect={(e) => {
        // Keep the menu open long enough for the spinner to be visible.
        e.preventDefault();
        onSelect();
      }}
      className="group flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5"
    >
      {busy ? (
        <Spinner className="size-3 shrink-0" />
      ) : (
        <HugeiconsIcon
          icon={remote ? CloudDownloadIcon : GitBranchIcon}
          size={12}
          strokeWidth={1.75}
          className={cn(
            "shrink-0",
            remote ? "text-sky-500/80" : "text-muted-foreground",
          )}
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs">{branch.name}</span>
        {branch.upstream ? (
          <span className="truncate text-[9.5px] text-muted-foreground/60">
            → {branch.upstream}
          </span>
        ) : null}
      </span>
      {branch.isHead ? (
        <HugeiconsIcon
          icon={Tick02Icon}
          size={12}
          strokeWidth={2.25}
          className="shrink-0 text-primary"
        />
      ) : null}
      {branch.kind === "worktree" ? (
        <span className="shrink-0 text-[9px] text-muted-foreground/70">
          工作树
        </span>
      ) : null}
      {showRename || showDelete ? (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {showRename ? (
            <button
              type="button"
              title={`重命名 ${branch.name}`}
              className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onRename(branch);
              }}
            >
              <HugeiconsIcon
                icon={PencilEdit02Icon}
                size={11}
                strokeWidth={1.9}
              />
            </button>
          ) : null}
          {showDelete ? (
            <button
              type="button"
              title={
                remote ? `删除远程分支 ${branch.name}` : `删除 ${branch.name}`
              }
              className="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(branch);
              }}
            >
              <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.9} />
            </button>
          ) : null}
        </div>
      ) : null}
    </DropdownMenuItem>
  );
}
