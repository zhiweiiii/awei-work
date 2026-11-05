import { useCallback, useRef } from "react";
import {
  NavigationHistory,
  type EditorLocation,
} from "@/modules/editor/lib/navigationHistory";

export function useJumpHistory(
  scope: string,
  open: (location: EditorLocation) => boolean,
  getCurrent: () => EditorLocation | null,
) {
  const histories = useRef(new Map<string, NavigationHistory>());
  const getHistory = useCallback(() => {
    const history = histories.current.get(scope) ?? new NavigationHistory();
    histories.current.delete(scope);
    histories.current.set(scope, history);
    if (histories.current.size > 32) {
      const oldest = histories.current.keys().next().value;
      if (oldest !== undefined) histories.current.delete(oldest);
    }
    return history;
  }, [scope]);
  const navigate = useCallback(
    (target: EditorLocation, origin?: EditorLocation) => {
      const from = origin ?? getCurrent();
      if (open(target)) getHistory().record(from, target);
    },
    [getCurrent, getHistory, open],
  );
  const travel = useCallback(
    (direction: -1 | 1) => {
      const history = getHistory();
      const target = history.go(direction, getCurrent());
      if (target && !open(target)) history.go(direction === -1 ? 1 : -1, null);
    },
    [getCurrent, getHistory, open],
  );
  const back = useCallback(() => travel(-1), [travel]);
  const forward = useCallback(() => travel(1), [travel]);
  return { navigate, back, forward };
}
