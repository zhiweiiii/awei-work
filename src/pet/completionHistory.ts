import {
  completionDeadline,
  type Notice,
  type PetSession,
  sessionKey,
} from "./agents";

export class CompletionHistory {
  private turns = new Map<string, Set<string>>();
  private previous = new Map<string, PetSession>();
  private unread = new Set<string>();

  unreadKeys(): string[] {
    return [...this.unread];
  }

  filter(
    notices: Notice[],
    sessions: PetSession[],
    now = performance.now(),
  ): Notice[] {
    const live = new Set(sessions.map(sessionKey));
    for (const key of this.turns.keys())
      if (!live.has(key)) this.turns.delete(key);
    for (const key of this.unread) if (!live.has(key)) this.unread.delete(key);
    const fresh = notices.filter(
      (notice) =>
        notice.kind !== "finished" ||
        !notice.turnId ||
        !this.turns.get(notice.key)?.has(notice.turnId),
    );
    for (const session of sessions) {
      const key = sessionKey(session);
      const was = this.previous.get(key);
      const turn = session.activity?.turnId;
      if (session.watched || session.phase === "idle" || !session.agent)
        this.unread.delete(key);
      else if (
        session.phase === "finished" &&
        was &&
        ((was.phase !== "finished" &&
          (was.phase === "working" ||
            was.phase === "attention" ||
            completionDeadline(session, now) > now)) ||
          (turn && was.activity?.turnId && turn !== was.activity.turnId)) &&
        (!turn || !this.turns.get(key)?.has(turn))
      )
        this.unread.add(key);
      if (session.phase !== "finished" || !turn) continue;
      let turns = this.turns.get(key);
      if (!turns) {
        turns = new Set();
        this.turns.set(key, turns);
      }
      turns.add(turn);
      if (turns.size > 64) {
        const oldest = turns.values().next().value;
        if (oldest !== undefined) turns.delete(oldest);
      }
    }
    this.previous = new Map(
      sessions.map((session) => [sessionKey(session), session]),
    );
    return fresh;
  }
}
