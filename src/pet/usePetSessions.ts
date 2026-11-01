import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  completionDeadline,
  type Notice,
  noticesBetween,
  type PetSession,
  sessionKey,
} from "./agents";
import { CompletionHistory } from "./completionHistory";

export function usePetSessions(visible: boolean, epoch: number) {
  const [sessions, setSessions] = useState<PetSession[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [unread, setUnread] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [readyEpoch, setReadyEpoch] = useState<number | null>(null);
  const [contextPending, setContextPending] = useState(true);
  const refreshRef = useRef<() => void>(() => {});
  const previousRef = useRef<PetSession[] | null>(null);
  const completions = useRef(new CompletionHistory());

  useEffect(() => {
    if (!visible) return;
    setContextPending(true);
    setNotices([]);
    let alive = true;
    let inflight = false;
    let again = false;
    let timer: number | undefined;
    let debounce: number | undefined;
    let release: (() => void) | undefined;
    let releaseContext: (() => void) | undefined;
    let contextRevision = 0;
    previousRef.current = null;
    const tick = async () => {
      if (!alive) return;
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      const revision = contextRevision;
      window.clearTimeout(timer);
      try {
        const next = await invoke<PetSession[]>("pet_sessions");
        if (!alive || revision !== contextRevision) return;
        const now = performance.now();
        const fresh = completions.current.filter(
          noticesBetween(previousRef.current ?? [], next, now),
          next,
          now,
        );
        setUnread(completions.current.unreadKeys());
        previousRef.current = next;
        setSessions(next);
        setReadyEpoch(epoch);
        setContextPending(false);
        setError(null);
        setNotices((current) => {
          const live = new Map(
            next
              .filter(
                (session) =>
                  !session.watched && session.agent && session.runId !== null,
              )
              .map((session) => [sessionKey(session), session]),
          );
          const merged = new Map(
            current
              .filter((notice) => {
                const session = live.get(notice.key);
                return (
                  session &&
                  (notice.kind === "progress" || notice.kind === "working"
                    ? session.phase === "working"
                    : session.phase === notice.kind)
                );
              })
              .map((n) => [n.key, n]),
          );
          for (const [key, notice] of merged) {
            const session = live.get(key);
            if (!session) continue;
            const activity = session.activity;
            const expiresAt =
              notice.kind === "finished"
                ? Math.min(
                    notice.expiresAt ?? Infinity,
                    completionDeadline(session, now),
                  )
                : notice.expiresAt;
            const update =
              activity &&
              (activity.kind !== "tool" || activity.failed) &&
              (activity.turnId === notice.turnId || !notice.turnId);
            if (
              expiresAt !== notice.expiresAt ||
              (update &&
                (activity.text !== notice.text ||
                  activity.turnId !== notice.turnId))
            ) {
              merged.set(key, {
                ...notice,
                expiresAt,
                text: update ? activity.text : notice.text,
                turnId: update ? activity.turnId : notice.turnId,
                title:
                  update && notice.kind !== "working"
                    ? activity.title
                    : notice.title,
              });
            }
          }
          for (const notice of fresh) {
            const previous = merged.get(notice.key);
            const id =
              (notice.kind === "finished" || notice.kind === "attention") &&
              previous?.kind === notice.kind &&
              (!previous.turnId || previous.turnId === notice.turnId)
                ? previous.id
                : notice.id;
            merged.set(notice.key, { ...notice, id });
          }
          return [...merged.values()];
        });
      } catch {
        if (alive) setError("状态更新失败，已保留上次信息");
      } finally {
        inflight = false;
        if (alive) {
          if (again) {
            again = false;
            void tick();
          } else timer = window.setTimeout(tick, 2000);
        }
      }
    };
    refreshRef.current = () => void tick();
    void tick();
    void listen<boolean | null>("awei-work:pet-context", ({ payload }) => {
      if (!alive) return;
      contextRevision++;
      setContextPending(true);
      if (payload !== null)
        setSessions((current) =>
          current.map((session) => ({
            ...session,
            watched: (session.viewed ?? session.active) && payload,
          })),
        );
      void tick();
    })
      .then((off) => {
        if (alive) releaseContext = off;
        else off();
      })
      .catch(() => {});
    void listen("terax:agent-signal", () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void tick(), 120);
    })
      .then((off) => {
        if (alive) release = off;
        else off();
      })
      .catch(() => {
        // Polling still refreshes states if event subscription is unavailable.
      });
    return () => {
      alive = false;
      refreshRef.current = () => {};
      release?.();
      releaseContext?.();
      window.clearTimeout(timer);
      window.clearTimeout(debounce);
    };
  }, [visible, epoch]);

  const refresh = useCallback(() => refreshRef.current(), []);
  return {
    sessions,
    notices,
    unread,
    ready: visible && readyEpoch === epoch,
    error,
    contextPending,
    refresh,
  };
}
