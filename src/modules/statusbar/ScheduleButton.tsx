import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { errorToast } from "@/lib/errorToast";
import { cn } from "@/lib/utils";
import {
  Add01Icon,
  ArrowRight01Icon,
  Clock01Icon,
  Delete02Icon,
} from "@hugeicons/core-free-icons";
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
  target: "terminal" | "codex" | "claude" | "agy" | "pet";
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

function targetShortLabel(job: ScheduledJob): string {
  switch (job.target) {
    case "terminal":
      return `终端 #${job.leaf_id}`;
    case "pet":
      return "宠物";
    case "codex":
      return "Codex";
    case "agy":
      return "Anti";
    case "claude":
      return "Claude";
  }
}

function targetFullLabel(job: ScheduledJob): string {
  switch (job.target) {
    case "terminal":
      return `终端 #${job.leaf_id}`;
    case "pet":
      return "宠物提示";
    case "codex":
      return "Codex 后台";
    case "agy":
      return "Anti 后台";
    case "claude":
      return "Claude Code 后台";
  }
}

// The Rust scheduler keeps time independently of the open panel.
export function ScheduleButton({ leafId }: Props) {
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
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

  const toggleExpanded = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setExpandedIds(new Set());
  };

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
        setAddOpen(false);
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
      .then(() => {
        setExpandedIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        refresh();
      })
      .catch((e) => errorToast("取消失败", String(e)));
  };

  const now = Date.now();

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            title="定时任务"
            aria-label="定时任务"
          >
            <HugeiconsIcon icon={Clock01Icon} size={13} strokeWidth={2} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" side="top" className="w-96 p-3">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
              <div className="flex items-baseline gap-1.5">
                <span className="text-xs font-medium text-foreground">
                  定时任务
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {jobs.length}
                </span>
              </div>
              <Button
                size="xs"
                variant="outline"
                className="h-6 gap-1 px-2 text-[11px]"
                onClick={() => {
                  setOpen(false);
                  setExpandedIds(new Set());
                  setAddOpen(true);
                }}
              >
                <HugeiconsIcon icon={Add01Icon} size={11} strokeWidth={2} />
                添加任务
              </Button>
            </div>

            {storageError ? (
              <p role="alert" className="text-xs text-destructive">
                {storageError}
              </p>
            ) : null}

            <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
              {jobs.length === 0 ? (
                <p className="py-3 text-center text-[11px] text-muted-foreground">
                  没有定时任务。
                </p>
              ) : (
                jobs.map((job) => {
                  const expanded = expandedIds.has(job.id);
                  const statusText = job.paused
                    ? "待绑定"
                    : job.running
                      ? "执行中"
                      : job.finished
                        ? "已结束"
                        : untilText(job.fire_at - now);
                  return (
                    <div
                      key={job.id}
                      className="rounded-md border border-border/40 bg-muted/40 transition-colors hover:bg-muted/60"
                    >
                      <div className="flex items-center gap-1 px-1.5 py-1">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => toggleExpanded(job.id)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 py-0.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <HugeiconsIcon
                            icon={ArrowRight01Icon}
                            size={11}
                            strokeWidth={2}
                            className={cn(
                              "shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-150",
                              expanded && "rotate-90",
                            )}
                          />
                          <span className="shrink-0 font-mono text-[10.5px] font-medium text-blue-500">
                            {job.daily_time ? `每天 ${job.daily_time}` : "单次"}
                          </span>
                          <span className="shrink-0 rounded bg-foreground/[0.06] px-1 py-0.25 text-[10px] text-muted-foreground">
                            {targetShortLabel(job)}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                            {job.command}
                          </span>
                          <span
                            className={cn(
                              "shrink-0 font-mono text-[10px]",
                              job.paused
                                ? "text-amber-500"
                                : job.running
                                  ? "text-emerald-500"
                                  : "text-muted-foreground",
                            )}
                          >
                            {statusText}
                          </span>
                        </button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-5 shrink-0 text-muted-foreground hover:text-destructive"
                          title="取消"
                          aria-label="取消任务"
                          onClick={() => cancel(job.id)}
                        >
                          <HugeiconsIcon
                            icon={Delete02Icon}
                            size={11}
                            strokeWidth={2}
                          />
                        </Button>
                      </div>

                      <div
                        className={cn(
                          "grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-150",
                          expanded
                            ? "grid-rows-[1fr] opacity-100"
                            : "grid-rows-[0fr] opacity-0",
                        )}
                      >
                        <div className="overflow-hidden">
                          <div className="flex flex-col gap-1.5 border-t border-border/40 px-2.5 py-2 text-[11px]">
                            <div className="whitespace-pre-wrap break-all font-mono text-foreground">
                              {job.command}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {targetFullLabel(job)} ·{" "}
                              {new Date(job.fire_at).toLocaleString()}
                            </div>
                            {job.last_result ? (
                              <div className="rounded bg-background/70 px-2 py-1.5">
                                <div className="mb-0.5 text-[10px] text-muted-foreground">
                                  上次执行结果
                                </div>
                                <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all font-mono text-[10.5px] text-foreground/90">
                                  {job.last_result}
                                </pre>
                              </div>
                            ) : null}
                            {job.paused && job.target === "terminal" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 self-start text-[11px]"
                                disabled={leafId === null}
                                onClick={() => {
                                  void invoke("schedule_rebind", {
                                    id: job.id,
                                    leafId,
                                  })
                                    .then(refresh)
                                    .catch((e) =>
                                      errorToast("绑定失败", String(e)),
                                    );
                                }}
                              >
                                绑定当前终端并恢复
                                {job.fire_at <= now ? "（到期立即发送）" : ""}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Dialog
        open={addOpen}
        onOpenChange={(next) => {
          if (!next && savingRef.current) return;
          setAddOpen(next);
        }}
      >
        <DialogContent className="gap-4 rounded-2xl p-5 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">添加定时任务</DialogTitle>
            <DialogDescription className="text-xs">
              任务自动保存并在重启后恢复，到点执行需保持 awei-work 运行。
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div className="flex flex-col gap-1">
                <Label htmlFor="schedule-target" className="text-xs">
                  执行模式
                </Label>
                <select
                  id="schedule-target"
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                  value={target}
                  onChange={(e) =>
                    setTarget(e.target.value as ScheduledJob["target"])
                  }
                >
                  <option value="terminal">终端</option>
                  <option value="codex">Codex（后台）</option>
                  <option value="claude">Claude Code（后台）</option>
                  <option value="agy">Antigravity CLI（后台）</option>
                  <option value="pet">宠物提示</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="schedule-mode" className="text-xs">
                  执行时间
                </Label>
                <select
                  id="schedule-mode"
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as typeof mode)}
                >
                  <option value="daily">每天重复</option>
                  <option value="once">指定日期时间</option>
                  <option value="delay">延时执行</option>
                </select>
              </div>
            </div>

            {mode !== "delay" ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="schedule-time" className="text-xs">
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
              <div className="flex items-end gap-2">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">小时</Label>
                  <Input
                    className="h-8 w-20 text-center"
                    inputMode="numeric"
                    value={hours}
                    onChange={(e) => setHours(e.target.value)}
                    placeholder="0"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">分钟</Label>
                  <Input
                    className="h-8 w-20 text-center"
                    inputMode="numeric"
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.value)}
                    placeholder="0"
                  />
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1">
              <Label htmlFor="schedule-command" className="text-xs">
                {target === "pet"
                  ? "提示内容"
                  : target === "terminal"
                    ? "命令"
                    : "消息"}
              </Label>
              <Input
                id="schedule-command"
                className="h-8 font-mono text-[12px]"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
                }}
                placeholder={
                  target === "pet"
                    ? "该休息一下了"
                    : target === "terminal"
                      ? "pnpm build"
                      : "你好"
                }
                spellCheck={false}
              />
            </div>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {target === "pet"
                ? "到点自动显示宠物气泡，直接说出填写的内容，不启动 agent。"
                : target === "terminal"
                  ? `目标：${leafId === null ? "未选择终端" : `当前终端 #${leafId}`}。重启或关闭原终端后，任务保留并暂停，需重新绑定。`
                  : "到点独立启动后台程序，不占用终端、不需工作目录。使用本机 CLI 的登录和配置，每次新建对话。"}
              过期待执行任务补发一次，中断请求不自动重发。
              {target !== "terminal" && target !== "pet"
                ? "后台最多并行 4 个，单次限时 30 分钟。"
                : ""}
            </p>

            {target === "terminal" && leafId === null ? (
              <p className="text-[11px] text-destructive">
                没有活动的命令行，无法安排终端模式任务。
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => setAddOpen(false)}
            >
              取消
            </Button>
            <Button
              size="sm"
              disabled={(target === "terminal" && leafId === null) || saving}
              onClick={submit}
            >
              {saving ? "添加中…" : "添加任务"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
