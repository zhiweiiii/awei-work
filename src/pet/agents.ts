export type AgentPhase = "idle" | "working" | "attention" | "finished";

export type PetSession = {
  leafId: number;
  projectId?: number | null;
  /** Null while the shell is being respawned. Without it there is no
   *  conversation to read, which is shown rather than papered over. */
  ptyId: number | null;
  runId: number | null;
  cwd: string | null;
  title: string | null;
  /** `claude`, `codex`, `opencode`, or null when nothing runs there. */
  agent: string | null;
  /** Null exactly when `agent` is. */
  phase: AgentPhase | null;
  /** Seconds in `phase`: working for this long, or finished this long ago. */
  forSecs: number | null;
  /** The command line the main window is showing, when it is open. */
  active: boolean;
  viewed?: boolean;
  /** Visible project with the main window focused. */
  watched: boolean;
  awaitingChoice?: boolean;
  activity?: {
    id: string;
    turnId: string;
    kind?: "text" | "tool";
    title: string;
    text: string;
    failed: boolean;
  } | null;
};

/** Something an agent did that is worth telling you about. */
export type Notice = {
  leafId: number;
  key: string;
  id: string;
  kind: "working" | "progress" | "finished" | "attention";
  title: string;
  text: string;
  turnId: string;
  failed: boolean;
  expiresAt: number | null;
};

export function sessionKey(session: PetSession): string {
  return `${session.ptyId}:${session.runId}:${session.cwd ?? ""}`;
}

export function phaseLabel(phase: AgentPhase | null): string {
  switch (phase) {
    case "working":
      return "工作中";
    case "attention":
      return "等待确认";
    case "finished":
      return "已完成";
    default:
      return "待命";
  }
}

export function labelOf(session: PetSession): string {
  if (session.title) return session.title;
  const cwd = session.cwd;
  if (!cwd) return `命令行 ${session.leafId}`;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function completionDeadline(session: PetSession, now: number): number {
  const age = session.forSecs;
  return (
    now +
    (age !== null && Number.isFinite(age) && age >= 0 ? 30 - age : 0) * 1000
  );
}

export function noticesBetween(
  previous: PetSession[],
  next: PetSession[],
  now = performance.now(),
): Notice[] {
  const before = new Map(previous.map((s) => [sessionKey(s), s]));
  const notices: Notice[] = [];
  for (const s of next) {
    const key = sessionKey(s);
    if (!s.agent || s.runId === null || s.watched) continue;
    const was = before.get(key);
    const activity = s.activity;
    let kind: Notice["kind"] | null = null;
    if (s.phase === "working" && was) {
      const sameTurn =
        activity?.turnId && activity.turnId === was.activity?.turnId;
      if (
        ((was.phase === "idle" || was.phase === "finished") && !sameTurn) ||
        (was.activity?.turnId &&
          activity?.turnId &&
          was.activity.turnId !== activity.turnId)
      )
        kind = "working";
      else if (
        activity &&
        (activity.id !== was.activity?.id ||
          activity.failed !== was.activity?.failed)
      )
        kind = "progress";
    } else if (s.phase === "attention" && !was) {
      kind = "attention";
    } else if (s.phase === "finished" && was) {
      if (
        completionDeadline(s, now) > now &&
        (was.phase !== "finished" ||
          (was.activity?.turnId &&
            activity?.turnId &&
            was.activity.turnId !== activity.turnId))
      )
        kind = "finished";
    } else if (s.phase === "attention" && was) {
      if (was.phase !== s.phase || activity?.turnId !== was.activity?.turnId)
        kind = s.phase;
    }
    if (
      !kind ||
      (kind === "progress" && activity?.kind === "tool" && !activity.failed)
    )
      continue;
    const turnId = activity?.turnId ?? "";
    const title =
      kind === "attention"
        ? "需要你确认"
        : kind === "finished"
          ? "处理结束"
          : kind === "working"
            ? "开始处理"
            : (activity?.title ?? "正在处理");
    const text =
      activity?.text ??
      (kind === "attention"
        ? "等待你的确认或回复"
        : kind === "finished"
          ? "点击查看本轮结果"
          : "正在处理你的任务");
    notices.push({
      leafId: s.leafId,
      key,
      kind,
      id: `${key}:${kind}:${kind === "progress" ? activity?.id : turnId || now}:${activity?.failed ?? false}`,
      title,
      text,
      turnId,
      failed: activity?.failed ?? false,
      expiresAt: kind === "finished" ? completionDeadline(s, now) : null,
    });
  }
  return notices;
}
