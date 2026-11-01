import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

export const PET_VISIBILITY_EVENT = "awei-work:pet-visibility";

export function usePetVisibility() {
  const [state, setState] = useState({ visible: false, epoch: 0 });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let revision = 0;
    const update = (visible: boolean) =>
      setState((current) =>
        current.visible === visible
          ? current
          : { visible, epoch: current.epoch + 1 },
      );
    let release: (() => void) | undefined;
    const read = async () => {
      const version = ++revision;
      try {
        const next = await invoke<boolean>("pet_window_open");
        if (alive && version === revision) {
          update(next);
          setError(null);
        }
      } catch {
        if (alive) setError("无法读取宠物窗口状态，请重新打开窗口");
      }
    };
    void listen<boolean>(PET_VISIBILITY_EVENT, ({ payload }) => {
      if (!alive) return;
      revision++;
      update(payload);
      setError(null);
    })
      .then((off) => {
        if (!alive) return off();
        release = off;
        void read();
      })
      .catch(() => {
        if (alive) setError("窗口状态监听失败，请重新打开窗口");
      });
    window.addEventListener("focus", read);
    return () => {
      alive = false;
      release?.();
      window.removeEventListener("focus", read);
    };
  }, []);
  return { ...state, error };
}
