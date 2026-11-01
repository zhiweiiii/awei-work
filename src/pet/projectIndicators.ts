import { type PetSession, sessionKey } from "./agents";

export type ProjectIndicator = {
  key: string;
  session: PetSession;
  status: "working" | "attention" | "finished";
};

const priority = { attention: 3, working: 2, finished: 1 };

export function projectIndicators(
  sessions: PetSession[],
  unread: ReadonlySet<string>,
): ProjectIndicator[] {
  const projects = new Map<string, ProjectIndicator>();
  for (const session of sessions) {
    const status =
      session.awaitingChoice ||
      session.phase === "attention" ||
      (session.phase === "working" && session.activity?.failed)
        ? "attention"
        : session.phase === "working"
          ? "working"
          : session.phase === "finished" && unread.has(sessionKey(session))
            ? "finished"
            : null;
    if (!session.agent || session.runId === null || !status) continue;
    const key =
      session.projectId == null
        ? `leaf:${session.leafId}`
        : `project:${session.projectId}`;
    const existing = projects.get(key);
    const score = priority[status] + Number(!!session.awaitingChoice);
    const existingScore = existing
      ? priority[existing.status] + Number(!!existing.session.awaitingChoice)
      : 0;
    if (
      !existing ||
      score > existingScore ||
      (score === existingScore && session.active)
    )
      projects.set(key, { key, session, status });
  }
  return [...projects.values()];
}

export function indicatorLabel(indicator: ProjectIndicator): string {
  switch (indicator.status) {
    case "working":
      return "正在处理";
    case "attention":
      return indicator.session.awaitingChoice
        ? "等待选择"
        : indicator.session.phase === "attention"
          ? "需要确认"
          : "步骤出错";
    case "finished":
      return "完成未读";
  }
}
