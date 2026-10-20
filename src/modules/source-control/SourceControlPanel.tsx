import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorToast } from "@/lib/errorToast";
import { type GitRepoHead, type GitStatusSnapshot, native } from "@/lib/native";
import { cn } from "@/lib/utils";
import { useAsyncQuery } from "@/modules/command-palette/hooks/useAsyncQuery";
import {
  copyToClipboard,
  revealInFinder,
} from "@/modules/explorer/lib/contextActions";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  COMPACT_CONTENT,
  COMPACT_ITEM,
} from "@/modules/explorer/lib/menuItemClass";
import { joinPath } from "@/modules/explorer/lib/useFileTree";
import { LOCAL_WORKSPACE, workspaceScopeKey } from "@/modules/workspace";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  CheckmarkCircle01Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudDownloadIcon,
  Download01Icon,
  Edit02Icon,
  Folder01Icon,
  FolderCloudIcon,
  FolderGitTwoIcon,
  GitBranchIcon,
  Refresh01Icon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { PushDialog } from "./PushDialog";
import {
  defaultLocalNameForRemote,
  RemoteCheckoutRow,
} from "./RemoteCheckoutRow";
import {
  repositoryTargetIsPending,
  type SourceControlRepositoryTarget,
} from "./repositoryTarget";
import type {
  PushAdvancedOptions,
  PushAllResult,
  PushPlan,
  RepoSyncItem,
  SyncProgress,
} from "./useMultiRepoSourceControl";
import type { RepoStatusEntry } from "./useRepoStatuses";
import type { SourceControlSummary } from "./useSourceControl";
import { changeTreeRows, type ChangeTreeRow } from "./lib/changeTree";
import {
  type CheckState,
  type SourceControlFileEntry,
  type SourceControlPanelAction,
  useSourceControlPanel,
} from "./useSourceControlPanel";

type Props = {
  open: boolean;
  sourceControl: SourceControlSummary;
  onOpenGitGraph?: () => void;
  onOpenDiff: (input: {
    path: string;
    repoRoot: string;
    mode: "+" | "-";
    originalPath: string | null;
    title?: string;
  }) => void;
  onOpenFile?: (absolutePath: string) => void;
  /** Paste text into the agent running in the current command line. Returns
   *  false when there is none, which is when the button has nothing to do. */
  onSendToAgent?: (text: string) => boolean;
  onNavigateToPath?: (path: string) => void;
  repositoryTarget: SourceControlRepositoryTarget;
  onFollowRepositoryContext: () => void;
  /** Optional extra content rendered in the panel header (e.g. multi-repo selector). */
  headerExtra?: ReactNode;
  /** Repos discovered in the workspace; >1 groups Changes and batches Sync. */
  repos?: GitRepoHead[];
  /** Per-repo snapshots owned by the multi-repo layer (grouped list + badges). */
  repoStatusEntries?: RepoStatusEntry[];
  applyRepoStatus?: (
    repoRoot: string,
    updater: (status: GitStatusSnapshot) => GitStatusSnapshot,
  ) => void;
  refreshRepoStatus?: (repoRoot: string) => Promise<void>;
  refreshAllRepoStatuses?: () => Promise<void>;
  /** Live per-repo Sync state; rendered above the change list while present. */
  syncProgress?: SyncProgress | null;
  onDismissSyncProgress?: () => void;
  /** Survey what a push would send, for the confirmation dialog. */
  buildPushPlan?: () => Promise<PushPlan>;
  /** Push with options (force) via the advanced push dialog. */
  pushAllAdvanced?: (
    plan: PushPlan,
    options: PushAdvancedOptions,
  ) => Promise<PushAllResult>;
  /** Open the remote manager for the active repo. */
  onManageRemotes?: () => void;
  /** Open the clone dialog (used from the no-repo state). */
  onCloneRepository?: () => void;
};

function syncPhaseText(phase: RepoSyncItem["phase"]): {
  text: string;
  tone: "muted" | "active" | "good" | "warn" | "bad";
} {
  switch (phase.kind) {
    case "pending":
      return { text: "Waiting", tone: "muted" };
    case "fetching":
      return { text: "Fetching…", tone: "active" };
    case "pulling":
      return {
        text: `Pulling ${phase.commits}…`,
        tone: "active",
      };
    case "pulled":
      return {
        text: `Pulled ${phase.commits} ${phase.commits === 1 ? "commit" : "commits"}`,
        tone: "good",
      };
    case "up-to-date":
      return { text: "Up to date", tone: "muted" };
    case "no-upstream":
      return { text: "No upstream", tone: "warn" };
    case "diverged":
      return { text: "Diverged — resolve manually", tone: "warn" };
    case "failed":
      return { text: phase.error, tone: "bad" };
  }
}

const SYNC_TONE_CLASS = {
  muted: "text-muted-foreground/70",
  active: "text-foreground/80",
  good: "text-emerald-500",
  warn: "text-amber-500",
  bad: "text-destructive",
} as const;

function SyncProgressList({
  progress,
  onDismiss,
}: {
  progress: SyncProgress;
  onDismiss?: () => void;
}) {
  const done = progress.items.filter(
    (i) =>
      i.phase.kind !== "pending" &&
      i.phase.kind !== "fetching" &&
      i.phase.kind !== "pulling",
  ).length;
  return (
    <div className="shrink-0 border-b border-border/50 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        {progress.running ? <Spinner className="size-3" /> : null}
        <span className="text-[11px] font-medium text-foreground/85">
          {progress.running
            ? `Syncing ${done + 1}/${progress.items.length}`
            : `Synced ${progress.items.length} repos`}
        </span>
        {!progress.running && onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="ml-auto cursor-pointer rounded px-1 text-[10px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          >
            Dismiss
          </button>
        ) : null}
      </div>
      <ul className="flex flex-col gap-0.5">
        {progress.items.map((item) => {
          const { text, tone } = syncPhaseText(item.phase);
          return (
            <li
              key={item.repoRoot}
              className="flex items-center gap-2 text-[10.5px]"
            >
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {item.name}
              </span>
              <span className={cn("shrink-0 truncate", SYNC_TONE_CLASS[tone])}>
                {text}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const SOURCE_CONTROL_TOOLTIP_CLASS =
  "border border-border/70 bg-zinc-950 text-zinc-100 shadow-lg shadow-black/30 dark:border-border/60 dark:bg-zinc-950 dark:text-zinc-100";

const ROW_HEIGHTS = {
  banner: 32,
  header: 30,
  repo: 26,
  folder: 24,
  entry: 30,
} as const;

type RowDescriptor =
  | { kind: "banner-diverged"; key: string }
  | {
      kind: "repo-header";
      key: string;
      label: string;
      count: number;
      collapsed: boolean;
    }
  | { kind: "list-header"; key: string; count: number }
  | ChangeTreeRow;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function upstreamBadgeLabel(upstream: string | null | undefined): string {
  if (!upstream) return "No upstream";
  return upstream;
}

function statusAccent(code: string): string {
  switch (code) {
    case "A":
      return "bg-emerald-500/85";
    case "U":
      return "bg-teal-500/85";
    case "M":
      return "bg-amber-500/85";
    case "D":
      return "bg-rose-500/85";
    case "R":
      return "bg-sky-500/85";
    default:
      return "bg-muted-foreground/40";
  }
}

function checkboxValue(state: CheckState): boolean | "indeterminate" {
  if (state === "checked") return true;
  if (state === "indeterminate") return "indeterminate";
  return false;
}

function BranchDropdown({
  repoRoot,
  repoLabel,
  displayRepoRoot,
  repositoryTarget,
  onFollowRepositoryContext,
  onNavigateToPath,
  onRefresh,
  runAction,
  actionBusy,
}: {
  repoRoot: string | null;
  repoLabel: string;
  displayRepoRoot: string | null;
  repositoryTarget: SourceControlRepositoryTarget;
  onFollowRepositoryContext: () => void;
  onNavigateToPath?: (path: string) => void;
  onRefresh: () => void;
  runAction: SourceControlPanelAction;
  actionBusy: string | null;
}) {
  const [open, setOpen] = useState(false);
  const workspace = LOCAL_WORKSPACE;
  const [pendingRemote, setPendingRemote] = useState<{
    remote: string;
    local: string;
  } | null>(null);
  const readBranches = useCallback(async () => {
    if (!repoRoot) return [];
    return (await native.gitListBranches(repoRoot, workspace)).branches;
  }, [repoRoot]);
  const query = useAsyncQuery({
    enabled: open && !!repoRoot,
    term: "",
    minLength: 0,
    debounceMs: 0,
    scopeKey: JSON.stringify([repoRoot, workspaceScopeKey(workspace)]),
    run: readBranches,
  });
  const { results: branches, loading, error } = query;
  const checkingOut = actionBusy !== null;
  const checkout = useCallback(
    async (branch: string, localName?: string) => {
      if (!repoRoot) return;
      const succeeded = await runAction(
        "checkout",
        async (operationWorkspace, ensureCurrent) => {
          await native.gitCheckoutBranch(
            repoRoot,
            branch,
            localName,
            operationWorkspace,
          );
          ensureCurrent();
        },
      );
      if (succeeded) {
        setPendingRemote(null);
        setOpen(false);
        onRefresh();
      }
    },
    [repoRoot, runAction, onRefresh],
  );
  const handleCheckout = useCallback(
    (branch: string) => checkout(branch),
    [checkout],
  );
  const handleRemoteCheckout = useCallback(async () => {
    if (!pendingRemote?.local.trim()) return;
    await checkout(pendingRemote.remote, pendingRemote.local.trim());
  }, [checkout, pendingRemote]);

  const localBranches = useMemo(
    () => branches.filter((b) => b.kind === "local"),
    [branches],
  );
  const remotes = useMemo(
    () => branches.filter((b) => b.kind === "remote"),
    [branches],
  );
  const worktrees = useMemo(
    () => branches.filter((b) => b.kind === "worktree"),
    [branches],
  );

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (checkingOut) return;
        setOpen(next);
        if (!next) setPendingRemote(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={checkingOut}
          title={displayRepoRoot ?? repoLabel}
          className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md bg-foreground/5 px-2 py-1 text-[11.5px] font-medium leading-none text-foreground transition-colors hover:bg-foreground/10 disabled:cursor-default disabled:opacity-70"
        >
          <HugeiconsIcon
            icon={FolderGitTwoIcon}
            size={12}
            strokeWidth={1.9}
            className="shrink-0 text-muted-foreground"
          />
          {displayRepoRoot ? (
            <>
              <span className="max-w-22 truncate">
                {basename(displayRepoRoot)}
              </span>
              <span className="text-muted-foreground/60">/</span>
            </>
          ) : null}
          <span className="max-w-24 truncate">{repoLabel}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {displayRepoRoot ? (
          <>
            <DropdownMenuLabel className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
              Repository
            </DropdownMenuLabel>
            <div
              className="truncate px-2 pb-1.5 text-[11px] text-muted-foreground"
              title={displayRepoRoot}
            >
              {displayRepoRoot}
            </div>
            {repositoryTarget.mode === "fixed" ? (
              <DropdownMenuItem
                onSelect={() => {
                  onFollowRepositoryContext();
                  setOpen(false);
                }}
                className="cursor-pointer text-[12px]"
              >
                Follow Active Context
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
          </>
        ) : null}
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            Loading branches…
          </div>
        ) : error ? (
          <div className="px-3 py-3 text-[11px] leading-snug text-destructive">
            {error}
            <Button size="xs" variant="ghost" onClick={query.retry}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            {pendingRemote ? (
              <>
                <RemoteCheckoutRow
                  remote={pendingRemote.remote}
                  value={pendingRemote.local}
                  onChange={(value) =>
                    setPendingRemote((current) =>
                      current ? { ...current, local: value } : current,
                    )
                  }
                  busy={checkingOut}
                  onConfirm={() => void handleRemoteCheckout()}
                  onCancel={() => setPendingRemote(null)}
                />
                <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />
              </>
            ) : null}
            {localBranches.length > 0 && (
              <>
                <DropdownMenuLabel className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
                  Local Branches
                </DropdownMenuLabel>
                <DropdownMenuGroup>
                  {localBranches.map((b) => (
                    <DropdownMenuItem
                      key={b.name}
                      disabled={checkingOut || b.isHead}
                      onSelect={() => void handleCheckout(b.name)}
                      className="flex cursor-pointer items-center gap-2 text-[12px]"
                    >
                      {b.isHead ? (
                        <HugeiconsIcon
                          icon={Tick02Icon}
                          size={14}
                          strokeWidth={1.8}
                          className="shrink-0"
                        />
                      ) : (
                        <span className="w-3.5 shrink-0" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{b.name}</span>
                      {b.upstream ? (
                        <span className="shrink-0 truncate text-[10px] text-muted-foreground/60">
                          → {b.upstream}
                        </span>
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
            {remotes.length > 0 && (
              <>
                {(localBranches.length > 0 || pendingRemote) && (
                  <DropdownMenuSeparator />
                )}
                <DropdownMenuLabel className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
                  Remote Branches: checkout as a new local branch
                </DropdownMenuLabel>
                <DropdownMenuGroup>
                  {remotes.map((b) => (
                    <DropdownMenuItem
                      key={b.name}
                      onSelect={(e) => {
                        e.preventDefault();
                        setPendingRemote({
                          remote: b.name,
                          local: defaultLocalNameForRemote(b.name),
                        });
                      }}
                      className="flex cursor-pointer items-center gap-2 text-[12px]"
                    >
                      <HugeiconsIcon
                        icon={CloudDownloadIcon}
                        size={13}
                        strokeWidth={1.8}
                        className="shrink-0 text-sky-500/80"
                      />
                      <span className="min-w-0 flex-1 truncate">{b.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
            {worktrees.length > 0 && (
              <>
                {localBranches.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
                  Worktrees
                </DropdownMenuLabel>
                <DropdownMenuGroup>
                  {worktrees.map((b) => (
                    <DropdownMenuItem
                      key={b.worktreePath ?? b.name}
                      onSelect={() => {
                        if (b.worktreePath && onNavigateToPath) {
                          onNavigateToPath(b.worktreePath);
                        }
                      }}
                      className="flex cursor-pointer items-center gap-2 text-[12px]"
                    >
                      <HugeiconsIcon
                        icon={Folder01Icon}
                        size={14}
                        strokeWidth={1.5}
                        className="shrink-0 text-muted-foreground"
                      />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate">{b.name}</span>
                        {b.worktreePath && (
                          <span className="truncate text-[10px] text-muted-foreground">
                            {b.worktreePath}
                          </span>
                        )}
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
            {branches.length === 0 && (
              <div className="px-3 py-3 text-[11px] text-muted-foreground">
                No branches found.
              </div>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const SourceControlPanel = memo(function SourceControlPanel(
  props: Props,
) {
  const workspace = LOCAL_WORKSPACE;
  const scopeKey = JSON.stringify([
    workspaceScopeKey(workspace),
    props.sourceControl.contextPath,
    props.sourceControl.repo?.repoRoot,
    props.sourceControl.status?.branch,
  ]);
  return <ScopedSourceControlPanel key={scopeKey} {...props} />;
});

function ScopedSourceControlPanel({
  open,
  sourceControl,
  onOpenGitGraph,
  onOpenDiff,
  onOpenFile,
  onSendToAgent,
  onNavigateToPath,
  repositoryTarget,
  onFollowRepositoryContext,
  headerExtra,
  repos,
  repoStatusEntries,
  applyRepoStatus,
  refreshRepoStatus,
  refreshAllRepoStatuses,
  syncProgress,
  onDismissSyncProgress,
  buildPushPlan,
  pushAllAdvanced,
  onManageRemotes,
  onCloneRepository,
}: Props) {
  const repoList = useMemo(() => repos ?? [], [repos]);
  const [pushPlan, setPushPlan] = useState<PushPlan | null>(null);
  const repoCount = repoList.length;
  const scm = useSourceControlPanel(
    open,
    sourceControl,
    onOpenDiff,
    repoList,
    {
      entries: repoStatusEntries ?? [],
      applyStatus: applyRepoStatus ?? (() => {}),
      refreshRepo: refreshRepoStatus ?? (async () => {}),
      refreshAll: refreshAllRepoStatuses ?? (async () => {}),
    },
    useMemo(
      () => ({
        buildPushPlan,
        onPreviewPush: setPushPlan,
      }),
      [buildPushPlan],
    ),
  );
  const refreshAnimationRef = useRef<number | null>(null);
  const [refreshAnimating, setRefreshAnimating] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  // Keys of repo/folder groups collapsed in the changes list.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );

  const toggleCollapsedGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (refreshAnimationRef.current) {
        window.clearTimeout(refreshAnimationRef.current);
      }
    };
  }, []);

  const fixedTargetPending = repositoryTargetIsPending({
    target: repositoryTarget,
    loadedContextPath: sourceControl.contextPath,
    loadedRepoRoot: sourceControl.repo?.repoRoot ?? null,
    isLoading: sourceControl.isLoading,
  });
  const panelState = fixedTargetPending ? "loading" : scm.panelState;
  const isRefreshing = panelState === "loading";
  const repoLabel = useMemo(() => {
    if (fixedTargetPending) return "Loading";
    if (!scm.status) return "Source Control";
    return scm.status.isDetached ? "detached" : scm.status.branch;
  }, [fixedTargetPending, scm.status]);

  const commitShortcut = "Ctrl+Enter";
  // stagedEntries covers the active repo only; fileEntries spans every repo, so
  // commit stays enabled when the staged work sits in another group.
  const stagedRepoCount =
    scm.repoGroups.length > 0
      ? scm.repoGroups.filter((g) => g.files.some((f) => f.staged)).length
      : scm.stagedEntries.length > 0
        ? 1
        : 0;
  const canCommit =
    stagedRepoCount > 0 &&
    scm.commitMessage.trim().length > 0 &&
    !fixedTargetPending &&
    !scm.actionBusy;
  const commitDisabledReason = scm.actionBusy
    ? "Wait for the current Git action to finish."
    : stagedRepoCount === 0
      ? "Stage changes to enable commit."
      : scm.commitMessage.trim().length === 0
        ? "Enter a commit message."
        : null;
  const commitHint = canCommit
    ? `Commit with ${commitShortcut}.`
    : (commitDisabledReason ?? `Commit with ${commitShortcut}.`);
  const PULL_COMMIT_PUSH_HINT =
    "Pull first (fast-forward only), then commit and push. Nothing is committed if the pull declines.";
  const commitAndPushHint = canCommit
    ? PULL_COMMIT_PUSH_HINT
    : (commitDisabledReason ?? PULL_COMMIT_PUSH_HINT);
  const pushHint = scm.pushHint ?? "Push is unavailable right now.";
  const pushDisabledReason = fixedTargetPending
    ? "Wait for the selected repository to finish loading."
    : scm.actionBusy
      ? "Wait for the current Git action to finish."
      : pushHint;
  // Aggregate, like changedCount: the staged count under the commit box has to
  // match what Commit will actually include across every repo.
  const stagedCount = scm.fileEntries.filter((f) => f.staged).length;

  const planLoading = scm.actionBusy === "push-preview";
  const pullBusy = scm.actionBusy === "pull";
  const draftBusy = scm.actionBusy === "draft";
  const rowIdPrefix = useId();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* Hand the staged diff to the agent and ask it for the commit message.
     The patch is what a message has to be written from; a list of file names
     is not enough to say WHY something changed. Multi-repo sends each repo's
     patch under its own heading, because one message per repo is what the
     commit flow will ask for.

     Sent without a trailing newline so the prompt lands in the agent's input
     unsent: the user gets to add context before pressing enter. */
  const sendChangesToAgent = useCallback(async () => {
    if (!onSendToAgent) {
      toast.error("请先打开 agent");
      return;
    }
    const roots =
      scm.repoGroups.length > 0
        ? scm.repoGroups
            .filter((g) => g.files.some((f) => f.staged))
            .map((g) => ({ repoRoot: g.repoRoot, name: g.name }))
        : scm.repo
          ? [{ repoRoot: scm.repo.repoRoot, name: basename(scm.repo.repoRoot) }]
          : [];
    if (roots.length === 0) return;
    await scm.runAction("draft", async (workspace, ensureCurrent) => {
      const parts: string[] = [];
      let patchSize = 0;
      for (const r of roots) {
        const res = await native.gitDiff(r.repoRoot, null, true, workspace);
        ensureCurrent();
        const patch = res.diffText.trim();
        if (!patch) continue;
        patchSize += patch.length;
        if (patchSize > 512 * 1024)
          throw new Error(
            "Staged changes are too large to send. Select fewer files first.",
          );
        parts.push(roots.length > 1 ? `### ${r.name}\n\n${patch}` : patch);
      }
      if (parts.length === 0) {
        toast.error("勾选的变更没有可读的差异");
        return;
      }
      const body = [
        "根据以下 git 变更内容，生成一条提交信息（commit message）：",
        "",
        "```diff",
        parts.join("\n\n"),
        "```",
      ].join("\n");
      if (!onSendToAgent(body)) return;
      toast.success("已发送到 agent");
    });
  }, [onSendToAgent, scm.repoGroups, scm.repo, scm.runAction]);
  const changedCount = scm.fileEntries.length;
  const pushStatusLabel = upstreamBadgeLabel(scm.status?.upstream);
  const hasUpstream = !!scm.status?.upstream;
  const isDiverged =
    !!scm.status && scm.status.ahead > 0 && scm.status.behind > 0;

  const canPull =
    hasUpstream &&
    !!scm.status &&
    scm.status.behind > 0 &&
    !isDiverged &&
    !fixedTargetPending &&
    !scm.actionBusy &&
    !sourceControl.busyAction &&
    !pullBusy;
  const canFetch =
    hasUpstream &&
    !fixedTargetPending &&
    !scm.actionBusy &&
    !sourceControl.busyAction;

  const footerFeedback = useMemo(() => {
    if (scm.actionError)
      return { tone: "error", message: scm.actionError } as const;
    if (scm.remoteError)
      return { tone: "error", message: scm.remoteError } as const;
    if (scm.actionMessage)
      return { tone: "success", message: scm.actionMessage } as const;
    return null;
  }, [scm.actionError, scm.actionMessage, scm.remoteError]);

  const handleCommitShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      canCommit
    ) {
      event.preventDefault();
      void scm.commit();
      return;
    }
  };

  const handleRefresh = useCallback(() => {
    setRefreshAnimating(true);
    if (refreshAnimationRef.current) {
      window.clearTimeout(refreshAnimationRef.current);
    }
    void scm
      .refresh()
      .catch((error) => {
        if (scm.isCurrent()) errorToast("Git refresh failed", error);
      })
      .finally(() => {
        if (!mountedRef.current || !scm.isCurrent()) return;
        refreshAnimationRef.current = window.setTimeout(() => {
          setRefreshAnimating(false);
          refreshAnimationRef.current = null;
        }, 450);
      });
  }, [scm]);

  const handleFetch = useCallback(() => {
    void sourceControl.runRemoteAction("sync");
  }, [sourceControl]);

  const handlePull = useCallback(async () => {
    await scm.runAction("pull", async (workspace, ensureCurrent) => {
      const targets =
        repoList.length > 1
          ? repoList
          : scm.repo
            ? [{ repoRoot: scm.repo.repoRoot }]
            : [];
      const failures: string[] = [];
      for (const target of targets) {
        ensureCurrent();
        try {
          await native.gitPullFfOnly(target.repoRoot, workspace);
          ensureCurrent();
        } catch (error) {
          ensureCurrent();
          failures.push(`${basename(target.repoRoot)}: ${String(error)}`);
        }
      }
      await scm.refresh();
      ensureCurrent();
      await refreshAllRepoStatuses?.();
      ensureCurrent();
      if (failures.length) throw new Error(failures.join("\n"));
    });
  }, [refreshAllRepoStatuses, repoList, scm]);

  const handlePushPreview = useCallback(async () => {
    if (!buildPushPlan) {
      await scm.push();
      return;
    }
    await scm.runAction("push-preview", async (_workspace, ensureCurrent) => {
      const plan = await buildPushPlan();
      ensureCurrent();
      setPushPlan(plan);
    });
  }, [buildPushPlan, scm]);

  const rows = useMemo<RowDescriptor[]>(() => {
    const result: RowDescriptor[] = [];
    if (isDiverged) {
      result.push({ kind: "banner-diverged", key: "banner-diverged" });
    }
    if (changedCount > 0) {
      result.push({
        kind: "list-header",
        key: "list-header",
        count: changedCount,
      });
      const pushByFolder = (
        files: SourceControlFileEntry[],
        repoKey: string,
      ) => {
        for (const row of changeTreeRows(files, repoKey, collapsedGroups))
          result.push(row);
      };

      // Multi-repo: a repo header above each repo's own folder grouping, so a
      // path that exists in several repos is never ambiguous.
      if (scm.repoGroups.length > 0) {
        for (const group of scm.repoGroups) {
          const repoKey = `repo:${group.repoRoot}`;
          const collapsed = collapsedGroups.has(repoKey);
          result.push({
            kind: "repo-header",
            key: repoKey,
            label: group.name,
            count: group.files.length,
            collapsed,
          });
          if (collapsed) continue;
          pushByFolder(group.files, repoKey);
        }
      } else {
        pushByFolder(scm.fileEntries, "repo:default");
      }
    }
    return result;
  }, [
    changedCount,
    collapsedGroups,
    isDiverged,
    scm.fileEntries,
    scm.repoGroups,
  ]);

  const rowKeyToIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => {
      map.set(row.key, index);
    });
    return map;
  }, [rows]);

  useEffect(() => {
    if (!focusedRowKey) return;
    if (!rowKeyToIndex.has(focusedRowKey)) {
      setFocusedRowKey(null);
    }
  }, [focusedRowKey, rowKeyToIndex]);

  const focusableIndices = useMemo(() => {
    const out: number[] = [];
    rows.forEach((row, index) => {
      if (row.kind === "entry") out.push(index);
    });
    return out;
  }, [rows]);

  const estimateSize = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return ROW_HEIGHTS.entry;
      switch (row.kind) {
        case "banner-diverged":
          return ROW_HEIGHTS.banner;
        case "list-header":
          return ROW_HEIGHTS.header;
        case "repo-header":
          return ROW_HEIGHTS.repo;
        case "folder-header":
          return ROW_HEIGHTS.folder;
        case "entry":
          return ROW_HEIGHTS.entry;
      }
    },
    [rows],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 12,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const moveFocus = useCallback(
    (direction: 1 | -1) => {
      if (focusableIndices.length === 0) return;
      const currentIndex =
        focusedRowKey === null ? -1 : (rowKeyToIndex.get(focusedRowKey) ?? -1);
      let pos = focusableIndices.indexOf(currentIndex);
      if (pos === -1) pos = direction > 0 ? -1 : focusableIndices.length;
      let nextPos = pos + direction;
      if (nextPos < 0) nextPos = 0;
      if (nextPos > focusableIndices.length - 1)
        nextPos = focusableIndices.length - 1;
      const targetRowIndex = focusableIndices[nextPos];
      const target = rows[targetRowIndex];
      if (!target) return;
      setFocusedRowKey(target.key);
      virtualizer.scrollToIndex(targetRowIndex, { align: "auto" });
    },
    [focusableIndices, focusedRowKey, rowKeyToIndex, rows, virtualizer],
  );

  const focusedEntry = useCallback((): SourceControlFileEntry | null => {
    if (!focusedRowKey) return null;
    const index = rowKeyToIndex.get(focusedRowKey);
    if (index === undefined) return null;
    const row = rows[index];
    return row && row.kind === "entry" ? row.entry : null;
  }, [focusedRowKey, rowKeyToIndex, rows]);

  const handlePanelKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.closest("button"))
      ) {
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      if (meta && (event.key === "r" || event.key === "R")) {
        event.preventDefault();
        handleRefresh();
        return;
      }
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveFocus(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          moveFocus(-1);
          break;
        case "Enter": {
          const entry = focusedEntry();
          if (entry) {
            event.preventDefault();
            void scm.selectFile(entry);
          }
          break;
        }
        case " ":
        case "s":
        case "S": {
          if (meta) break;
          const entry = focusedEntry();
          if (entry) {
            event.preventDefault();
            void scm.toggleStageFile(entry);
          }
          break;
        }
        case "d":
        case "D": {
          if (meta) break;
          const entry = focusedEntry();
          if (entry?.unstaged) {
            event.preventDefault();
            scm.requestDiscardFile(entry);
          }
          break;
        }
      }
    },
    [focusedEntry, handleRefresh, moveFocus, scm],
  );

  if (!open) return null;

  const fetchBusy = sourceControl.busyAction === "fetch";

  return (
    <TooltipProvider delayDuration={800} skipDelayDuration={300}>
      <aside className="flex h-full min-w-0 flex-col bg-card/80 backdrop-blur [contain:layout_style]">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3 pb-2.5 pt-3">
          <div className="flex min-w-0 items-center gap-1.5">
            {headerExtra}
            {/* RepoBranchSelector already covers the branch axis whenever any
                repo was discovered; the legacy branch-only button is only the
                fallback for a context-resolved repo with no scan results. */}
            {repoList.length > 0 ? null : (
              <BranchDropdown
                repoRoot={
                  fixedTargetPending ? null : (scm.repo?.repoRoot ?? null)
                }
                repoLabel={repoLabel}
                displayRepoRoot={
                  repositoryTarget.mode === "fixed"
                    ? repositoryTarget.repoRoot
                    : (scm.repo?.repoRoot ?? null)
                }
                repositoryTarget={repositoryTarget}
                onFollowRepositoryContext={onFollowRepositoryContext}
                onNavigateToPath={onNavigateToPath}
                onRefresh={handleRefresh}
                runAction={scm.runAction}
                actionBusy={scm.actionBusy}
              />
            )}
            {scm.status && (scm.status.ahead > 0 || scm.status.behind > 0) ? (
              <div className="flex shrink-0 items-center gap-0.5 text-[10px] font-semibold tabular-nums leading-none text-muted-foreground">
                {scm.status.ahead > 0 ? (
                  <span className="inline-flex items-center gap-0.5 rounded-md border border-border/60 px-1 py-0.5">
                    <HugeiconsIcon
                      icon={ArrowUp01Icon}
                      size={9}
                      strokeWidth={2.2}
                    />
                    {scm.status.ahead}
                  </span>
                ) : null}
                {scm.status.behind > 0 ? (
                  <span className="inline-flex items-center gap-0.5 rounded-md border border-border/60 px-1 py-0.5">
                    <HugeiconsIcon
                      icon={ArrowDown01Icon}
                      size={9}
                      strokeWidth={2.2}
                    />
                    {scm.status.behind}
                  </span>
                ) : null}
              </div>
            ) : null}
            {scm.status?.isDetached ? (
              <span className="rounded bg-muted/55 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                detached
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <IconActionButton
              label={
                fetchBusy
                  ? "Syncing…"
                  : repoCount > 1
                    ? `Sync ${repoCount} repos (fetch + fast-forward pull, one at a time)`
                    : "Sync (fetch + fast-forward pull)"
              }
              disabled={!canFetch}
              onClick={handleFetch}
              side="bottom"
            >
              {fetchBusy ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon
                  icon={FolderCloudIcon}
                  size={14}
                  strokeWidth={1.85}
                />
              )}
            </IconActionButton>
            <IconActionButton
              label={
                pullBusy
                  ? "Pulling…"
                  : isDiverged
                    ? "Branch diverged — resolve in terminal"
                    : !hasUpstream
                      ? "No upstream configured"
                      : (scm.status?.behind ?? 0) === 0
                        ? "Already up to date"
                        : `Pull ${scm.status?.behind ?? 0} commits (merge)`
              }
              disabled={!canPull}
              onClick={() => void handlePull()}
              side="bottom"
            >
              {pullBusy ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon
                  icon={Download01Icon}
                  size={14}
                  strokeWidth={1.9}
                />
              )}
            </IconActionButton>
            <IconActionButton
              label="Refresh source control"
              disabled={isRefreshing || !!scm.actionBusy}
              onClick={handleRefresh}
              side="bottom"
            >
              {isRefreshing ? (
                <Spinner className="size-3.5" />
              ) : (
                <HugeiconsIcon
                  icon={Refresh01Icon}
                  size={14}
                  strokeWidth={1.9}
                  className={cn(refreshAnimating && "animate-spin")}
                />
              )}
            </IconActionButton>
            {!fixedTargetPending && scm.repo?.repoRoot && onManageRemotes ? (
              <IconActionButton
                label="Manage remotes"
                onClick={onManageRemotes}
                side="bottom"
              >
                <HugeiconsIcon icon={Edit02Icon} size={14} strokeWidth={1.9} />
              </IconActionButton>
            ) : null}
          </div>
        </header>
        {syncProgress && syncProgress.items.length > 1 ? (
          <SyncProgressList
            progress={syncProgress}
            onDismiss={onDismissSyncProgress}
          />
        ) : null}

        {onOpenGitGraph ? (
          <button
            type="button"
            onClick={() => onOpenGitGraph()}
            className="group flex shrink-0 cursor-pointer items-center gap-2 border-b border-border/40 px-3 py-2 text-left text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
          >
            <HugeiconsIcon
              icon={GitBranchIcon}
              size={13}
              strokeWidth={1.85}
              className="shrink-0"
            />
            <span className="flex-1 text-[12px] font-medium">Commit Graph</span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={12}
              strokeWidth={2}
              className="shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5"
            />
          </button>
        ) : null}

        {panelState === "loading" ? (
          <PanelCenter title="Loading repository" />
        ) : null}

        {panelState === "no-repo" ? (
          <PanelCenter
            title="No repository"
            body="The active workspace is not inside a Git repository."
            action={
              onCloneRepository ? (
                <Button size="sm" onClick={onCloneRepository}>
                  Clone repository…
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {panelState === "error" ? (
          <PanelCenter
            title="Source control error"
            body={scm.statusError ?? "Unknown source control error"}
            action={
              <Button size="sm" onClick={() => void scm.refresh()}>
                Retry
              </Button>
            }
          />
        ) : null}

        {panelState === "ready" && scm.status ? (
          <>
            <div className="relative shrink-0 space-y-2 border-b border-border/40 bg-gradient-to-b from-card/65 to-card/30 px-2.5 pb-2.5 pt-2.5">
              <div
                className={cn(
                  "relative rounded-lg border bg-background/95 shadow-sm transition-colors",
                  scm.commitMessage.length > 0
                    ? "border-border/70"
                    : "border-border/45",
                  "focus-within:border-primary/45 focus-within:shadow-md focus-within:shadow-primary/5",
                )}
              >
                <Textarea
                  aria-label="Commit message"
                  disabled={!!scm.actionBusy}
                  value={scm.commitMessage}
                  onChange={(event) => scm.setCommitMessage(event.target.value)}
                  onKeyDown={handleCommitShortcut}
                  placeholder="Commit message"
                  rows={3}
                  className={cn(
                    "min-h-[72px] border-border resize-none rounded-lg bg-transparent px-3 pb-7 pt-2.5 text-[12.5px] leading-snug shadow-none placeholder:text-muted-foreground/65 focus-visible:ring-0 focus:border-0",
                  )}
                />
                <div className="pointer-events-none absolute inset-x-3 bottom-1.5 flex items-center justify-between p-1 gap-2 text-[10px] tabular-nums text-muted-foreground/55">
                  {scm.commitMessage.length > 0 ? (
                    <span>Ch: {scm.commitMessage.length}</span>
                  ) : (
                    <span className="flex gap-2 items-center">
                      {commitShortcut} <p>to commit</p>
                    </span>
                  )}
                </div>
              </div>

              <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full transition-colors",
                    canCommit
                      ? "bg-foreground/80"
                      : stagedCount > 0
                        ? "bg-muted-foreground/60"
                        : "bg-muted-foreground/30",
                  )}
                />
                <span className="truncate font-medium text-foreground/85">
                  {stagedCount === 0
                    ? "Nothing staged"
                    : `${stagedCount} ${stagedCount === 1 ? "file" : "files"} staged`}
                </span>
                <span className="ml-auto shrink-0 truncate text-muted-foreground/65">
                  {pushStatusLabel}
                </span>
              </div>

              <div className="flex min-w-0 items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 shrink-0 gap-1 px-1.5 text-[10.5px]"
                  disabled={!!scm.actionBusy || stagedCount === 0 || draftBusy}
                  title={
                    stagedCount === 0
                      ? "先勾选要提交的变更"
                      : "把勾选的变更发给 agent，让它写提交信息"
                  }
                  onClick={() => void sendChangesToAgent()}
                >
                  <HugeiconsIcon
                    icon={SparklesIcon}
                    size={12}
                    strokeWidth={1.75}
                  />
                  {draftBusy ? "读取中…" : "让 agent 写提交信息"}
                </Button>
              </div>

              <div className="grid w-full grid-cols-2 gap-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="xs"
                      className="h-7 cursor-pointer text-[11.5px] font-semibold tracking-tight shadow-sm disabled:cursor-not-allowed disabled:shadow-none"
                      disabled={!canCommit}
                      onClick={() => void scm.commit()}
                    >
                      {scm.actionBusy === "commit" ||
                      scm.actionBusy === "commit-and-push" ? (
                        <>
                          <Spinner className="size-3.5" />
                          Committing…
                        </>
                      ) : stagedRepoCount > 1 ? (
                        `Commit to ${stagedRepoCount} repos`
                      ) : (
                        "Commit"
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className={cn(
                      SOURCE_CONTROL_TOOLTIP_CLASS,
                      "text-[10.5px]",
                    )}
                  >
                    {commitHint}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="xs"
                      variant="secondary"
                      className="h-7 cursor-pointer text-[11.5px] font-medium disabled:cursor-not-allowed"
                      disabled={
                        (!scm.canPush && repoList.length <= 1) ||
                        fixedTargetPending ||
                        !!scm.actionBusy ||
                        planLoading
                      }
                      onClick={() => {
                        void handlePushPreview();
                      }}
                    >
                      {planLoading
                        ? "Checking…"
                        : scm.actionBusy === "push"
                          ? "Pushing…"
                          : "Push"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className={cn(
                      SOURCE_CONTROL_TOOLTIP_CLASS,
                      "max-w-64 text-[10.5px]",
                    )}
                  >
                    {pushDisabledReason}
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="grid w-full gap-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="xs"
                      variant="secondary"
                      className="h-7 cursor-pointer text-[11.5px] font-medium disabled:cursor-not-allowed"
                      disabled={!canCommit}
                      onClick={() => void scm.commitAndPush()}
                    >
                      {scm.actionBusy === "commit-and-push" ? (
                        <>
                          <Spinner className="size-3.5" />
                          Committing…
                        </>
                      ) : (
                        "Pull & Commit & Push"
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className={cn(
                      SOURCE_CONTROL_TOOLTIP_CLASS,
                      "text-[10.5px]",
                    )}
                  >
                    {commitAndPushHint}
                  </TooltipContent>
                </Tooltip>
              </div>

              <CommitFeedback
                feedback={footerFeedback}
                rewordable={scm.rewordTarget !== null && !scm.actionBusy}
                onReword={scm.openReword}
              />
            </div>

            {scm.allClean ? (
              <CleanTreeHint repoLabel={repoLabel} />
            ) : (
              <div
                ref={containerRef}
                tabIndex={0}
                role="listbox"
                aria-label="Changed files"
                aria-activedescendant={
                  focusedRowKey
                    ? `${rowIdPrefix}-${encodeURIComponent(focusedRowKey)}`
                    : undefined
                }
                onKeyDown={handlePanelKeyDown}
                className="relative min-h-0 flex-1 outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
              >
                <div
                  ref={scrollRef}
                  className="h-full overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
                >
                  <div
                    style={{
                      height: virtualizer.getTotalSize(),
                      position: "relative",
                      width: "100%",
                    }}
                  >
                    {virtualizer.getVirtualItems().map((virtualRow) => {
                      const row = rows[virtualRow.index];
                      if (!row) return null;
                      return (
                        <div
                          key={virtualRow.key}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            height: virtualRow.size,
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          <RowRenderer
                            row={row}
                            focused={focusedRowKey === row.key}
                            selectedKey={
                              scm.selected
                                ? `${scm.selected.repoRoot}\u0000${scm.selected.path}`
                                : null
                            }
                            rowIdPrefix={rowIdPrefix}
                            actionBusy={scm.actionBusy}
                            headerCheckState={scm.headerCheckState}
                            repoRoot={scm.repo?.repoRoot ?? null}
                            onFocusRow={setFocusedRowKey}
                            onToggleAll={scm.toggleAll}
                            onSelectFile={scm.selectFile}
                            onToggleStageFile={scm.toggleStageFile}
                            onDiscardFile={scm.requestDiscardFile}
                            onOpenFile={onOpenFile}
                            onToggleGroup={toggleCollapsedGroup}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : null}
      </aside>

      <PushDialog
        open={pushPlan !== null}
        onOpenChange={(o) => {
          if (!o) setPushPlan(null);
        }}
        plan={pushPlan}
        onPush={(plan, options) =>
          pushAllAdvanced
            ? pushAllAdvanced(plan, options)
            : Promise.reject(new Error("Push operation is unavailable"))
        }
        syncProgress={syncProgress}
      />

      <AlertDialog
        open={scm.pendingDiscard !== null}
        onOpenChange={(o) => {
          if (!o && !scm.actionBusy) scm.cancelPendingDiscard();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {scm.pendingDiscard?.scope === "all"
                ? `This will discard ${scm.pendingDiscard.label} and cannot be undone.`
                : scm.pendingDiscard
                  ? `Discard changes in "${scm.pendingDiscard.label}"? This cannot be undone.`
                  : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {scm.actionError ? (
            <p
              role="alert"
              className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-destructive"
            >
              {scm.actionError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={!!scm.actionBusy}
              onClick={() => scm.cancelPendingDiscard()}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!!scm.actionBusy}
              onClick={(event) => {
                event.preventDefault();
                void scm.confirmPendingDiscard();
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={scm.preCommitWarnings !== null}
        onOpenChange={(o) => {
          if (!o && !scm.actionBusy) scm.cancelPreCommitWarnings();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pre-commit checks found issues</AlertDialogTitle>
            <AlertDialogDescription>
              The repository's pre-commit checks reported the following. Do you
              still want to commit?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border border-border/50 bg-muted/30 px-2.5 py-2">
            {scm.preCommitWarnings?.map((warning) => (
              <li
                key={warning}
                className="text-[11px] leading-snug text-muted-foreground"
              >
                {warning}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={!!scm.actionBusy}
              onClick={() => scm.cancelPreCommitWarnings()}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!!scm.actionBusy}
              onClick={(event) => {
                event.preventDefault();
                void scm.confirmPreCommitWarnings();
              }}
            >
              Commit anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={scm.rewordOpen}
        onOpenChange={(o) => {
          if (!o && !scm.actionBusy) scm.cancelReword();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reword commit</AlertDialogTitle>
            <AlertDialogDescription>
              Rewrite the message of the last commit without touching its
              contents.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            aria-label="New commit message"
            disabled={!!scm.actionBusy}
            value={scm.rewordMessage}
            onChange={(event) => scm.setRewordMessage(event.target.value)}
            onKeyDown={(event) => {
              if (
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229 &&
                !scm.actionBusy &&
                event.key === "Enter" &&
                scm.rewordMessage.trim().length > 0
              ) {
                event.preventDefault();
                void scm.confirmReword();
              }
            }}
            placeholder="New commit message"
            autoFocus
            className="rounded-xl"
          />
          {scm.actionError ? (
            <p
              role="alert"
              className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-destructive"
            >
              {scm.actionError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={!!scm.actionBusy}
              onClick={() => scm.cancelReword()}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={
                scm.rewordMessage.trim().length === 0 || !!scm.actionBusy
              }
              onClick={(event) => {
                event.preventDefault();
                void scm.confirmReword();
              }}
            >
              Reword
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}

function PanelCenter({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-sm font-medium">{title}</div>
      {body ? (
        <div className="max-w-64 text-[11px] leading-relaxed text-muted-foreground">
          {body}
        </div>
      ) : null}
      {action}
    </div>
  );
}

function CleanTreeHint({ repoLabel }: { repoLabel: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center">
      <div className="flex size-8 items-center justify-center rounded-full border border-border/55 text-muted-foreground">
        <HugeiconsIcon
          icon={CheckmarkCircle01Icon}
          size={16}
          strokeWidth={1.6}
        />
      </div>
      <div className="text-[12px] font-medium text-foreground">
        Working tree clean
      </div>
      <div className="text-[10.5px] leading-snug text-muted-foreground">
        on <span className="font-mono text-foreground/80">{repoLabel}</span>
      </div>
    </div>
  );
}

type RowRendererProps = {
  row: RowDescriptor;
  focused: boolean;
  selectedKey: string | null;
  rowIdPrefix: string;
  actionBusy: string | null;
  headerCheckState: CheckState;
  repoRoot: string | null;
  onFocusRow: (key: string | null) => void;
  onToggleAll: () => Promise<void> | void;
  onSelectFile: (entry: SourceControlFileEntry) => Promise<void>;
  onToggleStageFile: (entry: SourceControlFileEntry) => Promise<void>;
  onDiscardFile: (entry: SourceControlFileEntry) => void;
  onOpenFile?: (absolutePath: string) => void;
  onToggleGroup: (key: string) => void;
};

const RowRenderer = memo(function RowRenderer(props: RowRendererProps) {
  const { row } = props;
  switch (row.kind) {
    case "banner-diverged":
      return <DivergedBanner />;
    case "list-header":
      return <ListHeader {...props} row={row} />;
    case "repo-header":
      return <RepoHeader row={row} onToggle={props.onToggleGroup} />;
    case "folder-header":
      return <FolderHeader row={row} onToggle={props.onToggleGroup} />;
    case "entry":
      return <EntryRow {...props} row={row} />;
  }
});

function DivergedBanner() {
  return (
    <div className="mx-2 mt-1 flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-foreground/[0.04] px-2 text-[10.5px] leading-none text-muted-foreground">
      <HugeiconsIcon
        icon={Alert02Icon}
        size={11}
        strokeWidth={1.9}
        className="shrink-0"
      />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground/85">
          Diverged from upstream
        </span>
        <span className="ml-1 opacity-75">— resolve in terminal</span>
      </span>
    </div>
  );
}

function RepoHeader({
  row,
  onToggle,
}: {
  row: Extract<RowDescriptor, { kind: "repo-header" }>;
  onToggle: (key: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(row.key)}
      aria-expanded={!row.collapsed}
      className="flex h-[26px] w-full cursor-pointer items-center gap-2 border-t border-border/40 px-2.5 pt-1 text-left hover:bg-foreground/[0.03]"
    >
      <HugeiconsIcon
        icon={row.collapsed ? ChevronRightIcon : ChevronDownIcon}
        size={10}
        strokeWidth={2}
        className="shrink-0 text-muted-foreground/60"
      />
      <HugeiconsIcon
        icon={FolderGitTwoIcon}
        size={12}
        strokeWidth={2}
        className="shrink-0 text-muted-foreground"
      />
      <span className="truncate text-[11px] font-semibold text-foreground/85">
        {row.label}
      </span>
      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground/[0.07] px-1 text-[9px] tabular-nums text-muted-foreground">
        {row.count}
      </span>
    </button>
  );
}

function FolderHeader({
  row,
  onToggle,
}: {
  row: Extract<RowDescriptor, { kind: "folder-header" }>;
  onToggle: (key: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(row.key)}
      aria-expanded={!row.collapsed}
      title={row.path || "(root)"}
      style={{ paddingLeft: 12 + row.depth * 16 }}
      className="flex h-6 w-full cursor-pointer items-center gap-2 px-3 text-left hover:bg-foreground/[0.03]"
    >
      <HugeiconsIcon
        icon={row.collapsed ? ChevronRightIcon : ChevronDownIcon}
        size={10}
        strokeWidth={2}
        className="shrink-0 text-muted-foreground/50"
      />
      <HugeiconsIcon
        icon={Folder01Icon}
        size={11}
        strokeWidth={2}
        className="shrink-0 text-muted-foreground/70"
      />
      <span className="truncate text-[10.5px] font-medium text-muted-foreground/80">
        {row.label}
      </span>
      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-border/50 px-1 text-[9px] tabular-nums text-muted-foreground/60">
        {row.count}
      </span>
    </button>
  );
}

function ListHeader({
  row,
  actionBusy,
  headerCheckState,
  onToggleAll,
}: RowRendererProps & {
  row: Extract<RowDescriptor, { kind: "list-header" }>;
}) {
  return (
    <div className="flex h-7 items-center gap-2 px-3">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/85">
        Changes
      </span>
      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-border/60 px-1 text-[9.5px] font-semibold tabular-nums text-muted-foreground">
        {row.count}
      </span>
      <div className="ml-auto flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[10.5px] font-medium text-muted-foreground hover:text-foreground">
        <span>All</span>
        <Checkbox
          aria-label="Stage all changes"
          checked={checkboxValue(headerCheckState)}
          disabled={actionBusy !== null}
          onCheckedChange={() => void onToggleAll()}
          className="size-3.5"
        />
      </div>
    </div>
  );
}

const EntryRow = memo(function EntryRow({
  row,
  focused,
  selectedKey,
  rowIdPrefix,
  actionBusy,
  repoRoot,
  onFocusRow,
  onSelectFile,
  onToggleStageFile,
  onDiscardFile,
  onOpenFile,
}: RowRendererProps & {
  row: Extract<RowDescriptor, { kind: "entry" }>;
}) {
  const entry = row.entry;
  const isSelected = selectedKey === entry.key;
  const fileName = basename(entry.path);
  const iconUrl = fileIconUrl(fileName);
  const isStageBusy =
    actionBusy === `stage:${entry.key}` ||
    actionBusy === `unstage:${entry.key}`;
  const disabled = actionBusy !== null;

  const root = entry.repoRoot || repoRoot;
  const absolutePath = root
    ? joinPath(root.replace(/\\/g, "/"), entry.path.replace(/\\/g, "/"))
    : null;
  const isDeleted = entry.statusCode === "D";
  const revealLabel = "Reveal in File Manager";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          id={`${rowIdPrefix}-${encodeURIComponent(row.key)}`}
          tabIndex={-1}
          data-focused={focused || undefined}
          data-selected={isSelected || undefined}
          role="option"
          aria-selected={isSelected}
          style={{ paddingLeft: 12 + row.depth * 16 }}
          onMouseDown={() => onFocusRow(row.key)}
          className={cn(
            "group relative flex h-[30px] items-center gap-2 rounded-md pr-2 transition-all duration-100",
            focused
              ? "bg-accent/60"
              : isSelected
                ? "bg-accent/55 text-foreground"
                : "hover:bg-accent/30",
          )}
        >
          <span
            className={cn(
              "pointer-events-none absolute inset-y-1 left-0 w-[2px] rounded-full transition-opacity",
              statusAccent(entry.statusCode),
              isSelected || focused
                ? "opacity-100"
                : "opacity-55 group-hover:opacity-95",
            )}
            aria-hidden
          />
          <button
            type="button"
            onClick={() => {
              onFocusRow(row.key);
              void onSelectFile(entry);
            }}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          >
            {iconUrl ? (
              <img src={iconUrl} alt="" className="size-4 shrink-0" />
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <div className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-none">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[12px] leading-tight",
                  isSelected || focused
                    ? "font-semibold text-foreground"
                    : "font-medium text-foreground/95",
                )}
              >
                {fileName}
              </span>
            </div>
          </button>

          <span className="flex size-5 shrink-0 items-center justify-center">
            {isStageBusy ? (
              <Spinner className="size-3" />
            ) : (
              <Checkbox
                aria-label={`Stage ${entry.path}`}
                checked={checkboxValue(entry.checkState)}
                disabled={disabled}
                onCheckedChange={() => void onToggleStageFile(entry)}
                className="size-3.5"
              />
            )}
          </span>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className={COMPACT_CONTENT}>
        {/* Open actions */}
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => {
            onFocusRow(row.key);
            void onSelectFile(entry);
          }}
        >
          Open Diff
        </ContextMenuItem>
        {!isDeleted && onOpenFile && absolutePath ? (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onOpenFile(absolutePath)}
          >
            Open File
          </ContextMenuItem>
        ) : null}

        {entry.unstaged ? (
          <>
            <ContextMenuSeparator />

            <ContextMenuItem
              className={COMPACT_ITEM}
              variant="destructive"
              disabled={disabled}
              onSelect={() => onDiscardFile(entry)}
            >
              Discard Changes
            </ContextMenuItem>
          </>
        ) : null}

        <ContextMenuSeparator />

        {/* Copy paths */}
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => void copyToClipboard(entry.path.replace(/\\/g, "/"))}
        >
          Copy Relative Path
        </ContextMenuItem>
        {absolutePath ? (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => void copyToClipboard(absolutePath)}
          >
            Copy Absolute Path
          </ContextMenuItem>
        ) : null}

        {/* Reveal in Finder — only for existing files */}
        {!isDeleted && absolutePath ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() => void revealInFinder(absolutePath)}
            >
              {revealLabel}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
});

function IconActionButton({
  label,
  disabled,
  side = "left",
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  side?: "left" | "top" | "right" | "bottom";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-6 p-3 cursor-pointer rounded-md text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        className={cn(SOURCE_CONTROL_TOOLTIP_CLASS, "text-[10.5px]")}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function CommitFeedback({
  feedback,
  rewordable,
  onReword,
}: {
  feedback: { tone: "error" | "success"; message: string } | null;
  rewordable: boolean;
  onReword: () => void;
}) {
  const [visibleFeedback, setVisibleFeedback] = useState(feedback);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!feedback) {
      setIsVisible(false);
      return;
    }
    setVisibleFeedback(feedback);
    setIsVisible(true);
    if (feedback.tone === "error") return;
    const hideTimer = window.setTimeout(() => setIsVisible(false), 3600);
    const clearTimer = window.setTimeout(() => {
      setVisibleFeedback((current) =>
        current?.message === feedback.message && current.tone === feedback.tone
          ? null
          : current,
      );
    }, 3900);
    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(clearTimer);
    };
  }, [feedback]);

  if (!visibleFeedback) return null;

  const isError = visibleFeedback.tone === "error";
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-3 top-[calc(100%-0.25rem)] z-20 flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug shadow-lg shadow-black/15 backdrop-blur transition-all duration-200",
        isVisible ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
        isError
          ? "border-destructive/30 bg-card/95 text-destructive"
          : "border-border/70 bg-card/95 text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isError ? "bg-destructive" : "bg-foreground/70",
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1",
          isError
            ? "max-h-32 overflow-y-auto whitespace-pre-wrap break-words pointer-events-auto"
            : "truncate",
          isError ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {visibleFeedback.message}
      </span>
      {rewordable && !isError ? (
        <button
          type="button"
          onClick={onReword}
          className="pointer-events-auto ml-auto shrink-0 cursor-pointer rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] font-semibold text-foreground/80 transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          Reword
        </button>
      ) : null}
    </div>
  );
}
