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
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
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

type QuotaHint = { percent: number | null; reset: string | null };
type UsageSummary = {
  letter: "C" | "O" | "A";
  agent: string;
  short: QuotaHint;
  week: QuotaHint;
  error: string | null;
};
type PanelMode = "preview" | "pinned" | null;

const QUOTA_WINDOWS = ["short", "week"] as const;
const QUOTA_LABELS = { short: "5 小时", week: "本周" } as const;
const EMPTY_AGY_GROUPS: AgyQuotaGroup[] = [
  { name: "Gemini Models", fiveHour: null, week: null },
  { name: "Claude and GPT models", fiveHour: null, week: null },
];
const QUOTA_GLYPHS = {
  C: "M71 19a25 25 0 1 0 0 38",
  O: "M48 13a25 25 0 1 1 0 50a25 25 0 1 1 0-50",
  A: "M23 63 48 13 73 63M32 46h32",
} as const;

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

function percentLabel(percent: number | null) {
  return percent === null ? "--" : `${percent}%`;
}

function clampPercent(percent: number) {
  return Math.max(0, Math.min(100, percent));
}

function resetHint(day: number | null, hour: number, minute: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(hour)}:${pad(minute)}`;
  return day === null ? clock : `${pad(day)}号${clock}`;
}

function epochResetHint(
  resetsAt: number | null,
  includeDay = true,
): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
  const date = new Date(resetsAt * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  return resetHint(
    includeDay ? date.getDate() : null,
    date.getHours(),
    date.getMinutes(),
  );
}

function agyResetSeconds(value: string | null | undefined): number | null {
  const epoch = value ? Date.parse(value) : NaN;
  return epoch > 0 && Number.isFinite(epoch) ? epoch / 1000 : null;
}

function agyGroupLabel(name: string): string {
  switch (name.toLowerCase()) {
    case "gemini models":
      return "Anti · Gemini";
    case "claude and gpt models":
      return "Anti · Claude / GPT";
    default:
      return `Anti · ${name}`;
  }
}

function agyQuotaHint(
  window: AgyQuotaWindow | null,
  includeDay: boolean,
): QuotaHint {
  return {
    percent: window?.percent ?? null,
    reset: epochResetHint(agyResetSeconds(window?.resetsAt), includeDay),
  };
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
  includeDay = true,
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
  if (!includeDay) return resetHint(null, hour24, minute);
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
  const [mode, setMode] = useState<PanelMode>(null);
  const previewTimer = useRef<number | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [claudeUsage, setClaudeUsage] = useState<ClaudeUsage | null>(null);
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>(null);
  const [agyUsage, setAgyUsage] = useState<AgyUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const revisionRef = useRef(0);
  const mountedRef = useRef(true);
  const cancelPreviewTimer = useCallback(() => {
    window.clearTimeout(previewTimer.current);
  }, []);

  useEffect(() => cancelPreviewTimer, [cancelPreviewTimer]);

  const schedulePreview = (next: "preview" | null) => {
    cancelPreviewTimer();
    previewTimer.current = window.setTimeout(
      () => setMode((current) => (current === "pinned" ? current : next)),
      next ? 160 : 200,
    );
  };

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
      const agyResult =
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

  const session = claudeUsage?.session ?? null;
  const claudeShortReset = claudeResetHint(
    session?.resets ?? null,
    claudeUsage?.fetchedAt ?? Number.NaN,
    false,
  );
  const primaryWeek =
    claudeUsage?.weeks.find(
      (week) => week.label.toLowerCase() === "all models",
    ) ??
    claudeUsage?.weeks[0] ??
    null;
  const codexFiveHour = [codexUsage?.primary, codexUsage?.secondary].find(
    (window) => window?.windowDurationMins === 300,
  );
  const codexWeek = [codexUsage?.primary, codexUsage?.secondary].find(
    (window) => window?.windowDurationMins === 10080,
  );
  const agyGroups = agyUsage?.groups.length
    ? agyUsage.groups
    : EMPTY_AGY_GROUPS;
  const summaries: UsageSummary[] = [
    {
      letter: "C",
      agent: "Claude Code",
      short: {
        percent: session?.percent ?? null,
        reset: claudeShortReset,
      },
      week: {
        percent: primaryWeek?.percent ?? null,
        reset: claudeResetHint(
          primaryWeek?.resets ?? null,
          claudeUsage?.fetchedAt ?? Number.NaN,
        ),
      },
      error: claudeUsage?.error ?? null,
    },
    {
      letter: "O",
      agent: "Codex",
      short: {
        percent: codexFiveHour?.usedPercent ?? null,
        reset: epochResetHint(codexFiveHour?.resetsAt ?? null, false),
      },
      week: {
        percent: codexWeek?.usedPercent ?? null,
        reset: epochResetHint(codexWeek?.resetsAt ?? null),
      },
      error: codexUsage?.error ?? null,
    },
    ...agyGroups.map<UsageSummary>((group) => ({
      letter: "A",
      agent: agyGroupLabel(group.name),
      short: agyQuotaHint(group.fiveHour, false),
      week: agyQuotaHint(group.week, true),
      error: agyUsage?.error ?? null,
    })),
  ];

  return (
    <Popover
      open={mode !== null}
      onOpenChange={(next) => {
        if (!next) {
          cancelPreviewTimer();
          setMode(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="sm"
          className="h-7 gap-1 rounded-md px-0.5"
          aria-label="Claude Code、Codex 与 Antigravity CLI 用量"
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") schedulePreview("preview");
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== "touch") schedulePreview(null);
          }}
          onFocus={(event) => {
            if (event.currentTarget.matches(":focus-visible")) {
              schedulePreview("preview");
            }
          }}
          onBlur={(event) => {
            if (!panelRef.current?.contains(event.relatedTarget)) {
              schedulePreview(null);
            }
          }}
          onClick={(event) => {
            event.preventDefault();
            cancelPreviewTimer();
            setMode(mode === "pinned" ? null : "pinned");
            if (mode !== "pinned") void load(false);
          }}
        >
          {summaries.map((summary) => (
            <UsageBadge key={summary.agent} summary={summary} />
          ))}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={panelRef}
        aria-label="模型用量"
        align="end"
        side="top"
        sideOffset={8}
        collisionPadding={8}
        className="@container max-h-(--radix-popover-content-available-height) w-[52rem] max-w-[calc(100vw-1rem)] gap-1 overflow-y-auto rounded-2xl border border-border/80 p-2 shadow-xl motion-reduce:animate-none! motion-reduce:transition-none"
        onPointerEnter={cancelPreviewTimer}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") schedulePreview(null);
        }}
        onFocus={cancelPreviewTimer}
        onBlur={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget) &&
            event.relatedTarget !== triggerRef.current
          ) {
            schedulePreview(null);
          }
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => {
          if (panelRef.current?.contains(document.activeElement)) {
            triggerRef.current?.focus();
          }
        }}
      >
        <div className="grid grid-cols-2 gap-1.5 @min-[46rem]:grid-cols-4">
          {summaries.map((summary) => (
            <UsageCard key={summary.agent} summary={summary} />
          ))}
        </div>
        <div className="flex justify-end">
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
              className={busy ? "motion-safe:animate-spin" : undefined}
            />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UsageBadge({ summary }: { summary: UsageSummary }) {
  return (
    <span
      aria-hidden="true"
      className={
        "inline-flex size-6 shrink-0 items-center justify-center " +
        (summary.error ? "rounded-sm ring-1 ring-destructive/75" : "")
      }
    >
      <QuotaGlyph summary={summary} compact />
    </span>
  );
}

function UsageCard({ summary }: { summary: UsageSummary }) {
  return (
    <section
      aria-label={summary.agent}
      className="@container flex min-w-0 flex-col rounded-xl bg-muted/50 p-2"
    >
      <p className="truncate text-center text-xs font-semibold">
        {summary.agent}
      </p>
      {summary.letter === "C" ? (
        <div className="mt-1 grid justify-items-center gap-1">
          <QuotaClock period="short" quota={summary.short} />
          <QuotaGlyph summary={summary} />
          <QuotaClock period="week" quota={summary.week} />
        </div>
      ) : (
        <div className="mt-1 grid flex-1 grid-cols-2 items-center gap-x-1.5 gap-y-1 @min-[11rem]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <QuotaClock
            period="short"
            quota={summary.short}
            stacked
            className="col-start-1 row-start-2 @min-[11rem]:row-start-1"
          />
          <div className="col-span-2 col-start-1 row-start-1 flex justify-center @min-[11rem]:col-span-1 @min-[11rem]:col-start-2">
            <QuotaGlyph summary={summary} />
          </div>
          <QuotaClock
            period="week"
            quota={summary.week}
            stacked
            className="col-start-2 row-start-2 @min-[11rem]:col-start-3 @min-[11rem]:row-start-1"
          />
        </div>
      )}
      {summary.error && (
        <p
          className="mt-1 text-center text-[11px] text-destructive"
          title={summary.error}
        >
          更新失败
        </p>
      )}
    </section>
  );
}

function QuotaClock({
  period,
  quota,
  stacked = false,
  className = "",
}: {
  period: (typeof QUOTA_WINDOWS)[number];
  quota: QuotaHint;
  stacked?: boolean;
  className?: string;
}) {
  return (
    <div
      className={
        (stacked
          ? "flex flex-col items-center justify-center gap-0.5 "
          : "flex items-center justify-center gap-x-1.5 ") +
        "whitespace-nowrap text-[10px] leading-4 " +
        className
      }
    >
      <span className="text-muted-foreground">{QUOTA_LABELS[period]}</span>
      <span
        className={`text-[11px] font-semibold tabular-nums ${toneOf(quota.percent)}`}
      >
        {percentLabel(quota.percent)}
      </span>
      <span className="tabular-nums text-muted-foreground">
        {quota.reset ?? "--"}
      </span>
    </div>
  );
}

function QuotaGlyph({
  summary,
  compact = false,
}: {
  summary: UsageSummary;
  compact?: boolean;
}) {
  const maskId = useId();
  const stacked = summary.letter === "C";
  return (
    <svg
      aria-hidden="true"
      viewBox="15 5 66 66"
      className={compact ? "block size-[22px]" : "block size-14 shrink-0"}
    >
      <mask
        id={maskId}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="96"
        height="76"
      >
        <path
          d={QUOTA_GLYPHS[summary.letter]}
          fill="none"
          stroke="white"
          strokeWidth="12"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        {QUOTA_WINDOWS.map((period) => {
          const { percent } = summary[period];
          // Match each glyph's actual stroked bounds (strokeWidth=12):
          // C spans x=23.75..77, y=7..69; O and A span x=17..79, y=7..69.
          const rect = stacked
            ? {
                x: 23.75,
                y: period === "short" ? 7 : 38.5,
                width: 53.25,
                height: 30.5,
              }
            : {
                x: period === "short" ? 17 : 48.5,
                y: 7,
                width: 30.5,
                height: 62,
              };
          return (
            <g key={period}>
              <rect {...rect} className="fill-foreground/15" />
              {percent === null ? null : (
                <rect
                  {...rect}
                  style={
                    {
                      "--quota-scale": clampPercent(percent) / 100,
                    } as CSSProperties
                  }
                  className={`fill-current [transform-box:fill-box] motion-safe:transition-transform motion-safe:duration-500 ${toneOf(percent)} ${stacked ? "origin-left scale-x-[var(--quota-scale)] motion-safe:starting:scale-x-0" : "origin-bottom scale-y-[var(--quota-scale)] motion-safe:starting:scale-y-0"}`}
                />
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
