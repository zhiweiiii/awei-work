import { invoke, Channel } from "@tauri-apps/api/core";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import type { ShellKind } from "@/lib/shellQuote";
import type { GatewayRoutes } from "./gatewayRoutes";

const textEncoder = new TextEncoder();

export type PtyHandlers = {
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
};

export type PtySession = {
  id: number;
  shellKind: ShellKind;
  write: (data: string) => Promise<void>;
  /**
   * Ask for a grid. Resolves with the grid the PTY actually ended up at,
   * which differs from the request while the phone owns the session (see
   * SizeOwner in the Rust pty module): ownership only moves after a cooldown,
   * so the desktop has to render at the owner's grid until it takes over.
   */
  resize: (
    cols: number,
    rows: number,
  ) => Promise<{ cols: number; rows: number }>;
  /** Force a repaint (SIGWINCH) without changing the grid. */
  kick: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
};

export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
  blocks?: boolean,
  shell?: string,
  paneId?: number,
  gatewayRoutes?: GatewayRoutes,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): Promise<PtySession> {
  // Raw bytes — no base64/JSON round-trip; messages arrive as ArrayBuffer.
  const onData = new Channel<ArrayBuffer>();
  const onExit = new Channel<number>();

  let released = false;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    onData.onmessage = noop;
    onExit.onmessage = noop;
  };

  onData.onmessage = (buf) => handlers.onData(new Uint8Array(buf));
  onExit.onmessage = (code) => {
    try {
      handlers.onExit?.(code);
    } finally {
      releaseHandlers();
    }
  };

  let opened: { id: number; shellKind: ShellKind };
  try {
    opened = await invoke<{ id: number; shellKind: ShellKind }>("pty_open", {
      cols,
      rows,
      cwd: cwd ?? null,
      workspace,
      blocks: blocks ?? false,
      shell: shell ?? null,
      paneId: paneId ?? null,
      gatewayRoutes: gatewayRoutes ?? null,
      onData,
      onExit,
    });
  } catch (error) {
    releaseHandlers();
    throw error;
  }

  const { id, shellKind } = opened;
  let closed = false;
  const headers = { "x-pty-id": String(id) };
  let writeTail = Promise.resolve();
  let queuedBytes = 0;
  let queuedWrites = 0;
  const write = (data: string): Promise<void> => {
    if (closed || released) return Promise.reject(new Error("Terminal closed"));
    if (data.length > 4 * 1024 * 1024)
      return Promise.reject(new Error("Terminal input exceeds 4 MiB"));
    const bytes = textEncoder.encode(data);
    if (queuedBytes + bytes.length > 4 * 1024 * 1024 || queuedWrites >= 2048)
      return Promise.reject(new Error("Terminal input queue is full"));
    queuedBytes += bytes.length;
    queuedWrites++;
    const pending = writeTail
      .then(() => {
        if (closed || released) throw new Error("Terminal closed");
        return invoke<void>("pty_write", bytes, { headers });
      })
      .finally(() => {
        queuedBytes -= bytes.length;
        queuedWrites--;
      });
    writeTail = pending.catch(() => {});
    return pending;
  };

  return {
    id,
    shellKind,
    // Raw bytes + id header: no JSON round-trip on the per-keystroke path.
    write,
    resize: (c, r) =>
      invoke<[number, number]>("pty_resize", { id, cols: c, rows: r }).then(
        ([cols, rows]) => ({ cols, rows }),
      ),
    kick: (c, r) => invoke("pty_kick", { id, cols: c, rows: r }),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await invoke("pty_close", { id });
      } finally {
        releaseHandlers();
      }
    },
  };
}
