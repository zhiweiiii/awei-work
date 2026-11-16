import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorToast } from "@/lib/errorToast";
import {
  leafCwd,
  leafHasForegroundProcess,
  liveLeafIds,
  respawnSession,
} from "@/modules/terminal";
import {
  clearGatewayPin,
  gatewayPin,
  setGatewayPin,
} from "@/modules/terminal/lib/gatewayPins";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type ClaudeApiFormat,
  type ClaudeAuthStyle,
  type ClaudeGatewayConfig,
  type ClaudeProvider,
  EMPTY_MODEL_ROUTES,
  setClaudeGateway,
} from "@/modules/settings/store";
import {
  Add01Icon,
  Copy01Icon,
  Delete02Icon,
  PencilEdit02Icon,
  SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type GatewayStatus = {
  running: boolean;
  origin: string;
  providerUrlPrefix: string;
  token: string;
  activeRequests: number;
  current: string | null;
};

type TestResult = {
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  model: string | null;
  message: string;
};

type Draft = {
  id: string | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: ClaudeApiFormat;
  authStyle: ClaudeAuthStyle;
  models: { default: string; opus: string; sonnet: string; haiku: string };
  /** Text in the input, so it can be cleared; parsed on save. */
  contextWindow: string;
};

/** Parse the context-window input. Empty or unparseable is "no opinion", which
 *  leaves Claude Code on its own 200k assumption rather than guessing for the
 *  user. */
function parseContextWindow(text: string): number | null {
  const value = Number.parseInt(text.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  baseUrl: "",
  apiKey: "",
  apiFormat: "openai_chat",
  authStyle: "bearer",
  models: { ...EMPTY_MODEL_ROUTES },
  contextWindow: "",
};

/**
 * Everything about a known relay except its key.
 *
 * OpenCode Zen serves the Go plan on two endpoints. The one taken here is the
 * OpenAI Chat side: the Anthropic side leaves the Chat-group models (GLM,
 * DeepSeek, Kimi, MiMo) depending on a server side conversion the plan does not
 * document, whereas converting locally is the thing this gateway exists to do.
 * Roles are mapped by capability: the reasoning models to Opus, the fast ones to
 * Haiku.
 */
const PRESETS: { label: string; draft: Draft }[] = [
  {
    label: "OpenCode Go",
    draft: {
      id: null,
      name: "OpenCode Go",
      baseUrl: "https://opencode.ai/inference/go/openai/v1",
      apiKey: "",
      apiFormat: "openai_chat",
      authStyle: "bearer",
      models: {
        default: "deepseek-v4.1-flash",
        opus: "deepseek-v4-pro",
        sonnet: "deepseek-v4.1-flash",
        haiku: "deepseek-v4.1-flash",
      },
      // The plan's models are 128k, not the 200k Claude Code would assume for
      // a name it does not know.
      contextWindow: "128000",
    },
  },
];

type Props = {
  /** The terminal the status bar is describing. Null when there is none. */
  leafId: number | null;
};

/**
 * Choose which relay Claude Code talks to, per terminal.
 *
 * Selecting one points that shell at the local gateway rather than at the relay,
 * so a provider that speaks OpenAI Chat Completions is usable from a client that
 * only speaks Anthropic Messages. The provider id is pinned into the URL, so
 * choosing a different one in another terminal does not redirect this one. As
 * before the variables live in that one shell, so a Claude Code that is already
 * running keeps its old endpoint until it restarts.
 */
export function ClaudeProviderButton(props: Props) {
  return <ScopedClaudeProviderButton key={props.leafId ?? "none"} {...props} />;
}

function ScopedClaudeProviderButton({ leafId }: Props) {
  const config = usePreferencesStore((s) => s.claudeGateway);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const statusRequestRef = useRef(0);
  const testRequestRef = useRef(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      statusRequestRef.current++;
      testRequestRef.current++;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Editing the draft invalidates its previous probe result and pending response.
  useEffect(() => {
    testRequestRef.current++;
    setTest(null);
  }, [draft]);
  const startOperation = () => {
    if (!mountedRef.current || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  };
  const finishOperation = () => {
    busyRef.current = false;
    if (mountedRef.current) setBusy(false);
  };
  /* Bumped whenever the mapping changes, because a plain Map cannot tell React
     that this terminal's badge is now stale. */
  const [pinRevision, setPinRevision] = useState(0);

  const pinnedId = leafId === null ? undefined : gatewayPin(leafId);
  /* The relay this terminal actually uses: its own pin, else the app-wide
     choice. The panel has to answer with the second one too, or a
     globally-routed terminal would look unrouted. */
  const globalId = config.global;
  const globalProvider =
    config.providers.find((provider) => provider.id === globalId) ?? null;
  const effectiveId = pinnedId === undefined ? globalId : pinnedId;
  const effective =
    config.providers.find((provider) => provider.id === effectiveId) ?? null;
  const routedGlobally =
    pinnedId === undefined && effectiveId !== null && effective !== null;
  /* A provider deleted out from under a terminal leaves the shell pointing at
     a URL the gateway will answer with 503, which is worth showing. Only a
     pin can dangle: the global choice is validated against the list when it is
     read, so it cannot name something that is gone. */
  const orphaned =
    pinnedId !== undefined && pinnedId !== null && effective === null;

  const refreshStatus = async () => {
    const request = ++statusRequestRef.current;
    try {
      const status = await invoke<GatewayStatus>("gateway_status");
      if (mountedRef.current && statusRequestRef.current === request)
        setStatus(status);
    } catch (e) {
      if (mountedRef.current && statusRequestRef.current === request)
        errorToast("读取网关状态失败", e);
    }
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void refreshStatus();
    else {
      statusRequestRef.current++;
      testRequestRef.current++;
      setDraft(null);
      setTest(null);
    }
  };

  /** Restart one shell so it picks the routing currently recorded for it.
   *
   *  `pin` is what to write first: `undefined` leaves the terminal without an
   *  opinion (so the global choice applies), a string pins it, `null` opts this
   *  one terminal out of the global choice. */
  const applyToTerminal = async (
    pin: string | null | undefined,
  ): Promise<boolean> => {
    if (!mountedRef.current) return false;
    if (leafId === null) {
      toast.error("没有可用的命令行");
      return false;
    }
    if (await leafHasForegroundProcess(leafId)) {
      toast.error("命令行正在运行任务，请结束任务后再切换供应商");
      return false;
    }
    if (!mountedRef.current) return false;
    const previous = gatewayPin(leafId);
    if (pin === undefined) clearGatewayPin(leafId);
    else setGatewayPin(leafId, pin);
    setPinRevision((n) => n + 1);
    const restore = () => {
      if (previous === undefined) clearGatewayPin(leafId);
      else setGatewayPin(leafId, previous);
      if (mountedRef.current) setPinRevision((n) => n + 1);
    };
    try {
      if (!(await respawnSession(leafId, leafCwd(leafId) ?? undefined))) {
        restore();
        toast.error("命令行正在启动或未能启动，请稍后重试");
        return false;
      }
      return true;
    } catch (e) {
      restore();
      errorToast("重启命令行失败", e);
      return false;
    }
  };

  /** Persist, then hand the same config to Rust so the running gateway agrees
   *  with what is on disk. */
  const persist = async (next: ClaudeGatewayConfig): Promise<boolean> => {
    try {
      await setClaudeGateway(next);
      await invoke("gateway_set_config", { config: next });
      return true;
    } catch (e) {
      errorToast("保存供应商失败", e);
      return false;
    }
  };

  const select = async (provider: ClaudeProvider) => {
    if (!startOperation()) return;
    try {
      if (leafId === null || (await leafHasForegroundProcess(leafId))) {
        toast.error("请先选择一个空闲命令行");
        return;
      }
      if (!mountedRef.current) return;
      // Verify before rewiring the shell: switching to an endpoint that does
      // not answer would leave a terminal that looks configured and fails on
      // the first prompt.
      const probe = await invoke<TestResult>("gateway_test_provider", {
        provider,
      });
      if (!mountedRef.current) return;
      if (!probe.ok) {
        setTest(probe);
        errorToast(`${provider.name} 接口不可用，未切换`, probe.message);
        return;
      }
      const latest = usePreferencesStore.getState().claudeGateway;
      if (
        !latest.providers.some(
          (item) => JSON.stringify(item) === JSON.stringify(provider),
        )
      ) {
        toast.error("供应商配置已变化，请重新选择");
        return;
      }
      if (!(await persist({ ...latest, current: provider.id }))) return;
      if (!mountedRef.current) return;
      if (!(await applyToTerminal(provider.id))) return;
      await refreshStatus();
      if (!mountedRef.current) return;
      setOpen(false);
      toast.success(
        `本命令行已切换到 ${provider.name}（${probe.latencyMs}ms）`,
      );
    } catch (e) {
      errorToast("切换供应商失败", e);
    } finally {
      finishOperation();
    }
  };

  const deactivate = async () => {
    if (!startOperation()) return;
    try {
      // An explicit opt-out, not "follow the global choice": 停用 on a terminal
      // means this shell, so it stays unrouted after everything else was made
      // global.
      if (!(await applyToTerminal(null))) return;
      if (!mountedRef.current) return;
      setOpen(false);
      toast.success("本命令行已停用");
    } finally {
      finishOperation();
    }
  };

  /** Make one relay the default for every command line, now and later.
   *
   *  Turning it on writes the preference and clears the pins of the command
   *  lines that are not running anything, then restarts them, so the answer is
   *  the same whether a shell already existed or is opened tomorrow. A pin is
   *  only cleared for an idle terminal: killing a running agent to change its
   *  endpoint would lose work, and that terminal keeps its own pin anyway.
   *  Turning it off writes the preference and touches nothing already running;
   *  new shells simply stop being routed. */
  const toggleGlobal = async (provider: ClaudeProvider | null) => {
    if (!startOperation()) return;
    try {
      if (provider) {
        const probe = await invoke<TestResult>("gateway_test_provider", {
          provider,
        });
        if (!mountedRef.current) return;
        if (!probe.ok) {
          setTest(probe);
          errorToast(`${provider.name} 接口不可用，未全局启用`, probe.message);
          return;
        }
      }
      const latest = usePreferencesStore.getState().claudeGateway;
      const next: ClaudeGatewayConfig = {
        ...latest,
        global: provider?.id ?? null,
      };
      if (!(await persist(next))) return;
      if (!mountedRef.current) return;

      if (!provider) {
        toast.success("已停止全局转发，新命令行不再自动使用供应商");
        return;
      }

      let restarted = 0;
      let skipped = 0;
      for (const id of liveLeafIds()) {
        // A pin the user set on purpose outlives this; so does a busy shell.
        if (gatewayPin(id) !== undefined) continue;
        if (await leafHasForegroundProcess(id)) {
          skipped += 1;
          continue;
        }
        if (await respawnSession(id, leafCwd(id) ?? undefined)) restarted += 1;
      }
      if (!mountedRef.current) return;
      setOpen(false);
      toast.success(
        skipped > 0
          ? `已全局使用 ${provider.name}：重启 ${restarted} 个，${skipped} 个正在运行，未改动`
          : `已全局使用 ${provider.name}：${restarted} 个命令行已切换`,
      );
    } catch (e) {
      errorToast("设置全局转发失败", e);
    } finally {
      finishOperation();
    }
  };

  /** Drop this terminal's own pin and go back to whatever the app-wide choice
   *  is. Only meaningful when there is one, and only offered then. */
  const followGlobal = async () => {
    if (!startOperation()) return;
    try {
      if (!(await applyToTerminal(undefined))) return;
      if (!mountedRef.current) return;
      setOpen(false);
      toast.success("本命令行已跟随全局设置");
    } finally {
      finishOperation();
    }
  };

  /** Send one real minimal request. Reachability alone cannot tell a working
   *  configuration from a wrong key, a wrong path or a model the plan does not
   *  include, which is the whole question being asked here. */
  const runTest = async (provider: ClaudeProvider) => {
    if (!startOperation()) return;
    const request = ++testRequestRef.current;
    const submittedDraft = draft;
    setTesting(true);
    setTest(null);
    try {
      const result = await invoke<TestResult>("gateway_test_provider", {
        provider,
      });
      if (
        mountedRef.current &&
        testRequestRef.current === request &&
        draftRef.current === submittedDraft
      )
        setTest(result);
    } catch (e) {
      errorToast("测试失败", e);
    } finally {
      if (mountedRef.current) setTesting(false);
      finishOperation();
    }
  };

  const draftProvider = (): ClaudeProvider | null => {
    if (!draft) return null;
    return {
      id: draft.id ?? "draft",
      name: draft.name.trim() || draft.baseUrl.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      apiFormat: draft.apiFormat,
      authStyle: draft.authStyle,
      models: {
        default: draft.models.default.trim(),
        opus: draft.models.opus.trim(),
        sonnet: draft.models.sonnet.trim(),
        haiku: draft.models.haiku.trim(),
      },
      contextWindow: parseContextWindow(draft.contextWindow),
    };
  };

  const save = async () => {
    if (!draft) return;
    if (!startOperation()) return;
    const submittedDraft = draft;
    const name = draft.name.trim() || draft.baseUrl.trim();
    try {
      const provider: ClaudeProvider = {
        id: draft.id ?? crypto.randomUUID(),
        name,
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
        apiFormat: draft.apiFormat,
        authStyle: draft.authStyle,
        models: {
          default: draft.models.default.trim(),
          opus: draft.models.opus.trim(),
          sonnet: draft.models.sonnet.trim(),
          haiku: draft.models.haiku.trim(),
        },
        contextWindow: parseContextWindow(draft.contextWindow),
      };
      const latest = usePreferencesStore.getState().claudeGateway;
      if (draft.id && !latest.providers.some((item) => item.id === draft.id)) {
        toast.error("供应商已删除，无法覆盖");
        return;
      }
      const providers = draft.id
        ? latest.providers.map((p) => (p.id === draft.id ? provider : p))
        : [...latest.providers, provider];
      if ((await persist({ ...latest, providers })) && mountedRef.current)
        setDraft((current) => (current === submittedDraft ? null : current));
    } finally {
      finishOperation();
    }
  };

  const remove = async (provider: ClaudeProvider) => {
    if (!startOperation()) return;
    try {
      const latest = usePreferencesStore.getState().claudeGateway;
      const providers = latest.providers.filter((p) => p.id !== provider.id);
      await persist({
        providers,
        current: latest.current === provider.id ? null : latest.current,
        // Deleting the global relay stops the global choice. Leaving the id
        // behind would keep the setting alive but unnamed, and every new shell
        // would be routed to a provider the gateway cannot resolve.
        global: latest.global === provider.id ? null : latest.global,
      });
      if (mountedRef.current) setPinRevision((n) => n + 1);
    } finally {
      finishOperation();
    }
  };

  const canSave =
    draft !== null && draft.baseUrl.trim() !== "" && draft.apiKey.trim() !== "";

  return (
    <>
      <ProviderBadge
        key={pinRevision}
        name={effective?.name ?? null}
        global={routedGlobally}
        orphaned={orphaned}
      />
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            title="Claude Code 供应商"
            aria-label="Claude Code 供应商"
          >
            <HugeiconsIcon
              icon={SlidersHorizontalIcon}
              size={13}
              strokeWidth={2}
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          className="max-h-[70vh] w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto p-3"
        >
          <div className="flex flex-col gap-2.5">
            <p className="text-[10.5px] leading-snug text-muted-foreground">
              切换会发送一次测试请求并重启空闲命令行。运行任务时不可切换。
            </p>
            {config.providers.length === 0 && draft === null ? (
              <p className="text-[10.5px] leading-snug text-muted-foreground">
                还没有供应商。添加一个中转站，Claude Code
                就能通过本地网关使用它， OpenAI 格式的接口会自动转换。
              </p>
            ) : null}

            {config.providers.map((provider) => {
              const isGlobal = provider.id === globalId;
              const active = provider.id === effectiveId;
              return (
                <div
                  key={provider.id}
                  className="group flex items-center gap-1 rounded-md pr-1 hover:bg-foreground/[0.06]"
                >
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void select(provider)}
                    title="在当前命令行切换到这个供应商"
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left disabled:opacity-50"
                  >
                    <span
                      aria-hidden
                      className={`size-1.5 shrink-0 rounded-full ${
                        active
                          ? "bg-emerald-500"
                          : isGlobal
                            ? "bg-emerald-500/40"
                            : "bg-muted-foreground/30"
                      }`}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex w-full items-center gap-1.5 truncate text-[11px] text-foreground">
                        {provider.name}
                        {isGlobal ? <GlobalTag /> : null}
                      </span>
                      <span className="w-full truncate text-[10px] text-muted-foreground">
                        {provider.apiFormat === "openai_chat"
                          ? "OpenAI 格式转换"
                          : "Anthropic 直通"}
                        {" · "}
                        {provider.baseUrl}
                        {provider.contextWindow
                          ? ` · ${Math.round(provider.contextWindow / 1000)}k`
                          : ""}
                      </span>
                    </span>
                  </button>
                  {/* Shown on hover so a list of endpoints stays readable, but
                      kept in the tab order and visible on focus: hover-only
                      controls are unreachable from the keyboard. */}
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void toggleGlobal(isGlobal ? null : provider)
                      }
                      title={
                        isGlobal
                          ? "停止全局转发，新命令行不再自动使用它"
                          : "让所有命令行都用这个供应商，包括以后新开的"
                      }
                      className={`flex h-6 items-center gap-1 rounded px-1.5 text-[10px] ${
                        isGlobal
                          ? "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-400"
                          : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                      } disabled:opacity-50`}
                    >
                      {isGlobal ? "取消全局" : "全局"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setDraft({
                          ...provider,
                          id: provider.id,
                          contextWindow:
                            provider.contextWindow === null
                              ? ""
                              : String(provider.contextWindow),
                        })
                      }
                      title="编辑"
                      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
                    >
                      <HugeiconsIcon
                        icon={PencilEdit02Icon}
                        size={12}
                        strokeWidth={1.75}
                      />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(provider)}
                      title="删除"
                      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive disabled:opacity-50"
                    >
                      <HugeiconsIcon
                        icon={Delete02Icon}
                        size={12}
                        strokeWidth={1.75}
                      />
                    </button>
                  </span>
                </div>
              );
            })}

            {draft === null ? (
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 flex-1 justify-start gap-1.5 text-[11px]"
                  onClick={() => setDraft({ ...EMPTY_DRAFT })}
                >
                  <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
                  添加供应商
                </Button>
                {PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    size="sm"
                    variant="outline"
                    className="h-8 shrink-0 text-[11px]"
                    title={`填好 ${preset.label} 的参数，只需再补一个 API Key`}
                    onClick={() =>
                      setDraft({
                        ...preset.draft,
                        models: { ...preset.draft.models },
                      })
                    }
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2.5 border-t border-border/60 pt-2.5">
                <Field label="名称">
                  <Input
                    aria-label="名称"
                    className="h-8"
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                    placeholder="OpenCode Go"
                    spellCheck={false}
                  />
                </Field>
                <Field label="Base URL">
                  <Input
                    aria-label="Base URL"
                    className="h-8"
                    value={draft.baseUrl}
                    onChange={(e) =>
                      setDraft({ ...draft, baseUrl: e.target.value })
                    }
                    placeholder="https://opencode.ai/inference/go/openai/v1"
                    spellCheck={false}
                  />
                </Field>
                <Field label="API Key">
                  <Input
                    type="password"
                    aria-label="API Key"
                    className="h-8"
                    value={draft.apiKey}
                    onChange={(e) =>
                      setDraft({ ...draft, apiKey: e.target.value })
                    }
                    placeholder={
                      draft.baseUrl && !draft.apiKey
                        ? "只差这一项，填好就能用"
                        : "sk-..."
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="接口格式">
                    <Select
                      value={draft.apiFormat}
                      onValueChange={(v) =>
                        setDraft({ ...draft, apiFormat: v as ClaudeApiFormat })
                      }
                    >
                      <SelectTrigger
                        aria-label="接口格式"
                        className="h-8 w-full text-[11px]"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="openai_chat" className="text-[11px]">
                          OpenAI Chat
                        </SelectItem>
                        <SelectItem value="anthropic" className="text-[11px]">
                          Anthropic
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="认证方式">
                    <Select
                      value={draft.authStyle}
                      onValueChange={(v) =>
                        setDraft({ ...draft, authStyle: v as ClaudeAuthStyle })
                      }
                    >
                      <SelectTrigger
                        aria-label="认证方式"
                        className="h-8 w-full text-[11px]"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="bearer" className="text-[11px]">
                          Bearer
                        </SelectItem>
                        <SelectItem value="api_key" className="text-[11px]">
                          x-api-key
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <Field label="默认模型">
                  <Input
                    aria-label="默认模型"
                    className="h-8"
                    value={draft.models.default}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        models: { ...draft.models, default: e.target.value },
                      })
                    }
                    placeholder="deepseek-v4.1-flash"
                    spellCheck={false}
                  />
                </Field>
                <Field label="上下文窗口（tokens）">
                  <Input
                    aria-label="上下文窗口"
                    className="h-8"
                    inputMode="numeric"
                    value={draft.contextWindow}
                    onChange={(e) =>
                      setDraft({ ...draft, contextWindow: e.target.value })
                    }
                    placeholder="留空按 Claude Code 默认（200k）"
                    spellCheck={false}
                  />
                  <span className="text-[10px] leading-snug text-muted-foreground">
                    中转站模型的真实上限，比如 128000。填小了会提早在压缩，
                    填大了仍会被上游拒绝。
                  </span>
                </Field>
                <div className="grid grid-cols-3 gap-2">
                  {(["opus", "sonnet", "haiku"] as const).map((role) => (
                    <Field key={role} label={ROLE_LABELS[role]}>
                      <Input
                        aria-label={`${ROLE_LABELS[role]} 模型`}
                        className="h-8"
                        value={draft.models[role]}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            models: { ...draft.models, [role]: e.target.value },
                          })
                        }
                        placeholder="沿用默认"
                        spellCheck={false}
                      />
                    </Field>
                  ))}
                </div>
                <p className="text-[10.5px] leading-snug text-muted-foreground">
                  Opus、Sonnet、Haiku 请求按对应项转发，留空沿用默认。 Claude
                  Code
                  直接指定这里已配置的上游模型时保留原名；其他名称走默认模型。
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={busy || testing || !canSave}
                    onClick={() => void save()}
                  >
                    保存
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || testing || !canSave}
                    onClick={() => {
                      const provider = draftProvider();
                      if (provider) void runTest(provider);
                    }}
                  >
                    {testing ? "测试中" : "测试"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || testing}
                    onClick={() => {
                      setDraft(null);
                      setTest(null);
                    }}
                  >
                    取消
                  </Button>
                </div>
              </div>
            )}

            {test ? <TestLine result={test} /> : null}

            <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2">
              <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                {status === null
                  ? "网关状态暂不可用"
                  : status.running
                    ? globalProvider
                      ? `网关 ${status.origin} · 全局使用 ${globalProvider.name}`
                      : `网关 ${status.origin} · 只作用于当前命令行`
                    : "网关未启动，选择供应商后自动开启"}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {/* Offered when the terminal has a pin of its own, which is
                    what keeps it off the app-wide choice. */}
                {pinnedId !== undefined && globalProvider ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-2 text-[10.5px]"
                    disabled={busy}
                    title={`取消本命令行的单独设置，跟随全局的 ${globalProvider.name}`}
                    onClick={() => void followGlobal()}
                  >
                    跟随全局
                  </Button>
                ) : null}
                {effectiveId !== null ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-2 text-[10.5px]"
                    disabled={busy}
                    onClick={() => void deactivate()}
                  >
                    停用
                  </Button>
                ) : null}
              </span>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

/** What the current terminal is routed through. Absent when it is not routed,
 *  which keeps the bar quiet for anyone not using this. */
function ProviderBadge({
  name,
  global,
  orphaned,
}: {
  name: string | null;
  /** Routed by the app-wide choice rather than this terminal's own pin. */
  global: boolean;
  orphaned: boolean;
}) {
  if (!name && !orphaned) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`flex max-w-40 shrink-0 cursor-default items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
            orphaned
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
              : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          }`}
        >
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${
              orphaned ? "bg-amber-500" : "bg-emerald-500"
            }`}
          />
          <span className="truncate">{orphaned ? "供应商已删除" : name}</span>
          {global && !orphaned ? <GlobalTag /> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-64 text-[11px] leading-relaxed"
      >
        {orphaned
          ? "这个命令行仍指向一个已删除的供应商，请重新选择一个。"
          : global
            ? `所有命令行都在走 ${name}（全局），包括以后新开的。`
            : `这个命令行的 Claude Code 正走 ${name}，其他命令行不受影响。`}
      </TooltipContent>
    </Tooltip>
  );
}

/** Marks a relay that is the app-wide default. Small and quiet: it is on every
 *  routed terminal, so it should not compete with the name it qualifies. */
function GlobalTag() {
  return (
    <span
      className="shrink-0 rounded bg-foreground/10 px-1 text-[9px] font-normal leading-4 text-muted-foreground"
      title="全局供应商：所有命令行都用它"
    >
      全局
    </span>
  );
}

/** The outcome of a probe, said plainly: latency when it worked, the relay's
 *  own reason when it did not.
 *
 *  A failure carries the upstream's own wording, often with a request id the
 *  user has to quote to their provider, so the text is selectable and has a
 *  copy action. Selection is opt-in because the panel sits inside a popover
 *  whose surrounding chrome is not meant to be dragged over.
 */
function TestLine({ result }: { result: TestResult }) {
  const text = result.ok
    ? `${result.message} · ${result.latencyMs}ms`
    : result.message;
  const copy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() =>
        toast.success("已复制", { position: "top-right", duration: 1500 }),
      )
      .catch(() => toast.error("复制失败", { position: "top-right" }));
  };
  return (
    <div
      className={`flex items-start gap-1.5 ${
        result.ok
          ? "text-emerald-700 dark:text-emerald-400"
          : "text-destructive"
      }`}
    >
      <p className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words text-[10.5px] leading-snug">
        {text}
      </p>
      <button
        type="button"
        onClick={copy}
        title="复制"
        className="flex size-5 shrink-0 items-center justify-center rounded opacity-70 hover:bg-foreground/10 hover:opacity-100"
      >
        <HugeiconsIcon icon={Copy01Icon} size={11} strokeWidth={1.75} />
      </button>
    </div>
  );
}

const ROLE_LABELS = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" } as const;

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px]">{label}</span>
      {children}
    </div>
  );
}
