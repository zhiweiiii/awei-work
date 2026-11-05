import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
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

type BrowserState = {
  listing: SshListing | null;
  selected: Set<string>;
  loading: boolean;
  error: string;
};
const initial = (): BrowserState => ({
  listing: null,
  selected: new Set(),
  loading: false,
  error: "",
});

export function SshFiles({ id }: { id: number }) {
  const [local, setLocal] = useState<BrowserState>(initial);
  const [remote, setRemote] = useState<BrowserState>(initial);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [busy, setBusy] = useState(false);
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
    async (side: Side, directory?: string) => {
      const generation = ++generations.current[side];
      const set = side === "local" ? setLocal : setRemote;
      set((before) => ({ ...before, loading: true, error: "" }));
      try {
        const listing = await listDirectory(id, side, directory);
        if (live.current && generations.current[side] === generation)
          set((before) => ({
            ...before,
            listing,
            loading: false,
            selected: new Set(),
          }));
      } catch (error) {
        if (live.current && generations.current[side] === generation)
          set((before) => ({
            ...before,
            loading: false,
            error: String(error),
          }));
      }
    },
    [id],
  );
  useEffect(() => {
    live.current = true;
    void load("local");
    void load("remote");
    return () => {
      live.current = false;
      generations.current.local++;
      generations.current.remote++;
    };
  }, [load]);
  const transfer = (side: Side) => {
    if (gate.current || !local.listing || !remote.listing) return;
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
          disabled={busy || !local.selected.size || !remote.listing}
          onClick={() => (overwrite ? setPending("local") : transfer("local"))}
        >
          上传 →
        </button>
        <button
          type="button"
          className="ssh-button"
          disabled={busy || !remote.selected.size || !local.listing}
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
            disabled={busy}
            onChange={(event) => setOverwrite(event.target.checked)}
          />
          覆盖同名文件
        </label>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(240px,1fr)_minmax(240px,1fr)] divide-x divide-border overflow-x-auto">
        {(["local", "remote"] as const).map((side) => (
          <FileList
            key={side}
            id={id}
            side={side}
            state={side === "local" ? local : remote}
            busy={busy}
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
          className="flex items-center gap-3 border-t border-border px-3 py-2"
          aria-live="polite"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate">
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
  id,
  side,
  state,
  busy,
  onNavigate,
  onSelect,
}: {
  id: number;
  side: Side;
  state: BrowserState;
  busy: boolean;
  onNavigate: (path: string) => void;
  onSelect: (name: string) => void;
}) {
  const [address, setAddress] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
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
    if (entry.kind === "dir" && state.listing && !busy)
      onNavigate(joinPath(state.listing.path, entry.name));
  };
  return (
    <section className="flex min-h-0 min-w-[190px] flex-col">
      <div className="flex items-center gap-2 px-2 pt-2">
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
          disabled={busy || state.loading}
          onClick={() =>
            onNavigate(state.listing?.path ?? (side === "remote" ? "." : ""))
          }
        >
          刷新
        </button>
        <button
          type="button"
          className="ssh-button"
          disabled={busy || !state.listing}
          onClick={() => setFolder("")}
        >
          新建目录
        </button>
      </div>
      <form
        className="flex gap-1 p-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && address.trim()) onNavigate(address.trim());
        }}
      >
        <button
          type="button"
          className="ssh-button"
          title="上级目录"
          disabled={busy || !state.listing}
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
          disabled={busy}
          onChange={(event) => setAddress(event.target.value)}
          placeholder={side === "local" ? "C:/Users/用户名" : "/home"}
        />
        <button type="submit" className="ssh-button" disabled={busy}>
          前往
        </button>
      </form>
      {(state.error || error) && (
        <p role="alert" className="break-words px-2 pb-2 text-destructive">
          {state.error || error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto" aria-busy={state.loading}>
        {state.loading && (
          <p className="px-3 py-2 text-muted-foreground">读取中…</p>
        )}
        {!state.loading && !state.listing?.entries.length && !state.error && (
          <p className="px-3 py-2 text-muted-foreground">空目录</p>
        )}
        {!state.loading &&
          state.listing?.entries.map((entry) => (
            <div
              key={entry.name}
              className={`flex items-center gap-2 px-2 py-1 hover:bg-accent ${state.selected.has(entry.name) ? "bg-accent" : ""}`}
            >
              <input
                aria-label={`选择 ${entry.name}`}
                type="checkbox"
                checked={state.selected.has(entry.name)}
                disabled={
                  busy || (entry.kind !== "file" && entry.kind !== "dir")
                }
                onChange={() => onSelect(entry.name)}
              />
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                title={entry.name}
                onDoubleClick={() => navigate(entry)}
                onClick={() => {
                  if (!busy && (entry.kind === "file" || entry.kind === "dir"))
                    onSelect(entry.name);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && entry.kind === "dir") {
                    event.preventDefault();
                    navigate(entry);
                  }
                }}
                disabled={busy}
              >
                {entry.kind === "dir" ? `${entry.name}/` : entry.name}
              </button>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {entry.kind === "file"
                  ? formatBytes(entry.size)
                  : entry.kind === "link"
                    ? "链接"
                    : entry.kind === "special"
                      ? "特殊"
                      : ""}
              </span>
            </div>
          ))}
      </div>
      <Dialog
        open={folder !== null}
        onOpenChange={(open) => {
          if (!open && !creating) setFolder(null);
        }}
      >
        <DialogContent className="gap-4">
          <DialogTitle>
            新建{side === "local" ? "本地" : "远程"}目录
          </DialogTitle>
          <DialogDescription className="break-all">
            {state.listing?.path}
          </DialogDescription>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (gate.current || !state.listing || !folder?.trim()) return;
              gate.current = true;
              setCreating(true);
              const directory = state.listing.path;
              void invoke("ssh_mkdir", {
                id,
                side,
                directory,
                folderName: folder.trim(),
              })
                .then(() => {
                  if (mounted.current) {
                    setFolder(null);
                    onNavigate(directory);
                  }
                })
                .catch((error: unknown) => {
                  if (mounted.current) setError(String(error));
                })
                .finally(() => {
                  gate.current = false;
                  if (mounted.current) setCreating(false);
                });
            }}
          >
            <input
              aria-label="目录名称"
              className="ssh-input"
              required
              value={folder ?? ""}
              onChange={(event) => setFolder(event.target.value)}
            />
            {error && (
              <p role="alert" className="break-words text-xs text-destructive">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="ssh-button justify-self-end"
              disabled={creating}
            >
              {creating ? "创建中…" : "创建"}
            </button>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
