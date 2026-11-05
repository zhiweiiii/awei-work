import { currentWorkspaceEnv } from "@/modules/workspace";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Transport } from "codemirror-languageserver";
import { pathToFileUri } from "@/modules/lsp/lib/uri";

export type LspSpawnConfig = {
  command: string;
  args: string[];
  root: string;
  env?: Record<string, string>;
  maxMemoryMb?: number;
  configuration?: unknown;
  cacheGeneration?: number;
};

export type LspExitInfo = {
  code: number | null;
  stderrTail: string;
  reason: string | null;
};

type ServerRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

function isServerRequest(msg: unknown): msg is ServerRequest {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "id" in msg &&
    (typeof msg.id === "string" || typeof msg.id === "number") &&
    "method" in msg &&
    typeof msg.method === "string"
  );
}

export class TauriLspTransport implements Transport {
  private sessionId: number | null = null;
  private closed = false;
  private onMsg: ((message: string) => void) | null = null;
  private onCloseCb: (() => void) | null = null;
  private onErrorCb: ((error: Error) => void) | null = null;
  private backlog: string[] = [];
  private pendingSends: string[] = [];
  private sendTail: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private root: string | null = null;
  private configuration: unknown = {};
  exitInfo: LspExitInfo | null = null;

  async start(config: LspSpawnConfig): Promise<void> {
    this.root = config.root;
    this.configuration = config.configuration ?? {};
    const decoder = new TextDecoder();
    const onMessage = new Channel<ArrayBuffer>();
    onMessage.onmessage = (buf) => {
      if (this.closed) return;
      const text = decoder.decode(buf);
      if (this.answerServerRequest(text)) return;
      if (this.onMsg) this.onMsg(text);
      else this.backlog.push(text);
    };
    const onExit = new Channel<LspExitInfo>();
    onExit.onmessage = (info) => {
      this.exitInfo = info;
      this.closed = true;
      this.sessionId = null;
      this.pendingSends = [];
      this.backlog = [];
      this.onCloseCb?.();
    };
    const sessionId = await invoke<number>("lsp_spawn", {
      command: config.command,
      args: config.args,
      env: config.env ?? null,
      root: config.root,
      maxRssMb: config.maxMemoryMb ?? null,
      cacheGeneration: config.cacheGeneration ?? null,
      workspace: currentWorkspaceEnv(),
      onMessage,
      onExit,
    });
    if (this.closed) {
      await invoke("lsp_kill", { id: sessionId }).catch(() => {});
      return;
    }
    this.sessionId = sessionId;
    const pending = this.pendingSends;
    this.pendingSends = [];
    for (const message of pending) this.send(message);
  }

  // The client library ignores server-to-client requests entirely.
  private answerServerRequest(text: string): boolean {
    // Cheap pre-check: requests carry both markers; skips a redundant
    // JSON.parse of large notification payloads like publishDiagnostics.
    if (!text.includes('"id"') || !text.includes('"method"')) return false;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return false;
    }
    if (!isServerRequest(msg)) return false;
    const reply = (body: Record<string, unknown>) =>
      this.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }));
    switch (msg.method) {
      case "workspace/configuration": {
        const items =
          (msg.params as { items?: unknown[] } | undefined)?.items ?? [];
        if (!Array.isArray(items)) {
          reply({
            error: { code: -32602, message: "Invalid configuration items" },
          });
          return true;
        }
        reply({
          result: items.map((item) => {
            const section = (item as { section?: unknown } | null)?.section;
            if (section === undefined || section === "")
              return this.configuration;
            if (typeof section !== "string") return null;
            let value: unknown = this.configuration;
            for (const part of section.split(".")) {
              if (!value || typeof value !== "object") return null;
              const field = Object.getOwnPropertyDescriptor(value, part);
              if (!field) return null;
              value = field.value;
            }
            return value;
          }),
        });
        return true;
      }
      case "window/workDoneProgress/create":
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/showMessageRequest":
        reply({ result: null });
        return true;
      case "workspace/workspaceFolders":
        reply({
          result: this.root
            ? [
                {
                  uri: pathToFileUri(this.root),
                  name: this.root.split(/[\\/]/).pop() ?? this.root,
                },
              ]
            : [],
        });
        return true;
      default:
        reply({
          error: { code: -32601, message: `unhandled method ${msg.method}` },
        });
        return true;
    }
  }

  send(message: string): void {
    if (this.closed) return;
    if (this.sessionId == null) {
      this.pendingSends.push(message);
      return;
    }
    const id = this.sessionId;
    const bytes = message.length * 2;
    if (this.queuedBytes + bytes > 16 * 1024 * 1024) {
      this.onErrorCb?.(new Error("Language server input queue exceeds 16 MiB"));
      this.close();
      return;
    }
    this.queuedBytes += bytes;
    this.sendTail = this.sendTail
      .then(async () => {
        if (!this.closed && this.sessionId === id)
          await invoke("lsp_send", { id, message });
      })
      .catch((error: unknown) => {
        if (!this.closed) {
          this.onErrorCb?.(new Error(String(error)));
          this.close();
        }
      })
      .finally(() => {
        this.queuedBytes -= bytes;
      });
  }

  onMessage(callback: (message: string) => void): void {
    this.onMsg = callback;
    if (this.backlog.length > 0) {
      const queued = this.backlog;
      this.backlog = [];
      for (const m of queued) callback(m);
    }
  }

  onClose(callback: () => void): void {
    this.onCloseCb = callback;
    if (this.closed) callback();
  }

  onError(callback: (error: Error) => void): void {
    this.onErrorCb = callback;
  }

  close(): void {
    this.pendingSends = [];
    this.backlog = [];
    if (this.closed) {
      this.sessionId = null;
      return;
    }
    this.closed = true;
    if (this.sessionId != null) {
      void invoke("lsp_kill", { id: this.sessionId }).catch(() => {});
      this.sessionId = null;
    }
  }

  async shutdown(): Promise<void> {
    await this.sendTail;
    const id = this.sessionId;
    if (id !== null && !this.closed) await invoke("lsp_shutdown", { id });
    this.close();
  }
}
