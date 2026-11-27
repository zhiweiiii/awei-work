import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { errorToast } from "@/lib/errorToast";
import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type UsageWindow = {
  label: string;
  percent: number | null;
  resets: string | null;
};

type ClaudeUsage = {
  session: UsageWindow | null;
  weeks: UsageWindow[];
  raw: string;
  fetchedAt: number;
  error: string | null;
};

type CodexUsageWindow = {
  usedPercent: number | null;
  resetsAt: number | null;
  windowDurationMins: number | null;
};

type CodexUsage = {
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  planType: string | null;
  fetchedAt: number;
  error: string | null;
};

type AgyQuotaWindow = { percent: number | null; resetsAt: string | null };
type AgyQuotaGroup = {
  name: string;
  fiveHour: AgyQuotaWindow | null;
  week: AgyQuotaWindow | null;
};
type AgyUsage = {
  groups: AgyQuotaGroup[];
  fetchedAt: number;
  error: string | null;
};

const WARN_AT = 75;
const DANGER_AT = 90;
const REFRESH_INTERVAL = 5 * 60 * 1000;

let pendingUsage: ReturnType<typeof requestUsage> | null = null;

function requestUsage(force: boolean) {
  return Promise.allSettled([
    Promise.resolve().then(() =>
      invoke<ClaudeUsage>("claude_usage", { force }),
    ),
    Promise.resolve().then(() => invoke<CodexUsage>("codex_usage", { force })),
    Promise.resolve().then(() => invoke<AgyUsage>("agy_usage", { force })),
  ]);
}

function readUsage(force: boolean) {
  if (pendingUsage) return pendingUsage;
  const request = requestUsage(force).finally(() => {
    if (pendingUsage === request) pendingUsage = null;
  });
  pendingUsage = request;
  return request;
}

function toneOf(percent: number | null): string {
  if (percent === null) return "text-muted-foreground";
  if (percent >= DANGER_AT) return "text-destructive";
  if (percent >= WARN_AT) return "text-amber-700 dark:text-amber-400";
  return "text-emerald-700 dark:text-emerald-400";
}

function barOf(percent: number): string {
  if (percent >= DANGER_AT) return "bg-destructive";
  if (percent >= WARN_AT) return "bg-amber-500";
  return "bg-emerald-500";
}

function ageLabel(fetchedAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - fetchedAt);
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}

function codexResetLabel(resetsAt: number | null): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
  const date = new Date(resetsAt * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function codexWindowTitle(window: CodexUsageWindow, fallback: string): string {
  if (window.windowDurationMins === 300) return "5 小时窗口";
  if (window.windowDurationMins === 10080) return "周窗口";
  return fallback;
}

function resetHint(day: number, hour: number, minute: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(day)}号${pad(hour)}:${pad(minute)}`;
}

function codexResetHint(resetsAt: number | null): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
  const date = new Date(resetsAt * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  return resetHint(date.getDate(), date.getHours(), date.getMinutes());
}

function agyResetSeconds(value: string | null | undefined): number | null {
  const epoch = value ? Date.parse(value) : NaN;
  return epoch > 0 && Number.isFinite(epoch) ? epoch / 1000 : null;
}

function maxAgyWindow(
  groups: AgyQuotaGroup[] | undefined,
  period: "fiveHour" | "week",
) {
  return (
    groups?.reduce<AgyQuotaWindow | null>((peak, group) => {
      const window = group[period];
      return window && (window.percent ?? -1) > (peak?.percent ?? -1)
        ? window
        : peak;
    }, null) ?? null
  );
}

function preserveOnError<T extends { error: string | null }>(
  previous: T | null,
  next: T,
): T {
  return next.error && previous ? { ...previous, error: next.error } : next;
}

function claudeResetHint(
  value: string | null,
  fetchedAt: number,
): string | null {
  if (!value) return null;
  const match = value.match(
    /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s+\(([^()]+)\))?$/i,
  );
  if (!match) return null;
  const [, day, hourText, minuteText = "00", period, zone] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (minute > 59 || (period ? hour < 1 || hour > 12 : hour > 23)) return null;
  const hour24 = period
    ? (hour % 12) + (period.toLowerCase() === "pm" ? 12 : 0)
    : hour;
  if (day)
    return Number(day) >= 1 && Number(day) <= 31
      ? resetHint(Number(day), hour24, minute)
      : null;

  const fetched = new Date(fetchedAt * 1000);
  if (!Number.isFinite(fetched.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(fetched);
    const part = (type: string) =>
      Number(parts.find((item) => item.type === type)?.value);
    const dayOffset =
      hour24 * 60 + minute < part("hour") * 60 + part("minute") ? 1 : 0;
    const reset = new Date(
      Date.UTC(part("year"), part("month") - 1, part("day") + dayOffset),
    );
    return Number.isFinite(reset.getTime())
      ? resetHint(reset.getUTCDate(), hour24, minute)
      : null;
  } catch {
    return null;
  }
}

export function ClaudeUsageButton() {
  const [open, setOpen] = useState(false);
  const [claudeUsage, setClaudeUsage] = useState<ClaudeUsage | null>(null);
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>(null);
  const [agyUsage, setAgyUsage] = useState<AgyUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const revisionRef = useRef(0);
  const mountedRef = useRef(true);

  const load = useCallback(async (force: boolean, notify = false) => {
    if (!mountedRef.current || busyRef.current) return;
    busyRef.current = true;
    const revision = ++revisionRef.current;
    setBusy(true);
    try {
      const [claude, codex, agy] = await readUsage(force);
      if (!mountedRef.current || revision !== revisionRef.current) return;
      const fetchedAt = Math.floor(Date.now() / 1000);
      const claudeResult: ClaudeUsage =
        claude.status === "fulfilled"
          ? claude.value
          : {
              session: null,
              weeks: [],
              raw: "",
              fetchedAt,
              error: String(claude.reason),
            };
      const codexResult: CodexUsage =
        codex.status === "fulfilled"
          ? codex.value
          : {
              primary: null,
              secondary: null,
              planType: null,
              fetchedAt,
              error: String(codex.reason),
            };
      setClaudeUsage((previous) => preserveOnError(previous, claudeResult));
      setCodexUsage((previous) => preserveOnError(previous, codexResult));
      const agyResult: AgyUsage =
        agy.status === "fulfilled"
          ? agy.value
          : { groups: [], fetchedAt, error: String(agy.reason) };
      setAgyUsage((previous) => preserveOnError(previous, agyResult));
      if (notify && claudeResult.error)
        errorToast("读取 Claude Code 用量失败", claudeResult.error);
      if (notify && codexResult.error)
        errorToast("读取 Codex 用量失败", codexResult.error);
      if (notify && agyResult.error)
        errorToast("读取 Antigravity CLI 用量失败", agyResult.error);
    } finally {
      if (mountedRef.current && revision === revisionRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const revision = revisionRef.current;
    void Promise.allSettled([
      Promise.resolve().then(() =>
        invoke<ClaudeUsage | null>("claude_usage_cached"),
      ),
      Promise.resolve().then(() =>
        invoke<CodexUsage | null>("codex_usage_cached"),
      ),
      Promise.resolve().then(() => invoke<AgyUsage | null>("agy_usage_cached")),
    ]).then(([claude, codex, agy]) => {
      if (!mountedRef.current || revisionRef.current !== revision) return;
      if (claude.status === "fulfilled" && claude.value)
        setClaudeUsage(claude.value);
      if (codex.status === "fulfilled" && codex.value)
        setCodexUsage(codex.value);
      if (agy.status === "fulfilled" && agy.value) setAgyUsage(agy.value);
      void load(false);
    });
    const timer = window.setInterval(() => {
      void load(true);
    }, REFRESH_INTERVAL);
    return () => {
      window.clearInterval(timer);
      mountedRef.current = false;
      revisionRef.current++;
      busyRef.current = false;
    };
  }, [load]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void load(false);
  };

  const session = claudeUsage?.session ?? null;
  const primaryWeek =
    claudeUsage?.weeks.find(
      (week) => week.label.toLowerCase() === "all models",
    ) ??
    claudeUsage?.weeks[0] ??
    null;
  const codexPrimary = codexUsage?.primary ?? null;
  const codexFiveHour = [codexUsage?.primary, codexUsage?.secondary].find(
    (window) => window?.windowDurationMins === 300,
  );
  const codexWeek = [codexUsage?.primary, codexUsage?.secondary].find(
    (window) => window?.windowDurationMins === 10080,
  );
  const agyFiveHour = maxAgyWindow(agyUsage?.groups, "fiveHour");
  const agyWeek = maxAgyWindow(agyUsage?.groups, "week");
  const summaryTitle = [
    "上半为 5 小时用量，下半为周用量。点击查看详情。",
    claudeUsage?.error ? `Claude Code 更新失败：${claudeUsage.error}` : null,
    codexUsage?.error ? `Codex 更新失败：${codexUsage.error}` : null,
    agyUsage?.error ? `Antigravity CLI 更新失败：${agyUsage.error}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 rounded-md px-0.5"
          title={summaryTitle}
          aria-label="Claude Code、Codex 与 Antigravity CLI 用量"
        >
          <UsageBadge
            letter="C"
            agent="Claude Code"
            shortPercent={session?.percent ?? null}
            shortReset={claudeResetHint(
              session?.resets ?? null,
              claudeUsage?.fetchedAt ?? Number.NaN,
            )}
            weekPercent={primaryWeek?.percent ?? null}
            weekReset={claudeResetHint(
              primaryWeek?.resets ?? null,
              claudeUsage?.fetchedAt ?? Number.NaN,
            )}
            error={Boolean(claudeUsage?.error)}
          />
          <UsageBadge
            letter="O"
            agent="Codex"
            shortPercent={codexFiveHour?.usedPercent ?? null}
            shortReset={codexResetHint(codexFiveHour?.resetsAt ?? null)}
            weekPercent={codexWeek?.usedPercent ?? null}
            weekReset={codexResetHint(codexWeek?.resetsAt ?? null)}
            error={Boolean(codexUsage?.error)}
          />
          <UsageBadge
            letter="A"
            agent="Antigravity CLI（各组最高用量）"
            shortPercent={agyFiveHour?.percent ?? null}
            shortReset={codexResetHint(agyResetSeconds(agyFiveHour?.resetsAt))}
            weekPercent={agyWeek?.percent ?? null}
            weekReset={codexResetHint(agyResetSeconds(agyWeek?.resetsAt))}
            error={Boolean(agyUsage?.error)}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="max-h-[70vh] w-80 overflow-y-auto p-3"
      >
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium">用量</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void load(true, true)}
              title="立即刷新用量"
              aria-label="立即刷新用量"
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
            >
              <HugeiconsIcon
                icon={Refresh01Icon}
                size={12}
                strokeWidth={1.75}
                className={busy ? "animate-spin" : undefined}
              />
            </button>
          </div>

          {claudeUsage === null && codexUsage === null && agyUsage === null ? (
            <p className="text-[10.5px] leading-snug text-muted-foreground">
              {busy ? "正在查询…" : "等待自动查询，也可以点右上角刷新。"}
            </p>
          ) : null}

          <UsageSection title="Claude Code">
            {session ? <WindowRow title="5 小时窗口" window={session} /> : null}
            {claudeUsage?.weeks.map((week) => (
              <WindowRow
                key={week.label}
                title={`本周（${week.label}）`}
                window={week}
              />
            ))}

            {claudeUsage?.error ? (
              <p className="select-text whitespace-pre-wrap break-words text-[10.5px] leading-snug text-destructive">
                {claudeUsage.error}
              </p>
            ) : null}

            {/* Claude Code also reports what drove the usage. It is prose and it
              changes shape, so it is shown as written rather than parsed. */}
            {claudeUsage?.raw.trim() ? (
              <details className="border-t border-border/60 pt-2">
                <summary className="cursor-pointer text-[10.5px] text-muted-foreground">
                  完整输出
                </summary>
                <pre className="mt-1.5 select-text whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-muted-foreground">
                  {claudeUsage.raw.trim()}
                </pre>
              </details>
            ) : null}

            {claudeUsage && !claudeUsage.error ? (
              <p className="text-[10px] text-muted-foreground">
                更新于 {ageLabel(claudeUsage.fetchedAt)}
              </p>
            ) : null}
          </UsageSection>
          <p className="text-[10px] text-muted-foreground">
            每 5 分钟自动更新。
          </p>

          <UsageSection title="Codex">
            {codexPrimary ? (
              <CodexWindowRow
                title={codexWindowTitle(codexPrimary, "短期窗口")}
                window={codexPrimary}
              />
            ) : null}
            {codexUsage?.secondary ? (
              <CodexWindowRow
                title={codexWindowTitle(codexUsage.secondary, "长期窗口")}
                window={codexUsage.secondary}
              />
            ) : null}
            {codexUsage?.error ? (
              <p className="select-text whitespace-pre-wrap break-words text-[10.5px] leading-snug text-destructive">
                {codexUsage.error}
              </p>
            ) : null}
            {codexUsage && !codexUsage.error ? (
              <p className="text-[10px] text-muted-foreground">
                {codexUsage.planType ? `${codexUsage.planType} · ` : ""}更新于{" "}
                {ageLabel(codexUsage.fetchedAt)}
              </p>
            ) : null}
          </UsageSection>

          <UsageSection title="Antigravity CLI">
            {agyUsage?.groups.map((group) => (
              <div key={group.name} className="flex flex-col gap-1.5">
                <span className="text-[10.5px] font-medium">{group.name}</span>
                {group.fiveHour && (
                  <AgyWindowRow label="5 小时窗口" window={group.fiveHour} />
                )}
                {group.week && (
                  <AgyWindowRow label="周窗口" window={group.week} />
                )}
              </div>
            ))}
            {agyUsage?.error && (
              <p className="select-text wrap-anywhere text-[10.5px] text-destructive">
                {agyUsage.error}
              </p>
            )}
            {agyUsage && !agyUsage.error && (
              <p className="text-[10px] text-muted-foreground">
                更新于 {ageLabel(agyUsage.fetchedAt)}
              </p>
            )}
          </UsageSection>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UsageBadge({
  letter,
  agent,
  shortPercent,
  shortReset,
  weekPercent,
  weekReset,
  error,
}: {
  letter: string;
  agent: string;
  shortPercent: number | null;
  shortReset: string | null;
  weekPercent: number | null;
  weekReset: string | null;
  error: boolean;
}) {
  const percentLabel = (percent: number | null) =>
    percent === null ? "--" : `${percent}%`;
  const title = [
    `${agent}${error ? " · 更新失败" : ""}`,
    `5 小时 ${percentLabel(shortPercent)}（${shortReset ?? "--"} 重置）`,
    `周 ${percentLabel(weekPercent)}（${weekReset ?? "--"} 重置）`,
  ].join("\n");
  return (
    <span
      aria-hidden="true"
      className={`relative grid size-6 shrink-0 place-items-center overflow-hidden rounded-md border ${error ? "border-destructive/75" : "border-border"}`}
      title={title}
    >
      <span className="absolute inset-0 grid grid-rows-2 gap-px bg-border/80">
        {[shortPercent, weekPercent].map((percent, index) => (
          <span
            key={index === 0 ? "5h" : "week"}
            className="block bg-background"
          >
            {percent === null ? null : (
              <span
                className={`block h-full opacity-45 dark:opacity-65 ${barOf(percent)}`}
                style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
              />
            )}
          </span>
        ))}
      </span>
      <span className="relative text-xs font-semibold text-foreground">
        {letter}
      </span>
    </span>
  );
}

function UsageSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-t border-border/60 pt-2">
      <span className="text-[10.5px] font-medium text-muted-foreground">
        {title}
      </span>
      {children}
    </section>
  );
}

function WindowRow({ title, window }: { title: string; window: UsageWindow }) {
  const percent = window.percent;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-foreground">{title}</span>
        <span className={`text-[11px] tabular-nums ${toneOf(percent)}`}>
          {percent === null ? "未知" : `${percent}%`}
        </span>
      </div>
      {percent === null ? null : (
        <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/10">
          <div
            className={`h-full rounded-full ${barOf(percent)}`}
            style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
          />
        </div>
      )}
      {window.resets ? (
        <span className="select-text text-[10px] text-muted-foreground">
          {window.resets} 重置
        </span>
      ) : null}
    </div>
  );
}

function AgyWindowRow({
  label,
  window,
}: {
  label: string;
  window: AgyQuotaWindow;
}) {
  return (
    <WindowRow
      title={label}
      window={{
        label,
        percent: window.percent,
        resets: codexResetLabel(agyResetSeconds(window.resetsAt)),
      }}
    />
  );
}

function CodexWindowRow({
  title,
  window,
}: {
  title: string;
  window: CodexUsageWindow;
}) {
  const percent = window.usedPercent;
  const reset = codexResetLabel(window.resetsAt);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-foreground">{title}</span>
        <span className={`text-[11px] tabular-nums ${toneOf(percent)}`}>
          {percent === null ? "未知" : `${percent}%`}
        </span>
      </div>
      {percent === null ? null : (
        <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/10">
          <div
            className={`h-full rounded-full ${barOf(percent)}`}
            style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
          />
        </div>
      )}
      {reset ? (
        <span className="text-[10px] text-muted-foreground">{reset} 重置</span>
      ) : null}
    </div>
  );
}
