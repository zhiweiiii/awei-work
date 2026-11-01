export type SessionInfo = {
  id: number;
  cwd: string | null;
  title: string | null;
  active: boolean;
  live: boolean;
  space: string | null;
  cols?: number;
  rows?: number;
};

export type SpaceInfo = { id: string; name: string };

/** One turn of an agent conversation, read from the agent's OWN transcript
 *  (`~/.claude/projects/**.jsonl`, `~/.codex/sessions/**.jsonl`, opencode's SQLite) rather than parsed off
 *  its screen. See the Rust `transcript` module. */
/** One piece of a turn, in the order the agent produced it. */
export type TranscriptPart =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      name: string;
      /** What it was called on: the command, the path, the pattern. */
      subject?: string;
      /** What it printed, already clipped server-side. */
      output?: string;
      /** Lines the clip dropped. */
      elided?: number;
      failed?: boolean;
    };

export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  at: number;
  /** The message for a user turn; the prose flattened out of `parts` for an
   *  agent one. Compared against, not rendered — `parts` is what is drawn. */
  text: string;
  reasoning?: string;
  parts: TranscriptPart[];
};

export type TranscriptMsg = {
  type: "transcript";
  source: string;
  session_id: string;
  title?: string;
  mode?: string;
  model?: string;
  messages: TranscriptMessage[];
  working?: { since: number };
  revision: number;
};

/** A command queued to run later. The clock is server-side (see
 *  src-tauri/src/modules/schedule.rs): a phone that locked its screen, or a
 *  tab that was closed, cannot be the thing counting down. */
export type ScheduledJob = {
  id: number;
  target?: "terminal" | "codex" | "claude" | "pet";
  daily_time?: string | null;
  running?: boolean;
  finished?: boolean;
  paused?: boolean;
  leaf_id: number;
  command: string;
  /** Epoch milliseconds. */
  fire_at: number;
  created_at: number;
};

export type SchedulesMsg = {
  type: "schedules";
  jobs: ScheduledJob[];
};

export type SessionsMsg = {
  type: "sessions";
  sessions: SessionInfo[];
  spaces: SpaceInfo[];
};

/** Any text message the server can push. Fields are optional because which
 *  ones are present depends on the `type` (the switch narrows by behaviour,
 *  not by a declared union). */
export type ServerMsg = {
  type?: string;
  id?: number;
  code?: number;
  cols?: number;
  rows?: number;
  alt?: boolean;
  seed?: boolean;
  message?: string;
  requestId?: string;
  accepted?: boolean;
  agent?: string | null;
  sessions?: SessionInfo[];
  spaces?: SpaceInfo[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function optionalText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

export function validGrid(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 2 &&
    rows >= 2 &&
    cols <= 2048 &&
    rows <= 1024 &&
    cols * rows <= 262144
  );
}
export function isSessionsMsg(value: unknown): value is SessionsMsg {
  if (
    !record(value) ||
    value.type !== "sessions" ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.spaces)
  )
    return false;
  return (
    value.sessions.length <= 10000 &&
    value.spaces.length <= 10000 &&
    value.sessions.every(
      (s) =>
        record(s) &&
        finite(s.id) &&
        Number.isSafeInteger(s.id) &&
        s.id > 0 &&
        optionalText(s.cwd) &&
        optionalText(s.title) &&
        optionalText(s.space) &&
        typeof s.active === "boolean" &&
        typeof s.live === "boolean",
    ) &&
    value.spaces.every(
      (s) =>
        record(s) && typeof s.id === "string" && typeof s.name === "string",
    )
  );
}
export function isTranscriptMsg(value: unknown): value is TranscriptMsg {
  if (
    !record(value) ||
    value.type !== "transcript" ||
    typeof value.source !== "string" ||
    typeof value.session_id !== "string" ||
    !finite(value.revision) ||
    !Array.isArray(value.messages) ||
    value.messages.length > 2000 ||
    !optionalText(value.title) ||
    !optionalText(value.mode) ||
    !optionalText(value.model)
  )
    return false;
  if (
    value.working !== undefined &&
    value.working !== null &&
    (!record(value.working) || !finite(value.working.since))
  )
    return false;
  let parts = 0;
  return value.messages.every((m) => {
    if (
      !record(m) ||
      typeof m.id !== "string" ||
      (m.role !== "user" && m.role !== "assistant") ||
      !finite(m.at) ||
      typeof m.text !== "string" ||
      !optionalText(m.reasoning) ||
      !Array.isArray(m.parts)
    )
      return false;
    parts += m.parts.length;
    if (parts > 20000) return false;
    return m.parts.every(
      (p) =>
        record(p) &&
        (p.kind === "text"
          ? typeof p.text === "string"
          : p.kind === "tool" &&
            typeof p.name === "string" &&
            optionalText(p.subject) &&
            optionalText(p.output) &&
            (p.elided === undefined || (finite(p.elided) && p.elided >= 0)) &&
            (p.failed === undefined || typeof p.failed === "boolean")),
    );
  });
}
export function isSchedulesMsg(value: unknown): value is SchedulesMsg {
  return (
    record(value) &&
    value.type === "schedules" &&
    Array.isArray(value.jobs) &&
    value.jobs.length <= 10000 &&
    value.jobs.every(
      (j) =>
        record(j) &&
        finite(j.id) &&
        finite(j.leaf_id) &&
        typeof j.command === "string" &&
        finite(j.fire_at) &&
        finite(j.created_at) &&
        (j.target === undefined ||
          j.target === "terminal" ||
          j.target === "codex" ||
          j.target === "claude" ||
          j.target === "pet") &&
        optionalText(j.daily_time) &&
        [j.running, j.finished, j.paused].every(
          (v) => v === undefined || typeof v === "boolean",
        ),
    )
  );
}
