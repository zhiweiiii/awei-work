import type {
  ClaudeGatewayConfig,
  ClaudeProvider,
} from "@/modules/settings/store";
import { invoke } from "@tauri-apps/api/core";

export const GATEWAY_GLOBAL_KEYS = {
  claude: "global",
  codex: "codexGlobal",
  agy: "agyGlobal",
} as const;
export type GatewayAgent = keyof typeof GATEWAY_GLOBAL_KEYS;
export type GatewayRoutes = Partial<Record<GatewayAgent, string | null>>;

export function isGatewayRoutes(value: unknown): value is GatewayRoutes {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, id]) =>
      (key === "claude" || key === "codex" || key === "agy") &&
      (id === null || (typeof id === "string" && id.length > 0)),
  );
}

export function supportsGatewayAgent(
  provider: ClaudeProvider,
  agent: GatewayAgent,
) {
  switch (agent) {
    case "codex":
      return provider.apiFormat === "openai_responses";
    case "agy":
      return provider.apiFormat === "gemini";
    default:
      return (
        provider.apiFormat === "anthropic" ||
        provider.apiFormat === "openai_chat"
      );
  }
}

export function globalGatewayRoute(
  config: ClaudeGatewayConfig,
  agent: GatewayAgent,
) {
  return config[GATEWAY_GLOBAL_KEYS[agent]];
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
  return {
    claude: resolve("claude"),
    codex: resolve("codex"),
    agy: resolve("agy"),
  };
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
