import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { layoutStyles, type PetLayout } from "./petLayout";

export function usePetBubble(
  visible: boolean,
  epoch: number,
  notification: boolean,
) {
  const scope = `${visible}:${epoch}`;
  const latest = useRef({ scope, notification });
  latest.current = { scope, notification };
  const [revision, setRevision] = useState(0);
  const transition = useMemo(
    () => ({ scope, notification, revision }),
    [scope, notification, revision],
  );
  const [applied, setApplied] = useState<{ scope: string; layout?: PetLayout }>(
    { scope: "" },
  );
  useEffect(() => {
    if (!visible) return;
    const { scope, notification } = transition;
    let alive = true;
    void invoke<PetLayout>("pet_set_notification", { notification })
      .then((layout) => {
        if (alive && latest.current.scope === scope)
          setApplied((previous) =>
            previous.scope === scope &&
            (previous.layout?.revision ?? 0) > layout.revision
              ? previous
              : { scope, layout },
          );
      })
      .catch((error) => console.warn("pet bubble layout failed:", error));
    return () => {
      alive = false;
    };
  }, [visible, transition]);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let release: (() => void) | undefined;
    void listen<PetLayout>("awei-work:pet-layout", ({ payload }) => {
      if (
        !alive ||
        latest.current.scope !== scope ||
        payload.mode !== (latest.current.notification ? "notice" : "compact")
      )
        return;
      setApplied((previous) =>
        previous.scope === scope &&
        payload.revision > (previous.layout?.revision ?? 0)
          ? { scope, layout: payload }
          : previous,
      );
    })
      .then((off) => {
        if (alive) release = off;
        else off();
      })
      .catch(() => {});
    return () => {
      alive = false;
      release?.();
    };
  }, [visible, scope]);
  const reposition = useCallback(() => {
    if (visible && latest.current.scope === scope)
      setRevision((current) => current + 1);
  }, [visible, scope]);
  return {
    notification:
      visible &&
      notification &&
      applied.scope === scope &&
      applied.layout?.mode === "notice",
    styles: layoutStyles(applied.scope === scope ? applied.layout : undefined),
    reposition,
  };
}
