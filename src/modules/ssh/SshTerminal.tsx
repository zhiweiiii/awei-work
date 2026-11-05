import { useEffect, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { buildTerminalTheme } from "@/styles/terminalTheme";
import { toast } from "sonner";
import "@xterm/xterm/css/xterm.css";

type Runtime = {
  terminal: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  onExit: Set<(reason: string) => void>;
  reason: string | null;
  disposed: boolean;
  resize: () => void;
};
const runtimes = new Map<number, Runtime>();

export function disposeSshTerminal(id: number) {
  const runtime = runtimes.get(id);
  if (!runtime) return;
  runtimes.delete(id);
  runtime.disposed = true;
  runtime.onExit.clear();
  runtime.terminal.dispose();
  runtime.element.remove();
}

function runtimeFor(id: number): Runtime {
  const existing = runtimes.get(id);
  if (existing) return existing;
  const element = document.createElement("div");
  element.className = "h-full w-full";
  const terminal = new Terminal({
    fontFamily: '"JetBrains Mono", Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: buildTerminalTheme(),
    allowProposedApi: false,
    disableStdin: true,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  const runtime: Runtime = {
    terminal,
    fit,
    element,
    onExit: new Set(),
    reason: null,
    disposed: false,
    resize: () => {},
  };
  runtimes.set(id, runtime);
  let opened = false;
  let opening = false;
  let writeTail = Promise.resolve();
  let queuedInput = 0;
  let queuedOutput = 0;
  let fitting = false;
  let resizeTail = Promise.resolve();
  let size = "";
  const fail = (reason: string) => {
    if (runtime.disposed || runtime.reason !== null) return;
    runtime.reason = reason;
    terminal.options.disableStdin = true;
    terminal.writeln(`\r\n${reason}`);
    for (const listener of runtime.onExit) listener(reason);
    void invoke("ssh_disconnect", { id }).catch(() => {});
  };
  terminal.attachCustomKeyEventHandler((event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      event.code === "KeyC" &&
      terminal.hasSelection()
    ) {
      if (event.type === "keydown") {
        event.preventDefault();
        void navigator.clipboard
          .writeText(terminal.getSelection())
          .catch(() => toast.error("复制失败"));
      }
      return false;
    }
    return true;
  });
  terminal.onData((data) => {
    if (!opened || runtime.disposed || runtime.reason !== null) return;
    const length = new TextEncoder().encode(data).length;
    if (queuedInput + length > 1024 * 1024) {
      fail("输入积压超过限制，连接已关闭");
      return;
    }
    queuedInput += length;
    writeTail = writeTail
      .then(async () => {
        if (!runtime.disposed && runtime.reason === null)
          await invoke("ssh_terminal_write", { id, data });
      })
      .catch((error: unknown) => fail(String(error)))
      .finally(() => {
        queuedInput -= length;
      });
  });
  const onData = new Channel<ArrayBuffer>();
  const onExit = new Channel<string>();
  onData.onmessage = (data) => {
    if (runtime.disposed || runtime.reason !== null) return;
    queuedOutput += data.byteLength;
    if (queuedOutput > 4 * 1024 * 1024) {
      fail("终端输出超过缓冲上限，连接已关闭");
      return;
    }
    terminal.write(new Uint8Array(data), () => {
      queuedOutput -= data.byteLength;
    });
  };
  onExit.onmessage = fail;
  runtime.resize = () => {
    if (
      runtime.disposed ||
      fitting ||
      !element.isConnected ||
      element.clientWidth < 30 ||
      element.clientHeight < 30
    )
      return;
    fitting = true;
    requestAnimationFrame(() => {
      fitting = false;
      if (
        runtime.disposed ||
        !element.isConnected ||
        element.clientWidth < 30 ||
        element.clientHeight < 30
      )
        return;
      if (!terminal.element) {
        terminal.open(element);
        if (getComputedStyle(element).visibility !== "hidden") terminal.focus();
      }
      terminal.options.theme = buildTerminalTheme();
      fit.fit();
      if (!opened && !opening) {
        opening = true;
        void invoke("ssh_terminal_open", {
          id,
          cols: terminal.cols,
          rows: terminal.rows,
          onData,
          onExit,
        })
          .then(() => {
            opened = true;
            if (!runtime.disposed && runtime.reason === null) {
              terminal.options.disableStdin = false;
              runtime.resize();
            }
          })
          .catch((error: unknown) => fail(String(error)));
      } else if (
        opened &&
        runtime.reason === null &&
        size !== `${terminal.cols}:${terminal.rows}`
      ) {
        const cols = terminal.cols;
        const rows = terminal.rows;
        size = `${cols}:${rows}`;
        resizeTail = resizeTail
          .then(async () => {
            if (!runtime.disposed && runtime.reason === null)
              await invoke("ssh_terminal_resize", { id, cols, rows });
          })
          .catch((error: unknown) => fail(String(error)));
      }
    });
  };
  return runtime;
}

export function SshTerminal({
  id,
  active,
  onClosed,
}: {
  id: number;
  active: boolean;
  onClosed: (reason: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callback = useRef(onClosed);
  callback.current = onClosed;
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const runtime = runtimeFor(id);
    container.append(runtime.element);
    const notify = (reason: string) => callback.current(reason);
    runtime.onExit.add(notify);
    if (runtime.reason) notify(runtime.reason);
    const observer = new ResizeObserver(runtime.resize);
    observer.observe(container);
    const themes = new MutationObserver(runtime.resize);
    themes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    runtime.resize();
    return () => {
      observer.disconnect();
      themes.disconnect();
      runtime.onExit.delete(notify);
      runtime.element.remove();
    };
  }, [id]);
  useEffect(() => {
    if (!active) return;
    const runtime = runtimes.get(id);
    runtime?.resize();
    runtime?.terminal.focus();
  }, [id, active]);
  return <div ref={host} className="h-full min-h-0 p-2" />;
}
