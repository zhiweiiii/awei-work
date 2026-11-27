import type { ClaudeProvider } from "@/modules/settings/store";

export const GIT_COMMIT_MESSAGE_MODELS = {
  "codex-fast": "Codex · GPT-6 Luna（低推理）",
  "claude-fast": "Claude Code · Haiku",
  "agy-fast": "Anti · Gemini 4 Hydrogen（低推理）",
} as const;

type BuiltinModel = keyof typeof GIT_COMMIT_MESSAGE_MODELS;
type GatewayModelId = `gateway-model:${string}`;

export type GitCommitMessageBackend = BuiltinModel | "gateway";
export type GitCommitMessageModel = BuiltinModel | GatewayModelId;

export function isGitCommitMessageModel(
  value: unknown,
): value is GitCommitMessageModel {
  return (
    typeof value === "string" &&
    (Object.keys(GIT_COMMIT_MESSAGE_MODELS).includes(value) ||
      (value.startsWith("gateway-model:") &&
        value.length > "gateway-model:".length))
  );
}

export function gatewayCommitMessageModels(providers: ClaudeProvider[]) {
  return providers.flatMap((provider) => {
    const models = new Set(
      Object.values(provider.models)
        .map((model) =>
          model
            .trim()
            .replace(/\[1m\]$/i, "")
            .trimEnd(),
        )
        .filter(Boolean),
    );
    return [...models].map((model) => ({
      value: `gateway-model:${JSON.stringify([provider.id, model])}` as const,
      label: `${provider.name} · ${model}`,
      gatewayModel: { provider, model },
    }));
  });
}
