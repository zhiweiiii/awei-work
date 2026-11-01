import { validGrid } from "@/web/protocol";
import { Terminal } from "@xterm/xterm";

// Turns the shared PTY's byte stream into a conversation.
//
// The phone does NOT render a terminal grid. Rendering the desktop's grid
// (commonly 138-192 columns) inside ~335 CSS px forces either a 3px font or
// horizontal panning, and both are unreadable. So the grid is never shown:
// a headless xterm parses the stream (it is the only thing that gets ANSI
// right — wrapping, \r redraws, absolute cursor moves, alt screen), and this
// module reads *logical lines* back out of its buffer. Those lines carry no
// column count of their own, so the page re-wraps them at whatever width the
// phone actually has, at a normal font size.
//
// Two cases, one output:
//
//   Normal buffer — a shell. Lines scroll past the cursor and are collected
//   as they settle.
//
//   Alternate screen — a full-screen program (claude, opencode, vim, htop).
//   Nothing scrolls past a cursor: one screen is repainted in place. The
//   content still moves upward though, so successive frames are compared to
//   work out how far the screen scrolled, and the lines that fell off the top
//   are collected the same way. That is deliberately generic — it knows
//   nothing about any particular program's layout, so it does not break when
//   one changes its box drawing.

export type Turn =
  | { kind: "sent"; id: number; at: number; text: string }
  | { kind: "output"; id: number; at: number; lines: string[]; open: boolean }
  | { kind: "note"; id: number; at: number; text: string };

/** `ESC [ ? 1 0 4 9 h` - the alternate-screen enter, as bytes. */
const ALT_ENTER = new TextEncoder().encode("\x1b[?1049h");

/** Byte offset of the alternate-screen enter, or -1. A serialized terminal
 *  puts it between the scrollback and a running program's screen. */
function indexOfAltEnter(bytes: Uint8Array): number {
  const needle = ALT_ENTER;
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Scrollback held by the headless parser before it is recycled. */
const PARSER_SCROLLBACK = 5000;
/** Recycle the parser once this many lines have scrolled off. Keeps the
 *  buffer indices we track small and, more importantly, correct: xterm shifts
 *  every index down once trimming starts, which would silently strand our
 *  read cursor. Emitted lines already live in `turns`, so recycling is free. */
const RECYCLE_AT = 4000;
/** Hard cap on retained output lines, so a long session cannot grow the DOM
 *  (and the phone's memory) without bound. */
const MAX_LINES = 4000;
const MAX_TURNS = 1000;
const MAX_RETAINED_CHARS = 4 * 1024 * 1024;
const MAX_PENDING_CHARS = 2 * 1024 * 1024;
const MAX_PARSER_PENDING_BYTES = 8 * 1024 * 1024;
/** Coalesce window. Output arrives in many small chunks while a command runs;
 *  flushing per chunk would emit half-written lines and thrash the DOM. */
const FLUSH_MS = 60;
/** A gap this long without output ends the current output block, so the next
 *  thing you send starts a new one. */
const TURN_IDLE_MS = 700;
/** How many recent sends are remembered for de-duplication (a TUI paints your
 *  prompt on screen, and it must not come back as output). */
const RECENT_SENDS = 12;

export class Conversation {
  private term: Terminal;
  private queuedBytes = 0;
  private readonly onChange: () => void;
  /** Absolute buffer index of the first line not yet emitted. */
  private readUpTo = 0;
  private flushTimer: number | null = null;
  private idleTimer: number | null = null;
  private nextId = 1;
  private inAlt = false;
  private agent: string | null = null;
  /** Previous alt-screen frame, for scroll detection. */
  private prevScreen: string[] = [];
  /** Column the previous frame's side panel started at, or -1. Rows that
   *  scroll off are trimmed with the cut of the frame they came from. */
  private sideCut = -1;
  /** Text we just sent, still waiting to be recognised in the shell's echo. */
  private pendingEcho: string | null = null;
  /** Recently sent text, so a TUI repainting it is not shown twice. */
  private recentSends: string[] = [];
  /** Id of the "started" note, while its program is still unidentified. */
  private startNoteId: number | null = null;
  /** Whether the current alt-screen frame is the program's very first one.
   *  A splash can only be the first thing a program draws; any later screen
   *  that also looks sparse (an exit / save prompt with a big ASCII banner)
   *  is an interaction the user must see, not a logo to suppress. */
  private firstFrame = true;

  turns: Turn[] = [];
  /** The alt screen as it stands right now. History lives in `turns`; this is
   *  only what is still on screen, so the two never overlap. */
  liveScreen: string[] | null = null;
  /** The same screen, read as conversation blocks. This is what is shown; the
   *  raw lines above stay available for when the parse looks wrong. */
  liveBlocks: Block[] = [];
  /** Sent while a full-screen program is running, not yet painted by it.
   *  Rendered after the live screen so the order stays honest. */
  pending: string[] = [];
  /** The program's own status furniture (model, usage, key hints), condensed
   *  to one line. Shown as a label, never as a bubble — it is not something
   *  anyone said. */
  status: string | null = null;
  /** The tab strip pinned to the bottom of the screen — Claude Code's running
   *  subagents ("◯ Explore Search repo for README content 0s"). Identified by
   *  position (the footer's bottom row, and not an input box), never by the
   *  agent's name or task, and kept separate from the bubbles so agent
   *  activity reads as a status chip rather than as conversation. */
  agents: string[] = [];
  /** What the program is doing right now, and for how long - the spinner line
   *  both tools draw above their input box ("✻ Thinking… (12s · …)"). It is a
   *  state, not something anyone said, so it is kept out of the bubbles and
   *  shown as its own indicator. Null when nothing is running. */
  thinking: Thinking | null = null;
  /** The agent's current mode ("auto-accept edits on", opencode's "Build").
   *  Pulled out of the footer before the rest is condensed, because it is the
   *  one status fragment that changes what typing into this session DOES. */
  mode: string | null = null;
  /** A numbered menu the program is offering ("1. Yes / 2. No"). Rendered as
   *  buttons instead of text: the answer is a keystroke, and on a phone
   *  tapping it beats opening the keyboard to type one digit. */
  choices: Choice[] = [];
  /** What the pending menu is attached to: the question, and whatever the
   *  program is showing to justify it - the command it wants to run, the diff
   *  it wants to write. Empty unless `choices` is.
   *
   *  Separate from `liveBlocks` because under an agent transcript the screen
   *  is not the conversation and is not rendered, but this part of it has to
   *  be: approving "create hello.txt" without seeing what goes in it is not a
   *  decision, it is a guess. */
  promptBlocks: Block[] = [];
  /** Diagnostics: how many alt-screen frames were seen, and how many of them
   *  were recognised as a scroll. A frame count that climbs while `scrolls`
   *  stays at 0 means the screen is being repainted in a way detectScroll does
   *  not recognise, and history is being lost. */
  stats = { frames: 0, scrolls: 0 };

  constructor(onChange: () => void) {
    this.onChange = onChange;
    this.term = this.makeTerm(80, 24);
  }

  private makeTerm(cols: number, rows: number): Terminal {
    // No `open()` call: this terminal is a parser, never a view. Without a
    // DOM element xterm skips its renderer entirely and only maintains the
    // buffer, which is exactly what we read.
    return new Terminal({
      cols,
      rows,
      scrollback: PARSER_SCROLLBACK,
      allowProposedApi: true,
    });
  }

  /** Parse at the PTY's real grid: the byte stream is laid out against it, so
   *  this is the only width at which wrapping and cursor moves come out right.
   *  It is a parsing detail and never reaches the screen. */
  setGrid(cols: number, rows: number) {
    if (!validGrid(cols, rows)) return;
    if (this.term.cols === cols && this.term.rows === rows) return;
    this.term.resize(cols, rows);
    // Frames of different widths are not comparable.
    this.prevScreen = [];
  }

  setAgent(agent: string | null) {
    if (agent === this.agent) return;
    this.agent = agent;
    this.scheduleFlush();
  }

  get program(): string | null {
    return this.agent;
  }

  /** Put the headless parser into/out of the alternate screen to match the
   *  PTY's real mode. The server's history ring can trim the `1049h` enter
   *  sequence, so a backlog that starts mid-TUI would otherwise parse as a
   *  shell; forcing the mode up front makes the replay land in the right
   *  buffer. The mode is then kept in sync by the flushes themselves. */
  setAltScreen(inAlt: boolean) {
    if (this.inAlt === inAlt) return;
    this.writeParsed(inAlt ? "\x1b[?1049h" : "\x1b[?1049l");
  }

  write(bytes: Uint8Array) {
    this.writeParsed(bytes);
  }

  private writeParsed(data: string | Uint8Array) {
    const term = this.term;
    this.queueWrite(data, () => {
      if (term === this.term) this.scheduleFlush();
    });
  }

  private queueWrite(data: string | Uint8Array, parsed: () => void) {
    const term = this.term;
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data).length
        : data.length;
    if (this.queuedBytes + bytes > MAX_PARSER_PENDING_BYTES) {
      throw new Error("Terminal parser queue exceeded 8 MiB");
    }
    this.queuedBytes += bytes;
    let pending = true;
    try {
      term.write(data, () => {
        pending = false;
        if (term === this.term) this.queuedBytes -= bytes;
        parsed();
      });
    } catch (error) {
      if (pending && term === this.term) this.queuedBytes -= bytes;
      throw error;
    }
  }

  /** Take in the seed the server sends when a phone attaches: the desktop
   *  terminal's own buffer, serialized.
   *
   *  There are no frames to reconstruct here - the buffer already IS the
   *  result of every frame the program ever painted, which is exactly why the
   *  desktop is asked for it instead of a byte log being replayed through the
   *  parser. So it is written as-is.
   *
   *  The one split that matters is the alternate-screen enter. A serialized
   *  terminal running a full-screen program is "scrollback, then `?1049h`,
   *  then the program's screen", and `flush` only ever reads whichever buffer
   *  is active - so writing straight past the switch would leave the
   *  scrollback unread and the phone would open on the TUI's screen alone.
   *  Write up to the switch, read the scrollback out as history, then write
   *  the rest. */
  writeSeed(bytes: Uint8Array): Promise<void> {
    const term = this.term;
    const at = indexOfAltEnter(bytes);
    const head = at < 0 ? bytes : bytes.subarray(0, at);
    return new Promise<void>((done, reject) => {
      if (this.queuedBytes + bytes.length > MAX_PARSER_PENDING_BYTES) {
        throw new Error("Terminal seed exceeded parser queue budget");
      }
      if (head.length > 0) {
        this.queueWrite(head, () => {
          try {
            if (term === this.term) {
              this.flush(at >= 0);
              this.emitSeededCursorRow(at >= 0);
            }
            if (at < 0) done();
          } catch (error) {
            reject(error);
          }
        });
      } else if (at < 0) done();
      // Queue both seed pieces before live frames can enter xterm's write queue.
      if (at >= 0) {
        this.queueWrite(bytes.subarray(at), () => {
          try {
            if (term === this.term) {
              this.firstFrame = false;
              this.flush();
            }
            done();
          } catch (error) {
            reject(error);
          }
        });
      }
    });
  }

  /** Emit the row the cursor is sitting on.
   *
   *  `flushNormal` deliberately stops above the cursor: that row may be a
   *  half-written prompt or a progress line, and emitting it on every flush
   *  would churn. A seed has no churn to avoid - the row is exactly what the
   *  desktop is showing at that moment - and leaving it out opened the phone
   *  on a blank page whenever the command line was simply sitting at its
   *  prompt, which is most of the time.
   *
   *  The read cursor moves past it, so the live stream does not repeat it. */
  private emitSeededCursorRow(asShell = false) {
    const buf = this.term.buffer.active;
    if (buf.type === "alternate" || (this.agent !== null && !asShell)) return;
    const at = buf.baseY + buf.cursorY;
    const text = buf.getLine(at)?.translateToString(true) ?? "";
    if (text.trim() === "") return;
    this.appendOutput([text]);
    this.readUpTo = at + 1;
    this.onChange();
  }

  /** Record what the user just sent.
   *
   *  Where it goes depends on what is running. Under a shell it is history:
   *  the output that follows will be appended after it, in order. Under a
   *  full-screen program the newest thing on screen is the program's own
   *  repaint, so a bubble pushed into history would land ABOVE content that is
   *  older than it. It waits in `pending` instead — rendered after the live
   *  screen, and dropped as soon as the program paints the prompt itself. */
  noteSent(text: string) {
    const trimmed = text.trim();
    this.recentSends.push(trimmed);
    if (this.recentSends.length > RECENT_SENDS) this.recentSends.shift();

    if (this.inAlt || this.agent !== null) {
      this.pending.push(text);
      let pendingChars = this.pending.reduce(
        (sum, item) => sum + item.length,
        0,
      );
      while (this.pending.length > 64 || pendingChars > MAX_PENDING_CHARS) {
        const oldest = this.pending.shift();
        if (oldest === undefined) break;
        pendingChars -= oldest.length;
        this.turns.push({
          kind: "sent",
          id: this.nextId++,
          at: Date.now(),
          text: oldest,
        });
      }
      this.trim();
      this.onChange();
      return;
    }
    this.closeOutput();
    this.pendingEcho = trimmed;
    this.turns.push({ kind: "sent", id: this.nextId++, at: Date.now(), text });
    this.trim();
    this.onChange();
  }

  note(text: string) {
    this.turns.push({ kind: "note", id: this.nextId++, at: Date.now(), text });
    this.trim();
    this.onChange();
  }

  /** Start over — a new session, or a reconnect that replays history. */
  reset() {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.flushTimer = null;
    this.idleTimer = null;
    const { cols, rows } = this.term;
    this.term.dispose();
    this.term = this.makeTerm(cols || 80, rows || 24);
    this.queuedBytes = 0;
    this.readUpTo = 0;
    this.inAlt = false;
    this.agent = null;
    this.prevScreen = [];
    this.sideCut = -1;
    this.liveScreen = null;
    this.liveBlocks = [];
    this.pending = [];
    this.status = null;
    this.agents = [];
    this.thinking = null;
    this.mode = null;
    this.choices = [];
    this.promptBlocks = [];
    this.pendingEcho = null;
    this.recentSends = [];
    this.startNoteId = null;
    this.firstFrame = true;
    this.turns = [];
    this.onChange();
  }

  private scheduleFlush() {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_MS);
  }

  private flush(asShell = false) {
    const buf = this.term.buffer.active;
    if (buf.type === "alternate") {
      this.flushAlt();
    } else {
      this.flushNormal(asShell);
    }
    this.armIdle();
    this.onChange();
  }

  // ── Alternate screen ───────────────────────────────────────────────────

  private flushAlt() {
    const buf = this.term.buffer.active;
    const cur: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      // Trim the right edge ourselves. xterm's own trimRight leaves padding on
      // cells that carry attributes, and a TUI pads to the full width with
      // styled blanks — so the same line comes back with different trailing
      // whitespace from frame to frame. That made every line compare unequal
      // and detectScroll never fired, silently losing the history.
      cur.push(
        (buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "").replace(
          /\s+$/,
          "",
        ),
      );
    }

    if (!this.inAlt) {
      // First frame of this program. Nothing has scrolled off yet, so there
      // is no history to collect — only a screen to show.
      this.inAlt = true;
      this.closeOutput();
      // Attaching mid-session means the splash is long gone, so the program
      // often cannot be named from this first frame. Label it generically now
      // and fill the name in once a later frame gives it away.
      const program = detectProgram(cur);
      this.startNoteId = this.nextId;
      this.note(program ? `${program} 已启动` : "全屏程序已启动");
      this.prevScreen = cur;
      this.setLive(cur);
      this.firstFrame = false;
      return;
    }

    this.stats.frames++;
    const scrolled = detectScroll(this.prevScreen, cur);
    if (scrolled > 0) {
      this.stats.scrolls++;
      // Those top lines are gone from the screen for good; they are the
      // conversation's history now. They go through exactly the same parse as
      // the live screen, so a message that scrolls away stays the bubble it
      // was instead of decaying into anonymous output — and, critically, is
      // not dropped as an "echo" of something we sent.
      this.appendBlocks(
        markEchoes(
          toBlocks(
            dropSideColumn(this.prevScreen.slice(0, scrolled), this.sideCut),
          ),
          this.recentSends,
        ),
      );
    }
    this.prevScreen = cur;
    this.setLive(cur);
  }

  private setLive(screen: string[]) {
    this.liveScreen = trimTrailingBlanks(screen);
    if (this.startNoteId !== null) {
      const program = detectProgram(this.liveScreen);
      if (program) {
        const note = this.turns.find((t) => t.id === this.startNoteId);
        if (note?.kind === "note") note.text = `${program} 已启动`;
        this.startNoteId = null; // named; stop looking
      }
    }
    // The menu comes off the screen FIRST, before anything else reads it.
    const menu = findChoices(this.liveScreen);
    this.choices = menu?.choices ?? [];
    // The dialog's own context, bounded: a menu is drawn directly under what
    // it is asking about, and the rest of the screen is not part of the
    // question.
    this.promptBlocks = menu
      ? toBlocks(
          this.liveScreen.slice(
            promptFrom(this.liveScreen, menu.start),
            menu.start,
          ),
        )
      : [];
    const split = splitFooter(this.liveScreen, menu ? menu.end + 1 : 0);
    if (menu) {
      split.body = [
        ...split.body.slice(0, menu.start),
        ...split.body.slice(menu.end + 1),
      ];
    }
    // A side panel is not conversation. Found and removed before anything
    // else reads the screen, so the working line, the menu scan and the
    // bubbles all see one column. The cut is remembered for the rows that
    // scroll off the NEXT frame, which are trimmed with the cut of the frame
    // they came from.
    this.sideCut = sideColumnCut(split.body);
    split.body = dropSideColumn(split.body, this.sideCut);
    // The working line is drawn right above the input box, so it lands either
    // side of the status rule - including on the footer's bottom row, which is
    // otherwise the agent tab strip. Take it out first, or a program that is
    // merely thinking is reported as running a subagent.
    const { thinking, body, footer } = splitWorking(split.body, split.footer);
    this.thinking = thinking;
    // The footer's bottom row is the tab strip (Claude's running subagents).
    // Pull it out by position before condensing the rest into the status
    // label, so agent activity becomes its own chip instead of a status
    // fragment — and is never mistaken for conversation.
    // The mode is read off the footer BEFORE condensing, since the lines
    // carrying it (opencode's "Build · <model>", Claude's model line) are
    // dropped as readouts by the condense pass — and before the tab strip is
    // taken, because the two compete for the same row.
    const mode = detectModeAt(footer, body);
    this.mode = mode.mode;

    let strip: string | null = null;
    let statusFooter = footer;
    let stripRow = -1;
    for (let i = footer.length - 1; i >= 0; i--) {
      if (footer[i].trim() !== "") {
        strip = footer[i];
        stripRow = i;
        statusFooter = footer.slice(0, i);
        break;
      }
    }
    // With no subagent running, the bottom row is whatever else the program
    // pins there — usually the mode. Showing it as a chip above the thread put
    // "auto mode on" at the top of the phone while the composer showed the
    // same thing at the bottom. A row already spoken for is not a tab strip.
    this.agents =
      strip !== null && !isInputBox(strip) && stripRow !== mode.footerRow
        ? [stripChrome(strip).trim()]
        : [];

    this.status = condenseStatus(statusFooter, this.recentSends);

    // A splash screen is a logo, not conversation, and it can only be the
    // first thing a program draws. Bubbling ASCII art would fill the thread
    // with nonsense; the "started" note already says it. Later frames are
    // interactions (an exit / save prompt under an ASCII banner is still a
    // prompt), so they are never suppressed.
    const blocks = this.firstFrame && isBanner(body) ? [] : toBlocks(body);
    this.liveBlocks = markEchoes(blocks, this.recentSends);

    // Drop anything we were holding that the program has now painted itself,
    // so a sent message is not shown twice.
    if (this.pending.length > 0) {
      const said = this.liveBlocks
        .filter((b) => b.role === "user")
        .map((b) => collapse(b.lines.join(" ")));
      this.pending = this.pending.filter((p) => {
        const want = collapse(p);
        if (want === "") return false;
        return !said.some((s) => sameMessage(s, want));
      });
    }
  }

  // ── Normal buffer ──────────────────────────────────────────────────────

  private flushNormal(asShell = false) {
    const buf = this.term.buffer.active;
    if (this.inAlt || (this.agent === null && this.liveScreen !== null)) {
      // The program exited. Whatever was still on its screen never scrolled
      // off, so fold it into the history before moving on — through the same
      // parse as every other frame: furniture stripped, echoes marked. Raw-
      // appending the screen put the input box, the status line and the
      // program's echo of a sent message into the output as anonymous AI.
      this.inAlt = false;
      if (this.liveScreen?.length) {
        const blocks = markEchoes(
          toBlocks(
            dropSideColumn(splitFooter(this.liveScreen).body, this.sideCut),
          ),
          this.recentSends,
        );
        this.appendBlocks(blocks);
        // A message the program painted is already a "sent" block above; drop
        // it from pending so it does not fold in again below.
        const said = blocks
          .filter((b) => b.role === "user")
          .map((b) => collapse(b.lines.join(" ")));
        this.pending = this.pending.filter((p) => {
          const want = collapse(p);
          if (want === "") return false;
          return !said.some((s) => sameMessage(s, want));
        });
      }
      this.liveScreen = null;
      this.liveBlocks = [];
      this.status = null;
      this.agents = [];
      this.thinking = null;
      this.mode = null;
      this.choices = [];
      this.promptBlocks = [];
      // Anything still unpainted goes back into the history, in order, now
      // that there is no live screen for it to sit after.
      for (const text of this.pending) {
        this.turns.push({
          kind: "sent",
          id: this.nextId++,
          at: Date.now(),
          text,
        });
      }
      this.pending = [];
      this.prevScreen = [];
      this.readUpTo = buf.baseY + buf.cursorY;
      this.closeOutput();
    }

    // Everything above the cursor is settled; the cursor's own line may still
    // be half-written (a prompt, a progress line), so it is left for later.
    if (this.agent !== null && !asShell) {
      if (this.readUpTo > buf.baseY) this.readUpTo = buf.baseY;
      const fresh: string[] = [];
      for (let i = this.readUpTo; i < buf.baseY; i++) {
        const line = buf.getLine(i);
        if (!line) continue;
        const text = line.translateToString(true);
        if (line.isWrapped && fresh.length > 0) fresh[fresh.length - 1] += text;
        else fresh.push(text);
      }
      if (fresh.length > 0)
        this.appendBlocks(markEchoes(toBlocks(fresh), this.recentSends));
      this.readUpTo = Math.max(this.readUpTo, buf.baseY);
      const screen: string[] = [];
      for (let y = 0; y < this.term.rows; y++)
        screen.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? "");
      this.setLive(screen);
      this.recycleIfNeeded();
      return;
    }
    this.liveScreen = null;
    this.liveBlocks = [];
    this.choices = [];
    this.promptBlocks = [];
    this.thinking = null;
    this.mode = null;
    this.status = null;
    this.agents = [];
    const end = buf.baseY + buf.cursorY;
    if (end < this.readUpTo) {
      // The buffer was cleared or reset under us.
      this.readUpTo = end;
    }
    const fresh: string[] = [];
    for (let i = this.readUpTo; i < end; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      // A line xterm marks as wrapped is the continuation of the one above:
      // it was broken at the PTY's column count, not by the program. Join it
      // back so the phone can re-wrap at its own width.
      if (line.isWrapped && fresh.length > 0) {
        fresh[fresh.length - 1] += text;
      } else {
        fresh.push(text);
      }
    }
    this.readUpTo = end;

    if (fresh.length > 0) this.appendOutput(fresh);
    this.recycleIfNeeded();
  }

  // ── Shared ─────────────────────────────────────────────────────────────

  /** Move parsed blocks into the history, keeping their roles. */
  private appendBlocks(blocks: Block[]) {
    for (const block of blocks) {
      const text = block.lines.join("\n");
      if (text.trim() === "") continue;
      if (block.role === "user") {
        this.closeOutput();
        this.turns.push({
          kind: "sent",
          id: this.nextId++,
          at: Date.now(),
          text,
        });
        continue;
      }
      const last = this.turns[this.turns.length - 1];
      if (last?.kind === "output" && last.open) {
        last.lines.push(...block.lines);
        last.at = Date.now();
      } else {
        this.turns.push({
          kind: "output",
          id: this.nextId++,
          at: Date.now(),
          lines: [...block.lines],
          open: true,
        });
      }
    }
    this.trim();
  }

  private appendOutput(raw: string[]) {
    let lines = tidy(raw);

    // Drop the shell's echo of what we just sent, so the command does not
    // appear twice (once as your bubble, once at the top of the output).
    if (this.pendingEcho) {
      // Match loosely. A line editor (PSReadLine, zle) repaints the command as
      // it goes, so the echo can arrive wrapped, re-rendered, or printed twice
      // on one line, none of which equals what was typed. Collapsing runs of
      // whitespace and asking only whether the command appears somewhere in
      // the line catches all of those; everything up to and including that
      // line is the echo and goes.
      const want = collapse(this.pendingEcho);
      const at =
        want.length >= 2
          ? lines.findIndex((l) => collapse(l).includes(want))
          : -1;
      if (at !== -1) {
        lines = lines.slice(at + 1);
        this.pendingEcho = null;
      } else if (lines.length > 8) {
        // It was never echoed (a TUI reading raw keys, say). Stop looking.
        this.pendingEcho = null;
      }
    }

    // A full-screen program paints your prompt into its own transcript. That
    // line eventually scrolls off and would arrive here as "output", so drop
    // anything that is just a repaint of something we already showed as sent.
    if (this.recentSends.length > 0) {
      lines = lines.filter((l) => !this.isRepaintOfSend(l));
    }

    if (lines.length === 0) return;

    const last = this.turns[this.turns.length - 1];
    if (last?.kind === "output" && last.open) {
      last.lines.push(...lines);
      last.at = Date.now();
    } else {
      this.turns.push({
        kind: "output",
        id: this.nextId++,
        at: Date.now(),
        lines,
        open: true,
      });
    }
    this.trim();
  }

  private isRepaintOfSend(line: string): boolean {
    const bare = collapse(stripDecoration(line));
    if (bare.length < 2) return false;
    return this.recentSends.some((s) => {
      const want = collapse(s);
      return want.length >= 2 && bare === want;
    });
  }

  private closeOutput() {
    const last = this.turns[this.turns.length - 1];
    if (last?.kind === "output") last.open = false;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Close the current output block once the stream goes quiet, so the next
   *  command starts its own block. */
  private armIdle() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      const last = this.turns[this.turns.length - 1];
      if (last?.kind === "output" && last.open) {
        last.open = false;
        this.onChange();
      }
    }, TURN_IDLE_MS);
  }

  /** Once enough lines have scrolled off, xterm starts trimming and every
   *  buffer index shifts. Rather than track the shift, start the parser over:
   *  the lines we care about are already in `turns`. */
  private recycleIfNeeded() {
    const buf = this.term.buffer.active;
    if (buf.baseY < RECYCLE_AT) return;
    this.term.clear(); // keeps the current screen, drops the scrollback
    const after = this.term.buffer.active;
    this.readUpTo =
      this.agent === null ? after.baseY + after.cursorY : after.baseY;
  }

  /** Keep the retained transcript bounded. */
  private trim() {
    let total = 0;
    let chars = 0;
    for (const t of this.turns) {
      if (t.kind === "output") total += t.lines.length;
      chars +=
        t.kind === "output"
          ? t.lines.reduce((sum, line) => sum + line.length, 0)
          : t.text.length;
    }
    const dropFirst = () => {
      const dropped = this.turns.shift();
      if (!dropped) return;
      if (dropped.kind === "output") {
        total -= dropped.lines.length;
        chars -= dropped.lines.reduce((sum, line) => sum + line.length, 0);
      } else chars -= dropped.text.length;
    };
    while (this.turns.length > MAX_TURNS) {
      dropFirst();
    }
    while (total > MAX_LINES || chars > MAX_RETAINED_CHARS) {
      const first = this.turns[0];
      if (!first) break;
      if (first.kind === "output") {
        let remove = 0;
        while (
          remove < first.lines.length &&
          (total > MAX_LINES || chars > MAX_RETAINED_CHARS)
        ) {
          chars -= first.lines[remove].length;
          total--;
          remove++;
        }
        first.lines.splice(0, remove);
        if (first.lines.length > 0) continue;
      }
      dropFirst();
    }
  }
}

/** How many lines the screen scrolled up between two frames, or 0.
 *
 *  Finds the smallest shift at which most of the old frame lines up with the
 *  new one. A program with a fixed footer (an input box, a status line) still
 *  matches, because the scrolling region is the bulk of the screen — those few
 *  unmatched footer rows do not outvote it. */
function detectScroll(prev: string[], cur: string[]): number {
  const height = Math.min(prev.length, cur.length);
  if (height < 6) return 0;
  for (let k = 1; k <= height - 4; k++) {
    let matched = 0;
    let compared = 0;
    let matchedText = 0;
    for (let i = 0; i + k < prev.length && i < cur.length; i++) {
      compared++;
      if (prev[i + k] === cur[i]) {
        matched++;
        if (prev[i + k].trim() !== "") matchedText++;
      }
    }
    if (compared < 4) break;
    // Blank screens line up at every shift, so require real text to agree.
    if (matched / compared >= 0.7 && matchedText >= 3) return k;
  }
  return 0;
}

/** Collapse blank runs and drop leading/trailing blank lines. */
function tidy(lines: string[]): string[] {
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blanks++;
      if (blanks > 1) continue;
      out.push("");
    } else {
      blanks = 0;
      out.push(line);
    }
  }
  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

function trimTrailingBlanks(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
}

/** Runs of whitespace collapsed to one space, for tolerant comparison. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Box drawing, block elements, geometric shapes, braille — the characters a
 *  TUI uses to draw its frame rather than to say anything. `⏺`/`●` markers are
 *  deliberately NOT in here: they carry meaning and are handled as bullets. */
const CHROME = /[─-╿▀-▟■-◿⠀-⣿⬀-⭟]/g;
/** The same set, anchored: a status bar or an input box opens with a rule. A
 *  rule is a RUN of frame characters (`╹▀▀▀▀…`); a single gutter marker (`┃`,
 *  `▣`) is decoration on a line that may be content, so it is not treated as
 *  a rule. Treating single markers as rules made the footer walk eat any
 *  message opencode rendered under a `┃` gutter, hiding user input as status. */
const CHROME_LEAD = /^\s*(?:[─-╿▀-▟■-◿⠀-⣿⬀-⭟]){2,}/;
/** Key hints — the giveaway that a line is a status bar, not content. */
const HINT = /\b(esc|ctrl\+|cmd\+|alt\+|tab|shift\+)\b/i;
/** A bare filesystem path is what an input box shows for the working
 *  directory, not conversation. */
const PATH_LIKE = /^\/?[A-Za-z]:[\\/]|^\/(?:[A-Za-z0-9._-]+[\\/])+/;
/** Above this share of frame characters, a line is drawing, not saying. */
const CHROME_SHARE = 0.3;
/** Prompt markers these tools put in front of what the user said. */
const USER_MARK = /^[>❯›]\s?/;
/** …and the same markers pointing at a numbered choice, which is not. */
const MENU_ITEM = /^[>❯›]\s*\d+[.)]\s/;

/** A line with its frame removed. */
export function stripChrome(line: string): string {
  return line.replace(CHROME, " ").replace(/\s+$/, "").replace(/^\s+/, "");
}

/** Strip the frame a TUI draws around text, so a line can be compared with
 *  what was actually typed. */
function stripDecoration(line: string): string {
  return stripChrome(line)
    .replace(/^[>|*\-•⏺●○\s]+/, "")
    .trim();
}

/** A block of screen content: one bubble. */
export type Block = { role: "user" | "out"; lines: string[] };

/** The program's working indicator: what it is doing, and for how long. */
export type Thinking = { label: string; seconds: number | null };

/** One entry of a numbered menu the program is offering. */
export type Choice = {
  key: string;
  label: string;
  selected: boolean;
  /** The option's own description, when the program prints one under it. */
  detail?: string;
};

/** A menu found on screen, and the rows it occupies. */
type ChoiceMenu = { choices: Choice[]; start: number; end: number };

/** Status widgets these tools scatter around the screen rather than pin to the
 *  bottom, so the footer walk never reaches them: token counters, timers,
 *  section labels. They are readouts, not conversation, and each would
 *  otherwise become its own bubble.
 *
 *  This is the one place that knows about specific tools. Everything else is
 *  generic, and an unmatched widget degrades into a small stray bubble rather
 *  than breaking the parse. */
const WIDGET = [
  /^\+?\s*Thought:?\s/i, // "+ Thought: 904ms"
  /^Context$/i,
  /^[\d,.]+\s*(tokens?|k)\b/i, // "15,981 tokens"
  /^\W*[\d,.]+\s*k?\s*tokens?(?![a-z])/i, // "↑ 1.2k tokens", with its arrow
  /^[\d.]+%\s*$/,
  /^\$[\d.]+$/,
  /^\$[\d.]+\s+spent$/i,
  /^Title generation request$/i, // opencode, while it names the thread
  /^LSPs?\b/i, // "LSP", "LSPs are disabled"
  /^Single[- ](digit|number)\s+input$/i, // opencode's generated title for "1"
  /^(Build|Plan|Chat)\s+·\s+/i, // opencode's model line
  /^Opus\s*\d/i, // claude's model line ("Opus 5 claude-fresh 强度:high …")
  /auto-update failed/i, // claude's startup warning (npm-prefix write error)
  /^\W*update installed/i, // claude's "✓ Update installed · Restart to apply"
  /^\d+\s*(files?|additions?|deletions?)$/i,
];

function isWidget(text: string): boolean {
  return WIDGET.some((re) => re.test(text));
}

/** Turn raw screen lines into conversation blocks.
 *
 *  This knows nothing about any particular program. It only does what is true
 *  of every full-screen TUI: the frame is drawn with box characters and is not
 *  content, blank lines separate one thing from the next, and a `>` marker
 *  introduces something the user said. Anything it gets wrong degrades into a
 *  slightly oddly-split bubble rather than lost text, and the raw screen stays
 *  one tap away. */
export function toBlocks(body: string[]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;

  for (const raw of body) {
    const text = stripChrome(raw);
    if (text.trim() === "") {
      cur = null; // blank line ends a block
      continue;
    }
    // A `>` at the start is the one near-universal "the user said this"
    // marker across these tools.
    // `>` and `❯` introduce what the user said — but the same glyph also
    // points at menu entries ("❯ 1. 上班"), which are the program offering a
    // choice, not the user speaking. Numbered items are excluded on that
    // basis. Messages we sent ourselves are recognised later and far more
    // reliably, by matching the text (see markEchoes); this marker only
    // catches prompts typed at the desktop, which we never saw go out.
    const userMark = USER_MARK.test(text) && !MENU_ITEM.test(text);
    const clean = userMark ? text.replace(USER_MARK, "") : text;
    if (clean.trim() === "") continue;
    if (!userMark && (isWidget(clean.trim()) || isWorkingLine(raw))) {
      cur = null; // a readout also separates what surrounds it
      continue;
    }
    const role: Block["role"] = userMark ? "user" : "out";
    if (!cur || cur.role !== role) {
      cur = { role, lines: [] };
      blocks.push(cur);
    }
    cur.lines.push(clean);
  }
  return blocks;
}

/** Blank columns that must precede a side panel, separating it from the
 *  conversation. */
const COLUMN_GAP = 2;
/** A side panel starts at least this far across the screen; a cut nearer the
 *  left edge would be splitting the conversation, not trimming a panel. */
const COLUMN_MIN_SHARE = 0.45;
/** ...and carries at most this share of the text. A right-hand region as full
 *  as the left one is a layout, not furniture, so it is left alone. */
const SIDE_MAX_SHARE = 0.5;
/** Rows that must agree on where the panel starts before it is one. */
const COLUMN_MIN_ROWS = 3;
/** Below this width there is no room for two columns. */
const COLUMN_MIN_WIDTH = 80;

/** Column at which a side panel begins, or -1 if the screen is one column.
 *
 *  opencode draws its readouts (session name, token count, cost, LSP state,
 *  cwd, branch) in a right-hand column on the same rows as the conversation.
 *  Read as text those rows interleave with what was said - "1% used" glued to
 *  the front of a sentence, a bare cwd path as its own bubble, a timestamp
 *  landing inside the echo of what you typed.
 *
 *  Found geometrically rather than by matching any of those strings: a panel
 *  is a set of rows whose last text segment all STARTS at the same column,
 *  far enough across, with a gutter in front of it. Keying on the starts
 *  rather than on which columns are empty matters, because we flush every
 *  60 ms and so catch half-drawn frames: one line painted before the panel was
 *  repainted over its columns is enough to hide an "all rows blank" gutter,
 *  and the scan then settles further right and leaves the panel's first entry
 *  in the conversation.
 *
 *  The text either side then has to look like panel and body rather than two
 *  halves of a layout. A tool that changes its readouts keeps working; one
 *  that does not draw a panel is untouched. */
function sideColumnCut(body: string[]): number {
  const width = body.reduce((n, r) => Math.max(n, r.length), 0);
  if (width < COLUMN_MIN_WIDTH) return -1;
  const rows = body.filter((r) => r.trim() !== "");
  if (rows.length < 4) return -1;

  const from = Math.floor(width * COLUMN_MIN_SHARE);
  const votes = new Map<number, number>();
  for (const row of rows) {
    let last = -1;
    for (let i = from; i < row.length; i++) {
      if (row[i] === " " || (i > 0 && row[i - 1] !== " ")) continue;
      if (i < COLUMN_GAP) continue;
      let gutter = true;
      for (let k = i - COLUMN_GAP; k < i; k++) {
        if (row[k] !== " ") gutter = false;
      }
      if (gutter) last = i;
    }
    if (last >= 0) votes.set(last, (votes.get(last) ?? 0) + 1);
  }

  let cut = -1;
  let best = 0;
  for (const [column, count] of votes) {
    if (count > best) {
      best = count;
      cut = column;
    }
  }
  if (cut < 0 || best < COLUMN_MIN_ROWS) return -1;

  let left = 0;
  let right = 0;
  for (const r of rows) {
    left += r.slice(0, cut).trim().length;
    right += r.slice(cut).trim().length;
  }
  if (left === 0 || right === 0 || right > left * SIDE_MAX_SHARE) return -1;
  return cut;
}

/** Keep only what is left of the side panel. A cut of -1 leaves rows alone. */
function dropSideColumn(rows: string[], cut: number): string[] {
  if (cut < 0) return rows;
  return rows.map((r) => r.slice(0, cut).replace(/\s+$/, ""));
}

/** A status rule: a line that is essentially a run of frame characters — the
 *  divider both tools draw above their footer. A single gutter marker is
 *  decoration, not a rule. */
function isRule(raw: string): boolean {
  const nonSpace = raw.replace(/\s/g, "").length;
  if (nonSpace < 8) return false;
  const chrome = (raw.match(CHROME) || []).length;
  return chrome / nonSpace >= 0.5;
}

/** Whether a footer row is the draft input box (a bare path or key hints)
 *  rather than the tab strip. */
function isInputBox(raw: string): boolean {
  const text = stripChrome(raw);
  if (HINT.test(text)) return true;
  if (PATH_LIKE.test(text)) return true;
  // A tilde home path is also a cwd display ("~\AppData\…\oc-scratch:master").
  if (/^~\S*[\\/]/.test(text)) return true;
  return false;
}

/** Drop the status bar / input box a TUI pins to the bottom of the screen.
 *
 *  Position-based: the footer is everything from the last status rule down —
 *  the tab strip, the input box and the status readouts all live below it.
 *  Walking up by "does this line look like furniture" alone breaks when the
 *  strip row (Claude's subagent tab: "  ◯ Explore Search repo for README
 *  content  0s") does not read as furniture, which leaks the whole status
 *  area into the conversation as output.
 *
 *  A rule only anchors the footer when it sits in the bottom of the screen;
 *  a dialog border or a divider mid-screen is content, not a status rule.
 *  Claude draws a second rule above its input strip, so the anchor is the
 *  bottom-most rule in the window. */
function splitFooter(
  lines: string[],
  floor = 0,
): { body: string[]; footer: string[] } {
  const from = Math.max(floor, lines.length - FOOTER_WINDOW);
  for (let i = lines.length - 1; i >= from; i--) {
    if (isRule(lines[i])) {
      return { body: lines.slice(0, i), footer: lines.slice(i) };
    }
  }
  // No rule drawn: fall back to the furniture walk.
  let end = lines.length;
  while (end > floor && isFurniture(lines[end - 1])) end--;
  return { body: lines.slice(0, end), footer: lines.slice(end) };
}
/** `floor` is where a menu ended: a rule ABOVE the options is part of the
 *  dialog, not the footer's top edge. Claude draws the diff it is asking about
 *  between two dashed rules, and the footer walk anchored on the lower of them
 *  and swallowed the whole prompt.
 *
 *  Status bars are only a few rows tall; a rule higher than the window is a
 *  dialog border or a divider inside the conversation, not the footer. */
const FOOTER_WINDOW = 12;
/** A status fragment is short; anything longer than this is a sentence that
 *  leaked in from a scrambled frame, not a status readout. */
const STATUS_PIECE_MAX = 50;

/** The footer as one short label: model, usage, whatever the program pins
 *  down there. Key hints are dropped — they are for the desktop keyboard and
 *  mean nothing on a phone. */
function condenseStatus(footer: string[], typed: string[]): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const line of footer) {
    const raw = stripChrome(line);
    const text = collapse(raw);
    if (text === "" || HINT.test(text)) continue;
    // Model / usage readouts (a WIDGET) are not status either; they would
    // otherwise pad the label with "Opus 5 claude-fresh 强度:high …".
    if (isWidget(text)) continue;
    // The input box lives down here too, and what is being typed into it is
    // not status — it is a draft message.
    if (typed.some((t) => t.length >= 2 && text.includes(collapse(t))))
      continue;
    // A status bar is redrawn in pieces, so the same fragment shows up on
    // several rows; keep the first of each. Columns are separated by a run of
    // spaces as often as by a bullet, so split on both.
    for (const piece of raw.split(/\s+·\s+|\s{2,}/)) {
      const key = collapse(piece);
      if (key === "") continue;
      // A status fragment is short ("Opus 5", "5h已用 8%", "main"); a long
      // run is a sentence that leaked in from a scrambled mid-repaint frame,
      // not something pinned to the status bar.
      if (key.length > STATUS_PIECE_MAX) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(key);
    }
  }
  if (parts.length === 0) return null;
  const text = parts.join(" · ");
  return text.length > 110 ? `${text.slice(0, 110)}…` : text;
}

/** Spinner glyphs and bullets these tools put in front of a working line.
 *  Braille spinners are already gone by here - `stripChrome` covers them. */
const SPINNER_LEAD = /^[\s*·•‧✻✽✢✳✦✧⏺●○◐◓◑◒⠿-]+/u;
/** A working line names what it is doing and trails off: "Thinking…",
 *  "Herding bytes...", "正在思考…". The ellipsis is the giveaway, and both
 *  tools use it; without one, a line is prose. */
const WORKING = /^(\p{L}[\p{L}\s]{0,30}?)\s*(?:…|\.{2,})/u;
/** Elapsed time as these tools print it: "1m 5s" or "12s". */
const ELAPSED_MS = /(\d+)\s*m\s*(\d+)\s*s/;
const ELAPSED_S = /(?:^|[^\d.])(\d+)\s*s\b/;
/** A working line is short. Anything longer is a sentence that happens to
 *  trail off, which is prose and belongs in a bubble. */
const WORKING_MAX = 80;
/** How far up from the input box the working line can sit. It is drawn right
 *  above the composer; searching the whole screen would let any line of prose
 *  ending in an ellipsis claim to be a spinner. */
const WORKING_WINDOW = 4;

/** Pull the program's working line out of the screen.
 *
 *  Generic on purpose: a spinner glyph is optional and every tool picks its
 *  own, but "a short line, near the input box, that trails off in an ellipsis,
 *  often with an elapsed time" is what all of them draw. The verb itself is
 *  never matched against a list - Claude cycles through dozens of them
 *  ("Musing", "Pondering", "Herding") and adding a new one must not break
 *  this.
 *
 *  Returns the screen with that row removed from whichever half held it. */
function splitWorking(
  body: string[],
  footer: string[],
): { thinking: Thinking | null; body: string[]; footer: string[] } {
  // The footer is searched first, and from the bottom: when the status rule is
  // drawn above the spinner, the spinner is the footer's own bottom row.
  for (let i = footer.length - 1; i >= 0; i--) {
    const hit = readWorking(footer[i]);
    if (!hit) continue;
    return {
      thinking: hit,
      body,
      footer: [...footer.slice(0, i), ...footer.slice(i + 1)],
    };
  }
  const from = Math.max(0, body.length - WORKING_WINDOW);
  for (let i = body.length - 1; i >= from; i--) {
    const hit = readWorking(body[i]);
    if (!hit) continue;
    return {
      thinking: hit,
      body: [...body.slice(0, i), ...body.slice(i + 1)],
      footer,
    };
  }
  return { thinking: null, body, footer };
}

/** The counters these tools print alongside the verb: an elapsed time in
 *  parentheses, a token tally, the interrupt hint. */
const WORKING_METRIC =
  /\(\s*(?:\d+\s*m\s*)?\d+\s*s(?![a-z])|[\d,.]+\s*k?\s*tokens?(?![a-z])|esc to interrupt/i;

/** A line that is unambiguously the program's working status, safe to drop
 *  wherever it appears on the screen.
 *
 *  `readWorking` is deliberately loose and is only trusted next to the input
 *  box, because "a short line trailing off in an ellipsis" also describes
 *  prose. Requiring one of the counters as well removes that ambiguity: no
 *  tool writes "Thinking… (12s · 1.2k tokens)" as something anyone said.
 *
 *  It exists because the rows that scroll off an alt screen go straight into
 *  the history with no working-line pass at all, so every repaint of the
 *  spinner became its own permanent bubble. The elapsed time and the token
 *  count belong to the indicator above the composer, which already shows
 *  them - in the thread they are the same state said a hundred times over. */
function isWorkingLine(raw: string): boolean {
  if (readWorking(raw) === null) return false;
  return WORKING_METRIC.test(stripChrome(raw));
}

function readWorking(raw: string): Thinking | null {
  const text = stripChrome(raw).replace(SPINNER_LEAD, "").trim();
  if (text === "" || text.length > WORKING_MAX) return null;
  const m =
    WORKING.exec(text) ?? /^(Working|Thinking|Reconnecting)\s*\(/i.exec(text);
  if (!m) return null;
  const label = m[1].trim();
  if (label === "" || isWidget(label)) return null;
  const ms = ELAPSED_MS.exec(text);
  if (ms) {
    return { label, seconds: Number(ms[1]) * 60 + Number(ms[2]) };
  }
  const sec = ELAPSED_S.exec(text);
  return { label, seconds: sec ? Number(sec[1]) : null };
}

/** Modes these tools pin to the status bar. The mode changes what typing into
 *  the session does, so it is the one status fragment shown on its own rather
 *  than folded into the condensed label.
 *
 *  Claude phrases it as "<something> mode on" / "auto-accept edits on";
 *  opencode puts the mode first on its model line ("Build · <model>"). */
const MODE_PHRASE =
  /\b((?:auto-?accept\s+edits|bypass\s+permissions|accept\s+edits|[\p{L}]+\s+mode)(?:\s+on)?)\b/iu;
const MODE_LEAD = /^(Build|Plan|Chat)\s*·/i;
/** How far above the status rule the mode line can sit. */
const MODE_WINDOW = 6;

/** The mode, and which footer row carried it.
 *
 *  The row matters as much as the value: the footer's bottom row is otherwise
 *  taken as the subagent tab strip, purely by position. When no subagent is
 *  running the mode line IS that bottom row, so it was read twice - once as
 *  the mode label under the composer, once as a chip above the thread. */
function detectModeAt(
  footer: string[],
  body: string[],
): { mode: string | null; footerRow: number } {
  const read = (raw: string): string | null => {
    const text = collapse(stripChrome(raw));
    if (text === "") return null;
    const lead = MODE_LEAD.exec(text);
    if (lead) return lead[1];
    const phrase = MODE_PHRASE.exec(text);
    return phrase ? phrase[1].trim() : null;
  };
  for (let i = footer.length - 1; i >= 0; i--) {
    const hit = read(footer[i]);
    if (hit) return { mode: hit, footerRow: i };
  }
  // opencode prints its mode on the input box's own row, which sits ABOVE the
  // status rule and so counts as body. Only the rows next to the box are
  // searched: the same line appears per-message further up the transcript, and
  // an old one must not outvote the current setting.
  const from = Math.max(0, body.length - MODE_WINDOW);
  for (let i = body.length - 1; i >= from; i--) {
    const hit = read(body[i]);
    if (hit) return { mode: hit, footerRow: -1 };
  }
  return { mode: null, footerRow: -1 };
}

/** A numbered menu row: "❯ 1. Yes", "  2. No, and tell Claude why". */
const CHOICE_ROW = /^([>❯›]?)\s*(\d{1,2})[.)]\s+(\S.*)$/;
/** How far up from the input box a menu can start. Both tools draw the
 *  question and its options directly above the composer. */
const CHOICE_WINDOW = 24;
/** Rows an option may take before the next one starts.
 *
 *  Generous on purpose: an option's description can wrap to several lines, and
 *  a widget can draw a rule through its own list. Being too tight is what made
 *  a real question widget parse as "not a menu" - the run broke at the first
 *  description, which left the tail of the list and none of the selection
 *  marker. The keys-count-upward and one-row-is-marked rules are what keep a
 *  prose list from joining across a gap this wide; the gap itself does not
 *  have to be the guard. */
const CHOICE_ROW_GAP = 6;
/** How much of the screen above a menu counts as the question it is asking.
 *  Enough for a prompt plus the diff or command under it; not the whole
 *  session. */
const PROMPT_WINDOW = 12;
/** Corners. A run of frame characters WITH one is a box edge; without one it
 *  is a divider. Both tools open a dialog with a plain divider, and both draw
 *  boxes elsewhere on screen, so the difference is what tells a widget's top
 *  edge from the bottom of the welcome banner. */
const BOX_CORNER = /[┌-┏┐-┓└-┗┘-┛├-┿╔-╬╭-╰]/;

/** Where the question a menu is asking starts.
 *
 *  A dialog opens with a divider, so the first one above the menu is its top
 *  edge and everything under it belongs to the question - which is what keeps
 *  Claude's diff ("1 hi", between two more dividers) with the prompt that asks
 *  about it. Box edges are skipped: the welcome banner's bottom is a run of
 *  frame characters too, and anchoring on it dragged the whole banner in. */
function promptFrom(screen: string[], menuStart: number): number {
  const from = Math.max(0, menuStart - PROMPT_WINDOW);
  for (let i = from; i < menuStart; i++) {
    if (isRule(screen[i]) && !BOX_CORNER.test(screen[i])) return i + 1;
  }
  return from;
}

/** Split a numbered menu off the screen.
 *
 *  Two discriminators, because numbering alone is not one: an agent writing
 *  "1. do this / 2. do that" in prose is common and must stay prose.
 *   - every menu these tools draw marks the current row with `❯` or `>`;
 *   - a menu numbers upward, so a run whose keys are not increasing is two
 *     things that happen to sit next to each other, not one menu.
 *
 *  Scanned upward from the input box over the WHOLE screen, before the footer
 *  is split off. The menu is the one thing here the agent transcript cannot
 *  know, so it must not depend on the rest of the parse working: Claude draws
 *  the diff it is asking about between two dashed rules, the footer walk
 *  anchored on the lower one, and the entire prompt vanished into the status
 *  area.
 *
 *  The question above the options stays in the body: it is what the program is
 *  asking, and it belongs in the thread. */
function findChoices(screen: string[]): ChoiceMenu | null {
  const from = Math.max(0, screen.length - CHOICE_WINDOW);

  // Pass one: every numbered row in the window, with where it sat.
  const hits: { at: number; choice: Choice }[] = [];
  for (let i = from; i < screen.length; i++) {
    const m = CHOICE_ROW.exec(stripChrome(screen[i]));
    if (!m) continue;
    hits.push({
      at: i,
      choice: { key: m[2], label: m[3].trim(), selected: m[1] !== "" },
    });
  }
  if (hits.length < 2) return null;

  // Pass two: the lowest run whose keys count upward and whose rows sit close
  // enough to be one list. Adjacency cannot be row-by-row: Claude's question
  // widget gives every option a description line, and draws a rule THROUGH its
  // own list. Scanning row by row stopped at the first description, which left
  // the tail of the list and none of the selection marker, so a real menu came
  // back as "not a menu".
  let best: { at: number; choice: Choice }[] = [];
  let run: { at: number; choice: Choice }[] = [];
  for (const hit of hits) {
    const prev = run[run.length - 1];
    const continues =
      prev !== undefined &&
      Number(hit.choice.key) > Number(prev.choice.key) &&
      hit.at - prev.at <= CHOICE_ROW_GAP;
    run = continues ? [...run, hit] : [hit];
    // `>=` so the LOWEST run wins a tie: prose numbered higher up must not
    // outrank the menu the program is actually waiting on.
    if (run.length >= best.length) best = run;
  }
  if (best.length < 2 || !best.some((h) => h.choice.selected)) return null;

  // Whatever sits between one option and the next describes it. On a phone
  // that matters: "选项 A" alone is not a choice anyone can make.
  let end = best[best.length - 1].at;
  const choices = best.map((hit, i) => {
    const following = best[i + 1];
    const until =
      following?.at ?? Math.min(screen.length, hit.at + CHOICE_ROW_GAP);
    const detail: string[] = [];
    for (let r = hit.at + 1; r < until; r++) {
      const text = stripChrome(screen[r]).trim();
      if (
        !following &&
        (text === "" ||
          isFurniture(screen[r]) ||
          isInputBox(screen[r]) ||
          isWorkingLine(screen[r]))
      )
        break;
      if (text !== "") detail.push(text);
      if (!following) end = r;
    }
    return detail.length > 0
      ? { ...hit.choice, detail: detail.join(" ") }
      : hit.choice;
  });

  return {
    choices,
    start: best[0].at,
    end,
  };
}

export function hasAgentChoices(screen: string[]): boolean {
  return findChoices(screen) !== null;
}

/** A splash screen: a logo and a version line, and essentially nothing else.
 *
 *  Judged on how much text there is, not on the ratio of drawing to text. A
 *  ratio flips either side of its threshold as soon as one long divider rule
 *  is drawn — which is why the same screen kept appearing and disappearing —
 *  whereas "has this screen got a conversation on it yet" is a stable question:
 *  a splash has a few dozen characters of text, a conversation has hundreds. */
function isBanner(body: string[]): boolean {
  let chrome = 0;
  let letters = 0;
  for (const line of body) {
    chrome += (line.match(CHROME) || []).length;
    letters += (line.match(/[\p{L}\p{N}]/gu) || []).length;
  }
  if (letters >= BANNER_MAX_LETTERS) return false;
  return chrome > letters / 2;
}
/** Above this much text, a screen is a conversation whatever else is on it. */
const BANNER_MAX_LETTERS = 120;

/** Whether a painted line is the message we sent.
 *
 *  A short message has to match exactly: looking for "1" as a substring would
 *  hit a token count or a timing. Anything long enough to be distinctive can
 *  match loosely, since these tools wrap and decorate what you typed. */
export function sameMessage(painted: string, sent: string): boolean {
  if (sent.length >= 10) return painted.includes(sent);
  if (sent.length >= 4) {
    // A short send ("claude", "cd x") can appear inside the tool's own UI: a
    // cwd path "...\opencode\claude-fresh", "Run claude doctor", a model line
    // "Opus 5 claude-fresh". Only claim the line when it is essentially the
    // message, not a mention of it.
    return painted.length <= sent.length + 12 && painted.includes(sent);
  }
  return painted === sent;
}

/** Re-label the blocks that are the program echoing back what we sent.
 *
 *  `>` is the only role marker that is at all common, and opencode does not
 *  use one — it renders your message as an ordinary line under a generated
 *  title. But we know exactly what we sent, so a line matching it is yours,
 *  whatever the program chose to draw around it. That is more reliable than
 *  any marker, and it is what makes a short message like "1" come out as a
 *  bubble on the right instead of being mistaken for output. */
function markEchoes(blocks: Block[], sent: string[]): Block[] {
  if (sent.length === 0) return blocks;
  const wants = sent.map(collapse).filter((s) => s !== "");
  const out: Block[] = [];
  for (const block of blocks) {
    if (block.role === "user") {
      out.push(block);
      continue;
    }
    const runs: Block[] = [];
    let run: Block | null = null;
    for (const line of block.lines) {
      const isMine = wants.some((w) => sameMessage(collapse(line), w));
      const role: Block["role"] = isMine ? "user" : "out";
      if (!run || run.role !== role) {
        run = { role, lines: [] };
        runs.push(run);
      }
      run.lines.push(line);
    }
    out.push(...runs);
  }
  return out;
}

/** Which tool just took over the screen, if we recognise it. Used only to
 *  label the moment it started — everything after that is read generically. */
export function detectProgram(screen: string[]): string | null {
  const text = screen.join("\n");
  if (/claude code|anthropic|welcome back|opus\s*\d/i.test(text))
    return "Claude Code";
  if (/(?:^|[^\w\\/])codex(?![\w\\/-])/i.test(text)) return "Codex";
  // "opencode" is also a folder name in a cwd path (and Claude's footer shows
  // the working directory), so only a bare word - the logo, the save screen,
  // the "OpenCode Go" footer - names the program.
  if (/(?:^|[^\w\\/])opencode(?![\w\\/-])/i.test(text)) return "OpenCode";
  return null;
}

/** Whether a line is the program drawing rather than the program talking. */
function isFurniture(raw: string): boolean {
  const text = stripChrome(raw);
  if (text.trim() === "") return true;
  if (HINT.test(text)) return true;
  // Note this tests the RAW line, not the stripped one: stripChrome also trims
  // indentation, so comparing the two would call every indented line furniture
  // and swallow the whole screen.
  if (CHROME_LEAD.test(raw)) return true;
  // An input box shows the working directory; a status bar pins the model /
  // usage readouts. Both are furniture, but they must not pull a `┃`-guttered
  // message above them into the status label with them.
  if (PATH_LIKE.test(text)) return true;
  if (isWidget(text)) return true;
  const nonSpace = raw.replace(/\s/g, "").length;
  if (nonSpace === 0) return true;
  const chrome = (raw.match(CHROME) || []).length;
  return chrome / nonSpace >= CHROME_SHARE;
}
