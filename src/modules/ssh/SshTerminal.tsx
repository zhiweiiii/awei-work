import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ensureMonoFontsLoaded, resolveFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { buildTerminalTheme } from "@/styles/terminalTheme";
import { Channel, invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { type FontWeight, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Runtime = {
  terminal: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  onExit: Set<(reason: string) => void>;
  reason: string | null;
  disposed: boolean;
  resize: () => void;
  applyPreferences: () => void;
  copySelection: () => Promise<boolean>;
  pasteClipboard: () => Promise<void>;
};
const runtimes = new Map<number, Runtime>();

function sshTerminalPreferences() {
  const prefs = usePreferencesStore.getState();
  return {
    fontFamily: resolveFontFamily(prefs.terminalFontFamily),
    fontWeight: prefs.terminalFontWeight as FontWeight,
    letterSpacing: prefs.terminalLetterSpacing,
    fontSize: Math.max(4, Math.round(prefs.terminalFontSize * prefs.zoomLevel)),
    cursorBlink: prefs.terminalCursorBlink,
    cursorStyle: prefs.terminalCursorStyle,
    scrollback: prefs.terminalScrollback,
  };
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to execCommand when WebView clipboard permission rejects.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  if (!ok) throw new Error("Clipboard write failed");
}

function isKey(event: KeyboardEvent, code: string, key: string): boolean {
  return (
    event.code === code ||
    event.key === key ||
    event.key === key.toUpperCase()
  );
}

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
  const initialPrefs = sshTerminalPreferences();
  const terminal = new Terminal({
    ...initialPrefs,
    theme: buildTerminalTheme(),
    allowProposedApi: false,
    disableStdin: true,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  const copySelection = async (): Promise<boolean> => {
    const selection = terminal.getSelection();
    if (!selection) return false;
    try {
      await writeClipboardText(selection);
      return true;
    } catch {
      toast.error("复制失败");
      return false;
    }
  };
  const pasteClipboard = async (): Promise<void> => {
    if (runtime.disposed || runtime.reason !== null || !opened) return;
    try {
      const text = await navigator.clipboard?.readText();
      if (text && !runtime.disposed && runtime.reason === null) {
        terminal.paste(text);
      }
    } catch {
      toast.error("读取剪贴板失败");
    }
  };
  const runtime: Runtime = {
    terminal,
    fit,
    element,
    onExit: new Set(),
    reason: null,
    disposed: false,
    resize: () => {},
    applyPreferences: () => {
      if (runtime.disposed) return;
      const next = sshTerminalPreferences();
      let refit = false;
      if (terminal.options.fontFamily !== next.fontFamily) {
        terminal.options.fontFamily = next.fontFamily;
        refit = true;
      }
      if (terminal.options.fontWeight !== next.fontWeight) {
        terminal.options.fontWeight = next.fontWeight;
        refit = true;
      }
      if (terminal.options.letterSpacing !== next.letterSpacing) {
        terminal.options.letterSpacing = next.letterSpacing;
        refit = true;
      }
      if (terminal.options.fontSize !== next.fontSize) {
        terminal.options.fontSize = next.fontSize;
        refit = true;
      }
      if (terminal.options.cursorBlink !== next.cursorBlink) {
        terminal.options.cursorBlink = next.cursorBlink;
      }
      if (terminal.options.cursorStyle !== next.cursorStyle) {
        terminal.options.cursorStyle = next.cursorStyle;
      }
      if (terminal.options.scrollback !== next.scrollback) {
        terminal.options.scrollback = next.scrollback;
      }
      if (refit) runtime.resize();
    },
    copySelection,
    pasteClipboard,
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
    if (event.isComposing || event.keyCode === 229) return false;
    const ctrlOnly = event.ctrlKey && !event.altKey && !event.metaKey;
    if (ctrlOnly && isKey(event, "KeyC", "c")) {
      if (event.shiftKey || terminal.hasSelection()) {
        event.preventDefault();
        if (event.type === "keydown" && terminal.hasSelection()) {
          void copySelection().then((copied) => {
            if (copied && !event.shiftKey && !runtime.disposed) {
              terminal.clearSelection();
            }
          });
        }
        return false;
      }
    }
    if (ctrlOnly && isKey(event, "KeyV", "v")) {
      event.preventDefault();
      if (event.type === "keydown") {
        void pasteClipboard();
      }
      return false;
    }
    return true;
  });
  void ensureMonoFontsLoaded().then(() => {
    if (runtime.disposed || !terminal.element) return;
    terminal.options.fontFamily = sshTerminalPreferences().fontFamily;
    runtime.resize();
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
  const [hasSelection, setHasSelection] = useState(false);
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize);
  const terminalFontFamily = usePreferencesStore((s) => s.terminalFontFamily);
  const terminalFontWeight = usePreferencesStore((s) => s.terminalFontWeight);
  const terminalLetterSpacing = usePreferencesStore(
    (s) => s.terminalLetterSpacing,
  );
  const terminalCursorBlink = usePreferencesStore((s) => s.terminalCursorBlink);
  const terminalCursorStyle = usePreferencesStore((s) => s.terminalCursorStyle);
  const terminalScrollback = usePreferencesStore((s) => s.terminalScrollback);

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
    runtime.applyPreferences();
    runtime.resize();
    return () => {
      observer.disconnect();
      themes.disconnect();
      runtime.onExit.delete(notify);
      runtime.element.remove();
    };
  }, [id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Preference fields drive runtime.applyPreferences().
  useEffect(() => {
    runtimes.get(id)?.applyPreferences();
  }, [
    id,
    zoomLevel,
    terminalFontSize,
    terminalFontFamily,
    terminalFontWeight,
    terminalLetterSpacing,
    terminalCursorBlink,
    terminalCursorStyle,
    terminalScrollback,
  ]);

  useEffect(() => {
    if (!active) return;
    const runtime = runtimes.get(id);
    runtime?.applyPreferences();
    runtime?.resize();
    runtime?.terminal.focus();
  }, [id, active]);

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) {
          setHasSelection(Boolean(runtimes.get(id)?.terminal.hasSelection()));
        }
      }}
    >
      <ContextMenuTrigger asChild>
        <div className="relative h-full w-full min-h-0 leading-normal">
          <div ref={host} className="zoom-exempt h-full w-full p-2" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-32 p-1"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          runtimes.get(id)?.terminal.focus();
        }}
      >
        <ContextMenuItem
          disabled={!hasSelection}
          className="rounded-xl px-2.5 py-1.5 text-[13px]"
          onSelect={() => {
            void runtimes.get(id)?.copySelection();
          }}
        >
          复制
        </ContextMenuItem>
        <ContextMenuItem
          className="rounded-xl px-2.5 py-1.5 text-[13px]"
          onSelect={() => {
            void runtimes.get(id)?.pasteClipboard();
          }}
        >
          粘贴
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="rounded-xl px-2.5 py-1.5 text-[13px]"
          onSelect={() => {
            runtimes.get(id)?.terminal.selectAll();
          }}
        >
          全选
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
