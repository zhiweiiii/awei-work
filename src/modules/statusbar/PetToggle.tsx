import { Button } from "@/components/ui/button";
import { errorToast } from "@/lib/errorToast";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setPetOpen } from "@/modules/settings/store";
import { PET_VISIBILITY_EVENT } from "@/pet/window";
import companionUrl from "@/pet/assets/companion.svg";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

export function PetToggle() {
  const [open, setOpen] = useState(false);
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const busy = useRef(false);
  const interacted = useRef(false);
  const visibilityRevision = useRef(0);
  const aliveRef = useRef(true);
  const [pending, setPending] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    aliveRef.current = true;
    if (!hydrated) return;
    let alive = true;
    let revision = 0;
    let release: (() => void) | undefined;
    const restore = usePreferencesStore.getState().petOpen;
    void listen<boolean>(PET_VISIBILITY_EVENT, ({ payload }) => {
      if (!alive) return;
      revision++;
      visibilityRevision.current++;
      interacted.current = true;
      setOpen(payload);
      void setPetOpen(payload).catch((error) =>
        errorToast("保存宠物开关失败", error),
      );
    })
      .then(async (off) => {
        if (!alive) return off();
        release = off;
        setConnected(true);
        const version = revision;
        const visible = await invoke<boolean>("pet_window_open");
        if (!alive || version !== revision) return;
        setOpen(visible);
        if (restore && !visible && !interacted.current && !busy.current) {
          busy.current = true;
          setPending(true);
          try {
            await invoke("open_pet_window", { focus: false });
          } finally {
            busy.current = false;
            if (alive) setPending(false);
          }
        }
      })
      .catch((error) => {
        if (alive) errorToast("读取宠物窗口状态失败", error);
      });
    return () => {
      alive = false;
      aliveRef.current = false;
      release?.();
    };
  }, [hydrated]);

  const toggle = async () => {
    if (busy.current) return;
    busy.current = true;
    interacted.current = true;
    setPending(true);
    try {
      const visible = await invoke<boolean>("pet_window_open");
      const version = visibilityRevision.current;
      await invoke(visible ? "close_pet_window" : "open_pet_window");
      if (aliveRef.current && version === visibilityRevision.current)
        setOpen(!visible);
    } catch (e) {
      errorToast("切换宠物窗口失败", e);
    } finally {
      busy.current = false;
      if (aliveRef.current) setPending(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className={`size-6 shrink-0 rounded-md hover:bg-accent hover:text-foreground ${
        open ? "text-foreground" : "text-muted-foreground"
      }`}
      onClick={() => void toggle()}
      disabled={pending || !hydrated || !connected}
      title="桌面宠物"
      aria-label="桌面宠物"
      aria-pressed={open}
    >
      <img
        src={companionUrl}
        alt=""
        draggable={false}
        className="size-6 object-contain"
      />
    </Button>
  );
}
