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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { type GitDiffResult, type GitLogEntry, native } from "@/lib/native";
import {
  Copy01Icon,
  GitBranchIcon,
  GitCommitIcon,
  GitCompareIcon,
  GitMergeConflictIcon,
  GitMergeIcon,
  Tag01Icon,
  UndoIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { errorToast } from "@/lib/errorToast";
import { toast } from "sonner";
import {
  currentWorkspaceScopeKey,
  LOCAL_WORKSPACE,
  workspaceScopeKey,
} from "@/modules/workspace/env";
import { useAsyncQuery } from "@/modules/command-palette/hooks/useAsyncQuery";

type ConfirmSpec = {
  title: string;
  description: string;
  confirmLabel: string;
  success: string;
  destructive?: boolean;
  /** When set the user must type this text before the action unlocks. */
  requireText?: string;
  action: () => Promise<void>;
};

type PromptField = {
  label: string;
  placeholder?: string;
  initial?: string;
  required?: boolean;
};

type PromptSpec = {
  title: string;
  description?: string;
  confirmLabel: string;
  success: string;
  fields: PromptField[];
  action: (values: string[]) => Promise<void>;
};

type DialogState =
  | { kind: "confirm"; spec: ConfirmSpec }
  | { kind: "prompt"; spec: PromptSpec }
  | { kind: "diff"; sha: string; subject: string }
  | null;

type Props = {
  repoRoot: string;
  commit: GitLogEntry;
  /** Called after any history-changing command succeeds so the list reloads. */
  onRefresh: () => void;
  children: ReactNode;
};

export function CommitContextMenu(props: Props) {
  const workspace = LOCAL_WORKSPACE;
  return (
    <ScopedCommitContextMenu
      key={JSON.stringify([
        props.repoRoot,
        props.commit.sha,
        workspaceScopeKey(workspace),
      ])}
      {...props}
    />
  );
}

function ScopedCommitContextMenu({
  repoRoot,
  commit,
  onRefresh,
  children,
}: Props) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const environmentKey = currentWorkspaceScopeKey();
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    async (action: () => Promise<void>, success: string) => {
      if (
        !mountedRef.current ||
        busyRef.current ||
        currentWorkspaceScopeKey() !== environmentKey
      )
        return;
      busyRef.current = true;
      setBusy(true);
      try {
        await action();
        toast.success(success);
        if (
          mountedRef.current &&
          currentWorkspaceScopeKey() === environmentKey
        ) {
          setDialog(null);
          onRefresh();
        }
      } catch (e) {
        errorToast("Git 操作失败", e);
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [onRefresh, environmentKey],
  );

  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch (error) {
      errorToast("Could not copy commit information", error);
    }
  }, []);

  const handleCopySha = () => {
    void copy(commit.sha);
  };

  const confirm = (spec: ConfirmSpec) => setDialog({ kind: "confirm", spec });
  const prompt = (spec: PromptSpec) => setDialog({ kind: "prompt", spec });

  const handleCheckout = () =>
    confirm({
      title: "检出此提交？",
      description: `将以 detached HEAD 状态检出 ${commit.shortSha}。`,
      confirmLabel: "检出",
      success: `已检出 ${commit.shortSha}`,
      action: () => native.gitCheckoutBranch(repoRoot, commit.sha),
    });

  const handleReset = (mode: "soft" | "mixed" | "hard") =>
    confirm({
      title: `重置 ${mode} 到 ${commit.shortSha}？`,
      description:
        mode === "hard"
          ? "移动 HEAD 并丢弃该提交之后的所有工作区与暂存区更改。此操作无法撤销。"
          : mode === "soft"
            ? "移动 HEAD，保留工作区与暂存区不变。"
            : "移动 HEAD 并取消暂存，保留工作区更改。",
      confirmLabel: `重置 ${mode}`,
      success: `已重置 ${mode} 到 ${commit.shortSha}`,
      destructive: true,
      requireText: mode === "hard" ? commit.shortSha : undefined,
      action: () => native.gitReset(repoRoot, mode, commit.sha),
    });

  const handleRevert = () =>
    confirm({
      title: "还原此提交？",
      description: `创建新提交以撤销 ${commit.shortSha} 引入的更改。`,
      confirmLabel: "还原",
      success: `已还原 ${commit.shortSha}`,
      destructive: true,
      action: () => native.gitRevertCommit(repoRoot, commit.sha),
    });

  const handleCherryPick = () =>
    confirm({
      title: "摘取此提交？",
      description: `将 ${commit.shortSha} 引入的更改作为新提交应用到当前分支。`,
      confirmLabel: "摘取",
      success: `已摘取 ${commit.shortSha}`,
      action: () => native.gitCherryPick(repoRoot, commit.sha),
    });

  const handleNewBranch = () =>
    prompt({
      title: "从此提交新建分支",
      description: `在 ${commit.shortSha} 处创建并检出新分支。`,
      confirmLabel: "创建分支",
      success: `已从 ${commit.shortSha} 创建分支`,
      fields: [{ label: "分支名称", placeholder: "feature/…", required: true }],
      action: (values) =>
        native.gitCreateBranch(repoRoot, values[0] ?? "", {
          startPoint: commit.sha,
          checkout: true,
        }),
    });

  const handleCreateTag = () =>
    prompt({
      title: "创建标签",
      description: `为 ${commit.shortSha} 创建标签。`,
      confirmLabel: "创建标签",
      success: `已为 ${commit.shortSha} 创建标签`,
      fields: [
        { label: "标签名称", required: true },
        { label: "备注（可选）", placeholder: "v1.0.0 发布说明" },
      ],
      action: (values) =>
        native.gitTagCreate(repoRoot, values[0] ?? "", commit.sha, {
          annotated: true,
          message: values[1]?.trim() || undefined,
        }),
    });

  const handleDiff = () =>
    setDialog({ kind: "diff", sha: commit.sha, subject: commit.subject });

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent side="right" className="min-w-56">
          <ContextMenuLabel className="flex items-center gap-1.5 px-2.5 py-1.5 font-mono text-[10.5px]">
            <HugeiconsIcon
              icon={GitCommitIcon}
              size={12}
              strokeWidth={1.9}
              className="text-muted-foreground"
            />
            {commit.shortSha}
          </ContextMenuLabel>
          <ContextMenuSeparator className="my-1 border-t border-border/30" />
          <ContextMenuItem
            onSelect={handleCopySha}
            className="flex cursor-pointer items-center gap-2"
          >
            <HugeiconsIcon icon={Copy01Icon} size={14} strokeWidth={1.9} />
            复制 SHA
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={handleDiff}
            className="flex cursor-pointer items-center gap-2"
          >
            <HugeiconsIcon icon={GitCompareIcon} size={14} strokeWidth={1.9} />
            与工作区比较…
          </ContextMenuItem>
          <ContextMenuSeparator className="my-1 border-t border-border/30" />
          <ContextMenuItem
            onSelect={handleCheckout}
            className="flex cursor-pointer items-center gap-2"
          >
            <HugeiconsIcon icon={GitCommitIcon} size={14} strokeWidth={1.9} />
            检出此提交…
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger className="flex items-center gap-2">
              <HugeiconsIcon icon={UndoIcon} size={14} strokeWidth={1.9} />
              重置…
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-36">
              <ContextMenuItem
                onSelect={() => handleReset("soft")}
                className="flex cursor-pointer items-center gap-2"
              >
                Soft
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => handleReset("mixed")}
                className="flex cursor-pointer items-center gap-2"
              >
                Mixed
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onSelect={() => handleReset("hard")}
                className="flex cursor-pointer items-center gap-2"
              >
                Hard…
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem
            variant="destructive"
            onSelect={handleRevert}
            className="flex cursor-pointer items-center gap-2"
          >
            <HugeiconsIcon
              icon={GitMergeConflictIcon}
              size={14}
              strokeWidth={1.9}
            />
            还原提交…
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={handleCherryPick}
            className="flex cursor-pointer items-center gap-2"
          >
            <HugeiconsIcon icon={GitMergeIcon} size={14} strokeWidth={1.9} />
            摘取提交…
          </ContextMenuItem>
          <ContextMenuSeparator className="my-1 border-t border-border/30" />
          <ContextMenuItem
            onSelect={handleNewBranch}
            className="flex cursor-pointer items-center gap-2"
          >
            <HugeiconsIcon icon={GitBranchIcon} size={14} strokeWidth={1.9} />
            从此提交新建分支…
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={handleCreateTag}
            className="flex cursor-pointer items-center gap-2"
          >
            <HugeiconsIcon icon={Tag01Icon} size={14} strokeWidth={1.9} />
            创建标签…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {dialog?.kind === "confirm" ? (
        <ConfirmDialog
          spec={dialog.spec}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => void run(dialog.spec.action, dialog.spec.success)}
        />
      ) : null}
      {dialog?.kind === "prompt" ? (
        <PromptDialog
          spec={dialog.spec}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={(values) =>
            void run(() => dialog.spec.action(values), dialog.spec.success)
          }
        />
      ) : null}
      {dialog?.kind === "diff" ? (
        <CommitDiffDialog
          repoRoot={repoRoot}
          sha={dialog.sha}
          subject={dialog.subject}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}

function ConfirmDialog({
  spec,
  busy,
  onConfirm,
  onCancel,
}: {
  spec: ConfirmSpec;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const needsText = spec.requireText !== undefined;
  const canConfirm = !needsText || typed === spec.requireText;
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{spec.title}</AlertDialogTitle>
          <AlertDialogDescription>{spec.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {needsText ? (
          <Input
            autoFocus
            placeholder={`输入 ${spec.requireText} 确认`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={onCancel}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            variant={spec.destructive ? "destructive" : "default"}
            disabled={busy || !canConfirm}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {busy ? <Spinner className="size-3.5" /> : null}
            {spec.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PromptDialog({
  spec,
  busy,
  onConfirm,
  onCancel,
}: {
  spec: PromptSpec;
  busy: boolean;
  onConfirm: (values: string[]) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<string[]>(() =>
    spec.fields.map((field) => field.initial ?? ""),
  );
  const canConfirm = spec.fields.every(
    (field, index) =>
      !field.required || (values[index] ?? "").trim().length > 0,
  );
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{spec.title}</AlertDialogTitle>
          {spec.description ? (
            <AlertDialogDescription>{spec.description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <div className="grid gap-3">
          {spec.fields.map((field, index) => (
            <div key={field.label} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">
                {field.label}
              </span>
              <Input
                autoFocus={index === 0}
                aria-label={field.label}
                placeholder={field.placeholder}
                value={values[index] ?? ""}
                onChange={(e) =>
                  setValues((current) =>
                    current.map((value, i) =>
                      i === index ? e.target.value : value,
                    ),
                  )
                }
              />
            </div>
          ))}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={onCancel}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || !canConfirm}
            onClick={(event) => {
              event.preventDefault();
              onConfirm(values);
            }}
          >
            {busy ? <Spinner className="size-3.5" /> : null}
            {spec.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CommitDiffDialog({
  repoRoot,
  sha,
  subject,
  onClose,
}: {
  repoRoot: string;
  sha: string;
  subject: string;
  onClose: () => void;
}) {
  const workspace = LOCAL_WORKSPACE;
  const environmentKey = workspaceScopeKey(workspace);
  const run = useCallback(async () => {
    if (currentWorkspaceScopeKey() !== environmentKey) return [];
    const diff = await native.gitDiffCommitVsWorktree(repoRoot, sha, workspace);
    if (currentWorkspaceScopeKey() !== environmentKey) return [];
    return [diff];
  }, [repoRoot, sha, environmentKey]);
  const query = useAsyncQuery<GitDiffResult>({
    enabled: true,
    term: sha,
    minLength: 1,
    debounceMs: 0,
    scopeKey: JSON.stringify([repoRoot, sha, environmentKey]),
    run,
  });
  const diff = query.results[0];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[70vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="pr-8">
            与工作区比较 - {sha.slice(0, 7)}
          </DialogTitle>
          <DialogDescription className="truncate">
            {subject || "（无主题）"}
          </DialogDescription>
        </DialogHeader>
        {query.loading ? (
          <div className="flex items-center gap-2 py-6 text-[11.5px] text-muted-foreground">
            <Spinner className="size-3.5" />
            正在加载差异…
          </div>
        ) : query.error ? (
          <div className="flex items-center justify-between gap-2 py-6 text-[11.5px] text-destructive">
            <span className="truncate">{query.error}</span>
            <Button
              size="xs"
              variant="ghost"
              className="h-6 cursor-pointer"
              onClick={query.retry}
            >
              重试
            </Button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <pre className="min-h-0 flex-1 overflow-auto rounded-xl bg-muted/40 p-3 font-mono text-[10.5px] leading-relaxed text-foreground/90 [scrollbar-gutter:stable]">
              {diff?.diffText || "（无更改）"}
            </pre>
            {diff?.truncated ? (
              <div className="shrink-0 pt-2 text-[10.5px] text-muted-foreground">
                差异已截断
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
