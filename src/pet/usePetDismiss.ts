import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef } from "react";

export function usePetDismiss(
  visible: boolean,
  epoch: number,
  active: boolean,
  blocked: () => boolean,
  onDismiss: () => void,
) {
  const scope = useMemo(
    () => ({ visible, epoch, active }),
    [visible, epoch, active],
  );
  const latest = useRef({ scope, blocked, onDismiss });
  latest.current = { scope, blocked, onDismiss };
  const revision = useRef(0);
  const checkFocus = useCallback(async () => {
    const current = latest.current;
    if (!current.scope.visible || !current.scope.active || current.blocked())
      return;
    const request = ++revision.current;
    try {
      const focused = await getCurrentWindow().isFocused();
      if (
        request === revision.current &&
        latest.current.scope === current.scope &&
        !latest.current.blocked() &&
        !focused
      )
        latest.current.onDismiss();
    } catch {
      // Keep the notice when native focus cannot be confirmed.
    }
  }, []);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let release: (() => void) | undefined;
    const outside = (event: PointerEvent) => {
      const current = latest.current;
      if (!current.scope.active || current.blocked()) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".pet-companion, .pet-notification")
      )
        return;
      revision.current++;
      current.onDismiss();
    };
    const focused = () => {
      revision.current++;
    };
    const blurred = () => {
      void checkFocus();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("focus", focused);
    void getCurrentWindow()
      .onFocusChanged(({ payload }) => {
        if (!alive) return;
        if (payload) focused();
        else blurred();
      })
      .then((off) => {
        if (alive) release = off;
        else off();
      })
      .catch(() => {
        if (alive) window.addEventListener("blur", blurred);
      });
    return () => {
      alive = false;
      revision.current++;
      release?.();
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("focus", focused);
      window.removeEventListener("blur", blurred);
    };
  }, [visible, checkFocus]);
  return checkFocus;
}
