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
  leafGatewayRoutes,
  leafHasForegroundProcess,
  liveLeafIds,
  respawnSession,
} from "@/modules/terminal";
import {
  type GatewayAgent,
  type GatewayRoutes,
  globalGatewayRoute,
  resolvedGatewayRoutes,
  supportsGatewayAgent,
  syncGatewayConfig,
} from "@/modules/terminal/lib/gatewayRoutes";
import { leafIds } from "@/modules/terminal/lib/panes";
import type { TerminalTab } from "@/modules/tabs";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type ClaudeApiFormat,
  type ClaudeAuthStyle,
  type ClaudeGatewayConfig,
  type ClaudeProvider,
  DEFAULT_PREFERENCES,
  EMPTY_MODEL_ROUTES,
  setClaudeGateway,
} from "@/modules/settings/store";
import { normalizePreference } from "@/modules/settings/validation";
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
  project: TerminalTab | null;
  onChangeProjectRoutes: (id: number, routes: GatewayRoutes) => boolean;
};
const AGENT_LABELS = { claude: "Claude Code", codex: "Codex" } as const;
const FORMATS = {
  anthropic: "Anthropic Messages",
  openai_chat: "OpenAI Chat",
  openai_responses: "OpenAI Responses",
} as const;

async function restartIdleLeaves(leaves: number[]): Promise<number> {
  let pending = 0;
  for (const id of leaves) {
    if (await leafHasForegroundProcess(id)) {
      pending += 1;
    } else if (!(await respawnSession(id, leafCwd(id) ?? undefined))) {
      pending += 1;
    }
  }
  return pending;
}

export function ModelGatewayButton(props: Props) {
  return (
    <ScopedModelGatewayButton key={props.project?.id ?? "none"} {...props} />
  );
}

function ScopedModelGatewayButton({ project, onChangeProjectRoutes }: Props) {
  const config = usePreferencesStore((s) => s.claudeGateway);
  const [agent, setAgent] = useState<GatewayAgent>("claude");
  const [scope, setScope] = useState<"project" | "global">(
    project ? "project" : "global",
  );
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
  const projectRoute = project?.gatewayRoutes?.[agent];
  const globalId = globalGatewayRoute(config, agent);
  const effectiveId = projectRoute === undefined ? globalId : projectRoute;
  const effective = config.providers.find(
    (provider) =>
      provider.id === effectiveId && supportsGatewayAgent(provider, agent),
  );
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

  const persist = async (next: ClaudeGatewayConfig): Promise<boolean> => {
    try {
      const normalized = normalizePreference(
        "claudeGateway",
        next,
        DEFAULT_PREFERENCES,
      ) as ClaudeGatewayConfig;
      await setClaudeGateway(normalized);
      usePreferencesStore.setState({ claudeGateway: normalized });
      await syncGatewayConfig(normalized);
      return true;
    } catch (error) {
      errorToast("保存供应商失败", error);
      return false;
    }
  };

  const applyRoute = async (
    scope: "project" | "global",
    provider: ClaudeProvider | null | undefined,
  ) => {
    if (scope === "project" && !project) return;
    if (!startOperation()) return;
    try {
      if (provider) {
        const probe = await invoke<TestResult>("gateway_test_provider", {
          provider,
        });
        if (!mountedRef.current) return;
        if (!probe.ok) {
          setTest(probe);
          errorToast(`${provider.name} 接口不可用`, probe.message);
          return;
        }
      }
      const latest = usePreferencesStore.getState().claudeGateway;
      if (
        provider &&
        !latest.providers.some(
          (item) => JSON.stringify(item) === JSON.stringify(provider),
        )
      ) {
        toast.error("供应商配置已变化，请重新选择");
        return;
      }

      let leaves: number[];
      if (scope === "global") {
        const key = agent === "codex" ? "codexGlobal" : "global";
        const next = { ...latest, [key]: provider?.id ?? null };
        if (!(await persist(next))) return;
        leaves = liveLeafIds().filter(
          (id) => leafGatewayRoutes(id)?.[agent] === undefined,
        );
      } else {
        if (!project) return;
        await syncGatewayConfig(latest);
        if (!mountedRef.current) return;
        const routes = { ...project.gatewayRoutes };
        if (provider === undefined) delete routes[agent];
        else routes[agent] = provider?.id ?? null;
        if (!onChangeProjectRoutes(project.id, routes)) return;
        leaves = leafIds(project.paneTree);
      }

      const pending = await restartIdleLeaves(leaves);
      if (!mountedRef.current) return;
      await refreshStatus();
      const description =
        pending > 0 ? `${pending} 个命令行将在重开后应用` : undefined;
      toast.success(
        `${AGENT_LABELS[agent]} · ${scope === "project" ? "当前项目" : "全局"}已更新`,
        { description },
      );
    } catch (error) {
      errorToast("更新模型代理失败", error);
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
      const previous = latest.providers.find((item) => item.id === draft.id);
      if (draft.id && !previous) {
        toast.error("供应商已删除，无法覆盖");
        return;
      }
      const providers = draft.id
        ? latest.providers.map((p) => (p.id === draft.id ? provider : p))
        : [...latest.providers, provider];
      if (!(await persist({ ...latest, providers }))) return;
      if (mountedRef.current)
        setDraft((current) => (current === submittedDraft ? null : current));
      if (
        previous &&
        (previous.apiFormat !== provider.apiFormat ||
          previous.contextWindow !== provider.contextWindow ||
          (provider.apiFormat === "openai_responses" &&
            previous.models.default !== provider.models.default))
      ) {
        const affected = liveLeafIds().filter((id) => {
          const routes = resolvedGatewayRoutes(latest, leafGatewayRoutes(id));
          return routes.claude === provider.id || routes.codex === provider.id;
        });
        const pending = await restartIdleLeaves(affected);
        if (pending > 0)
          toast.info(`${pending} 个命令行将在重开后应用供应商配置`);
      }
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
        codexGlobal:
          latest.codexGlobal === provider.id ? null : latest.codexGlobal,
      });
    } finally {
      finishOperation();
    }
  };

  const canSave =
    draft !== null &&
    draft.baseUrl.trim() !== "" &&
    draft.apiKey.trim() !== "" &&
    (draft.apiFormat !== "openai_responses" ||
      draft.models.default.trim() !== "");

  return (
    <>
      {(["claude", "codex"] as const).map((kind) => {
        const override = project?.gatewayRoutes?.[kind];
        const id =
          override === undefined ? globalGatewayRoute(config, kind) : override;
        const provider = config.providers.find(
          (item) => item.id === id && supportsGatewayAgent(item, kind),
        );
        return (
          <ProviderBadge
            key={kind}
            agent={kind}
            name={provider?.name ?? null}
            global={override === undefined}
            orphaned={!!id && !provider}
          />
        );
      })}
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            title="模型网关"
            aria-label="模型网关"
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
            <div className="grid grid-cols-2 gap-2">
              <Field label="客户端">
                <Select
                  value={agent}
                  onValueChange={(value) => setAgent(value as GatewayAgent)}
                  disabled={busy}
                >
                  <SelectTrigger
                    aria-label="代理客户端"
                    className="h-8 w-full text-[11px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Claude Code</SelectItem>
                    <SelectItem value="codex">Codex</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="代理范围">
                <Select
                  value={scope}
                  onValueChange={(value) =>
                    setScope(value as "project" | "global")
                  }
                  disabled={busy}
                >
                  <SelectTrigger
                    aria-label="代理范围"
                    className="h-8 w-full text-[11px]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="project" disabled={!project}>
                      当前项目
                    </SelectItem>
                    <SelectItem value="global">全局</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {scope === "project" && project && (
              <p
                className="truncate text-[10.5px] text-muted-foreground"
                title={project.title}
              >
                {project.title}
              </p>
            )}
            {draft === null &&
            !config.providers.some((provider) =>
              supportsGatewayAgent(provider, agent),
            ) ? (
              <p className="text-[10.5px] leading-snug text-muted-foreground">
                {agent === "codex"
                  ? "为 Codex 添加支持 OpenAI Responses 的供应商。"
                  : "为 Claude Code 添加 Anthropic Messages 或 OpenAI Chat 供应商。"}
              </p>
            ) : null}

            {config.providers.map((provider) => {
              const isGlobal = provider.id === globalId;
              const compatible = supportsGatewayAgent(provider, agent);
              const active =
                provider.id === (scope === "global" ? globalId : effectiveId);
              return (
                <div
                  key={provider.id}
                  className="group flex items-center gap-1 rounded-md pr-1 hover:bg-foreground/[0.06]"
                >
                  <button
                    type="button"
                    disabled={busy || !compatible}
                    onClick={() => void applyRoute(scope, provider)}
                    title={
                      compatible
                        ? `为${scope === "project" ? "当前项目" : "全局"}启用 ${AGENT_LABELS[agent]} 代理`
                        : `此接口格式不适用于 ${AGENT_LABELS[agent]}`
                    }
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
                        {FORMATS[provider.apiFormat]}
                        {" · "}
                        {provider.models.default || provider.baseUrl}
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
                  onClick={() =>
                    setDraft({
                      ...EMPTY_DRAFT,
                      apiFormat:
                        agent === "codex"
                          ? "openai_responses"
                          : EMPTY_DRAFT.apiFormat,
                    })
                  }
                >
                  <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
                  添加供应商
                </Button>
                {agent === "claude" &&
                  PRESETS.map((preset) => (
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
                        <SelectItem
                          value="openai_responses"
                          className="text-[11px]"
                        >
                          OpenAI Responses（Codex）
                        </SelectItem>
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
                    placeholder="留空采用客户端默认值"
                    spellCheck={false}
                  />
                  <span className="text-[10px] leading-snug text-muted-foreground">
                    中转站模型的真实上限，比如 128000。填小了会提早在压缩，
                    填大了仍会被上游拒绝。
                  </span>
                </Field>
                {draft.apiFormat !== "openai_responses" && (
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
                              models: {
                                ...draft.models,
                                [role]: e.target.value,
                              },
                            })
                          }
                          placeholder="沿用默认"
                          spellCheck={false}
                        />
                      </Field>
                    ))}
                  </div>
                )}
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
                    ? effective
                      ? `${AGENT_LABELS[agent]} · ${effective.name}`
                      : `网关 ${status.origin}`
                    : "网关未启动，选择供应商后自动开启"}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {scope === "project" && projectRoute !== undefined ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-2 text-[10.5px]"
                    disabled={busy}
                    onClick={() => void applyRoute("project", undefined)}
                  >
                    跟随全局
                  </Button>
                ) : null}
                {(
                  scope === "global"
                    ? globalId !== null
                    : effectiveId !== null
                ) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-2 text-[10.5px]"
                    disabled={busy}
                    onClick={() => void applyRoute(scope, null)}
                  >
                    {scope === "global" ? "停用全局代理" : "停用项目代理"}
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
  agent,
  name,
  global,
  orphaned,
}: {
  agent: GatewayAgent;
  name: string | null;
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
          <span className="truncate">
            {AGENT_LABELS[agent]} · {orphaned ? "供应商不可用" : name}
          </span>
          {global && !orphaned ? <GlobalTag /> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-64 text-[11px] leading-relaxed"
      >
        {orphaned
          ? "此项目的供应商已删除或接口格式已变更，请重新选择。"
          : global
            ? `${AGENT_LABELS[agent]} 全局默认 · ${name}`
            : `${AGENT_LABELS[agent]} 当前项目 · ${name}`}
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
      title="全局默认供应商"
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
