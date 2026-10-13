import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { errorToast } from "@/lib/errorToast";
import { Clock01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/** A command queued to run later, as the backend reports it. */
type ScheduledJob = {
  id: number;
  leaf_id: number;
  command: string;
  /** Epoch milliseconds. */
  fire_at: number;
  created_at: number;
  daily_time: string | null;
  target: "terminal" | "codex" | "claude";
  running: boolean;
  finished: boolean;
  paused: boolean;
  last_result: string | null;
};

type Props = {
  /** Used only for terminal-mode jobs. */
  leafId: number | null;
};

function untilText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分后`;
  if (m > 0) return `${m} 分 ${s} 秒后`;
  return `${s} 秒后`;
}

// The Rust scheduler keeps time independently of the open panel.
export function ScheduleButton({ leafId }: Props) {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const [command, setCommand] = useState("");
  const [mode, setMode] = useState<"delay" | "once" | "daily">("daily");
  const [target, setTarget] = useState<ScheduledJob["target"]>("terminal");
  const [time, setTime] = useState("06:30");
  const [dateTime, setDateTime] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const refreshEpoch = useRef(0);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);
  // Re-renders the countdowns. Only ticks while the panel is open.
  const [, setTick] = useState(0);

  const refresh = useCallback(() => {
    const epoch = ++refreshEpoch.current;
    void invoke<ScheduledJob[]>("schedule_list")
      .then((items) => {
        if (epoch !== refreshEpoch.current) return;
        setJobs(items);
        setStorageError(null);
      })
      .catch((e) => {
        if (epoch === refreshEpoch.current) setStorageError(String(e));
      });
  }, []);

  // Desktop and phone share the backend queue.
  useEffect(() => {
    refresh();
    const errors = listen<string>("terax:schedule-error", (e) => {
      refreshEpoch.current += 1;
      setStorageError(e.payload);
    });
    const stop = listen<ScheduledJob[]>("terax:schedules", (e) => {
      refreshEpoch.current += 1;
      setJobs(Array.isArray(e.payload) ? e.payload : []);
    });
    return () => {
      refreshEpoch.current += 1;
      void stop.then((off) => off());
      void errors.then((off) => off());
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    refresh();
    const handle = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(handle);
  }, [open, refresh]);

  const submit = () => {
    if ((target === "terminal" && leafId === null) || savingRef.current) return;
    const text = command.trim();
    if (text === "") {
      toast.error("先填写要发送的内容");
      return;
    }
    const delaySeconds =
      (Number(hours) || 0) * 3600 + (Number(minutes) || 0) * 60;
    if (
      mode === "delay" &&
      (!Number.isFinite(delaySeconds) || delaySeconds <= 0)
    ) {
      toast.error("请填写多久之后执行");
      return;
    }
    const fireAt = new Date(dateTime).getTime();
    if (mode === "once" && (!Number.isFinite(fireAt) || fireAt <= Date.now())) {
      toast.error("请选择未来的发送时间");
      return;
    }
    if (mode === "daily" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      toast.error("请选择每日发送时间");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    void invoke("schedule_add_at", {
      target,
      leafId: target === "terminal" ? leafId : null,
      command: text,
      fireAt:
        mode === "once"
          ? fireAt
          : mode === "delay"
            ? Date.now() + Math.round(delaySeconds * 1000)
            : null,
      dailyTime: mode === "daily" ? time : null,
    })
      .then(() => {
        setCommand((current) => (current === command ? "" : current));
        setHours((current) => (current === hours ? "" : current));
        setMinutes((current) => (current === minutes ? "" : current));
        toast.success(
          mode === "daily" ? `已安排：每天 ${time} 发送` : "已添加定时任务",
        );
        refresh();
      })
      .catch((e) => errorToast("排队失败", String(e)))
      .finally(() => {
        savingRef.current = false;
        setSaving(false);
      });
  };

  const cancel = (id: number) => {
    void invoke("schedule_cancel", { id })
      .then(refresh)
      .catch((e) => errorToast("取消失败", String(e)));
  };

  const now = Date.now();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-foreground"
          title="定时发送命令"
          aria-label="定时发送命令"
        >
          <HugeiconsIcon icon={Clock01Icon} size={13} strokeWidth={2} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-96 p-3">
        <div className="flex flex-col gap-2.5">
          <Label htmlFor="schedule-target">执行模式</Label>
          <select
            id="schedule-target"
            className="h-8 rounded-md border border-border bg-background text-xs"
            value={target}
            onChange={(e) =>
              setTarget(e.target.value as ScheduledJob["target"])
            }
          >
            <option value="terminal">终端</option>
            <option value="codex">Codex（后台）</option>
            <option value="claude">Claude Code（后台）</option>
          </select>
          <Label htmlFor="schedule-mode">发送方式</Label>
          <select
            id="schedule-mode"
            className="h-8 rounded-md border border-border bg-background text-xs"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="daily">每天重复</option>
            <option value="once">指定日期时间</option>
            <option value="delay">延时执行</option>
          </select>
          <div className="flex flex-col gap-1">
            <Label className="text-[11px]">
              {target === "terminal" ? "命令" : "消息"}
            </Label>
            <Input
              className="h-8 font-mono text-[12px]"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
              }}
              placeholder={target === "terminal" ? "pnpm build" : "你好"}
              spellCheck={false}
            />
          </div>
          <div className="flex items-end gap-2">
            {mode !== "delay" ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="schedule-time" className="text-[11px]">
                  {mode === "daily"
                    ? "每天（本机时间）"
                    : "日期和时间（本机时间）"}
                </Label>
                <Input
                  id="schedule-time"
                  type={mode === "daily" ? "time" : "datetime-local"}
                  className="h-8"
                  value={mode === "daily" ? time : dateTime}
                  onChange={(e) =>
                    mode === "daily"
                      ? setTime(e.target.value)
                      : setDateTime(e.target.value)
                  }
                />
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <Label className="text-[11px]">小时</Label>
                  <Input
                    className="h-8 w-16 text-center"
                    inputMode="numeric"
                    value={hours}
                    onChange={(e) => setHours(e.target.value)}
                    placeholder="0"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-[11px]">分钟</Label>
                  <Input
                    className="h-8 w-16 text-center"
                    inputMode="numeric"
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.value)}
                    placeholder="0"
                  />
                </div>
              </>
            )}
            <Button
              size="sm"
              className="ml-auto h-8"
              disabled={(target === "terminal" && leafId === null) || saving}
              onClick={submit}
            >
              {saving ? "添加中…" : "添加任务"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {target === "terminal"
              ? `目标：${leafId === null ? "未选择终端" : `当前终端 #${leafId}`}。重启或关闭原终端后，任务保留并暂停，需重新绑定。`
              : "到点独立启动后台程序，不占用终端、不需工作目录。使用本机 CLI 的登录和配置，每次新建对话。"}
            任务自动保存，重启恢复。执行时需保持 awei-work
            运行；后台过期待执行任务补发一次，中断请求不自动重发。后台最多并行 4
            个，单次限时 30 分钟。
          </p>
          {storageError ? (
            <p role="alert" className="text-xs text-destructive">
              {storageError}
            </p>
          ) : null}

          {target === "terminal" && leafId === null ? (
            <p className="text-[11px] text-muted-foreground">
              没有活动的命令行，无法安排。
            </p>
          ) : null}

          <div className="mt-0.5 flex max-h-64 flex-col gap-1 overflow-y-auto border-t border-border/60 pt-2">
            {jobs.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                没有排队的命令。
              </p>
            ) : (
              jobs.map((job) => (
                <div
                  key={job.id}
                  className="flex items-baseline gap-2 rounded-md bg-muted/50 px-2 py-1"
                >
                  <span className="shrink-0 font-mono text-[10.5px] text-blue-500">
                    {job.daily_time ? `每天 ${job.daily_time}` : "单次"}
                    <br />
                    {job.paused
                      ? "待绑定终端"
                      : job.running
                        ? "执行中"
                        : job.finished
                          ? "已结束"
                          : untilText(job.fire_at - now)}
                  </span>
                  {/* Wraps rather than truncates: a queued command you cannot
                      read in full is one you cannot decide to cancel. */}
                  <span className="min-w-0 flex-1 break-all font-mono text-[11px]">
                    {job.command}
                    <span className="block text-muted-foreground text-[10px]">
                      {job.target === "terminal"
                        ? `终端 #${job.leaf_id}`
                        : job.target === "codex"
                          ? "Codex 后台"
                          : "Claude Code 后台"}{" "}
                      · {new Date(job.fire_at).toLocaleString()}
                    </span>
                    {job.last_result ? (
                      <details className="mt-1 text-[11px]">
                        <summary>上次执行结果</summary>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">
                          {job.last_result}
                        </pre>
                      </details>
                    ) : null}
                    {job.paused && job.target === "terminal" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={leafId === null}
                        onClick={() => {
                          void invoke("schedule_rebind", { id: job.id, leafId })
                            .then(refresh)
                            .catch((e) => errorToast("绑定失败", String(e)));
                        }}
                      >
                        绑定当前终端并恢复
                        {job.fire_at <= now ? "（到期立即发送）" : ""}
                      </Button>
                    ) : null}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5 shrink-0 text-muted-foreground hover:text-destructive"
                    title="取消"
                    onClick={() => cancel(job.id)}
                  >
                    <HugeiconsIcon
                      icon={Delete02Icon}
                      size={11}
                      strokeWidth={2}
                    />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
