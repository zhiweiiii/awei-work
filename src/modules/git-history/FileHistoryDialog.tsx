import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  native,
  type GitDiffContentResult,
  type GitLogEntry,
} from "@/lib/native";
import {
  ChevronDownIcon,
  Copy01Icon,
  File02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorToast } from "@/lib/errorToast";
import {
  currentWorkspaceScopeKey,
  LOCAL_WORKSPACE,
  workspaceScopeKey,
} from "@/modules/workspace/env";

export type FileHistoryCommitFileInput = {
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoRoot: string;
  /** Repo-relative path, e.g. `src/app/App.tsx`. */
  path: string;
  /** When provided, row clicks open the commit's single-file diff in a tab. */
  onOpenCommitFile?: (input: FileHistoryCommitFileInput) => void;
};

type LoadState = "loading" | "idle" | "error";

type DiffState =
  | { state: "loading" }
  | { state: "loaded"; text: string; truncated: boolean }
  | { state: "error"; error: string };

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown error";
}

function relativeDate(secs: number): string {
  if (!secs) return "";
  const delta = Math.max(0, Date.now() / 1000 - secs);
  const units: [number, string][] = [
    [365 * 86400, "年前"],
    [30 * 86400, "个月前"],
    [7 * 86400, "周前"],
    [86400, "天前"],
    [3600, "小时前"],
    [60, "分钟前"],
  ];
  for (const [span, label] of units) {
    if (delta >= span) return `${Math.floor(delta / span)} ${label}`;
  }
  return "刚刚";
}

export function FileHistoryDialog({
  open,
  onOpenChange,
  repoRoot,
  path,
  onOpenCommitFile,
}: Props) {
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [expandedSha, setExpandedSha] = useState<string | null>(null);
  const [diffEntry, setDiffEntry] = useState<DiffState | null>(null);
  const [copiedSha, setCopiedSha] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const diffRequestRef = useRef(0);
  const workspace = LOCAL_WORKSPACE;
  const environmentKey = workspaceScopeKey(workspace);
  const scopeKey = JSON.stringify([open, repoRoot, path, environmentKey]);
  const scopeRef = useRef({ key: scopeKey });
  if (scopeRef.current.key !== scopeKey) {
    scopeRef.current = { key: scopeKey };
    requestIdRef.current++;
    diffRequestRef.current++;
  }
  const scope = scopeRef.current;
  const [loadedScope, setLoadedScope] = useState(scope);
  const current = useCallback(
    () =>
      open &&
      scopeRef.current === scope &&
      currentWorkspaceScopeKey() === environmentKey,
    [open, scope, environmentKey],
  );

  const loadLog = useCallback(async () => {
    if (!current()) return;
    const requestId = ++requestIdRef.current;
    setLoadState("loading");
    setError(null);
    setCommits([]);
    setLoadedScope(scope);
    setExpandedSha(null);
    setDiffEntry(null);
    diffRequestRef.current += 1;
    try {
      const entries = await native.gitLogFile(
        repoRoot,
        path,
        {
          maxCount: 50,
        },
        workspace,
      );
      if (requestId !== requestIdRef.current || !current()) return;
      setCommits(entries);
      setLoadState("idle");
    } catch (err) {
      if (requestId !== requestIdRef.current || !current()) return;
      setError(normalizeError(err));
      setLoadState("error");
    }
  }, [repoRoot, path, current, scope]);

  useEffect(() => {
    if (!open) return;
    void loadLog();
    return () => {
      requestIdRef.current += 1;
      diffRequestRef.current += 1;
    };
  }, [open, loadLog]);

  useEffect(() => {
    if (!copiedSha) return;
    const t = window.setTimeout(() => setCopiedSha(null), 1100);
    return () => window.clearTimeout(t);
  }, [copiedSha]);

  const loadDiff = useCallback(
    async (sha: string) => {
      if (!current()) return;
      const requestId = ++diffRequestRef.current;
      setDiffEntry({ state: "loading" });
      try {
        const result: GitDiffContentResult = await native.gitCommitFileDiff(
          repoRoot,
          sha,
          path,
          null,
          workspace,
        );
        if (requestId !== diffRequestRef.current || !current()) return;
        setDiffEntry({
          state: "loaded",
          text: result.fallbackPatch,
          truncated: result.truncated,
        });
      } catch (err) {
        if (requestId !== diffRequestRef.current || !current()) return;
        setDiffEntry({ state: "error", error: normalizeError(err) });
      }
    },
    [repoRoot, path, current],
  );

  const handleRowClick = useCallback(
    (commit: GitLogEntry) => {
      if (!current()) return;
      if (onOpenCommitFile) {
        onOpenCommitFile({
          repoRoot,
          sha: commit.sha,
          shortSha: commit.shortSha,
          subject: commit.subject,
          path,
          originalPath: null,
        });
        return;
      }
      if (expandedSha === commit.sha) {
        diffRequestRef.current++;
        setExpandedSha(null);
        setDiffEntry(null);
        return;
      }
      setExpandedSha(commit.sha);
      void loadDiff(commit.sha);
    },
    [expandedSha, loadDiff, onOpenCommitFile, path, repoRoot, current],
  );

  const copySha = useCallback(
    async (sha: string) => {
      const requestId = requestIdRef.current;
      try {
        await navigator.clipboard.writeText(sha);
        if (current() && requestIdRef.current === requestId) setCopiedSha(sha);
      } catch (error) {
        errorToast("Could not copy commit SHA", error);
      }
    },
    [current],
  );

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-1.5">
            <HugeiconsIcon
              icon={File02Icon}
              size={16}
              strokeWidth={1.75}
              className="text-muted-foreground"
            />
            历史记录 - {basename(path)}
          </AlertDialogTitle>
          <AlertDialogDescription
            className="truncate font-mono text-[11px]"
            title={path}
          >
            {path}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="-mt-2 max-h-[55vh] min-h-[160px] overflow-y-auto">
          {loadedScope !== scope || loadState === "loading" ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-muted-foreground">
              <Spinner className="size-3" />
              加载中…
            </div>
          ) : loadState === "error" ? (
            <div className="grid gap-2 py-6 text-center">
              <div className="px-4 text-xs text-destructive">
                {error ?? "加载失败"}
              </div>
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void loadLog()}
                >
                  重试
                </Button>
              </div>
            </div>
          ) : commits.length === 0 ? (
            <div className="py-10 text-center text-[11px] text-muted-foreground">
              此文件没有提交历史记录。
            </div>
          ) : (
            <ul className="space-y-px">
              {commits.map((commit) => {
                const expanded = expandedSha === commit.sha;
                return (
                  <li key={commit.sha}>
                    <div
                      className={cn(
                        "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 transition-colors",
                        expanded ? "bg-accent/45" : "hover:bg-accent/25",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => handleRowClick(commit)}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                      >
                        <HugeiconsIcon
                          icon={ChevronDownIcon}
                          size={12}
                          strokeWidth={2}
                          className={cn(
                            "shrink-0 text-muted-foreground/60 transition-transform",
                            expanded && "rotate-180",
                          )}
                        />
                        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground/80">
                          {commit.shortSha}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-tight text-foreground/95">
                          {commit.subject || (
                            <span className="text-muted-foreground">
                              (no subject)
                            </span>
                          )}
                        </span>
                        <span
                          className="max-w-24 shrink-0 truncate text-[10.5px] text-muted-foreground/80"
                          title={commit.authorEmail || commit.author}
                        >
                          {commit.author || "Unknown"}
                        </span>
                        <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/70">
                          {relativeDate(commit.timestampSecs)}
                        </span>
                      </button>
                      <button
                        type="button"
                        title="复制 SHA"
                        onClick={() => void copySha(commit.sha)}
                        className={cn(
                          "flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[10px] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-foreground/8",
                          copiedSha === commit.sha
                            ? "text-primary"
                            : "text-muted-foreground",
                        )}
                      >
                        <HugeiconsIcon
                          icon={Copy01Icon}
                          size={10}
                          strokeWidth={1.9}
                        />
                        {copiedSha === commit.sha ? "已复制" : "SHA"}
                      </button>
                    </div>
                    {expanded ? (
                      <div className="px-2 pb-2 pl-7">
                        {diffEntry?.state === "loading" ? (
                          <div className="flex items-center gap-2 py-3 text-[10.5px] text-muted-foreground">
                            <Spinner className="size-3" />
                            加载 diff…
                          </div>
                        ) : diffEntry?.state === "error" ? (
                          <div className="flex items-center justify-between gap-2 py-2 text-[10.5px] text-destructive">
                            <span className="truncate">{diffEntry.error}</span>
                            <Button
                              size="xs"
                              variant="ghost"
                              className="h-6 cursor-pointer text-[10.5px]"
                              onClick={() => void loadDiff(commit.sha)}
                            >
                              重试
                            </Button>
                          </div>
                        ) : diffEntry?.state === "loaded" ? (
                          <>
                            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/40 p-2.5 font-mono text-[10px] leading-snug text-foreground/85">
                              {diffEntry.text || "无差异。"}
                            </pre>
                            {diffEntry.truncated ? (
                              <div className="mt-1 text-[10px] text-muted-foreground/60">
                                Diff 已截断。
                              </div>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>关闭</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
