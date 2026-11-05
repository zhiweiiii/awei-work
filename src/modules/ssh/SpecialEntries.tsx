import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSsh } from "@/modules/ssh/store";
import type { CodeProfile } from "@/modules/ssh/entryTypes";

type Special = CodeProfile;
type CodeTask = {
  taskId: string;
  id: string;
  phase: string;
  message: string;
};

export function useSpecialEntries(onError: (error: string) => void) {
  const ready = useSsh((state) => state.ready);
  const [opening, setOpening] = useState<string | null>(null);
  const [passwordFor, setPasswordFor] = useState<CodeProfile | null>(null);
  const [secret, setSecret] = useState("");
  const [tasks, setTasks] = useState<ReadonlyMap<string, CodeTask>>(new Map());
  const latest = useRef(new Map<string, string>());
  const gate = useRef(false);
  const live = useRef(true);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    live.current = true;
    const accept = (payload: CodeTask, restored = false) => {
      const profile = useSsh
        .getState()
        .profiles.find((profile) => profile.id === payload.id);
      if (
        cancelled ||
        !live.current ||
        profile?.kind !== "code" ||
        !/^[a-f0-9]{32}$/.test(payload.taskId) ||
        typeof payload.message !== "string"
      )
        return;
      const previous = latest.current.get(payload.id);
      if (restored && previous) return;
      if (payload.phase !== "queued" && previous && previous !== payload.taskId)
        return;
      latest.current.set(payload.id, payload.taskId);
      const oldest = latest.current.keys().next().value;
      if (latest.current.size > 64 && oldest !== undefined)
        latest.current.delete(oldest);
      setTasks((before) => {
        const next = new Map(before);
        next.set(payload.id, payload);
        const oldest = next.keys().next().value;
        if (next.size > 64 && oldest !== undefined) next.delete(oldest);
        return next;
      });
    };
    const unsubscribe = listen<CodeTask>("ssh:code-task", ({ payload }) =>
      accept(payload),
    );
    void unsubscribe
      .then(async () => {
        const active = await invoke<CodeTask[]>("ssh_code_status");
        if (!cancelled && live.current)
          for (const task of active) accept(task, true);
      })
      .catch((error: unknown) => {
        if (live.current) errorRef.current(String(error));
      });
    return () => {
      cancelled = true;
      live.current = false;
      void unsubscribe.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [ready]);
  const run = async (profile: Special, password?: string) => {
    if (gate.current) return;
    gate.current = true;
    setOpening(profile.id);
    onError("");
    try {
      if (
        useSsh.getState().profiles.find((item) => item.id === profile.id) !==
        profile
      )
        throw new Error("连接已变更，请重新打开");
      if (profile.passwordMode === "ask" && password === undefined) {
        setSecret("");
        setPasswordFor(profile);
        return;
      }
      await invoke("ssh_open_special", {
        entry: profile,
        secret: password ?? null,
      });
      if (live.current) {
        setPasswordFor(null);
        setSecret("");
      }
    } catch (error) {
      if (live.current) onError(String(error));
    } finally {
      gate.current = false;
      if (live.current) setOpening(null);
    }
  };
  const open = (profile: Special) => {
    void run(profile);
  };
  const dialogs = (
    <>
      <Dialog
        open={passwordFor !== null}
        onOpenChange={(next) => {
          if (!next && !opening) {
            setPasswordFor(null);
            setSecret("");
          }
        }}
      >
        <DialogContent>
          <DialogTitle>打开 {passwordFor?.name}</DialogTitle>
          <DialogDescription>
            本次密码仅供执行使用，不保存到连接配置。
          </DialogDescription>
          <form
            className="grid gap-3 text-xs"
            onSubmit={(event) => {
              event.preventDefault();
              if (passwordFor) void run(passwordFor, secret);
            }}
          >
            <input
              className="ssh-input"
              type="password"
              autoComplete="off"
              aria-label="本次登录密码"
              required
              maxLength={2000}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            <button
              className="ssh-button justify-self-end"
              type="submit"
              disabled={!!opening}
            >
              执行
            </button>
          </form>
        </DialogContent>
      </Dialog>

    </>
  );
  return { open, opening, dialogs, tasks };
}
