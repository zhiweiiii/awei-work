import { ensureMonoFontsLoaded } from "@/lib/fonts";
import { pathIdentity } from "@/lib/pathIdentity";
import type { AgentResume } from "@/modules/spaces/lib/projectRestore";
import type { ShellKind } from "@/lib/shellQuote";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { terminalInputOwner } from "@/modules/terminal/lib/inputPolicy";
import { formatDroppedPaths } from "@/modules/terminal/lib/quoteShellPath";
import {
  installTerminalDiagnostics,
  recordTerminalEvent,
  terminalDiagnosticsEnabled,
} from "@/modules/terminal/lib/terminalDiagnostics";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BlockDecorations,
  type BlockMatch,
  type VisibleBlocks,
} from "../block/lib/blockDecorations";
import type { BlockMode } from "../block/lib/modeMachine";
import { DormantRing } from "./dormantRing";
import { gatewayPin, setGatewayPin } from "./gatewayPins";
import {
  createShellIntegrationState,
  registerCwdHandler,
  registerOsc52ClipboardHandler,
  registerPromptTracker,
  type ShellIntegrationState,
} from "./osc-handlers";
import { openPty, type PtySession } from "./pty-bridge";
import "../block/block.css";
import {
  ensureAgentActivityListener,
  isAgentActivePty,
  useAgentActivityStore,
} from "./agentActivity";
import {
  acquireSlot,
  applyBackgroundActive,
  applyCursorBlink,
  applyCursorStyle,
  applyExternalGrid,
  applyLetterSpacing,
  applyTheme as applyPoolTheme,
  applyScrollback,
  applyTerminalFont,
  applyWebglPreference,
  configureRendererPool,
  discardRetainedSlot,
  disposeLeafSlot,
  focusSlot,
  getLiveSlotForLeaf,
  getSlotForLeaf,
  isLeafAltScreen,
  parkLeafSlot,
  poolSize,
  poolSlotStats,
  refreshLeafSlot,
  releaseSlot,
  serializeLeaf,
  setSlotFocused,
} from "./rendererPool";
import {
  clearTermFind,
  findInTerminal,
  revealTermMatch,
  type TermMatch,
} from "./terminalFind";
import { useTerminalFont } from "./useTerminalFont";

type Callbacks = {
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
};

type Session = {
  pty: PtySession | null;
  ptyOpening: boolean;
  spawnEpoch: number;
  initialCwd: string | undefined;
  workspace: WorkspaceEnv;
  lastCwd: string | null;
  pendingExit: number | null;
  shellExited: boolean;
  callbacks: Callbacks;
  visibleNow: boolean;
  focusedNow: boolean;
  disposed: boolean;
  ready: Promise<void>;
  cols: number;
  rows: number;
  resizeEpoch: number;
  container: HTMLDivElement | null;
  snapshot: string | null;
  dormantRing: DormantRing;
  pendingInput: string;
  hasSlot: boolean;
  blocks: boolean;
  blockMode: BlockMode;
  blockListeners: Set<() => void>;
  blockDecorations: BlockDecorations | null;
  // Set by the block shell-input; called to pull focus back when the xterm
  // grid steals it at the prompt (e.g. on a click), so typing stays in the bar.
  inputFocus: (() => void) | null;
  inputPaste: ((text: string) => boolean) | null;
  // Per-leaf unsent shell-input text; the single workspace bar swaps it on focus change.
  inputDraft: string;
  // Live "input has text" flag from the block shell-input (gates the watermark).
  inputActive: boolean;
  // A command was submitted on this leaf; kills the watermark synchronously,
  // before the shell's OSC 133 C round-trips through the PTY.
  everSubmitted: boolean;
  restoringAgent: boolean;
  manualInput: boolean;
  // True if the slot was in alt-screen mode (TUI like vim, htop, dofek)
  // at the most recent release. Read once on the next bind to trigger a
  // SIGWINCH-driven repaint instead of replaying dormant bytes.
  altScreenAtRelease: boolean;
  // OSC 133 C..D window (or blocks running mode): a foreground process owns
  // the terminal, so the leaf must keep its live grid while hidden.
  commandRunning: boolean;
  foregroundBusy: boolean;
  promptConfirmTimer: ReturnType<typeof setTimeout> | null;
  promptEpoch: number;
  hiddenReleaseTimer: ReturnType<typeof setTimeout> | null;
  // Pane is parked on a dead shell (spawn failed, or the shell exited
  // abnormally) showing a notice; Enter respawns instead of reaching the pty.
  awaitingRestart: boolean;
  // Shared OSC trust gate for blocks mode (inCommand = agent is running).
  shellState: ShellIntegrationState;
};

const sessions = new Map<number, Session>();

// Block-overlay viewport listeners, keyed by leafId at module scope so the
// overlay (a child) can subscribe before the parent effect creates the session.
const blockViewportListeners = new Map<number, Set<() => void>>();

const readyLeaves = new Set<number>();
const readyWaiters = new Map<
  number,
  { resolve: () => void; timer: ReturnType<typeof setTimeout> }[]
>();

function markSessionReady(leafId: number): void {
  if (readyLeaves.has(leafId)) return;
  readyLeaves.add(leafId);
  const waiters = readyWaiters.get(leafId);
  if (!waiters) return;
  readyWaiters.delete(leafId);
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.resolve();
  }
}

export function whenSessionReady(
  leafId: number,
  timeoutMs = 4000,
): Promise<void> {
  if (readyLeaves.has(leafId)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const arr = readyWaiters.get(leafId);
      const i = arr?.findIndex((w) => w.timer === timer) ?? -1;
      if (arr && i >= 0) arr.splice(i, 1);
      if (arr?.length === 0) readyWaiters.delete(leafId);
      resolve();
    }, timeoutMs);
    const arr = readyWaiters.get(leafId) ?? [];
    arr.push({ resolve, timer });
    readyWaiters.set(leafId, arr);
  });
}

export async function resumeAgentInLeaf(
  leafId: number,
  saved: AgentResume,
  workspace: WorkspaceEnv,
  isCurrent: () => boolean,
): Promise<void> {
  const command = await invoke<string>("agent_resume_command", {
    ...saved,
    workspace,
  });
  if (!isCurrent()) return;
  const deadline = Date.now() + 20000;
  let session = sessions.get(leafId);
  while (
    isCurrent() &&
    !session?.disposed &&
    !session?.shellExited &&
    (!session?.container || !session.pty) &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    session = sessions.get(leafId);
  }
  if (!isCurrent()) return;
  if (
    !session ||
    session.disposed ||
    session.shellExited ||
    !session.container ||
    !session.pty
  )
    throw new Error("Restored terminal did not become available");
  session.restoringAgent = true;
  try {
    if (!session.hasSlot) {
      bindLeafToSlot(leafId, session);
      if (!session.visibleNow) parkLeafSlot(leafId);
    }
    await whenSessionReady(leafId, Math.max(1, deadline - Date.now()));
    if (!isCurrent() || sessions.get(leafId) !== session) return;
    if (
      !session?.pty ||
      session.disposed ||
      session.shellExited ||
      !readyLeaves.has(leafId)
    )
      throw new Error(
        "Terminal shell did not become ready; session was not started",
      );
    if (
      session.manualInput ||
      session.everSubmitted ||
      session.commandRunning ||
      isAgentActivePty(session.pty.id)
    )
      throw new Error(
        "Terminal is already running a command; automatic resume was skipped",
      );
    if (
      !session.lastCwd ||
      pathIdentity(session.lastCwd) !== pathIdentity(saved.cwd)
    )
      throw new Error(
        "Terminal directory changed; automatic resume was skipped",
      );
    await session.pty.write(`${command}\r`);
    session.everSubmitted = true;
    onLeafCommandState(leafId, true);
  } finally {
    session.restoringAgent = false;
    scheduleHiddenRelease(leafId, session);
  }
}

const PENDING_INPUT_MAX = 256 * 1024;

// Input typed before the pty attaches is queued and flushed on attach. Cap the
// queue so a large paste into a still-spawning pane can't grow it without bound.
function queuePendingInput(s: Session, data: string): boolean {
  if (s.pendingInput.length + data.length > PENDING_INPUT_MAX) return false;
  s.pendingInput += data;
  return true;
}

function observePty(operation: Promise<unknown>, action: string): void {
  void operation.catch((error) =>
    console.warn(`[awei-work] PTY ${action} failed:`, error),
  );
}

export function writeToSession(leafId: number, data: string): boolean {
  const s = sessions.get(leafId);
  if (!s || s.shellExited) return false;
  s.manualInput = true;
  if (s.pty) {
    observePty(s.pty.write(data), "write");
    return true;
  }
  return queuePendingInput(s, data);
}

export function submitToLeaf(leafId: number, text: string): boolean {
  const s = sessions.get(leafId);
  if (!s || s.shellExited) return false;
  s.manualInput = true;
  // Bracketed paste keeps a multiline command atomic; trailing CR runs it.
  const data = text.includes("\n")
    ? `\x1b[200~${text}\x1b[201~\r`
    : `${text}\r`;
  if (s.pty) observePty(s.pty.write(data), "write");
  else if (!queuePendingInput(s, data)) return false;
  s.everSubmitted = true;
  return true;
}

/**
 * Bracketed-paste text into a leaf without submitting it, so the user can
 * type a follow-up question before pressing Enter. Used to hand a code
 * selection to an agent (Claude Code) already running in that pane.
 */
export function pasteToLeaf(leafId: number, text: string): boolean {
  const s = sessions.get(leafId);
  if (!s || s.shellExited) return false;
  s.manualInput = true;
  const data = `\x1b[200~${text}\x1b[201~`;
  if (s.pty) observePty(s.pty.write(data), "write");
  else if (!queuePendingInput(s, data)) return false;
  return true;
}

export function interruptLeaf(leafId: number): void {
  const pty = sessions.get(leafId)?.pty;
  if (pty) observePty(pty.write("\x03"), "interrupt");
}

export function leafCwd(leafId: number): string | null {
  return sessions.get(leafId)?.lastCwd ?? null;
}

export function leafWorkspace(leafId: number): WorkspaceEnv | null {
  const workspace = sessions.get(leafId)?.workspace;
  return workspace ? { ...workspace } : null;
}

export function leafShellKind(leafId: number): ShellKind {
  return sessions.get(leafId)?.pty?.shellKind ?? "unknown";
}

export function navigateFocusedBlocks(dir: -1 | 1): boolean {
  for (const [, s] of sessions) {
    if (!s.visibleNow || !s.focusedNow || !s.blockDecorations) continue;
    s.blockDecorations.navigateBlocks(dir);
    return true;
  }
  return false;
}

export function clearLeafBlockSelection(leafId: number): boolean {
  return sessions.get(leafId)?.blockDecorations?.clearBlockSelection() ?? false;
}

export function leafGridSelection(leafId: number): string | null {
  const sel = getSlotForLeaf(leafId)?.term.getSelection() ?? "";
  return sel.length > 0 ? sel : null;
}

export function getLeafBlockMode(leafId: number): BlockMode {
  return sessions.get(leafId)?.blockMode ?? "prompt";
}

export function subscribeLeafBlockMode(
  leafId: number,
  cb: () => void,
): () => void {
  const s = sessions.get(leafId);
  if (!s) return () => {};
  s.blockListeners.add(cb);
  return () => {
    s.blockListeners.delete(cb);
  };
}

export function setLeafInputFocus(
  leafId: number,
  fn: (() => void) | null,
): void {
  const s = sessions.get(leafId);
  if (s) s.inputFocus = fn;
}

export function focusLeafInput(leafId: number): void {
  sessions.get(leafId)?.inputFocus?.();
}

export function setLeafInputPaste(
  leafId: number,
  fn: ((text: string) => boolean) | null,
): void {
  const s = sessions.get(leafId);
  if (s) s.inputPaste = fn;
}

export function getLeafDraft(leafId: number): string {
  return sessions.get(leafId)?.inputDraft ?? "";
}

export function setLeafDraft(leafId: number, text: string): void {
  const s = sessions.get(leafId);
  if (s) {
    if (s.inputDraft !== text) s.manualInput = true;
    s.inputDraft = text;
  }
}

export function setLeafInputActivity(leafId: number, active: boolean): void {
  const s = sessions.get(leafId);
  if (!s || s.inputActive === active) return;
  s.inputActive = active;
  const set = blockViewportListeners.get(leafId);
  if (set) for (const l of set) l();
}

export type WatermarkState = "visible" | "hidden" | "dead";

// Watermark gate: a block terminal that has never run a command, whose grid is
// still untouched, and whose input is empty. Synchronous so tab switches, slot
// rebinds and the Enter-to-OSC-133 gap never flash it over real content.
// "dead" is permanent and lets the component unmount for good. The grid check
// scans glyphs, not the cursor: the prompt integration prints a blank gap line
// at spawn, so the cursor sits below row 0 even on a visually empty terminal.
export function blockWatermarkState(leafId: number): WatermarkState {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return "dead";
  if (s.everSubmitted || s.blockDecorations?.hasAnyBlock()) return "dead";
  if (!s.blockDecorations || s.inputActive) return "hidden";
  const slot = getSlotForLeaf(leafId);
  if (!slot) return "hidden";
  const buf = slot.term.buffer.active;
  if (buf.baseY > 0) return "dead";
  const rows = Math.min(buf.length, slot.term.rows);
  for (let i = 0; i < rows; i++) {
    if (buf.getLine(i)?.translateToString(true)) return "dead";
  }
  return "visible";
}

/**
 * Clear the scrollback and screen of the currently focused terminal, keeping
 * the active prompt line. Returns false when no
 * focused terminal slot is bound (e.g. focus is in the editor or AI panel).
 */
export function clearFocusedTerminal(): boolean {
  for (const [leafId, s] of sessions) {
    if (!s.visibleNow || !s.focusedNow) continue;
    const slot = getSlotForLeaf(leafId);
    if (!slot) continue;
    slot.term.clear();
    return true;
  }
  return false;
}

export function leafIdForPty(ptyId: number): number | null {
  for (const [leafId, s] of sessions) {
    if (s.pty?.id === ptyId) return leafId;
  }
  return null;
}

export function ptyIdForLeaf(leafId: number): number | null {
  return sessions.get(leafId)?.pty?.id ?? null;
}

/**
 * What this command line currently holds, as a replayable ANSI string.
 *
 * This is what a phone is seeded with when it attaches: the desktop's own
 * terminal buffer is the only honest answer to "what does this command line
 * show", so the bridge asks for it instead of keeping a second copy of the
 * output on the Rust side. A leaf with a renderer slot is serialized live; a
 * parked one answers from the snapshot taken when its slot was released, plus
 * the output that has arrived since - the same two pieces the desktop itself
 * replays when the pane comes back.
 */
export function snapshotLeaf(leafId: number): string | null {
  const s = sessions.get(leafId);
  const maxChars = 2 * 1024 * 1024;
  // The slot's own terminal first (bound or merely parked), then the snapshot
  // stored when a slot was taken away from this leaf. Only one of the two ever
  // holds anything: binding writes the stored copy back and clears it.
  const live = serializeLeaf(leafId, maxChars);
  if (live && live.snapshot === null) return null;
  let out = live?.snapshot ?? s?.snapshot ?? "";
  if (out.length > maxChars) return null;
  // Output that arrived while the pane had no slot has not reached any
  // terminal yet, so it is appended the same way the desktop replays it when
  // the pane comes back.
  if (s && s.dormantRing.byteLength() > 0) {
    const decoder = new TextDecoder();
    s.dormantRing.peek((bytes) => {
      out += decoder.decode(bytes, { stream: true });
    });
    out += decoder.decode();
  }
  return out === "" || out.length > maxChars ? null : out;
}

function leafBusy(s: Session): boolean {
  return (
    s.restoringAgent ||
    s.commandRunning ||
    (s.pty !== null && isAgentActivePty(s.pty.id))
  );
}

const HIDDEN_RELEASE_DELAY_MS = 300;
const PROMPT_CONFIRM_DELAY_MS = 48;

// A parked hidden leaf went idle: give the post-command prompt a moment to
// render into the live buffer, then hand the slot back to the pool.
function scheduleHiddenRelease(leafId: number, s: Session): void {
  if (s.visibleNow || !s.hasSlot) return;
  cancelHiddenRelease(s);
  s.hiddenReleaseTimer = setTimeout(() => {
    s.hiddenReleaseTimer = null;
    if (s.disposed || s.visibleNow || !s.hasSlot) return;
    if (s.blocks || isLeafAltScreen(leafId) || leafBusy(s)) return;
    unbindLeafFromSlot(leafId, s);
  }, HIDDEN_RELEASE_DELAY_MS);
}

function cancelHiddenRelease(s: Session): void {
  if (s.hiddenReleaseTimer !== null) {
    clearTimeout(s.hiddenReleaseTimer);
    s.hiddenReleaseTimer = null;
  }
}

function cancelPromptConfirm(s: Session): void {
  s.promptEpoch += 1;
  if (s.promptConfirmTimer !== null) {
    clearTimeout(s.promptConfirmTimer);
    s.promptConfirmTimer = null;
  }
}

function confirmBlockPrompt(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s || s.blockMode === "prompt" || s.promptConfirmTimer !== null) return;
  const epoch = s.promptEpoch;
  s.promptConfirmTimer = setTimeout(() => {
    s.promptConfirmTimer = null;
    void (async () => {
      const current = sessions.get(leafId);
      if (!current || current.disposed || current.blockMode === "prompt")
        return;
      if (!current.pty || current.shellExited) {
        applyBlockMode(leafId, "prompt");
        return;
      }
      let foreground: boolean;
      try {
        foreground = await invoke<boolean>("pty_has_foreground_job", {
          id: current.pty.id,
        });
      } catch (e) {
        console.error(
          "[awei-work] pty_has_foreground_job failed for block prompt",
          e,
        );
        return;
      }
      if (
        !foreground &&
        sessions.get(leafId) === current &&
        current.promptEpoch === epoch
      ) {
        applyBlockMode(leafId, "prompt");
      }
    })();
  }, PROMPT_CONFIRM_DELAY_MS);
}

async function releaseIfIdle(leafId: number, s: Session): Promise<void> {
  const epoch = s.spawnEpoch;
  s.foregroundBusy = true;
  const busy = await leafHasForegroundJob(leafId);
  if (sessions.get(leafId) !== s || s.disposed || s.spawnEpoch !== epoch)
    return;
  s.foregroundBusy = busy;
  if (busy || s.disposed || s.visibleNow || !s.hasSlot) return;
  if (s.blocks || isLeafAltScreen(leafId) || leafBusy(s)) return;
  unbindLeafFromSlot(leafId, s);
}

async function leafHasForegroundJob(leafId: number): Promise<boolean> {
  const s = sessions.get(leafId);
  if (!s?.pty || s.shellExited) return false;
  try {
    return await invoke<boolean>("pty_has_foreground_job", { id: s.pty.id });
  } catch (e) {
    console.error(
      "[awei-work] pty_has_foreground_job failed for leaf",
      leafId,
      e,
    );
    return true;
  }
}

function onLeafCommandState(leafId: number, running: boolean): void {
  const s = sessions.get(leafId);
  if (!s || s.commandRunning === running) return;
  s.commandRunning = running;
  if (!running) {
    scheduleHiddenRelease(leafId, s);
    return;
  }
  cancelHiddenRelease(s);
  // A command started in a hidden released leaf (e.g. submitted by the AI):
  // rebind its retained slot so output parses live instead of filling the
  // ring. Deferred: this callback fires inside xterm's parse loop and the
  // rebind touches the same terminal (fit/resize).
  if (!s.visibleNow && !s.hasSlot && s.container && !s.disposed) {
    setTimeout(() => {
      if (s.disposed || s.visibleNow || s.hasSlot || !s.container) return;
      if (!leafBusy(s)) return;
      bindLeafToSlot(leafId, s);
      parkLeafSlot(leafId);
    }, 0);
  }
}

ensureAgentActivityListener((ptyId) => {
  const leafId = leafIdForPty(ptyId);
  if (leafId === null) return;
  const s = sessions.get(leafId);
  if (s) scheduleHiddenRelease(leafId, s);
});

configureRendererPool({
  onUserInput(leafId) {
    const session = sessions.get(leafId);
    if (session) session.manualInput = true;
  },
  async formatNativeLeafPaths(leafId, paths) {
    const session = sessions.get(leafId);
    if (!session || session.disposed || session.shellExited) return null;
    const pty = session.pty;
    const nativePaths =
      session.workspace.kind === "wsl" &&
      paths.some((path) => /^[A-Za-z]:[\\/]|^[\\/]{2}/.test(path))
        ? await invoke<string[]>("wsl_native_paths", {
            paths,
            workspace: session.workspace,
          })
        : paths;
    if (
      sessions.get(leafId) !== session ||
      session.disposed ||
      session.shellExited ||
      session.pty !== pty
    )
      return null;
    return formatDroppedPaths(
      nativePaths,
      pty?.shellKind ?? "unknown",
      pty ? isAgentActivePty(pty.id) : false,
    );
  },
  formatLeafPaths(leafId, paths) {
    const session = sessions.get(leafId);
    if (!session || session.disposed || session.shellExited) return null;
    return formatDroppedPaths(
      paths,
      session.pty?.shellKind ?? "unknown",
      session.pty ? isAgentActivePty(session.pty.id) : false,
    );
  },
  resolveLeaf(leafId) {
    const s = sessions.get(leafId);
    if (!s) return null;
    return {
      writeToPty: (data) => {
        // Parked on a dead shell (spawn failure or abnormal exit): Enter retries.
        if (s.awaitingRestart) {
          if (data.includes("\r")) void respawnSession(leafId);
          return;
        }
        if (s.pty) observePty(s.pty.write(data), "write");
        else queuePendingInput(s, data);
      },
      resizePty: (cols, rows) => {
        const pty = s.pty;
        const epoch = ++s.resizeEpoch;
        s.cols = cols;
        s.rows = rows;
        void pty
          ?.resize(cols, rows)
          .then((eff) => {
            if (s.disposed || s.pty !== pty || s.resizeEpoch !== epoch) return;
            if (eff.cols === cols && eff.rows === rows) return;
            // Refused: the phone owns the session inside the cooldown. Render
            // at its grid rather than the one we asked for.
            s.cols = eff.cols;
            s.rows = eff.rows;
            applyExternalGrid(leafId, eff.cols, eff.rows);
          })
          .catch(() => {});
      },
      kickPty: (cols, rows) => {
        const pty = s.pty;
        if (!pty || cols <= 0 || rows <= 0) return;
        // The bump-and-restore lives in Rust so it never looks like a grid
        // change: going through resize() broadcast the transient to attached
        // phones, which then re-gridded twice per rebind while a TUI ran.
        pty
          .kick(cols, rows)
          .catch((e) => console.warn("[awei-work] kickPty failed:", e));
      },
    };
  },
  evictLeaf(leafId) {
    const s = sessions.get(leafId);
    if (!s) return;
    unbindLeafFromSlot(leafId, s);
  },
  focusLeafInput(leafId) {
    const s = sessions.get(leafId);
    if (!s) return false;
    const owner = syncLeafInput(leafId, s);
    if (owner === "terminal") return false;
    if (owner === "shell" && s.visibleNow && s.focusedNow) {
      if (terminalDiagnosticsEnabled())
        recordTerminalEvent(leafId, "focus", { target: "shell" });
      s.inputFocus?.();
    }
    return true;
  },
  isLeafFocused(leafId) {
    const s = sessions.get(leafId);
    return !!s && s.visibleNow && s.focusedNow;
  },
  pasteLeafInput(leafId, text) {
    const s = sessions.get(leafId);
    if (s) s.manualInput = true;
    if (!s || s.disposed || terminalInputOwner(s) !== "shell") return false;
    if (s.inputPaste) return s.inputPaste(text);
    s.inputDraft += text;
    setLeafInputActivity(leafId, s.inputDraft.length > 0);
    return true;
  },
  isLeafBlocks(leafId) {
    return sessions.get(leafId)?.blocks ?? false;
  },
  isLeafBusy(leafId) {
    const s = sessions.get(leafId);
    return !!s && (leafBusy(s) || s.foregroundBusy);
  },
  isLeafVisible(leafId) {
    return sessions.get(leafId)?.visibleNow ?? false;
  },
  storeSnapshot(leafId, out) {
    const s = sessions.get(leafId);
    if (!s) return;
    s.snapshot = out.snapshot;
    if (out.cols > 0) s.cols = out.cols;
    if (out.rows > 0) s.rows = out.rows;
    s.altScreenAtRelease = out.altScreen;
  },
});

function ensureSession(
  leafId: number,
  initialCwd?: string,
  blocks = false,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): Session {
  const existing = sessions.get(leafId);
  if (existing) return existing;

  const session: Session = {
    pty: null,
    ptyOpening: false,
    spawnEpoch: 0,
    initialCwd,
    workspace: { ...workspace },
    lastCwd: null,
    pendingExit: null,
    shellExited: false,
    callbacks: {},
    visibleNow: false,
    focusedNow: false,
    disposed: false,
    ready: Promise.resolve(),
    cols: 0,
    rows: 0,
    resizeEpoch: 0,
    container: null,
    snapshot: null,
    dormantRing: new DormantRing(),
    pendingInput: "",
    hasSlot: false,
    blocks,
    blockMode: "prompt",
    blockListeners: new Set(),
    blockDecorations: null,
    inputFocus: null,
    inputPaste: null,
    inputDraft: "",
    inputActive: false,
    everSubmitted: false,
    restoringAgent: false,
    manualInput: false,
    altScreenAtRelease: false,
    commandRunning: false,
    foregroundBusy: false,
    promptConfirmTimer: null,
    promptEpoch: 0,
    hiddenReleaseTimer: null,
    awaitingRestart: false,
    shellState: createShellIntegrationState(),
  };
  sessions.set(leafId, session);

  session.ready = (async () => {
    await ensureMonoFontsLoaded();
    await document.fonts.ready;
  })();

  return session;
}

function deliverPtyBytes(leafId: number, bytes: Uint8Array): void {
  const s = sessions.get(leafId);
  if (!s) return;
  // Retained slots keep parsing live (render paused); the ring is only for
  // leaves whose buffer was stolen or never bound.
  const slot = getLiveSlotForLeaf(leafId);
  if (slot) {
    if (terminalDiagnosticsEnabled())
      recordTerminalEvent(leafId, "output", {
        bytes: bytes.length,
        visible: s.visibleNow,
        parked: slot.parked,
      });
    slot.term.write(bytes);
  } else s.dormantRing.push(bytes);
}

const SPAWN_RETRY_DELAY_MS = 250;

async function openPtyWithRetry(
  leafId: number,
  s: Session,
  cwd: string | undefined,
): Promise<PtySession> {
  try {
    return await openPtyForSession(leafId, s, cwd);
  } catch (e) {
    console.error("[awei-work] openPty failed, retrying once:", e);
    await new Promise((r) => setTimeout(r, SPAWN_RETRY_DELAY_MS));
    if (s.disposed) throw e;
    return openPtyForSession(leafId, s, cwd);
  }
}

// Spawn failure must not flow through onExit: handleLeafExit closes the pane
// (or respawns the last one, which would loop). Show the error in the pane
// and let Enter retry instead of leaving a dead black grid.
function surfaceSpawnFailure(leafId: number, s: Session, e: unknown): void {
  console.error("[awei-work] shell spawn failed:", e);
  s.shellExited = true;
  s.awaitingRestart = true;
  cancelPromptConfirm(s);
  syncLeafInput(leafId, s);
  const detail = String(e)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 300);
  deliverPtyBytes(
    leafId,
    new TextEncoder().encode(
      `\r\n\x1b[31m[awei-work] failed to start shell: ${detail}\x1b[0m\r\n\x1b[2mpress Enter to retry\x1b[0m\r\n`,
    ),
  );
}

// Windows-style "graceful" close: only a clean exit tears the pane down. A
// shell that died on its own (a TUI child taking pwsh with it on Ctrl+C leaves
// 0x800703E3) parks the pane instead, so a crash can never silently close the
// last pane and with it the window.
function surfaceAbnormalExit(leafId: number, s: Session, code: number): void {
  s.awaitingRestart = true;
  cancelPromptConfirm(s);
  syncLeafInput(leafId, s);
  // Win32 codes come back as unsigned; show the familiar hex next to it.
  const hex =
    code < 0 || code > 0xffff
      ? ` (0x${(code >>> 0).toString(16).toUpperCase()})`
      : "";
  deliverPtyBytes(
    leafId,
    new TextEncoder().encode(
      `\r\n\x1b[33m[awei-work] shell exited with code ${code}${hex}\x1b[0m\r\n\x1b[2mpress Enter to restart\x1b[0m\r\n`,
    ),
  );
}

async function openPtyForSession(
  leafId: number,
  s: Session,
  cwd: string | undefined,
): Promise<PtySession> {
  const epoch = s.spawnEpoch;
  const startCols = s.cols > 0 ? s.cols : 80;
  const startRows = s.rows > 0 ? s.rows : 24;
  const pty = await openPty(
    startCols,
    startRows,
    {
      onData: (bytes) => {
        if (!s.disposed && sessions.get(leafId) === s && s.spawnEpoch === epoch)
          deliverPtyBytes(leafId, bytes);
      },
      onExit: (code) => {
        if (s.disposed || sessions.get(leafId) !== s || s.spawnEpoch !== epoch)
          return;
        s.shellExited = true;
        s.pty = null;
        s.pendingInput = "";
        s.commandRunning = false;
        s.foregroundBusy = false;
        if (code !== 0) {
          // Park, keeping stdin so Enter can restart — do not disable it here.
          surfaceAbnormalExit(leafId, s, code);
          scheduleHiddenRelease(leafId, s);
          return;
        }
        cancelPromptConfirm(s);
        syncLeafInput(leafId, s);
        scheduleHiddenRelease(leafId, s);
        if (s.callbacks.onExit) s.callbacks.onExit(code);
        else s.pendingExit = code;
      },
    },
    cwd,
    s.blocks,
    usePreferencesStore.getState().terminalShell || undefined,
    leafId,
    gatewayPin(leafId),
    s.workspace,
  );
  // Only resize if the bound dims changed during the spawn: a same-size
  // ResizePseudoConsole during conhost warmup is a known ConPTY trigger for
  // a console that never renders (blank tab).
  if (
    s.cols > 0 &&
    s.rows > 0 &&
    (s.cols !== startCols || s.rows !== startRows)
  ) {
    observePty(pty.resize(s.cols, s.rows), "resize");
  }
  return pty;
}

function syncLeafInput(
  leafId: number,
  s: Session,
): ReturnType<typeof terminalInputOwner> {
  const owner = terminalInputOwner(s);
  const slot = getSlotForLeaf(leafId);
  if (slot) {
    const disabled = owner !== "terminal";
    if (slot.term.options.disableStdin !== disabled)
      slot.term.options.disableStdin = disabled;
    if (slot.term.textarea && slot.term.textarea.disabled !== disabled)
      slot.term.textarea.disabled = disabled;
    if (disabled && slot.term.textarea === document.activeElement)
      slot.term.blur();
  }
  return owner;
}

function applyBlockMode(leafId: number, mode: BlockMode, force = false): void {
  const s = sessions.get(leafId);
  if (!s) return;
  const previousMode = s.blockMode;
  if (previousMode === mode && !force) return;
  const prompt = mode === "prompt";
  s.blockMode = mode;
  s.commandRunning = !prompt;
  // Mirrors the non-blocks prompt tracker so the OSC 52 clipboard gate
  // treats agent output (a running block) as untrusted too.
  s.shellState.inCommand = !prompt;
  syncLeafInput(leafId, s);
  if (terminalDiagnosticsEnabled())
    recordTerminalEvent(leafId, "mode", {
      from: previousMode,
      to: mode,
      epoch: s.promptEpoch,
    });
  if (s.visibleNow && s.focusedNow && (previousMode !== mode || force))
    focusSlot(leafId);
  for (const l of s.blockListeners) l();
}

function bindLeafToSlot(leafId: number, s: Session): void {
  if (!s.container) return;
  const altScreen = s.altScreenAtRelease;
  s.altScreenAtRelease = false;
  acquireSlot({
    leafId,
    container: s.container,
    snapshot: s.snapshot,
    altScreen,
    drainRing: (write) => s.dormantRing.drain(write),
    // Keep stdin alive on a parked pane so Enter can trigger the retry.
    shellExited: s.shellExited && !s.awaitingRestart,
    cols: s.cols,
    rows: s.rows,
    registerOsc: (term) => {
      if (s.blocks) {
        const osc52 = registerOsc52ClipboardHandler(
          term,
          undefined,
          s.shellState,
        );
        const deco = new BlockDecorations(term, {
          onCwd: (next) => {
            markSessionReady(leafId);
            if (s.lastCwd === next) return;
            s.lastCwd = next;
            s.callbacks.onCwd?.(next);
          },
          onMode: (mode) => {
            if (mode === "prompt") {
              confirmBlockPrompt(leafId);
              return;
            }
            cancelPromptConfirm(s);
            applyBlockMode(leafId, mode);
          },
          onViewport: () => {
            const set = blockViewportListeners.get(leafId);
            if (set) for (const l of set) l();
          },
        });
        s.blockDecorations = deco;
        const onGridFocus = () => {
          if (terminalInputOwner(s) === "shell") focusSlot(leafId);
        };
        term.textarea?.addEventListener("focus", onGridFocus);
        return [
          () => {
            s.blockDecorations = null;
            osc52();
            deco.dispose();
            term.textarea?.removeEventListener("focus", onGridFocus);
          },
        ];
      }
      // Shared in-command flag — see osc-handlers.ts. The prompt tracker
      // flips it on OSC 133 B/C/D/A; the cwd handler reads it to ignore OSC
      // 7 emitted by untrusted command output (remote SSH, `cat` of an
      // attacker file, etc.).
      const shellState = createShellIntegrationState();
      const prompt = registerPromptTracker(term, shellState, (running) =>
        onLeafCommandState(leafId, running),
      );
      const cwd = registerCwdHandler(
        term,
        (next) => {
          markSessionReady(leafId);
          if (s.lastCwd === next) return;
          s.lastCwd = next;
          s.callbacks.onCwd?.(next);
        },
        shellState,
      );
      const osc52 = registerOsc52ClipboardHandler(term, undefined, shellState);
      return [prompt.dispose, cwd, osc52];
    },
  });
  s.snapshot = null;
  s.hasSlot = true;
  syncLeafInput(leafId, s);
  if (s.blocks) applyBlockMode(leafId, s.blockMode, true);
  if (s.lastCwd !== null) s.callbacks.onCwd?.(s.lastCwd);
  if (s.pendingExit !== null) {
    const code = s.pendingExit;
    s.pendingExit = null;
    s.callbacks.onExit?.(code);
  }
}

function unbindLeafFromSlot(leafId: number, s: Session): void {
  if (!s.hasSlot) return;
  const out = releaseSlot(leafId);
  if (out) {
    if (out.cols > 0) s.cols = out.cols;
    if (out.rows > 0) s.rows = out.rows;
  }
  s.hasSlot = false;
}

function attachSession(
  leafId: number,
  container: HTMLDivElement,
  callbacks: Callbacks,
): void {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  s.callbacks = callbacks;
  s.container = container;

  if (s.visibleNow) bindLeafToSlot(leafId, s);

  if (!s.pty && !s.ptyOpening && !s.shellExited) {
    s.ptyOpening = true;
    s.spawnEpoch += 1;
    openPtyWithRetry(leafId, s, s.initialCwd)
      .then((pty) => {
        s.ptyOpening = false;
        if (s.disposed || s.shellExited) {
          observePty(pty.close(), "close");
          return;
        }
        s.pty = pty;
        if (s.pendingInput) {
          observePty(pty.write(s.pendingInput), "write");
          s.pendingInput = "";
        }
        if (s.cols > 0 && s.rows > 0)
          observePty(pty.resize(s.cols, s.rows), "resize");
      })
      .catch((e) => {
        s.ptyOpening = false;
        if (!s.disposed) surfaceSpawnFailure(leafId, s, e);
      });
  }
}

function detachSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  unbindLeafFromSlot(leafId, s);
  s.callbacks = {};
  s.container = null;
}

export async function respawnSession(
  leafId: number,
  cwd?: string,
): Promise<boolean> {
  const s = sessions.get(leafId);
  if (!s || s.disposed || s.ptyOpening) return false;
  s.spawnEpoch += 1;
  readyLeaves.delete(leafId);
  if (s.pty) observePty(s.pty.close(), "close");
  s.pty = null;
  s.snapshot = null;
  s.dormantRing = new DormantRing();
  s.shellExited = false;
  s.pendingExit = null;
  s.pendingInput = "";
  s.altScreenAtRelease = false;
  s.commandRunning = false;
  s.foregroundBusy = false;
  cancelPromptConfirm(s);
  s.awaitingRestart = false;
  cancelHiddenRelease(s);

  const slot = getSlotForLeaf(leafId);
  if (slot) {
    slot.term.clear();
    slot.term.reset();
  } else {
    discardRetainedSlot(leafId);
  }

  if (s.blocks) applyBlockMode(leafId, "running", true);
  else syncLeafInput(leafId, s);
  s.ptyOpening = true;
  let pty: PtySession;
  try {
    pty = await openPtyWithRetry(leafId, s, cwd ?? s.initialCwd);
  } catch (e) {
    s.ptyOpening = false;
    if (!s.disposed) surfaceSpawnFailure(leafId, s, e);
    return false;
  }
  s.ptyOpening = false;
  if (s.disposed || s.shellExited) {
    observePty(pty.close(), "close");
    return false;
  }
  s.pty = pty;
  if (s.pendingInput) {
    observePty(pty.write(s.pendingInput), "write");
    s.pendingInput = "";
  }
  if (s.cols > 0 && s.rows > 0)
    observePty(pty.resize(s.cols, s.rows), "resize");
  return true;
}

export async function leafHasForegroundProcess(
  leafId: number,
): Promise<boolean> {
  const s = sessions.get(leafId);
  if (!s?.pty || s.shellExited) return false;
  try {
    const result = await invoke<boolean>("pty_has_foreground_process", {
      id: s.pty.id,
    });
    return result;
  } catch (e) {
    console.error(
      "[awei-work] pty_has_foreground_process failed for leaf",
      leafId,
      e,
    );
    return true;
  }
}

export function disposeSession(leafId: number): Promise<void> {
  const s = sessions.get(leafId);
  if (!s) return Promise.resolve();
  s.disposed = true;
  s.spawnEpoch += 1;
  cancelPromptConfirm(s);
  cancelHiddenRelease(s);
  disposeLeafSlot(leafId);
  s.hasSlot = false;
  s.snapshot = null;
  const closing = s.pty?.close() ?? Promise.resolve();
  observePty(closing, "close");
  if (s.pty) useAgentActivityStore.getState().clear(s.pty.id);
  s.pty = null;
  s.pendingInput = "";
  sessions.delete(leafId);
  setGatewayPin(leafId, null);
  blockViewportListeners.delete(leafId);
  readyLeaves.delete(leafId);
  const waiters = readyWaiters.get(leafId);
  if (waiters) {
    readyWaiters.delete(leafId);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }
  return closing;
}

type Options = {
  workspace: WorkspaceEnv;
  leafId: number;
  container: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  focused?: boolean;
  initialCwd?: string;
  blocks?: boolean;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
};

export function useTerminalSession({
  workspace,
  leafId,
  container,
  visible,
  focused = true,
  initialCwd,
  blocks = false,
  onExit,
  onCwd,
}: Options) {
  const cbRef = useRef({ onExit, onCwd });
  cbRef.current = { onExit, onCwd };

  // initialCwd seeds the first PTY spawn only. It must NOT be an effect dep:
  // OSC 7 updates the leaf cwd on every `cd`, and re-running the bind effect
  // would detach/rebind the renderer slot (disposing block markers) on each cd.
  const initialCwdRef = useRef(initialCwd);
  initialCwdRef.current = initialCwd;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  useEffect(() => {
    let cancelled = false;
    const s = ensureSession(
      leafId,
      initialCwdRef.current,
      blocks,
      workspaceRef.current,
    );
    s.ready.then(() => {
      if (cancelled || s.disposed) return;
      const node = container.current;
      if (!node) return;
      attachSession(leafId, node, {
        onExit: (c) => cbRef.current.onExit?.(c),
        onCwd: (c) => cbRef.current.onCwd?.(c),
      });
      if (s.visibleNow && s.focusedNow && !s.blocks) focusSlot(leafId);
    });
    return () => {
      cancelled = true;
      detachSession(leafId);
    };
  }, [leafId, container, blocks]);

  const [blockMode, setBlockMode] = useState<BlockMode>("prompt");
  useEffect(() => {
    if (!blocks) return;
    const s = ensureSession(
      leafId,
      initialCwdRef.current,
      blocks,
      workspaceRef.current,
    );
    setBlockMode(s.blockMode);
    const cb = () => setBlockMode(sessions.get(leafId)?.blockMode ?? "prompt");
    s.blockListeners.add(cb);
    return () => {
      s.blockListeners.delete(cb);
    };
  }, [leafId, blocks]);

  const { fontFamily, fontWeight, fontSize } = useTerminalFont();
  const zoomLevel = usePreferencesStore((p) => p.zoomLevel);
  useLayoutEffect(() => {
    applyTerminalFont({
      fontFamily,
      fontWeight,
      fontSize: Math.max(4, Math.round(fontSize * zoomLevel)),
    });
  }, [fontFamily, fontWeight, fontSize, zoomLevel]);

  const letterSpacing = usePreferencesStore((p) => p.terminalLetterSpacing);
  useEffect(() => {
    applyLetterSpacing(letterSpacing);
  }, [letterSpacing]);

  const scrollback = usePreferencesStore((p) => p.terminalScrollback);
  useEffect(() => {
    applyScrollback(scrollback);
  }, [scrollback]);

  const webglPref = usePreferencesStore((p) => p.terminalWebglEnabled);
  useEffect(() => {
    applyWebglPreference(webglPref);
  }, [webglPref]);

  const cursorBlink = usePreferencesStore((p) => p.terminalCursorBlink);
  useEffect(() => {
    applyCursorBlink(cursorBlink);
  }, [cursorBlink]);

  const cursorStyle = usePreferencesStore((p) => p.terminalCursorStyle);
  useEffect(() => {
    applyCursorStyle(cursorStyle);
  }, [cursorStyle]);

  const bgActive = usePreferencesStore(
    (p) => p.backgroundKind === "image" && !!p.backgroundImageId,
  );
  useEffect(() => {
    applyBackgroundActive(bgActive);
  }, [bgActive]);

  useEffect(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    s.visibleNow = visible;
    s.focusedNow = focused;
    syncLeafInput(leafId, s);
    if (terminalDiagnosticsEnabled())
      recordTerminalEvent(leafId, "visibility", { visible, focused });
    if (visible) {
      cancelHiddenRelease(s);
      if (s.container && !s.hasSlot) bindLeafToSlot(leafId, s);
      else if (s.hasSlot) refreshLeafSlot(leafId);
      setSlotFocused(leafId, focused);
      if (focused && !blocks) focusSlot(leafId);
    } else if (s.hasSlot) {
      // Always park first (keeps the grid live, pauses rendering); release
      // only after confirming nothing owns the terminal. Sync signals (OSC
      // 133, agent detect) short-circuit; the async foreground-process check
      // covers shells without integration.
      parkLeafSlot(leafId);
      if (!s.blocks && !isLeafAltScreen(leafId) && !leafBusy(s)) {
        void releaseIfIdle(leafId, s);
      }
    }
  }, [leafId, visible, focused, blocks]);

  const write = useCallback(
    (data: string) => {
      const s = sessions.get(leafId);
      if (!s || s.shellExited) return;
      if (s.pty) observePty(s.pty.write(data), "write");
      else queuePendingInput(s, data);
    },
    [leafId],
  );

  const focus = useCallback(() => focusSlot(leafId), [leafId]);

  const getBuffer = useCallback(
    (maxLines = 200): string | null => {
      const s = sessions.get(leafId);
      if (!s) return null;
      const slot = getLiveSlotForLeaf(leafId);
      if (slot) {
        const buf = slot.term.buffer.active;
        const total = buf.length;
        const lines: string[] = [];
        const start = Math.max(0, total - maxLines);
        for (let i = start; i < total; i++) {
          lines.push(buf.getLine(i)?.translateToString(true) ?? "");
        }
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        return lines.join("\n");
      }
      if (!s.snapshot) return "";
      const plain = stripAnsi(s.snapshot);
      const lines = plain.split(/\r?\n/);
      const tail = lines.slice(-maxLines);
      while (tail.length && tail[tail.length - 1] === "") tail.pop();
      return tail.join("\n");
    },
    [leafId],
  );

  const getSelection = useCallback((): string | null => {
    const slot = getSlotForLeaf(leafId);
    const sel = slot?.term.getSelection() ?? "";
    return sel.length > 0 ? sel : null;
  }, [leafId]);

  const applyTheme = useCallback(() => {
    applyPoolTheme();
  }, []);

  const selectBlockAt = useCallback(
    (clientY: number) =>
      sessions.get(leafId)?.blockDecorations?.selectBlockAt(clientY),
    [leafId],
  );

  const readBlockId = useCallback(
    (id: string) =>
      sessions.get(leafId)?.blockDecorations?.readById(id) ?? null,
    [leafId],
  );

  const subscribeBlocks = useCallback(
    (cb: () => void) => {
      let set = blockViewportListeners.get(leafId);
      if (!set) {
        set = new Set();
        blockViewportListeners.set(leafId, set);
      }
      set.add(cb);
      return () => {
        const live = blockViewportListeners.get(leafId);
        live?.delete(cb);
        if (live && live.size === 0) blockViewportListeners.delete(leafId);
      };
    },
    [leafId],
  );

  const visibleBlocks = useCallback(
    (): VisibleBlocks =>
      sessions.get(leafId)?.blockDecorations?.visibleBlocks() ?? {
        blocks: [],
        sticky: null,
      },
    [leafId],
  );

  const searchBlock = useCallback(
    (id: string, query: string) =>
      sessions.get(leafId)?.blockDecorations?.searchBlock(id, query) ?? [],
    [leafId],
  );

  const revealMatch = useCallback(
    (m: BlockMatch) => sessions.get(leafId)?.blockDecorations?.revealMatch(m),
    [leafId],
  );

  const clearSearch = useCallback(
    () => sessions.get(leafId)?.blockDecorations?.clearSearch(),
    [leafId],
  );

  const findAll = useCallback(
    (query: string): TermMatch[] => {
      const slot = getLiveSlotForLeaf(leafId);
      if (!slot || !query) return [];
      return findInTerminal(slot.term, query);
    },
    [leafId],
  );

  const revealFind = useCallback(
    (m: TermMatch) => {
      const slot = getLiveSlotForLeaf(leafId);
      if (!slot) return;
      revealTermMatch(slot.term, m);
    },
    [leafId],
  );

  const clearFind = useCallback(() => {
    const slot = getSlotForLeaf(leafId);
    if (!slot) return;
    clearTermFind(slot.term);
  }, [leafId]);

  return useMemo(
    () => ({
      write,
      focus,
      getBuffer,
      getSelection,
      applyTheme,
      blockMode,
      selectBlockAt,
      readBlockId,
      subscribeBlocks,
      visibleBlocks,
      searchBlock,
      revealMatch,
      clearSearch,
      findAll,
      revealFind,
      clearFind,
    }),
    [
      write,
      focus,
      getBuffer,
      getSelection,
      applyTheme,
      blockMode,
      selectBlockAt,
      readBlockId,
      subscribeBlocks,
      visibleBlocks,
      searchBlock,
      revealMatch,
      clearSearch,
      findAll,
      revealFind,
      clearFind,
    ],
  );
}

const ANSI_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[78=>]|\x1bc|\x1b[NOP\]X^_]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function terminalDebugStats() {
  const liveSessions = [...sessions.entries()].map(([leafId, s]) => ({
    leafId,
    pty: !!s.pty,
    visible: s.visibleNow,
    focused: s.focusedNow,
    hasSlot: s.hasSlot,
    ringBytes: s.dormantRing.byteLength(),
    snapshotLen: s.snapshot?.length ?? 0,
    shellExited: s.shellExited,
  }));
  const ringTotal = liveSessions.reduce((n, s) => n + s.ringBytes, 0);
  const snapshotTotal = liveSessions.reduce((n, s) => n + s.snapshotLen, 0);
  const slots = poolSlotStats();
  return {
    poolSize: poolSize(),
    webglContexts: slots.filter((s) => s.webgl).length,
    idleSlots: slots.filter((s) => s.leafId === null).length,
    slots,
    sessionCount: liveSessions.length,
    sessions: liveSessions,
    ringBytesTotal: ringTotal,
    snapshotCharsTotal: snapshotTotal,
    domCanvases: document.querySelectorAll("canvas").length,
    domScreens: document.querySelectorAll(".xterm-screen").length,
    domRows: document.querySelectorAll(".xterm-rows > div").length,
    jsHeapBytes:
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize ?? null,
  };
}

if (import.meta.env?.DEV && typeof window !== "undefined") {
  (window as unknown as { __teraxTerm?: unknown }).__teraxTerm =
    terminalDebugStats;
}

if (typeof window !== "undefined")
  installTerminalDiagnostics(terminalDebugStats);
