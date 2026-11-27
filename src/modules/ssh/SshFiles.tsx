import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { errorToast } from "@/lib/errorToast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  formatBytes,
  joinPath,
  listDirectory,
  parentDirectory,
  type Side,
  type SshEntry,
  type SshListing,
  type TransferProgress,
} from "@/modules/ssh/api";
import {
  rememberSshDirectory,
  sshFileDirectories,
  type SshProfile,
} from "@/modules/ssh/store";

type BrowserState = {
  listing: SshListing | null;
  selected: Set<string>;
  loading: boolean;
  error: string;
};
const initial = (): BrowserState => ({
  listing: null,
  selected: new Set(),
  loading: true,
  error: "",
});

type FileEdit = { directory: string; oldName?: string; name: string };

const FILE_ROW =
  "grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 px-2 py-1 @min-[20rem]:grid-cols-[1rem_minmax(0,1fr)_3.5rem_7rem]";
const MODIFIED_CELL =
  "col-span-2 col-start-2 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground @min-[20rem]:col-span-1 @min-[20rem]:col-start-4 @min-[20rem]:text-right";
const modifiedFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const ModifiedTime = memo(function ModifiedTime({
  seconds,
}: {
  seconds: number;
}) {
  const date = new Date(seconds * 1000);
  if (seconds === 0 || !Number.isFinite(date.getTime()))
    return <span className={MODIFIED_CELL}>未知</span>;
  return (
    <time
      className={MODIFIED_CELL}
      dateTime={date.toISOString()}
      title={date.toLocaleString("zh-CN", { hourCycle: "h23" })}
    >
      {modifiedFormat.format(date)}
    </time>
  );
});

export function SshFiles({
  id,
  profile,
  projectDirectory,
}: {
  id: number;
  profile: SshProfile;
  projectDirectory: string | null;
}) {
  const [localDefault] = useState(() => projectDirectory || undefined);
  const [local, setLocal] = useState<BrowserState>(initial);
  const [remote, setRemote] = useState<BrowserState>(initial);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [message, setMessage] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [pending, setPending] = useState<Side | null>(null);
  const live = useRef(false);
  const gate = useRef(false);
  const task = useRef<string | null>(null);
  const generations = useRef({ local: 0, remote: 0 });
  const setters = { local: setLocal, remote: setRemote };
  const load = useCallback(
    async (side: Side, ...directories: (string | undefined)[]) => {
      const generation = ++generations.current[side];
      const set = side === "local" ? setLocal : setRemote;
      set((before) => ({ ...before, loading: true, error: "" }));
      const current = () =>
        live.current && generations.current[side] === generation;
      let message = "";
      for (const directory of new Set(directories)) {
        try {
          const listing = await listDirectory(id, side, directory);
          if (!current()) return;
          set((before) => ({
            ...before,
            listing,
            loading: false,
            selected: new Set(),
          }));
          void rememberSshDirectory(profile, side, listing.path).catch(
            (error: unknown) => {
              if (current()) errorToast("保存 SSH 目录失败", error);
            },
          );
          return;
        } catch (error) {
          if (!current()) return;
          message = String(error);
        }
      }
      if (current())
        set((before) => ({ ...before, loading: false, error: message }));
    },
    [id, profile],
  );
  useEffect(() => {
    live.current = true;
    let cancelled = false;
    void sshFileDirectories(profile)
      .catch((error: unknown): Partial<Record<Side, string>> => {
        if (!cancelled) errorToast("读取 SSH 目录记录失败", error);
        return {};
      })
      .then((saved) => {
        if (cancelled) return;
        void load(
          "local",
          saved.local ?? localDefault,
          localDefault,
          undefined,
        );
        void load("remote", saved.remote, undefined);
      });
    return () => {
      cancelled = true;
      live.current = false;
      generations.current.local++;
      generations.current.remote++;
    };
  }, [load, localDefault, profile]);
  const edit = async (side: Side, edit: FileEdit) => {
    if (gate.current) throw new Error("请等待当前文件操作完成");
    gate.current = true;
    setMutating(true);
    try {
      const { directory, name, oldName } = edit;
      if (oldName === undefined) {
        await invoke("ssh_mkdir", { id, side, directory, folderName: name });
      } else {
        await invoke("ssh_rename", {
          id,
          side,
          directory,
          oldName,
          newName: name,
        });
      }
      if (live.current) await load(side, directory);
    } finally {
      gate.current = false;
      if (live.current) setMutating(false);
    }
  };
  const blocked = busy || mutating || local.loading || remote.loading;
  const transfer = (side: Side) => {
    if (gate.current || blocked || !local.listing || !remote.listing) return;
    const names = [...(side === "local" ? local : remote).selected];
    if (!names.length) return;
    const localDirectory = local.listing.path;
    const remoteDirectory = remote.listing.path;
    gate.current = true;
    setBusy(true);
    setCancelling(false);
    setPending(null);
    setMessage("");
    const taskId = crypto.randomUUID();
    task.current = taskId;
    setProgress({ taskId, file: "准备传输…", bytes: 0, files: 0 });
    const onProgress = new Channel<TransferProgress>();
    onProgress.onmessage = (value) => {
      if (live.current && task.current === value.taskId) setProgress(value);
    };
    void invoke<TransferProgress>("ssh_transfer", {
      id,
      request: {
        taskId,
        direction: side === "local" ? "upload" : "download",
        names,
        localDirectory,
        remoteDirectory,
        overwrite,
      },
      onProgress,
    })
      .then((result) => {
        if (live.current) {
          setProgress(result);
          setMessage(
            `已完成 ${result.files} 个文件，${formatBytes(result.bytes)}`,
          );
        }
      })
      .catch((error: unknown) => {
        if (live.current) setMessage(String(error));
      })
      .finally(() => {
        gate.current = false;
        task.current = null;
        if (live.current) {
          setBusy(false);
          setCancelling(false);
          void load("local", localDirectory);
          void load("remote", remoteDirectory);
        }
      });
  };
  const cancel = () => {
    if (!task.current || cancelling) return;
    setCancelling(true);
    void invoke("ssh_transfer_cancel", { id, taskId: task.current }).catch(
      (error: unknown) => {
        if (live.current) {
          setMessage(String(error));
          setCancelling(false);
        }
      },
    );
  };
  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          className="ssh-button"
          disabled={blocked || !local.selected.size || !remote.listing}
          onClick={() => (overwrite ? setPending("local") : transfer("local"))}
        >
          上传 →
        </button>
        <button
          type="button"
          className="ssh-button"
          disabled={blocked || !remote.selected.size || !local.listing}
          onClick={() =>
            overwrite ? setPending("remote") : transfer("remote")
          }
        >
          ← 下载
        </button>
        <label className="ml-auto flex items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={overwrite}
            disabled={busy || mutating}
            onChange={(event) => setOverwrite(event.target.checked)}
          />
          覆盖同名文件
        </label>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(240px,1fr)_minmax(240px,1fr)] divide-x divide-border overflow-x-auto">
        {(["local", "remote"] as const).map((side) => (
          <FileList
            key={side}
            side={side}
            state={side === "local" ? local : remote}
            busy={busy || mutating}
            onEdit={(request) => edit(side, request)}
            onNavigate={(path) => void load(side, path)}
            onSelect={(name) =>
              setters[side]((before) => {
                const selected = new Set(before.selected);
                if (selected.has(name)) selected.delete(name);
                else selected.add(name);
                return { ...before, selected };
              })
            }
          />
        ))}
      </div>
      {(progress || message) && (
        <div
          className="flex items-center gap-3 border-t border-border px-3 py-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-150"
          aria-live="polite"
        >
          <div className="min-w-0 flex-1">
            <p
              key={busy ? "ongoing" : "result"}
              className={
                busy || !message.startsWith("已完成")
                  ? "truncate"
                  : "truncate text-emerald-700 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200 dark:text-emerald-400"
              }
            >
              {busy
                ? `${cancelling ? "正在取消" : "传输中"}：${progress?.file ?? ""}`
                : message}
            </p>
            {progress && (busy || !message.startsWith("已完成")) && (
              <p className="mt-1 text-muted-foreground">
                {formatBytes(progress.bytes)} · 已完成 {progress.files} 个文件
              </p>
            )}
          </div>
          {busy && (
            <button
              type="button"
              className="ssh-button"
              disabled={cancelling}
              onClick={cancel}
            >
              取消
            </button>
          )}
        </div>
      )}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogContent className="gap-4">
          <DialogTitle>覆盖同名文件？</DialogTitle>
          <DialogDescription>
            本次{pending === "local" ? "上传" : "下载"}
            将替换目标目录中的同名文件，文件夹会合并。取消时已完成的文件会保留。
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="ssh-button"
              onClick={() => setPending(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="ssh-button bg-primary text-primary-foreground"
              onClick={() => {
                if (pending) transfer(pending);
              }}
            >
              确认传输
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FileList({
  side,
  state,
  busy,
  onEdit,
  onNavigate,
  onSelect,
}: {
  side: Side;
  state: BrowserState;
  busy: boolean;
  onEdit: (request: FileEdit) => Promise<void>;
  onNavigate: (path: string) => void;
  onSelect: (name: string) => void;
}) {
  const [address, setAddress] = useState("");
  const [draft, setDraft] = useState<FileEdit | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const gate = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    setAddress(state.listing?.path ?? "");
    setError("");
  }, [state.listing?.path]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const navigate = (entry: SshEntry) => {
    if (entry.kind === "dir" && state.listing && !blocked)
      onNavigate(joinPath(state.listing.path, entry.name));
  };
  const blocked = busy || state.loading;
  const onlySelected =
    state.selected.size === 1 ? [...state.selected][0] : undefined;
  const startEdit = (oldName?: string) => {
    if (blocked || !state.listing) return;
    setError("");
    setDraft({ directory: state.listing.path, oldName, name: oldName ?? "" });
  };
  const rename = draft?.oldName !== undefined;
  return (
    <section className="@container flex min-h-0 min-w-[190px] flex-col">
      <div className="flex flex-wrap items-center gap-2 px-2 pt-2">
        <span className="font-medium">
          {side === "local" ? "本地" : "远程"}
        </span>
        <span className="ml-auto text-muted-foreground">
          {state.selected.size ? `已选 ${state.selected.size}` : ""}
        </span>
        <button
          type="button"
          title="刷新"
          className="ssh-button"
          disabled={blocked}
          onClick={() =>
            onNavigate(state.listing?.path ?? (side === "remote" ? "." : ""))
          }
        >
          刷新
        </button>
        <button
          type="button"
          className="ssh-button"
          disabled={blocked || !state.listing}
          onClick={() => startEdit()}
        >
          新建目录
        </button>
        <button
          type="button"
          className="ssh-button"
          disabled={blocked || onlySelected === undefined}
          onClick={() => {
            if (onlySelected !== undefined) startEdit(onlySelected);
          }}
        >
          重命名
        </button>
      </div>
      <form
        className="flex gap-1 p-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!blocked && address.trim()) onNavigate(address.trim());
        }}
      >
        <button
          type="button"
          className="ssh-button"
          title="上级目录"
          disabled={blocked || !state.listing}
          onClick={() => {
            if (state.listing)
              onNavigate(parentDirectory(state.listing.path, side));
          }}
        >
          ↑
        </button>
        <input
          className="ssh-input min-w-0 flex-1"
          aria-label={`${side === "local" ? "本地" : "远程"}路径`}
          value={address}
          disabled={blocked}
          onChange={(event) => setAddress(event.target.value)}
          placeholder={side === "local" ? "C:/Users/用户名" : "/home"}
        />
        <button type="submit" className="ssh-button" disabled={blocked}>
          前往
        </button>
      </form>
      {state.error && (
        <p role="alert" className="break-words px-2 pb-2 text-destructive">
          {state.error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto" aria-busy={state.loading}>
        {state.loading && (
          <p className="px-3 py-2 text-muted-foreground">读取中…</p>
        )}
        {!state.loading && !state.listing?.entries.length && !state.error && (
          <p className="px-3 py-2 text-muted-foreground">空目录</p>
        )}
        {!state.loading && !!state.listing?.entries.length && (
          <div
            className={`${FILE_ROW} hidden border-b border-border text-[11px] text-muted-foreground @min-[20rem]:grid`}
          >
            <span className="col-start-2">名称</span>
            <span className="text-right">大小</span>
            <span className="text-right">修改时间</span>
          </div>
        )}
        {!state.loading &&
          state.listing?.entries.map((entry) => (
            <div
              key={entry.name}
              className={`${FILE_ROW} grid hover:bg-accent ${state.selected.has(entry.name) ? "bg-accent" : ""}`}
            >
              <input
                aria-label={`选择 ${entry.name}`}
                type="checkbox"
                checked={state.selected.has(entry.name)}
                disabled={
                  blocked || (entry.kind !== "file" && entry.kind !== "dir")
                }
                onChange={() => onSelect(entry.name)}
              />
              <button
                type="button"
                className="min-w-0 truncate text-left"
                title={entry.name}
                onDoubleClick={() => navigate(entry)}
                onClick={() => {
                  if (
                    !blocked &&
                    (entry.kind === "file" || entry.kind === "dir")
                  )
                    onSelect(entry.name);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && entry.kind === "dir") {
                    event.preventDefault();
                    navigate(entry);
                  }
                  if (
                    event.key === "F2" &&
                    (entry.kind === "file" || entry.kind === "dir")
                  ) {
                    event.preventDefault();
                    startEdit(entry.name);
                  }
                }}
                disabled={blocked}
              >
                {entry.kind === "dir" ? `${entry.name}/` : entry.name}
              </button>
              <span className="whitespace-nowrap text-right text-[10px] text-muted-foreground">
                {entry.kind === "file"
                  ? formatBytes(entry.size)
                  : entry.kind === "link"
                    ? "链接"
                    : entry.kind === "special"
                      ? "特殊"
                      : ""}
              </span>
              <ModifiedTime seconds={entry.modified} />
            </div>
          ))}
      </div>
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open && !gate.current) setDraft(null);
        }}
      >
        <DialogContent className="gap-4">
          <DialogTitle>
            {rename ? "重命名" : "新建"}
            {side === "local" ? "本地" : "远程"}
            {rename ? "文件或目录" : "目录"}
          </DialogTitle>
          <DialogDescription className="break-all">
            {draft?.oldName ?? draft?.directory}
          </DialogDescription>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                gate.current ||
                blocked ||
                !draft ||
                !draft.name.trim() ||
                draft.name === draft.oldName
              )
                return;
              gate.current = true;
              setSubmitting(true);
              setError("");
              void onEdit({
                ...draft,
                name: rename ? draft.name : draft.name.trim(),
              })
                .then(() => {
                  if (mounted.current) setDraft(null);
                })
                .catch((error: unknown) => {
                  if (mounted.current) setError(String(error));
                })
                .finally(() => {
                  gate.current = false;
                  if (mounted.current) setSubmitting(false);
                });
            }}
          >
            <input
              aria-label={rename ? "新名称" : "目录名称"}
              className="ssh-input"
              required
              value={draft?.name ?? ""}
              disabled={submitting}
              onFocus={(event) => event.target.select()}
              onChange={(event) => {
                const name = event.target.value;
                setDraft((before) => before && { ...before, name });
              }}
            />
            {error && (
              <p role="alert" className="break-words text-xs text-destructive">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="ssh-button justify-self-end"
              disabled={
                blocked ||
                submitting ||
                !draft?.name.trim() ||
                draft.name === draft.oldName
              }
            >
              {submitting ? "处理中…" : rename ? "重命名" : "创建"}
            </button>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
