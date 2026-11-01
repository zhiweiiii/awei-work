import { useCallback, useEffect, useRef, useState } from "react";
import { type Notice, type PetSession, sessionKey } from "./agents";
import { NoticeQueue, type ShownNotice } from "./noticeQueue";
import { noticeSentence } from "./noticeText";

type Snapshot = {
  scope: string;
  shown: ShownNotice | null;
  deadline: number | null;
};

export function usePetNotice(
  visible: boolean,
  epoch: number,
  notices: Notice[],
  agents: PetSession[],
  suspended = false,
) {
  const queue = useRef(new NoticeQueue());
  const scope = `${visible}:${epoch}`;
  const queueScope = useRef(scope);
  const [snapshot, setSnapshot] = useState<Snapshot>({
    scope,
    shown: null,
    deadline: null,
  });
  const publish = useCallback((currentScope: string) => {
    const shown = queue.current.shown;
    const deadline = queue.current.deadline();
    setSnapshot((current) =>
      current.scope === currentScope &&
      current.shown === shown &&
      current.deadline === deadline
        ? current
        : { scope: currentScope, shown, deadline },
    );
  }, []);
  useEffect(() => {
    if (queueScope.current !== scope) {
      queue.current.reset();
      queueScope.current = scope;
    }
    if (visible && !suspended)
      queue.current.sync(notices, agents, performance.now());
    else if (!visible) queue.current.reset();
    publish(scope);
  }, [visible, scope, notices, agents, suspended, publish]);
  useEffect(() => {
    if (!visible || snapshot.scope !== scope || snapshot.deadline === null)
      return;
    const timer = window.setTimeout(
      () => {
        if (queueScope.current !== scope) return;
        queue.current.advance(performance.now());
        publish(scope);
      },
      Math.max(0, snapshot.deadline - performance.now()),
    );
    return () => window.clearTimeout(timer);
  }, [visible, scope, snapshot.scope, snapshot.deadline, publish]);
  const dismiss = useCallback(() => {
    if (queueScope.current !== scope) return;
    queue.current.dismiss(performance.now());
    publish(scope);
  }, [scope, publish]);
  const setPaused = useCallback(
    (paused: boolean) => {
      if (queueScope.current !== scope) return;
      queue.current.setPaused(paused, performance.now());
      publish(scope);
    },
    [scope, publish],
  );
  const dismissAll = useCallback(() => {
    if (queueScope.current !== scope) return;
    queue.current.dismissAll();
    publish(scope);
  }, [scope, publish]);
  const shown = visible && snapshot.scope === scope ? snapshot.shown : null;
  const notice = shown?.notice;
  const session =
    !suspended && notice && notices.some((item) => item.key === notice.key)
      ? (agents.find(
          (agent) => sessionKey(agent) === notice.key && !agent.watched,
        ) ?? null)
      : null;
  return {
    session,
    kind: notice?.kind ?? null,
    sentence: session && notice ? noticeSentence(session, notice) : "",
    setPaused,
    dismiss,
    dismissAll,
  };
}
