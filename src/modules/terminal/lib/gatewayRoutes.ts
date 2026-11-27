import type {
  ClaudeGatewayConfig,
  ClaudeProvider,
} from "@/modules/settings/store";
import { invoke } from "@tauri-apps/api/core";

export type GatewayAgent = "claude" | "codex";
export type GatewayRoutes = Partial<Record<GatewayAgent, string | null>>;

export function isGatewayRoutes(value: unknown): value is GatewayRoutes {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, id]) =>
      (key === "claude" || key === "codex") &&
      (id === null || (typeof id === "string" && id.length > 0)),
  );
}

export function supportsGatewayAgent(
  provider: ClaudeProvider,
  agent: GatewayAgent,
) {
  return agent === "codex"
    ? provider.apiFormat === "openai_responses"
    : provider.apiFormat !== "openai_responses";
}

export function globalGatewayRoute(
  config: ClaudeGatewayConfig,
  agent: GatewayAgent,
) {
  return agent === "codex" ? config.codexGlobal : config.global;
}

export function resolvedGatewayRoutes(
  config: ClaudeGatewayConfig,
  project: GatewayRoutes | undefined,
) {
  const resolve = (agent: GatewayAgent) => {
    const override = project?.[agent];
    const id =
      override === undefined ? globalGatewayRoute(config, agent) : override;
    return config.providers.some(
      (p) => p.id === id && supportsGatewayAgent(p, agent),
    )
      ? id
      : null;
  };
  return { claude: resolve("claude"), codex: resolve("codex") };
}

let synced: { config: ClaudeGatewayConfig; pending: Promise<void> } | undefined;

export function syncGatewayConfig(config: ClaudeGatewayConfig): Promise<void> {
  if (synced?.config === config) return synced.pending;
  const pending = (synced?.pending.catch(() => {}) ?? Promise.resolve())
    .then(() => invoke<void>("gateway_set_config", { config }))
    .catch((error) => {
      if (synced?.pending === pending) synced = undefined;
      throw error;
    });
  synced = { config, pending };
  return pending;
}
