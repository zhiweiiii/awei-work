import { type Notice, type PetSession, sessionKey } from "./agents";

export type ShownNotice = { notice: Notice; serial: number; until: number };
const priority = (notice: Notice) =>
  notice.kind === "attention"
    ? 3
    : notice.kind === "finished" || notice.failed
      ? 2
      : 1;

export class NoticeQueue {
  shown: ShownNotice | null = null;
  private observed = new Map<string, string>();
  private pending = new Map<string, { notice: Notice; at: number }>();
  private lastProgress = new Map<string, number>();
  private serial = 0;
  private pausedAt: number | null = null;

  reset() {
    this.shown = null;
    this.observed.clear();
    this.pending.clear();
    this.lastProgress.clear();
    this.pausedAt = null;
  }

  setPaused(paused: boolean, now: number) {
    if (paused) this.pausedAt ??= now;
    else if (this.pausedAt !== null) {
      if (this.shown)
        this.shown = {
          ...this.shown,
          until: this.shown.until + now - this.pausedAt,
        };
      this.pausedAt = null;
      this.advance(now);
    }
  }

  sync(notices: Notice[], agents: PetSession[], now: number) {
    const live = new Map(
      agents
        .filter(
          (agent) => !agent.watched && agent.agent && agent.runId !== null,
        )
        .map((agent) => [sessionKey(agent), agent]),
    );
    const current = new Map(
      notices
        .filter((notice) => live.has(notice.key))
        .map((notice) => [notice.key, notice]),
    );
    const existing = new Set(agents.map(sessionKey));
    for (const key of this.observed.keys())
      if (!current.has(key)) this.observed.delete(key);
    for (const key of this.pending.keys())
      if (!current.has(key)) this.pending.delete(key);
    for (const key of this.lastProgress.keys())
      if (!existing.has(key)) this.lastProgress.delete(key);
    if (this.shown && !current.has(this.shown.notice.key)) this.shown = null;
    if (this.shown) {
      const latest = current.get(this.shown.notice.key);
      if (
        latest &&
        ((latest.kind !== this.shown.notice.kind &&
          !(priority(latest) === 1 && priority(this.shown.notice) === 1)) ||
          (latest.turnId &&
            this.shown.notice.turnId &&
            latest.turnId !== this.shown.notice.turnId))
      )
        this.shown = null;
    }
    for (const notice of current.values()) {
      if (this.observed.get(notice.key) === notice.id) {
        if (this.shown?.notice.id === notice.id && this.shown.notice !== notice)
          this.shown = { ...this.shown, notice };
        const pending = this.pending.get(notice.key);
        if (pending?.notice.id === notice.id) pending.notice = notice;
        continue;
      }
      this.observed.set(notice.key, notice.id);
      if (
        this.shown?.notice.key === notice.key &&
        priority(this.shown.notice) === 1 &&
        priority(notice) === 1
      ) {
        this.shown = { ...this.shown, notice };
        this.pending.delete(notice.key);
        continue;
      }
      this.pending.set(notice.key, { notice, at: now });
      if (
        this.shown &&
        priority(this.shown.notice) === 1 &&
        priority(notice) > 1 &&
        this.pausedAt === null
      )
        this.shown = null;
    }
    while (this.pending.size > 16) {
      const lowest = [...this.pending.values()].sort(
        (a, b) => priority(a.notice) - priority(b.notice) || a.at - b.at,
      )[0];
      if (lowest) this.pending.delete(lowest.notice.key);
    }
    this.advance(now);
  }

  advance(now: number) {
    if (
      this.shown &&
      this.shown.notice.expiresAt !== null &&
      now >= this.shown.notice.expiresAt
    )
      this.shown = null;
    if (this.pausedAt !== null) return;
    if (this.shown && this.shown.until <= now) this.shown = null;
    if (this.shown) return;
    const ready = [...this.pending.values()]
      .filter(({ notice, at }) => {
        if (
          (notice.expiresAt !== null && now >= notice.expiresAt) ||
          (priority(notice) === 1 && now - at > 30_000)
        ) {
          this.pending.delete(notice.key);
          return false;
        }
        return (
          priority(notice) > 1 ||
          now >= (this.lastProgress.get(notice.key) ?? -Infinity) + 15_000
        );
      })
      .sort((a, b) => priority(b.notice) - priority(a.notice) || a.at - b.at);
    const next = ready[0];
    if (!next) return;
    this.pending.delete(next.notice.key);
    if (priority(next.notice) === 1)
      this.lastProgress.set(next.notice.key, now);
    this.shown = {
      notice: next.notice,
      serial: ++this.serial,
      until: now + 8000,
    };
  }

  dismiss(now: number) {
    this.pausedAt = null;
    this.shown = null;
    this.advance(now);
  }

  dismissAll() {
    this.pausedAt = null;
    this.shown = null;
    this.pending.clear();
  }

  deadline(): number | null {
    if (this.shown) {
      const expiresAt = this.shown.notice.expiresAt ?? Infinity;
      const until = this.pausedAt === null ? this.shown.until : Infinity;
      return Number.isFinite(Math.min(until, expiresAt))
        ? Math.min(until, expiresAt)
        : null;
    }
    if (this.pausedAt !== null) return null;
    const times = [...this.pending.values()].map(({ notice }) =>
      priority(notice) > 1
        ? 0
        : (this.lastProgress.get(notice.key) ?? -Infinity) + 15_000,
    );
    return times.length ? Math.min(...times) : null;
  }
}
