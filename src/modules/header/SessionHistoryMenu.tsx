import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorToast } from "@/lib/errorToast";
import {
  currentWorkspaceScopeKey,
  LOCAL_WORKSPACE,
  workspaceScopeKey,
} from "@/modules/workspace";
import { Add01Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type Session = {
  agent: "claude" | "codex";
  id: string;
  title: string;
  updatedAt: number;
};

const AGENT_LABEL: Record<Session["agent"], string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** What each agent's own resume takes. Typed into the shell as written. */
function resumeCommand(session: Session): string {
  return session.agent === "claude"
    ? `claude --resume ${session.id}`
    : `codex resume ${session.id}`;
}

function ageLabel(updatedAt: number): string {
  const minutes = Math.max(0, Math.floor(Date.now() / 1000 - updatedAt) / 60);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${Math.floor(minutes)} 分钟前`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

type Props = {
  /** Directory the list is scoped to. Both agents key their history by it. */
  cwd: string | null;
  /** Runs a command in the terminal being shown. Null when there is none,
   *  which is when there is nothing to resume into. */
  onRun: ((command: string) => void) | null;
};

/**
 * Past Claude Code and Codex conversations for this directory, resumable.
 *
 * The list is read from the files the agents write, not from their own resume
 * pickers: those are interactive TUIs, so using them would mean spawning a
 * process and scraping a screen for something already sitting on disk.
 *
 * Loading happens when the menu opens. It is a directory walk plus a bounded
 * read per session, cheap but not free, and an unopened menu should cost
 * nothing.
 */
export function SessionHistoryMenu({ cwd, onRun }: Props) {
  const workspace = LOCAL_WORKSPACE;
  const scopeKey = workspaceScopeKey(workspace);
  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState(0);
  const [result, setResult] = useState<{
    cwd: string | null;
    scopeKey: string;
    requestId: number;
    sessions: Session[];
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    if (!cwd) {
      setResult({ cwd, scopeKey, requestId, sessions: [] });
      return;
    }
    let cancelled = false;
    void invoke<Session[]>("agent_sessions", { cwd, workspace }).then(
      (sessions) => {
        if (!cancelled && currentWorkspaceScopeKey() === scopeKey)
          setResult({ cwd, scopeKey, requestId, sessions });
      },
      (error) => {
        if (cancelled || currentWorkspaceScopeKey() !== scopeKey) return;
        setResult({
          cwd,
          scopeKey,
          requestId,
          sessions: [],
          error: String(error),
        });
        errorToast("读取会话历史失败", error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cwd, open, requestId, scopeKey]);

  const sessions =
    result?.cwd === cwd &&
    result.scopeKey === scopeKey &&
    result.requestId === requestId
      ? result.sessions
      : null;
  const loading = open && sessions === null;

  const resume = (session: Session) => {
    if (
      !onRun ||
      currentWorkspaceScopeKey() !== scopeKey ||
      !sessions?.includes(session)
    )
      return;
    onRun(resumeCommand(session));
  };

  return (
    <DropdownMenu
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setRequestId((id) => id + 1);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="会话历史"
          aria-label="会话历史"
        >
          <HugeiconsIcon icon={Clock01Icon} size={14} strokeWidth={1.75} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[70vh] w-80 overflow-y-auto"
      >
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
          新对话
        </DropdownMenuLabel>
        <DropdownMenuItem disabled={!onRun} onSelect={() => onRun?.("claude")}>
          <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={1.75} />
          新对话 Claude Code
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!onRun} onSelect={() => onRun?.("codex")}>
          <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={1.75} />
          新对话 Codex
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
          {cwd ? `${cwd} 的历史会话` : "没有命令行"}
        </DropdownMenuLabel>

        {loading && sessions === null ? (
          <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            读取中…
          </div>
        ) : null}

        {result?.error && sessions !== null ? (
          <button
            type="button"
            onClick={() => setRequestId((id) => id + 1)}
            className="w-full px-2 py-3 text-center text-[11px] text-destructive hover:bg-accent"
            title={result.error}
          >
            读取历史失败，点击重试
          </button>
        ) : sessions !== null && sessions.length === 0 && !loading ? (
          <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            这个目录还没有历史会话
          </div>
        ) : null}

        {sessions?.map((session) => (
          <DropdownMenuItem
            key={`${session.agent}:${session.id}`}
            disabled={!onRun}
            onSelect={() => resume(session)}
            className="flex flex-col items-start gap-0.5 py-1.5"
          >
            <span className="w-full truncate text-[11.5px]">
              {session.title}
            </span>
            <span className="flex w-full items-center gap-1.5 text-[10px] text-muted-foreground">
              <span
                aria-hidden
                className={`size-1.5 shrink-0 rounded-full ${
                  session.agent === "claude" ? "bg-orange-500" : "bg-sky-500"
                }`}
              />
              {AGENT_LABEL[session.agent]}
              <span className="ml-auto shrink-0">
                {ageLabel(session.updatedAt)}
              </span>
            </span>
          </DropdownMenuItem>
        ))}

        {sessions && sessions.length > 0 && !onRun ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-[10px] text-muted-foreground">
              当前标签不是命令行，无法恢复
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
