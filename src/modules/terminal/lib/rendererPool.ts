import { openExternalUrl } from "@/lib/external-link";
import { resolveFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { TerminalCursorStyle } from "@/modules/settings/store";
import {
  recordTerminalEvent,
  terminalDiagnosticsEnabled,
} from "@/modules/terminal/lib/terminalDiagnostics";
import { buildTerminalTheme } from "@/styles/terminalTheme";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type FontWeight, Terminal } from "@xterm/xterm";
import { toast } from "sonner";
import { clipboardAttachmentPaths } from "./clipboardAttachments";
import { shouldCursorBlink } from "./cursorBlink";
import { terminalReadlineSequence } from "./keymap";
import {
  readTerminalClipboard,
  writeTerminalClipboard,
} from "./terminalClipboard";
import { createTerminalLinkHandler } from "./terminalLinks";
import { pasteIntoTerminal } from "./terminalPaste";

export const POOL_MAX_SIZE = 5;
const FIT_DEBOUNCE_MS = 8;
const PTY_RESIZE_DEBOUNCE_MS = 256;
const SNAPSHOT_SCROLLBACK_CAP = 5_000;

export type SlotAdapter = {
  onUserInput(leafId: number): void;
  resolveLeaf(leafId: number): LeafBridge | null;
  evictLeaf(leafId: number): void;
  focusLeafInput(leafId: number): boolean;
  pasteLeafInput(leafId: number, text: string): boolean;
  formatLeafPaths(leafId: number, paths: string[]): string | null;
  formatNativeLeafPaths(
    leafId: number,
    paths: string[],
  ): Promise<string | null>;
  isLeafFocused(leafId: number): boolean;
  isLeafBlocks(leafId: number): boolean;
  isLeafBusy(leafId: number): boolean;
  isLeafVisible(leafId: number): boolean;
  storeSnapshot(leafId: number, out: SerializeOutput): void;
};

export type LeafBridge = {
  writeToPty(data: string): void;
  resizePty(cols: number, rows: number): void;
  // Force a SIGWINCH on the underlying PTY at the given dims. Implemented
  // as a +1 row / restore bump because the Linux kernel suppresses winsize
  // ioctls that don't actually change the size. Used to make alt-screen
  // TUIs repaint from scratch after they were dormant.
  kickPty(cols: number, rows: number): void;
};

export type Slot = {
  readonly id: number;
  readonly term: Terminal;
  readonly fitAddon: FitAddon;
  readonly serializeAddon: SerializeAddon;
  readonly host: HTMLDivElement;
  webglAddon: WebglAddon | null;
  webglCanvases: HTMLCanvasElement[];
  currentLeafId: number | null;
  // Leaf whose buffer this slot still holds intact after release; serialized
  // only if another leaf steals the slot.
  retainedLeafId: number | null;
  parked: boolean;
  oscDisposers: (() => void)[];
  observer: ResizeObserver | null;
  fitTimer: ReturnType<typeof setTimeout> | null;
  ptyTimer: ReturnType<typeof setTimeout> | null;
  webglReapTimer: ReturnType<typeof setTimeout> | null;
  slotReapTimer: ReturnType<typeof setTimeout> | null;
  unhideRaf: number | null;
  lastCols: number;
  lastRows: number;
  lastW: number;
  lastH: number;
  lastUsedAt: number;
};

const slots: Slot[] = [];
let recyclerEl: HTMLDivElement | null = null;
let adapter: SlotAdapter | null = null;
let configuredFont: RendererFont | null = null;

type RendererFont = {
  fontFamily: string;
  fontWeight: string;
  fontSize: number;
};

let windowActive =
  typeof document === "undefined" || (!document.hidden && document.hasFocus());
let windowActivityBound = false;
let cursorBlinkEnabled = false;

function focusInteractiveTerminal(term: Terminal): void {
  if (!term.options.disableStdin) term.focus();
}

function syncViewportChrome(slot: Slot): void {
  const value = slot.term.buffer.active.type === "alternate" ? "true" : "false";
  if (slot.host.dataset.teraxAltScreen !== value) {
    slot.host.dataset.teraxAltScreen = value;
  }
}

function bindWindowActivityListeners(): void {
  if (windowActivityBound || typeof window === "undefined") return;
  windowActivityBound = true;
  const sync = () => setWindowActive(!document.hidden && document.hasFocus());
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  document.addEventListener("visibilitychange", sync);
}

function setWindowActive(active: boolean): void {
  if (windowActive === active) return;
  windowActive = active;
  for (const slot of slots) {
    if (slot.currentLeafId === null) continue;
    applyCursorBlinkOnSlot(
      slot,
      adapter?.isLeafFocused(slot.currentLeafId) ?? false,
    );
  }
}

export function configureRendererPool(a: SlotAdapter): void {
  adapter = a;
  bindWindowActivityListeners();
}

export function formatPathsForLeaf(
  leafId: number,
  paths: string[],
): string | null {
  try {
    return adapter?.formatLeafPaths(leafId, paths) ?? null;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export async function formatNativePathsForLeaf(
  leafId: number,
  paths: string[],
): Promise<string | null> {
  try {
    return (await adapter?.formatNativeLeafPaths(leafId, paths)) ?? null;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export function forEachSlot(fn: (slot: Slot) => void): void {
  for (const s of slots) fn(s);
}

export function poolSize(): number {
  return slots.length;
}

export type PoolSlotStat = {
  id: number;
  leafId: number | null;
  retainedLeafId: number | null;
  parked: boolean;
  cols: number;
  rows: number;
  bufferLines: number;
  webgl: boolean;
  canvases: number;
};

export function poolSlotStats(): PoolSlotStat[] {
  return slots.map((s) => ({
    id: s.id,
    leafId: s.currentLeafId,
    retainedLeafId: s.retainedLeafId,
    parked: s.parked,
    cols: s.term.cols,
    rows: s.term.rows,
    bufferLines: s.term.buffer.active.length,
    webgl: !!s.webglAddon,
    canvases: s.webglCanvases.length,
  }));
}

// Bracketed paste via xterm, so an app that enabled it (Claude Code) treats a
// dropped path as a real paste while a plain shell gets the literal text.
export function pasteIntoLeaf(leafId: number, text: string): boolean {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (slot?.term.options.disableStdin)
    return adapter?.pasteLeafInput(leafId, text) ?? false;
  return pasteIntoTerminal(slot?.term ?? null, text);
}

function getRecycler(): HTMLDivElement {
  if (recyclerEl?.isConnected) return recyclerEl;
  const el = document.createElement("div");
  el.setAttribute("data-terax-recycler", "");
  el.style.cssText =
    "position:fixed;left:-99999px;top:-99999px;width:1024px;height:768px;overflow:hidden;pointer-events:none;contain:strict;";
  document.body.appendChild(el);
  recyclerEl = el;
  return el;
}

const MCR_BG_ACTIVE = 4.5;
const MCR_BG_INACTIVE = 1;

function bgActive(
  prefs: ReturnType<typeof usePreferencesStore.getState>,
): boolean {
  return prefs.backgroundKind === "image" && !!prefs.backgroundImageId;
}

function termOptions() {
  const prefs = usePreferencesStore.getState();
  const font = configuredFont ?? {
    fontFamily: resolveFontFamily(prefs.terminalFontFamily),
    fontWeight: prefs.terminalFontWeight,
    fontSize: Math.max(4, Math.round(prefs.terminalFontSize * prefs.zoomLevel)),
  };
  return {
    fontFamily: font.fontFamily,
    fontWeight: font.fontWeight as FontWeight,
    letterSpacing: prefs.terminalLetterSpacing,
    fontSize: font.fontSize,
    theme: buildTerminalTheme(),
    cursorBlink: false,
    cursorStyle: prefs.terminalCursorStyle,
    cursorInactiveStyle: "outline" as const,
    scrollback: prefs.terminalScrollback,
    allowProposedApi: true,
    minimumContrastRatio: bgActive(prefs) ? MCR_BG_ACTIVE : MCR_BG_INACTIVE,
  };
}

export function applyBackgroundActive(active: boolean): void {
  const value = active ? MCR_BG_ACTIVE : MCR_BG_INACTIVE;
  for (const slot of slots) {
    if (slot.term.options.minimumContrastRatio === value) continue;
    slot.term.options.minimumContrastRatio = value;
  }
}

function createSlot(): Slot {
  let focusTerminal = () => {};
  const term = new Terminal({
    ...termOptions(),
    linkHandler: createTerminalLinkHandler(() => focusTerminal()),
  });
  focusTerminal = () => focusInteractiveTerminal(term);
  const fitAddon = new FitAddon();
  const serializeAddon = new SerializeAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(serializeAddon);
  term.loadAddon(
    new WebLinksAddon((_e, uri) => {
      void openExternalUrl(uri, () => focusInteractiveTerminal(term));
    }),
  );

  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%;";
  host.setAttribute("data-terax-slot", String(slots.length));
  getRecycler().appendChild(host);
  term.open(host);

  // Right-click never opens a menu: WebView2 enables its own by default
  // (wry's `default_context_menus` is true and Tauri does not override it),
  // so suppressing it is this handler's job. Selection copies, no selection
  // pastes, which is the terminal convention.
  //
  // Capture phase, and propagation stops here. xterm has its own right-click
  // machinery on `.xterm`, a child of this host: it moves its hidden textarea
  // under the cursor so the native menu's Paste lands there and its own
  // `paste` listener forwards it. With the menu suppressed that route can
  // never fire anyway, and capturing keeps it from arming at all.
  if (!host.dataset.teraxContextMenu) {
    host.dataset.teraxContextMenu = "1";

    // The right click still reaches the program as a mouse report: xterm
    // forwards it whenever the program turned mouse tracking on, and that is
    // left alone on purpose so a program that wants the button gets it.
    //
    // Capture phase, and propagation stops here, so xterm's own contextmenu
    // handler never runs: it moves the hidden textarea under the cursor so
    // the native menu's Paste lands there and its `paste` listener forwards
    // it, which would be a second route to the pty.
    host.addEventListener(
      "contextmenu",
      (e) => {
        // WebView2 enables its own menu by default (wry's
        // `default_context_menus` is true and Tauri does not override it), so
        // suppressing it is this handler's job.
        e.preventDefault();
        e.stopPropagation();
        // Copying happens on selection, so right-click only pastes.
        //
        // A program that turned mouse tracking on owns the mouse and may run
        // its own right-click paste. Claude Code does, and pasting here as
        // well pasted twice, the second arriving a beat later once it had
        // read the clipboard. So the button is left to such programs.
        // Accepted cost: opencode turns tracking on but never pastes, so
        // right-click paste does nothing there.
        if (term.modes.mouseTrackingMode !== "none") return;
        const targetLeafId = slot.currentLeafId;
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (
              text &&
              targetLeafId !== null &&
              slot.currentLeafId === targetLeafId
            )
              pasteIntoLeaf(targetLeafId, text);
          })
          .catch(() => {});
      },
      true,
    );

    // Copy on select, the terminal convention. Read on mouseup rather than
    // from onSelectionChange, which fires on every cell the drag crosses; one
    // gesture should be one copy. Double and triple click land here too.
    // The selection is deliberately left standing: it is the user's mark of
    // what they took, and clearing it under them looks like the copy failed.
    let lastCopied = "";
    host.addEventListener("mouseup", (e) => {
      if (e.button !== 0) return;
      if (!term.hasSelection()) {
        lastCopied = "";
        return;
      }
      const selection = term.getSelection();
      // Re-selecting the same text is not a new copy; clicking inside an
      // existing selection would otherwise re-toast on every click.
      if (!selection || selection === lastCopied) return;
      lastCopied = selection;
      void navigator.clipboard
        .writeText(selection)
        .then(() => {
          // Top-right on purpose: the app's other toasts sit bottom-right,
          // over the status bar and the prompt just copied from.
          toast.success(`已复制 ${selection.length} 个字符`, {
            position: "top-right",
            duration: 1500,
          });
        })
        .catch(() => {
          toast.error("复制失败", { position: "top-right" });
        });
    });
  }

  const slot: Slot = {
    id: slots.length,
    term,
    fitAddon,
    serializeAddon,
    host,
    webglAddon: null,
    webglCanvases: [],
    currentLeafId: null,
    retainedLeafId: null,
    parked: false,
    oscDisposers: [],
    observer: null,
    fitTimer: null,
    ptyTimer: null,
    webglReapTimer: null,
    slotReapTimer: null,
    unhideRaf: null,
    lastCols: term.cols,
    lastRows: term.rows,
    lastW: 0,
    lastH: 0,
    lastUsedAt: 0,
  };

  term.onWriteParsed(() => {
    syncViewportChrome(slot);
    if (slot.currentLeafId !== null && terminalDiagnosticsEnabled())
      recordTerminalEvent(slot.currentLeafId, "parsed", {
        x: term.buffer.active.cursorX,
        y: term.buffer.active.cursorY,
      });
  });
  term.onRender(({ start, end }) => {
    if (slot.currentLeafId !== null && terminalDiagnosticsEnabled())
      recordTerminalEvent(slot.currentLeafId, "render", {
        start,
        end,
        cols: term.cols,
        rows: term.rows,
      });
  });
  term.textarea?.addEventListener("focus", () => {
    if (slot.currentLeafId !== null && terminalDiagnosticsEnabled())
      recordTerminalEvent(slot.currentLeafId, "focus", { target: "terminal" });
  });
  term.onResize(({ cols, rows }) => {
    if (slot.currentLeafId !== null && terminalDiagnosticsEnabled())
      recordTerminalEvent(slot.currentLeafId, "resize", { cols, rows });
  });
  for (const kind of ["compositionstart", "compositionend", "blur"]) {
    term.textarea?.addEventListener(kind, () => {
      if (slot.currentLeafId !== null && terminalDiagnosticsEnabled())
        recordTerminalEvent(slot.currentLeafId, kind, {});
    });
  }

  term.attachCustomKeyEventHandler((event) => {
    if (event.type === "keydown" && slot.currentLeafId !== null)
      adapter?.onUserInput(slot.currentLeafId);
    // During IME composition the browser is assembling a multi-keystroke
    // character (Chinese pinyin → hanzi, Korean jamo → syllable, etc.).
    // Raw keydown events — including the Enter that commits a candidate —
    // must NOT be forwarded to the PTY; xterm will receive the final
    // composed string through its own compositionend handler instead.
    // keyCode 229 ("Process") is what Chromium reports for every key
    // pressed inside an active IME session when isComposing is not yet set.
    if (event.isComposing || event.keyCode === 229) return false;

    const leafId = slot.currentLeafId;
    if (leafId === null) return false;
    const bridge = adapter?.resolveLeaf(leafId);
    if (!bridge) return true;
    const readlineSequence = terminalReadlineSequence(event, {
      isAlternateScreen: isAltScreen(slot),
    });
    if (readlineSequence) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty(readlineSequence);
      return false;
    }
    if (isShiftEnter(event)) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty("\x1b\r");
      return false;
    }
    if (isTerminalCopy(event)) {
      if (event.type === "keydown" && slot.term.hasSelection()) {
        const sel = slot.term.getSelection();
        if (sel) void writeTerminalClipboard(sel);
      }
      event.preventDefault();
      return false;
    }
    if (isTerminalPaste(event)) {
      if (event.type === "keydown") {
        const targetLeafId = slot.currentLeafId;
        void (async () => {
          // An image on the clipboard becomes a file path; otherwise paste text.
          const attachment = await clipboardAttachmentPaths();
          const plainText = attachment ? null : await readTerminalClipboard();
          if (targetLeafId === null || slot.currentLeafId !== targetLeafId)
            return;
          const text = attachment
            ? await formatNativePathsForLeaf(targetLeafId, attachment)
            : plainText;
          if (
            text &&
            targetLeafId !== null &&
            slot.currentLeafId === targetLeafId
          )
            pasteIntoLeaf(targetLeafId, text);
        })().catch((error) =>
          console.error("[awei-work] clipboard paste failed:", error),
        );
      }
      event.preventDefault();
      return false;
    }
    return true;
  });

  term.onData((data) => {
    const leafId = slot.currentLeafId;
    if (leafId === null) return;
    adapter?.resolveLeaf(leafId)?.writeToPty(data);
  });

  slots.push(slot);
  return slot;
}

type PickResult = { slot: Slot; previousLeafId: number | null };

function isAltScreen(s: Slot): boolean {
  try {
    return s.term.buffer.active.type === "alternate";
  } catch {
    return false;
  }
}

function evictionScore(s: Slot): number {
  const leafId = s.currentLeafId;
  const visible = leafId !== null && (adapter?.isLeafVisible(leafId) ?? false);
  const busy = leafId !== null && (adapter?.isLeafBusy(leafId) ?? false);
  const blocks = leafId !== null && (adapter?.isLeafBlocks(leafId) ?? false);
  const focused = leafId !== null && (adapter?.isLeafFocused(leafId) ?? false);
  return (
    (visible ? 1000 : 0) +
    (isAltScreen(s) ? 100 : 0) +
    (busy ? 80 : 0) +
    (blocks ? 50 : 0) +
    (focused ? 10 : 0) +
    s.lastUsedAt / 1e12
  );
}

function pickSlotFor(leafId: number): PickResult {
  const retainedOwn = slots.find(
    (s) => s.currentLeafId === null && s.retainedLeafId === leafId,
  );
  if (retainedOwn) return { slot: retainedOwn, previousLeafId: null };

  const clean = slots.find(
    (s) => s.currentLeafId === null && s.retainedLeafId === null,
  );
  if (clean) return { slot: clean, previousLeafId: null };
  if (slots.length < POOL_MAX_SIZE)
    return { slot: createSlot(), previousLeafId: null };

  // Retained buffers are cheaper to lose than bound ones: serialize, no evict.
  let retained: Slot | null = null;
  for (const s of slots) {
    if (s.currentLeafId !== null) continue;
    if (!retained || s.lastUsedAt < retained.lastUsedAt) retained = s;
  }
  if (retained) return { slot: retained, previousLeafId: null };

  let best: Slot | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of slots) {
    if (s.currentLeafId === leafId) return { slot: s, previousLeafId: null };
    if (
      isAltScreen(s) ||
      (s.currentLeafId !== null && adapter?.isLeafBusy(s.currentLeafId))
    )
      continue;
    const score = evictionScore(s);
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  if (!best) return { slot: createSlot(), previousLeafId: null };
  const chosen = best;
  return { slot: chosen, previousLeafId: chosen.currentLeafId };
}

export type AcquireParams = {
  leafId: number;
  container: HTMLDivElement;
  snapshot: string | null;
  // True if the slot was in alt-screen mode (TUI like vim, htop, dofek)
  // at the time it was released. When set, bindSlot skips ring replay
  // and kicks SIGWINCH so the TUI repaints from scratch.
  altScreen: boolean;
  drainRing: (write: (bytes: Uint8Array) => void) => void;
  shellExited: boolean;
  cols: number;
  rows: number;
  registerOsc: (term: Terminal) => (() => void)[];
};

export function acquireSlot(params: AcquireParams): Slot {
  const existing = slots.find((s) => s.currentLeafId === params.leafId);
  if (existing) {
    rewireSlot(existing, params);
    return existing;
  }

  const pick = pickSlotFor(params.leafId);
  if (pick.previousLeafId !== null) {
    adapter?.evictLeaf(pick.previousLeafId);
  }
  if (
    pick.slot.currentLeafId !== null &&
    pick.slot.currentLeafId !== params.leafId
  ) {
    detachSlotFromLeaf(pick.slot, false);
  }
  if (
    pick.slot.retainedLeafId !== null &&
    pick.slot.retainedLeafId !== params.leafId
  ) {
    adapter?.storeSnapshot(pick.slot.retainedLeafId, serializeSlot(pick.slot));
    discardRetention(pick.slot);
  }
  bindSlot(pick.slot, params);
  return pick.slot;
}

function discardRetention(slot: Slot): void {
  slot.retainedLeafId = null;
  for (const d of slot.oscDisposers) {
    try {
      d();
    } catch {}
  }
  slot.oscDisposers = [];
}

function bindSlot(slot: Slot, p: AcquireParams): void {
  const fast = slot.retainedLeafId === p.leafId;
  const stale =
    !slot.webglAddon ||
    slot.parked ||
    performance.now() - slot.lastUsedAt > SLOT_STALE_MS;
  const hadWebgl = !!slot.webglAddon;
  slot.retainedLeafId = null;
  slot.currentLeafId = p.leafId;
  slot.host.dataset.teraxBlocks = adapter?.isLeafBlocks(p.leafId)
    ? "true"
    : "false";
  slot.lastUsedAt = performance.now();

  cancelPendingUnhide(slot);
  cancelWebglReap(slot);
  cancelSlotReap(slot);
  unparkSlotHost(slot);
  if (!fast) {
    slot.host.style.visibility = "hidden";
    if (hadWebgl) disposeSlotWebgl(slot);
  }

  if (slot.host.parentNode !== p.container) {
    p.container.appendChild(slot.host);
  }

  slot.term.options.disableStdin = p.shellExited;

  if (!fast) {
    slot.term.clear();
    slot.term.reset();

    if (
      p.cols > 0 &&
      p.rows > 0 &&
      (slot.term.cols !== p.cols || slot.term.rows !== p.rows)
    ) {
      slot.term.resize(p.cols, p.rows);
    }

    if (p.snapshot) {
      try {
        slot.term.write(p.snapshot);
      } catch (e) {
        console.warn("[awei-work] snapshot replay failed:", e);
      }
    }
    if (p.altScreen) {
      // TUI output is incremental cursor-positioned updates that can't be
      // replayed on top of a stale snapshot; the SIGWINCH kick below makes
      // the TUI redraw from scratch instead.
      p.drainRing(() => {});
    } else {
      p.drainRing((bytes) => slot.term.write(bytes));
    }
    // No `\x1b[?25h` here. The `reset()` above is a RIS and already leaves the
    // cursor visible, so a previous tenant cannot bequeath a hidden one. Forcing
    // it visible again after the replay instead overrides what the replayed
    // bytes asked for: an inline TUI that hides the real cursor once at startup
    // and paints its own (codex, Claude Code) never sends `?25l` again, so the
    // real cursor stays lit and chases every repaint across the pane.

    for (const d of slot.oscDisposers) {
      try {
        d();
      } catch {}
    }
    slot.oscDisposers = p.registerOsc(slot.term);
  } else {
    p.drainRing((bytes) => slot.term.write(bytes));
  }

  setupResizeObserver(slot, p);
  slot.fitAddon.fit();
  slot.lastCols = slot.term.cols;
  slot.lastRows = slot.term.rows;
  slot.lastW = p.container.clientWidth;
  slot.lastH = p.container.clientHeight;
  if (slot.lastCols !== p.cols || slot.lastRows !== p.rows) {
    // resizePty updates session.cols/rows + pty backend; no separate scope call.
    adapter?.resolveLeaf(p.leafId)?.resizePty(slot.lastCols, slot.lastRows);
  }

  applyCursorBlinkOnSlot(slot, adapter?.isLeafFocused(p.leafId) ?? false);
  syncViewportChrome(slot);

  if (!fast && p.altScreen && !p.shellExited) {
    adapter?.resolveLeaf(p.leafId)?.kickPty(slot.term.cols, slot.term.rows);
  }

  if (fast) {
    if (stale) {
      if (!slot.webglAddon) attachWebgl(slot);
      try {
        slot.term.refresh(0, slot.term.rows - 1);
      } catch {}
    }
    if (adapter?.isLeafFocused(p.leafId)) focusSlot(p.leafId);
  } else {
    scheduleUnhide(slot, stale || hadWebgl);
  }
}

function scheduleUnhide(slot: Slot, stale: boolean): void {
  slot.unhideRaf = requestAnimationFrame(() => {
    slot.unhideRaf = requestAnimationFrame(() => {
      slot.unhideRaf = null;
      slot.host.style.visibility = "";
      if (stale) {
        if (!slot.webglAddon) attachWebgl(slot);
        try {
          slot.term.refresh(0, slot.term.rows - 1);
        } catch {}
      }
      const leafId = slot.currentLeafId;
      if (leafId !== null && adapter?.isLeafFocused(leafId)) {
        focusSlot(leafId);
      }
    });
  });
}

function cancelPendingUnhide(slot: Slot): void {
  if (slot.unhideRaf !== null) {
    cancelAnimationFrame(slot.unhideRaf);
    slot.unhideRaf = null;
  }
}

function rewireSlot(slot: Slot, p: AcquireParams): void {
  slot.lastUsedAt = performance.now();
  unparkSlotHost(slot);
  if (slot.host.parentNode !== p.container) {
    p.container.appendChild(slot.host);
  }
  setupResizeObserver(slot, p);
  slot.fitAddon.fit();
  slot.lastW = p.container.clientWidth;
  slot.lastH = p.container.clientHeight;
  if (slot.term.cols !== p.cols || slot.term.rows !== p.rows) {
    adapter?.resolveLeaf(p.leafId)?.resizePty(slot.term.cols, slot.term.rows);
  }
  slot.lastCols = slot.term.cols;
  slot.lastRows = slot.term.rows;
}

function setupResizeObserver(slot: Slot, p: AcquireParams): void {
  slot.observer?.disconnect();
  if (slot.fitTimer) clearTimeout(slot.fitTimer);
  if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
  slot.fitTimer = null;
  slot.ptyTimer = null;

  const container = p.container;
  const flushPty = () => {
    slot.ptyTimer = null;
    if (slot.currentLeafId !== p.leafId) return;
    if (slot.term.cols === slot.lastCols && slot.term.rows === slot.lastRows)
      return;
    slot.lastCols = slot.term.cols;
    slot.lastRows = slot.term.rows;
    adapter?.resolveLeaf(p.leafId)?.resizePty(slot.lastCols, slot.lastRows);
  };

  slot.observer = new ResizeObserver(() => {
    if (slot.parked) return;
    if (slot.fitTimer) clearTimeout(slot.fitTimer);
    slot.fitTimer = setTimeout(() => {
      slot.fitTimer = null;
      if (slot.currentLeafId !== p.leafId || slot.parked) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === slot.lastW && h === slot.lastH) return;
      slot.lastW = w;
      slot.lastH = h;
      slot.fitAddon.fit();
      if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
      slot.ptyTimer = setTimeout(flushPty, PTY_RESIZE_DEBOUNCE_MS);
    }, FIT_DEBOUNCE_MS);
  });
  slot.observer.observe(container);
}

export type SerializeOutput = {
  snapshot: string | null;
  cols: number;
  rows: number;
  altScreen: boolean;
};

export type ReleaseOutput = { cols: number; rows: number };

export function releaseSlot(leafId: number): ReleaseOutput | null {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return null;
  detachSlotFromLeaf(slot, true);
  return { cols: slot.term.cols, rows: slot.term.rows };
}

/** Serialize the leaf's terminal right now, without disturbing its slot.
 *  The web bridge seeds a phone from this: the desktop's own buffer is the
 *  only honest answer to "what does this command line show", and the addon
 *  reproduces scrollback, current screen and the alternate screen of a running
 *  full-screen program in one string.
 *
 *  A *retained* slot counts. Parking a pane leaves its content in that slot's
 *  terminal and clears the session's stored snapshot (the stored copy is
 *  written back into the slot on bind and dropped), so a leaf that is merely
 *  hidden has its buffer here and nowhere else. Null only when the slot was
 *  repurposed, and the caller then falls back to the stored snapshot. */
export function serializeLeaf(
  leafId: number,
  maxChars?: number,
): SerializeOutput | null {
  const slot =
    slots.find((s) => s.currentLeafId === leafId) ??
    slots.find((s) => s.currentLeafId === null && s.retainedLeafId === leafId);
  return slot ? serializeSlot(slot, maxChars) : null;
}

export function readLeafScreen(leafId: number): string[] | null {
  const slot =
    slots.find((slot) => slot.currentLeafId === leafId) ??
    slots.find(
      (slot) => slot.currentLeafId === null && slot.retainedLeafId === leafId,
    );
  if (!slot) return null;
  const buffer = slot.term.buffer.active;
  const lines: string[] = [];
  for (let row = buffer.baseY; row < buffer.baseY + slot.term.rows; row++)
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-64);
}

function serializeSlot(slot: Slot, maxChars?: number): SerializeOutput {
  let snapshot: string | null = null;
  try {
    let cap = Math.min(
      SNAPSHOT_SCROLLBACK_CAP,
      usePreferencesStore.getState().terminalScrollback,
    );
    if (maxChars !== undefined) {
      cap = Math.min(
        cap,
        Math.max(
          0,
          Math.floor(maxChars / (16 * slot.term.cols)) - slot.term.rows,
        ),
      );
    }
    snapshot = slot.serializeAddon.serialize({ scrollback: cap });
    if (maxChars !== undefined && snapshot.length > maxChars && cap > 0) {
      snapshot = slot.serializeAddon.serialize({ scrollback: 0 });
    }
    if (maxChars !== undefined && snapshot.length > maxChars) snapshot = null;
  } catch (e) {
    console.warn("[awei-work] serialize failed:", e);
  }
  return {
    snapshot,
    cols: slot.term.cols,
    rows: slot.term.rows,
    altScreen: isAltScreen(slot),
  };
}

function detachSlotFromLeaf(slot: Slot, retain: boolean): void {
  if (retain && slot.currentLeafId !== null) {
    slot.retainedLeafId = slot.currentLeafId;
    parkSlotHost(slot);
  } else {
    discardRetention(slot);
    unparkSlotHost(slot);
    if (slot.host.parentNode !== getRecycler()) {
      getRecycler().appendChild(slot.host);
    }
  }

  slot.observer?.disconnect();
  slot.observer = null;
  if (slot.fitTimer) clearTimeout(slot.fitTimer);
  if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
  slot.fitTimer = null;
  slot.ptyTimer = null;

  cancelPendingUnhide(slot);
  slot.host.style.visibility = "";

  slot.currentLeafId = null;
  slot.lastUsedAt = performance.now();
  scheduleWebglReap(slot);
  scheduleSlotReap(slot);
}

// display:none makes xterm's IntersectionObserver pause rendering while the
// buffer keeps parsing writes; visibility:hidden would not (geometry remains).
function parkSlotHost(slot: Slot): void {
  if (slot.parked) return;
  slot.parked = true;
  slot.host.style.display = "none";
}

function unparkSlotHost(slot: Slot): void {
  if (!slot.parked) return;
  slot.parked = false;
  slot.host.style.display = "";
}

function scheduleWebglReap(slot: Slot): void {
  cancelWebglReap(slot);
  if (!slot.webglAddon) return;
  slot.webglReapTimer = setTimeout(() => {
    slot.webglReapTimer = null;
    if (slot.currentLeafId === null || slot.parked) disposeSlotWebgl(slot);
  }, WEBGL_REAP_GRACE_MS);
}

function cancelWebglReap(slot: Slot): void {
  if (slot.webglReapTimer !== null) {
    clearTimeout(slot.webglReapTimer);
    slot.webglReapTimer = null;
  }
}

function scheduleSlotReap(slot: Slot): void {
  cancelSlotReap(slot);
  slot.slotReapTimer = setTimeout(() => {
    slot.slotReapTimer = null;
    reapIdleSlot(slot);
  }, SLOT_REAP_GRACE_MS);
}

function cancelSlotReap(slot: Slot): void {
  if (slot.slotReapTimer !== null) {
    clearTimeout(slot.slotReapTimer);
    slot.slotReapTimer = null;
  }
}

function reapIdleSlot(slot: Slot): void {
  if (slot.currentLeafId !== null) return;
  const idle = slots.filter((s) => s.currentLeafId === null);
  if (idle.length <= IDLE_SLOTS_KEEP_WARM) return;
  idle.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const surplus = idle.slice(0, idle.length - IDLE_SLOTS_KEEP_WARM);
  if (!surplus.includes(slot)) return;
  if (slot.retainedLeafId !== null) {
    adapter?.storeSnapshot(slot.retainedLeafId, serializeSlot(slot));
  }
  disposeSlot(slot);
}

function disposeSlot(slot: Slot): void {
  cancelSlotReap(slot);
  cancelWebglReap(slot);
  cancelPendingUnhide(slot);
  if (slot.fitTimer) clearTimeout(slot.fitTimer);
  if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
  slot.fitTimer = null;
  slot.ptyTimer = null;
  slot.observer?.disconnect();
  slot.observer = null;
  for (const d of slot.oscDisposers) {
    try {
      d();
    } catch {}
  }
  slot.oscDisposers = [];
  disposeSlotWebgl(slot);
  try {
    slot.term.dispose();
  } catch (e) {
    console.warn("[awei-work] slot dispose failed:", e);
  }
  slot.host.remove();
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
}

const WEBGL_RECOVERY_DELAY_MS = 250;
// Below this a re-shown slot is fresh enough to trust; above it, repaint on
// unhide to defeat silent GPU/context staleness.
const SLOT_STALE_MS = 10_000;
const WEBGL_REAP_GRACE_MS = 30_000;
const SLOT_REAP_GRACE_MS = 45_000;
const IDLE_SLOTS_KEEP_WARM = 1;

function attachWebgl(slot: Slot): void {
  if (slot.webglAddon || !slot.term.element) return;
  if (!usePreferencesStore.getState().terminalWebglEnabled) return;
  if (
    slots.filter((candidate) => candidate.webglAddon).length >= POOL_MAX_SIZE
  ) {
    const inactive = slots.find(
      (candidate) =>
        candidate.webglAddon &&
        (candidate.parked || candidate.currentLeafId === null),
    );
    if (!inactive) return;
    disposeSlotWebgl(inactive);
  }
  const elem = slot.term.element;
  const before = new Set<HTMLCanvasElement>(
    elem.querySelectorAll<HTMLCanvasElement>("canvas"),
  );
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      const cur = slot.webglAddon;
      if (cur === webgl) {
        slot.webglAddon = null;
        slot.webglCanvases = [];
      }
      try {
        webgl.dispose();
      } catch {}
      // Recovery: WebKit may transiently lose contexts on sleep/wake or GPU
      // reset; without re-attach the slot would silently fall back to DOM
      // forever. Defer past WebKit's reset window before retrying.
      setTimeout(() => {
        if (slot.webglAddon || slot.currentLeafId === null || slot.parked)
          return;
        if (!usePreferencesStore.getState().terminalWebglEnabled) return;
        attachWebgl(slot);
        if (slot.webglAddon) {
          try {
            slot.term.refresh(0, slot.term.rows - 1);
          } catch {}
        }
      }, WEBGL_RECOVERY_DELAY_MS);
    });
    slot.term.loadAddon(webgl);
    const after = elem.querySelectorAll<HTMLCanvasElement>("canvas");
    const added: HTMLCanvasElement[] = [];
    for (const c of after) if (!before.has(c)) added.push(c);
    slot.webglAddon = webgl;
    slot.webglCanvases = added;
  } catch (e) {
    console.warn("[awei-work-webgl] unavailable:", e);
  }
}

function disposeSlotWebgl(slot: Slot): void {
  if (!slot.webglAddon) return;
  const addon = slot.webglAddon;
  for (const canvas of slot.webglCanvases) releaseCanvasContext(canvas);
  slot.webglCanvases = [];
  try {
    addon.dispose();
  } catch (e) {
    console.warn("[awei-work-webgl] dispose failed:", e);
  }
  try {
    const r = (
      addon as unknown as { _renderer?: Record<string, unknown> | null }
    )._renderer;
    if (r) {
      r._canvas = null;
      r._gl = null;
      r._charAtlas = null;
      r._atlas = null;
    }
    (
      addon as unknown as { _renderer?: unknown; _renderService?: unknown }
    )._renderer = null;
    (
      addon as unknown as { _renderer?: unknown; _renderService?: unknown }
    )._renderService = null;
  } catch {}
  slot.webglAddon = null;
}

function releaseCanvasContext(canvas: HTMLCanvasElement): void {
  let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  } catch {}
  if (!gl) {
    try {
      gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
    } catch {}
  }
  if (gl) {
    try {
      const ext = gl.getExtension("WEBGL_lose_context");
      if (ext && !gl.isContextLost()) ext.loseContext();
    } catch {}
  }
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {}
}

export function applyWebglPreference(enabled: boolean): void {
  for (const slot of slots) {
    if (enabled) {
      if (slot.currentLeafId !== null && !slot.parked && !slot.webglAddon) {
        attachWebgl(slot);
        if (slot.webglAddon) {
          try {
            slot.term.refresh(0, slot.term.rows - 1);
          } catch {}
        }
      }
    } else if (slot.webglAddon) {
      cancelWebglReap(slot);
      disposeSlotWebgl(slot);
    }
  }
}

// Parked and retained slots can't be measured (display:none); poison lastW
// so the refit happens on unpark/rebind instead.
function refitSlot(slot: Slot): void {
  if (slot.parked || slot.currentLeafId === null) {
    slot.lastW = -1;
    return;
  }
  slot.fitAddon.fit();
  slot.lastCols = slot.term.cols;
  slot.lastRows = slot.term.rows;
  adapter
    ?.resolveLeaf(slot.currentLeafId)
    ?.resizePty(slot.term.cols, slot.term.rows);
}

/**
 * Force a leaf's grid to one the desktop did not pick, because the phone
 * claimed the PTY. The byte stream is laid out against the owner's cols/rows,
 * so the desktop has to render at them too or every wrapped line and absolute
 * cursor move lands wrong.
 *
 * Auto-fit is deliberately left running: any desktop-side fit (window resize,
 * focus, tab switch) is an activity claim and should take the grid back. The
 * handover cooldown on the Rust side is what stops the two ends ping-ponging.
 */
export function applyExternalGrid(
  leafId: number,
  cols: number,
  rows: number,
): void {
  if (cols < 2 || rows < 2) return;
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return;
  if (slot.term.cols === cols && slot.term.rows === rows) return;
  slot.term.resize(cols, rows);
  slot.lastCols = cols;
  slot.lastRows = rows;
}

export function applyLetterSpacing(spacing: number): void {
  for (const slot of slots) {
    if (slot.term.options.letterSpacing === spacing) continue;
    slot.term.options.letterSpacing = spacing;
    refitSlot(slot);
  }
}

export function applyTerminalFont(font: RendererFont): void {
  const next = {
    fontFamily: resolveFontFamily(font.fontFamily),
    fontWeight: font.fontWeight,
    fontSize: font.fontSize,
  };
  configuredFont = next;
  for (const slot of slots) {
    let refit = false;
    if (slot.term.options.fontFamily !== next.fontFamily) {
      slot.term.options.fontFamily = next.fontFamily;
      refit = true;
    }
    if (slot.term.options.fontSize !== next.fontSize) {
      slot.term.options.fontSize = next.fontSize;
      refit = true;
    }
    if (slot.term.options.fontWeight !== next.fontWeight) {
      slot.term.options.fontWeight = next.fontWeight as FontWeight;
    }
    if (refit) refitSlot(slot);
  }
}

export function applyScrollback(value: number): void {
  for (const slot of slots) {
    if (slot.term.options.scrollback === value) continue;
    slot.term.options.scrollback = value;
  }
}

export function applyTheme(): void {
  const theme = buildTerminalTheme();
  for (const slot of slots) {
    slot.term.options.theme = theme;
  }
}

export function focusSlot(leafId: number): void {
  if (adapter?.focusLeafInput(leafId)) return;
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (slot) focusInteractiveTerminal(slot.term);
}

export function setSlotFocused(leafId: number, focused: boolean): void {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return;
  applyCursorBlinkOnSlot(slot, focused);
}

export function applyCursorBlink(enabled: boolean): void {
  cursorBlinkEnabled = enabled;
  for (const slot of slots) {
    if (slot.currentLeafId === null) continue;
    applyCursorBlinkOnSlot(
      slot,
      adapter?.isLeafFocused(slot.currentLeafId) ?? false,
    );
  }
}

export function applyCursorStyle(style: TerminalCursorStyle): void {
  for (const slot of slots) {
    if (slot.term.options.cursorStyle === style) continue;
    slot.term.options.cursorStyle = style;
  }
}

function applyCursorBlinkOnSlot(slot: Slot, focused: boolean): void {
  const desired = shouldCursorBlink(cursorBlinkEnabled, windowActive, focused);
  if (slot.term.options.cursorBlink === desired) return;
  slot.term.options.cursorBlink = desired;
}

export function getSlotForLeaf(leafId: number): Slot | null {
  return slots.find((s) => s.currentLeafId === leafId) ?? null;
}

export function isLeafAltScreen(leafId: number): boolean {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  return slot ? isAltScreen(slot) : false;
}

export function parkLeafSlot(leafId: number): void {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return;
  parkSlotHost(slot);
  scheduleWebglReap(slot);
}

export function refreshLeafSlot(leafId: number): void {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return;
  cancelWebglReap(slot);
  unparkSlotHost(slot);
  if (usePreferencesStore.getState().terminalWebglEnabled && !slot.webglAddon) {
    attachWebgl(slot);
  }
  // The observer skips parked slots; catch up on container resizes here.
  const container = slot.host.parentElement;
  if (
    container &&
    (container.clientWidth !== slot.lastW ||
      container.clientHeight !== slot.lastH)
  ) {
    slot.lastW = container.clientWidth;
    slot.lastH = container.clientHeight;
    slot.fitAddon.fit();
    if (slot.term.cols !== slot.lastCols || slot.term.rows !== slot.lastRows) {
      slot.lastCols = slot.term.cols;
      slot.lastRows = slot.term.rows;
      adapter?.resolveLeaf(leafId)?.resizePty(slot.lastCols, slot.lastRows);
    }
  }
  try {
    slot.term.refresh(0, slot.term.rows - 1);
  } catch {}
}

export function disposeLeafSlot(leafId: number): void {
  const slot = slots.find(
    (s) => s.currentLeafId === leafId || s.retainedLeafId === leafId,
  );
  if (slot) disposeSlot(slot);
}

export function discardRetainedSlot(leafId: number): void {
  const slot = slots.find(
    (s) => s.currentLeafId === null && s.retainedLeafId === leafId,
  );
  if (!slot) return;
  discardRetention(slot);
  slot.term.clear();
  slot.term.reset();
}

export function getLiveSlotForLeaf(leafId: number): Slot | null {
  return (
    slots.find(
      (s) => s.currentLeafId === leafId || s.retainedLeafId === leafId,
    ) ?? null
  );
}

function isTerminalCopy(e: KeyboardEvent): boolean {
  return (
    e.ctrlKey &&
    e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    (e.code === "KeyC" || e.key === "c" || e.key === "C")
  );
}

// Ctrl+Shift+V (the terminal convention) and plain Ctrl+V both paste. Ctrl+V
// would otherwise reach the shell as a literal ^V, which no one wants on
// Windows where it is the universal paste chord.
function isTerminalPaste(e: KeyboardEvent): boolean {
  return (
    e.ctrlKey &&
    !e.altKey &&
    !e.metaKey &&
    (e.code === "KeyV" || e.key === "v" || e.key === "V")
  );
}

function isShiftEnter(e: KeyboardEvent): boolean {
  return (
    e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
  );
}
