import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

type Reminder = { id: string; text: string };

export function usePetReminder(visible: boolean) {
  const [items, setItems] = useState<Reminder[]>([]);
  const [paused, setPaused] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const dismissing = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const items = await invoke<Reminder[]>("pet_reminders");
      if (mounted.current && revision.current === request) {
        setItems((current) =>
          items.map(
            (item) =>
              current.find(
                (existing) =>
                  existing.id === item.id && existing.text === item.text,
              ) ?? item,
          ),
        );
        setError(null);
      }
    } catch {
      if (mounted.current && revision.current === request)
        setError("无法读取宠物提醒");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const focused = () => void refresh();
    window.addEventListener("focus", focused);
    let alive = true;
    let release: (() => void) | undefined;
    void listen("awei-work:pet-reminders", () => {
      if (alive) void refresh();
    })
      .then((off) => {
        if (!alive) return off();
        release = off;
        void refresh();
      })
      .catch(() => {
        if (alive) setError("宠物提醒监听失败");
      });
    return () => {
      alive = false;
      mounted.current = false;
      revision.current++;
      release?.();
      window.removeEventListener("focus", focused);
    };
  }, [refresh]);
  useEffect(() => {
    if (visible) void refresh();
  }, [visible, refresh]);

  const shown = visible ? (items[0] ?? null) : null;
  const dismiss = useCallback(async () => {
    if (!shown || dismissing.current) return;
    dismissing.current = true;
    setPending(true);
    try {
      await invoke("pet_dismiss_reminder", { id: shown.id });
      if (!mounted.current) return;
      revision.current++;
      setItems((items) => items.filter((item) => item.id !== shown.id));
      setError(null);
      void refresh();
    } catch {
      if (mounted.current) setError("无法关闭提醒，请重试");
    } finally {
      dismissing.current = false;
      if (mounted.current) setPending(false);
    }
  }, [shown, refresh]);
  useEffect(() => {
    if (!shown || paused || pending || error) return;
    const timer = window.setTimeout(() => void dismiss(), 15000);
    return () => window.clearTimeout(timer);
  }, [shown, paused, pending, error, dismiss]);

  return { shown, dismiss, setPaused, pending, error };
}
