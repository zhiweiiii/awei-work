import type { EditorThemeId, Preferences } from "@/modules/settings/store";

export const EDITOR_THEMES = [
  "kanagawa",
  "kanagawa-lotus",
  "kanagawa-dragon",
  "tokyo-night",
  "catppuccin-mocha",
  "catppuccin-latte",
  "rose-pine",
  "rose-pine-dawn",
  "everforest",
  "everforest-light",
  "dracula",
  "solarized-dark",
  "solarized-light",
  "nord",
  "gruvbox-dark",
  "atomone",
  "aura",
  "copilot",
  "github-dark",
  "github-light",
  "xcode-dark",
  "xcode-light",
] as const;

export function isEditorThemeId(v: unknown): v is EditorThemeId {
  return (
    typeof v === "string" && (EDITOR_THEMES as readonly string[]).includes(v)
  );
}

const FORMATTERS = new Set([
  "lsp",
  "biome",
  "prettier",
  "ruff",
  "rustfmt",
  "gofmt",
  "clang-format",
  "shfmt",
  "zigfmt",
  "custom",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function stringRecord(value: unknown): value is Record<string, string> {
  return (
    record(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

export function normalizePreference(
  key: keyof Preferences,
  value: unknown,
  defaults: Preferences,
): unknown {
  const fallback = defaults[key];
  const number = (min: number, max: number, integer = false) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, integer ? Math.round(value) : value));
  };
  switch (key) {
    case "theme":
      return value === "system" || value === "light" || value === "dark"
        ? value
        : fallback;
    case "editorTheme":
      return value === "auto" || isEditorThemeId(value) ? value : fallback;
    case "backgroundKind":
      return value === "none" || value === "image" ? value : fallback;
    case "backgroundImageId":
      return value === null || typeof value === "string" ? value : fallback;
    case "backgroundOpacity":
      return number(0, 1);
    case "backgroundBlur":
      return number(0, 64, true);
    case "editorFontSize":
    case "terminalFontSize":
      return number(8, 32, true);
    case "terminalLetterSpacing":
      return number(-10, 10, true);
    case "terminalScrollback":
      return number(200, 50_000, true);
    case "zoomLevel":
      return number(0.5, 2);
    case "editorAutoSaveDelay":
      return number(100, 60_000, true);
    case "terminalCursorStyle":
      return value === "bar" || value === "block" || value === "underline"
        ? value
        : fallback;
    case "terminalFontWeight":
      return typeof value === "string" &&
        ["normal", "500", "600", "bold"].includes(value.trim())
        ? value.trim()
        : fallback;
    case "protectedBranches":
      return strings(value) ? [...value] : [...defaults.protectedBranches];
    case "editorFormatter":
      return typeof value === "string" && FORMATTERS.has(value)
        ? value
        : fallback;
    case "editorFormatterByLang":
      return record(value)
        ? Object.fromEntries(
            Object.entries(value).filter(
              ([, formatter]) =>
                typeof formatter === "string" && FORMATTERS.has(formatter),
            ),
          )
        : {};
    case "lspActivation":
      return record(value)
        ? Object.fromEntries(
            Object.entries(value).filter(
              ([, activation]) =>
                activation === "enabled" || activation === "dismissed",
            ),
          )
        : {};
    case "lspCustomServers": {
      if (!Array.isArray(value)) return [];
      const seen = new Set<string>();
      return value.filter((server) => {
        if (
          !record(server) ||
          typeof server.id !== "string" ||
          !server.id ||
          seen.has(server.id) ||
          typeof server.name !== "string" ||
          typeof server.command !== "string" ||
          !strings(server.args) ||
          !stringRecord(server.languages) ||
          !strings(server.rootMarkers)
        )
          return false;
        seen.add(server.id);
        return true;
      });
    }
    case "shortcuts":
      return record(value)
        ? Object.fromEntries(
            Object.entries(value).filter(
              ([, bindings]) =>
                Array.isArray(bindings) &&
                bindings.every(
                  (binding) =>
                    record(binding) &&
                    typeof binding.key === "string" &&
                    ["ctrl", "shift", "alt", "meta"].every(
                      (modifier) =>
                        binding[modifier] === undefined ||
                        typeof binding[modifier] === "boolean",
                    ),
                ),
            ),
          )
        : {};
    case "claudeGateway": {
      if (!record(value) || !Array.isArray(value.providers))
        return { providers: [], current: null };
      const seen = new Set<string>();
      const providers = value.providers.filter((provider) => {
        if (
          !record(provider) ||
          typeof provider.id !== "string" ||
          !provider.id ||
          seen.has(provider.id) ||
          !["name", "baseUrl", "apiKey"].every(
            (field) => typeof provider[field] === "string",
          ) ||
          (provider.apiFormat !== "anthropic" &&
            provider.apiFormat !== "openai_chat") ||
          (provider.authStyle !== "bearer" &&
            provider.authStyle !== "api_key") ||
          !record(provider.models) ||
          !["default", "opus", "sonnet", "haiku"].every(
            (role) =>
              typeof (provider.models as Record<string, unknown>)[role] ===
              "string",
          )
        )
          return false;
        seen.add(provider.id);
        return true;
      });
      return {
        providers,
        current:
          typeof value.current === "string" && seen.has(value.current)
            ? value.current
            : null,
      };
    }
    default:
      return typeof value === typeof fallback ? value : fallback;
  }
}
