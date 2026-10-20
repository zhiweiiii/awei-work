import {
  type EDITOR_THEMES,
  isEditorThemeId,
  normalizePreference,
} from "@/modules/settings/validation";
import type { KeyBinding, ShortcutId } from "@/modules/shortcuts/shortcuts";

export { EDITOR_THEMES, isEditorThemeId } from "@/modules/settings/validation";

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";

export type ThemePref = "system" | "light" | "dark";

export const DEFAULT_THEME_ID = "terax-default";

export type BackgroundKind = "none" | "image";

export type TerminalCursorStyle = "bar" | "block" | "underline";

export type EditorThemeId = (typeof EDITOR_THEMES)[number];

/** "auto" follows the active app theme's editorTheme pairing (resolved live). */
export const EDITOR_THEME_AUTO = "auto" as const;
export type EditorThemePref = typeof EDITOR_THEME_AUTO | EditorThemeId;

export const EDITOR_THEME_MODE: Record<EditorThemeId, "light" | "dark"> = {
  kanagawa: "dark",
  "kanagawa-lotus": "light",
  "kanagawa-dragon": "dark",
  "tokyo-night": "dark",
  "catppuccin-mocha": "dark",
  "catppuccin-latte": "light",
  "rose-pine": "dark",
  "rose-pine-dawn": "light",
  everforest: "dark",
  "everforest-light": "light",
  dracula: "dark",
  "solarized-dark": "dark",
  "solarized-light": "light",
  nord: "dark",
  "gruvbox-dark": "dark",
  atomone: "dark",
  aura: "dark",
  copilot: "dark",
  "github-dark": "dark",
  "github-light": "light",
  "xcode-dark": "dark",
  "xcode-light": "light",
};

export const EDITOR_THEME_LABELS: Record<EditorThemeId, string> = {
  kanagawa: "Kanagawa Wave",
  "kanagawa-lotus": "Kanagawa Lotus",
  "kanagawa-dragon": "Kanagawa Dragon",
  "tokyo-night": "Tokyo Night",
  "catppuccin-mocha": "Catppuccin Mocha",
  "catppuccin-latte": "Catppuccin Latte",
  "rose-pine": "Rosé Pine",
  "rose-pine-dawn": "Rosé Pine Dawn",
  everforest: "Everforest Dark",
  "everforest-light": "Everforest Light",
  dracula: "Dracula",
  "solarized-dark": "Solarized Dark",
  "solarized-light": "Solarized Light",
  nord: "Nord",
  "gruvbox-dark": "Gruvbox Dark",
  atomone: "Atom One",
  aura: "Aura",
  copilot: "Copilot",
  "github-dark": "GitHub Dark",
  "github-light": "GitHub Light",
  "xcode-dark": "Xcode Dark",
  "xcode-light": "Xcode Light",
};

export type Preferences = {
  theme: ThemePref;
  themeId: string;
  backgroundKind: BackgroundKind;
  backgroundImageId: string | null;
  backgroundOpacity: number;
  backgroundBlur: number;
  editorTheme: EditorThemePref;
  editorFontSize: number;
  autostart: boolean;
  restoreWindowState: boolean;
  vimMode: boolean;
  editorWordWrap: boolean;
  showHidden: boolean;
  /** File tree: leave out anything git ignores. */
  hideGitIgnored: boolean;
  /** Let a running agent have the shortcuts it needs (Ctrl+P, Ctrl+T, …). */
  agentKeyPassthrough: boolean;
  /** Fold a run of directories that each hold only the next one. */
  compactFolders: boolean;
  /** Relays Claude Code can be pointed at, and which one is selected. */
  claudeGateway: ClaudeGatewayConfig;
  explorerGitDecorations: boolean;
  /** Branch names that must not be force-pushed / rebased without warning. */
  protectedBranches: string[];
  terminalWebglEnabled: boolean;
  terminalCursorBlink: boolean;
  terminalCursorStyle: TerminalCursorStyle;
  terminalFontFamily: string;
  terminalFontWeight: string;
  terminalShell: string;
  terminalLetterSpacing: number;
  terminalFontSize: number;
  terminalScrollback: number;
  zoomLevel: number;
  shortcuts: Record<ShortcutId, KeyBinding[]>;
  editorAutoSave: boolean;
  editorAutoSaveDelay: number;
  editorFormatOnSave: boolean;
  /** Diff view: fold the unchanged stretches so only the changes are shown. */
  diffCollapseUnchanged: boolean;
  editorFormatter: EditorFormatter;
  /** languageResolver id -> formatter, overriding the global default. */
  editorFormatterByLang: Record<string, EditorFormatter>;
  /** Shell template for the "custom" formatter; {file} is the quoted path. */
  editorCustomFormatCommand: string;
  lspActivation: Record<string, LspActivation>;
  lspCustomServers: LspCustomServer[];
};

export type EditorFormatter =
  | "lsp"
  | "biome"
  | "prettier"
  | "ruff"
  | "rustfmt"
  | "gofmt"
  | "clang-format"
  | "shfmt"
  | "zigfmt"
  | "custom";

export type LspActivation = "enabled" | "dismissed";

export type LspCustomServer = {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** languageResolver id -> LSP languageId */
  languages: Record<string, string>;
  rootMarkers: string[];
};

const STORE_PATH = "terax-settings.json";
const KEY_THEME = "theme";
const KEY_THEME_ID = "themeId";
const KEY_BG_KIND = "backgroundKind";
const KEY_BG_IMAGE_ID = "backgroundImageId";
const KEY_BG_OPACITY = "backgroundOpacity";
const KEY_BG_BLUR = "backgroundBlur";
const KEY_EDITOR_THEME = "editorTheme";
const KEY_EDITOR_FONT_SIZE = "editorFontSize";
const KEY_AUTOSTART = "autostart";
const KEY_RESTORE_WINDOW = "restoreWindowState";

const KEY_VIM_MODE = "vimMode";
const KEY_EDITOR_WORD_WRAP = "editorWordWrap";
const KEY_SHOW_HIDDEN = "showHidden";
const KEY_HIDE_GIT_IGNORED = "hideGitIgnored";
const KEY_AGENT_KEY_PASSTHROUGH = "agentKeyPassthrough";
const KEY_COMPACT_FOLDERS = "compactFolders";
const KEY_CLAUDE_GATEWAY = "claudeGateway";
/** Parameter sets written by the panel this replaced. Read once, to carry an
 *  existing endpoint over as a provider. */
const LEGACY_KEY_AGENT_ENV_PRESETS = "agentEnvPresets";
const LEGACY_KEY_SHOW_HIDDEN_DIRS = "showHiddenDirectories";
const KEY_EXPLORER_GIT_DECORATIONS = "explorerGitDecorations";
const KEY_PROTECTED_BRANCHES = "protectedBranches";
const KEY_TERMINAL_WEBGL_ENABLED = "terminalWebglEnabled";
const KEY_TERMINAL_CURSOR_BLINK = "terminalCursorBlink";
const KEY_TERMINAL_CURSOR_STYLE = "terminalCursorStyle";
const KEY_TERMINAL_FONT_FAMILY = "terminalFontFamily";
const KEY_TERMINAL_FONT_WEIGHT = "terminalFontWeight";
const KEY_TERMINAL_SHELL = "terminalShell";
const KEY_TERMINAL_LETTER_SPACING = "terminalLetterSpacing";
const KEY_TERMINAL_FONT_SIZE = "terminalFontSize";
const KEY_TERMINAL_SCROLLBACK = "terminalScrollback";
const KEY_ZOOM_LEVEL = "zoomLevel";
const KEY_SHORTCUTS = "shortcuts";
const KEY_EDITOR_AUTO_SAVE = "editorAutoSave";
const KEY_EDITOR_AUTO_SAVE_DELAY = "editorAutoSaveDelay";
const KEY_EDITOR_FORMAT_ON_SAVE = "editorFormatOnSave";
const KEY_DIFF_COLLAPSE_UNCHANGED = "diffCollapseUnchanged";
const KEY_EDITOR_FORMATTER = "editorFormatter";
const KEY_EDITOR_FORMATTER_BY_LANG = "editorFormatterByLang";
const KEY_EDITOR_CUSTOM_FORMAT_COMMAND = "editorCustomFormatCommand";
const KEY_LSP_ACTIVATION = "lspActivation";
const KEY_LSP_CUSTOM_SERVERS = "lspCustomServers";

export const TERMINAL_FONT_SIZE_DEFAULT = 14;
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;

export const TERMINAL_FONT_SIZES = [
  10, 12, 13, 14, 15, 16, 18, 20, 22, 24,
] as const;

export const EDITOR_FONT_SIZE_DEFAULT = 13;
export const EDITOR_FONT_SIZE_MIN = 8;
export const EDITOR_FONT_SIZE_MAX = 32;
export const EDITOR_FONT_SIZES = [
  10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24,
] as const;

export const TERMINAL_SCROLLBACK_DEFAULT = 2000;
export const TERMINAL_SCROLLBACK_MIN = 200;
export const TERMINAL_SCROLLBACK_MAX = 50_000;
export const TERMINAL_SCROLLBACK_PRESETS = [
  500, 1000, 2000, 5000, 10_000, 25_000,
] as const;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  themeId: DEFAULT_THEME_ID,
  backgroundKind: "none",
  backgroundImageId: null,
  backgroundOpacity: 0.5,
  backgroundBlur: 0,
  editorTheme: EDITOR_THEME_AUTO,
  editorFontSize: EDITOR_FONT_SIZE_DEFAULT,
  autostart: false,
  restoreWindowState: true,
  vimMode: false,
  editorWordWrap: false,
  showHidden: false,
  hideGitIgnored: false,
  agentKeyPassthrough: true,
  compactFolders: true,
  claudeGateway: { providers: [], current: null } as ClaudeGatewayConfig,
  explorerGitDecorations: true,
  protectedBranches: ["main", "master", "develop"],
  terminalWebglEnabled: true,
  terminalCursorBlink: false,
  terminalCursorStyle: "bar",
  terminalFontFamily: "",
  terminalFontWeight: "normal",
  terminalShell: "",
  terminalLetterSpacing: 0,
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  terminalScrollback: TERMINAL_SCROLLBACK_DEFAULT,
  zoomLevel: 1.0,
  shortcuts: {} as Record<ShortcutId, KeyBinding[]>,
  editorAutoSave: false,
  editorAutoSaveDelay: 1000,
  editorFormatOnSave: false,
  diffCollapseUnchanged: true,
  editorFormatter: "lsp",
  editorFormatterByLang: {},
  editorCustomFormatCommand: "",
  lspActivation: {},
  lspCustomServers: [],
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

// LazyStore.onChange only fires within the writing process. The settings
// page lives in a separate webview, so writes there never reach the main
// window's subscribers. Mirror every setter through a Tauri event so any
// window can listen.
const PREFS_CHANGED_EVENT = "terax://prefs-changed";

let preferenceMutation = Promise.resolve();

function enqueuePreferenceMutation(work: () => Promise<void>): Promise<void> {
  const operation = preferenceMutation.then(work);
  preferenceMutation = operation.catch(() => {});
  return operation;
}

async function writeStoredPreference(
  key: PrefKey,
  raw: unknown,
): Promise<void> {
  const value = normalizePreference(key, raw, DEFAULT_PREFERENCES);
  await store.set(key, value);
  await store.save();
  await emit(PREFS_CHANGED_EVENT, { key, value });
}

function writePref(key: PrefKey, raw: unknown): Promise<void> {
  const value = normalizePreference(key, raw, DEFAULT_PREFERENCES);
  return enqueuePreferenceMutation(() => writeStoredPreference(key, value));
}

export async function loadPreferences(): Promise<Preferences> {
  // Single IPC roundtrip — fetching keys individually fans out to one
  // `plugin:store|get` per setting and is the dominant boot cost.
  const entries = await store.entries();
  const map = new Map<string, unknown>(entries);
  const get = <T>(key: string): T | undefined => {
    const value = map.get(key);
    if (value === undefined) return undefined;
    if (key === LEGACY_KEY_SHOW_HIDDEN_DIRS && typeof value !== "boolean")
      return undefined;
    return (
      Object.getOwnPropertyDescriptor(DEFAULT_PREFERENCES, key)
        ? normalizePreference(key as PrefKey, value, DEFAULT_PREFERENCES)
        : value
    ) as T | undefined;
  };
  return {
    theme: get<ThemePref>(KEY_THEME) ?? DEFAULT_PREFERENCES.theme,
    themeId: get<string>(KEY_THEME_ID) ?? DEFAULT_PREFERENCES.themeId,
    backgroundKind:
      get<BackgroundKind>(KEY_BG_KIND) ?? DEFAULT_PREFERENCES.backgroundKind,
    backgroundImageId:
      get<string | null>(KEY_BG_IMAGE_ID) ??
      DEFAULT_PREFERENCES.backgroundImageId,
    backgroundOpacity: clampBgOpacity(
      get<number>(KEY_BG_OPACITY) ?? DEFAULT_PREFERENCES.backgroundOpacity,
    ),
    backgroundBlur: clampBlur(
      get<number>(KEY_BG_BLUR) ?? DEFAULT_PREFERENCES.backgroundBlur,
    ),
    editorTheme: ((): EditorThemePref => {
      const stored = get<string>(KEY_EDITOR_THEME);
      if (stored === EDITOR_THEME_AUTO || isEditorThemeId(stored))
        return stored;
      return DEFAULT_PREFERENCES.editorTheme;
    })(),
    editorFontSize: clampEditorFontSize(
      get<number>(KEY_EDITOR_FONT_SIZE) ?? DEFAULT_PREFERENCES.editorFontSize,
    ),
    autostart: get<boolean>(KEY_AUTOSTART) ?? DEFAULT_PREFERENCES.autostart,
    restoreWindowState:
      get<boolean>(KEY_RESTORE_WINDOW) ??
      DEFAULT_PREFERENCES.restoreWindowState,
    vimMode: get<boolean>(KEY_VIM_MODE) ?? DEFAULT_PREFERENCES.vimMode,
    editorWordWrap:
      get<boolean>(KEY_EDITOR_WORD_WRAP) ?? DEFAULT_PREFERENCES.editorWordWrap,
    showHidden:
      get<boolean>(KEY_SHOW_HIDDEN) ??
      get<boolean>(LEGACY_KEY_SHOW_HIDDEN_DIRS) ??
      DEFAULT_PREFERENCES.showHidden,
    hideGitIgnored:
      get<boolean>(KEY_HIDE_GIT_IGNORED) ?? DEFAULT_PREFERENCES.hideGitIgnored,
    agentKeyPassthrough:
      get<boolean>(KEY_AGENT_KEY_PASSTHROUGH) ??
      DEFAULT_PREFERENCES.agentKeyPassthrough,
    compactFolders:
      get<boolean>(KEY_COMPACT_FOLDERS) ?? DEFAULT_PREFERENCES.compactFolders,
    claudeGateway:
      get<ClaudeGatewayConfig>(KEY_CLAUDE_GATEWAY) ??
      migrateAgentEnvPresets(
        get<LegacyAgentEnvPreset[]>(LEGACY_KEY_AGENT_ENV_PRESETS),
      ),
    explorerGitDecorations:
      get<boolean>(KEY_EXPLORER_GIT_DECORATIONS) ??
      DEFAULT_PREFERENCES.explorerGitDecorations,
    protectedBranches:
      get<string[]>(KEY_PROTECTED_BRANCHES) ??
      DEFAULT_PREFERENCES.protectedBranches,
    terminalWebglEnabled:
      get<boolean>(KEY_TERMINAL_WEBGL_ENABLED) ??
      DEFAULT_PREFERENCES.terminalWebglEnabled,
    terminalCursorBlink:
      get<boolean>(KEY_TERMINAL_CURSOR_BLINK) ??
      DEFAULT_PREFERENCES.terminalCursorBlink,
    terminalCursorStyle: coerceTerminalCursorStyle(
      get<unknown>(KEY_TERMINAL_CURSOR_STYLE),
    ),
    terminalFontFamily:
      get<string>(KEY_TERMINAL_FONT_FAMILY) ??
      DEFAULT_PREFERENCES.terminalFontFamily,
    terminalFontWeight: coerceFontWeight(
      get<string>(KEY_TERMINAL_FONT_WEIGHT) ??
        DEFAULT_PREFERENCES.terminalFontWeight,
    ),
    terminalShell:
      get<string>(KEY_TERMINAL_SHELL) ?? DEFAULT_PREFERENCES.terminalShell,
    terminalLetterSpacing:
      get<number>(KEY_TERMINAL_LETTER_SPACING) ??
      DEFAULT_PREFERENCES.terminalLetterSpacing,
    terminalFontSize:
      get<number>(KEY_TERMINAL_FONT_SIZE) ??
      DEFAULT_PREFERENCES.terminalFontSize,
    terminalScrollback: clampScrollback(
      get<number>(KEY_TERMINAL_SCROLLBACK) ??
        DEFAULT_PREFERENCES.terminalScrollback,
    ),
    zoomLevel: get<number>(KEY_ZOOM_LEVEL) ?? DEFAULT_PREFERENCES.zoomLevel,
    shortcuts:
      get<Record<ShortcutId, KeyBinding[]>>(KEY_SHORTCUTS) ??
      DEFAULT_PREFERENCES.shortcuts,
    editorAutoSave:
      get<boolean>(KEY_EDITOR_AUTO_SAVE) ?? DEFAULT_PREFERENCES.editorAutoSave,
    editorAutoSaveDelay: clampAutoSaveDelay(
      get<number>(KEY_EDITOR_AUTO_SAVE_DELAY) ??
        DEFAULT_PREFERENCES.editorAutoSaveDelay,
    ),
    editorFormatOnSave:
      get<boolean>(KEY_EDITOR_FORMAT_ON_SAVE) ??
      DEFAULT_PREFERENCES.editorFormatOnSave,
    diffCollapseUnchanged:
      get<boolean>(KEY_DIFF_COLLAPSE_UNCHANGED) ??
      DEFAULT_PREFERENCES.diffCollapseUnchanged,
    editorFormatter:
      get<EditorFormatter>(KEY_EDITOR_FORMATTER) ??
      DEFAULT_PREFERENCES.editorFormatter,
    editorFormatterByLang:
      get<Record<string, EditorFormatter>>(KEY_EDITOR_FORMATTER_BY_LANG) ??
      DEFAULT_PREFERENCES.editorFormatterByLang,
    editorCustomFormatCommand:
      get<string>(KEY_EDITOR_CUSTOM_FORMAT_COMMAND) ??
      DEFAULT_PREFERENCES.editorCustomFormatCommand,
    lspActivation:
      get<Record<string, LspActivation>>(KEY_LSP_ACTIVATION) ??
      DEFAULT_PREFERENCES.lspActivation,
    lspCustomServers:
      get<LspCustomServer[]>(KEY_LSP_CUSTOM_SERVERS) ??
      DEFAULT_PREFERENCES.lspCustomServers,
  };
}

export function setLspActivation(
  id: string,
  value: LspActivation | null,
): Promise<void> {
  return enqueuePreferenceMutation(() => updateLspActivation(id, value));
}

async function updateLspActivation(
  id: string,
  value: LspActivation | null,
): Promise<void> {
  const current = normalizePreference(
    "lspActivation",
    await store.get(KEY_LSP_ACTIVATION),
    DEFAULT_PREFERENCES,
  ) as Record<string, LspActivation>;
  const next = { ...current };
  if (value === null) delete next[id];
  else next[id] = value;
  await writeStoredPreference(KEY_LSP_ACTIVATION, next);
}

export async function setLspCustomServers(
  value: LspCustomServer[],
): Promise<void> {
  await writePref(KEY_LSP_CUSTOM_SERVERS, value);
}

export async function setTheme(value: ThemePref): Promise<void> {
  await writePref(KEY_THEME, value);
}

export async function setThemeId(value: string): Promise<void> {
  await writePref(KEY_THEME_ID, value);
}

/** Slider stores 0..1. Actual rendered opacity is halved in SurfaceLayer
 *  so the image never exceeds 50% — keeps UI/terminal readable at any setting. */
export const BG_OPACITY_RENDER_FACTOR = 0.5;

function clampBgOpacity(v: number): number {
  if (!Number.isFinite(v)) return 0.7;
  return Math.min(1, Math.max(0, v));
}

function clampBlur(v: number): number {
  if (!Number.isFinite(v)) return 16;
  return Math.min(64, Math.max(0, Math.round(v)));
}

export async function setBackgroundKind(value: BackgroundKind): Promise<void> {
  await writePref(KEY_BG_KIND, value);
}

export async function setBackgroundImageId(
  value: string | null,
): Promise<void> {
  await writePref(KEY_BG_IMAGE_ID, value);
}

export async function setBackgroundOpacity(value: number): Promise<void> {
  await writePref(KEY_BG_OPACITY, clampBgOpacity(value));
}

export async function setBackgroundBlur(value: number): Promise<void> {
  await writePref(KEY_BG_BLUR, clampBlur(value));
}

export async function setEditorTheme(value: EditorThemePref): Promise<void> {
  await writePref(KEY_EDITOR_THEME, value);
}

export function clampEditorFontSize(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_FONT_SIZE_DEFAULT;
  return Math.min(
    EDITOR_FONT_SIZE_MAX,
    Math.max(EDITOR_FONT_SIZE_MIN, Math.round(value)),
  );
}

export async function setEditorFontSize(value: number): Promise<void> {
  await writePref(KEY_EDITOR_FONT_SIZE, clampEditorFontSize(value));
}

export async function setAutostart(value: boolean): Promise<void> {
  await writePref(KEY_AUTOSTART, value);
}

export async function setRestoreWindowState(value: boolean): Promise<void> {
  await writePref(KEY_RESTORE_WINDOW, value);
}

export async function setVimMode(value: boolean): Promise<void> {
  await writePref(KEY_VIM_MODE, value);
}

export async function setEditorWordWrap(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_WORD_WRAP, value);
}

export async function setShowHidden(value: boolean): Promise<void> {
  await writePref(KEY_SHOW_HIDDEN, value);
}

export async function setHideGitIgnored(value: boolean): Promise<void> {
  await writePref(KEY_HIDE_GIT_IGNORED, value);
}

export async function setAgentKeyPassthrough(value: boolean): Promise<void> {
  await writePref(KEY_AGENT_KEY_PASSTHROUGH, value);
}

export async function setCompactFolders(value: boolean): Promise<void> {
  await writePref(KEY_COMPACT_FOLDERS, value);
}

/** The wire format a relay speaks. Mirrors `gateway::config::ApiFormat`. */
export type ClaudeApiFormat = "anthropic" | "openai_chat";

/** How a relay wants its credential presented. Mirrors
 *  `gateway::config::AuthStyle`. It cannot be inferred from the format:
 *  OpenCode Zen serves Anthropic on `/zen/go` but ignores a Bearer header
 *  there and only honours `x-api-key`. */
export type ClaudeAuthStyle = "bearer" | "api_key";

/** Upstream model per Claude Code role. Empty falls back to `default`, and an
 *  empty `default` passes the requested name through. */
export type ClaudeModelRoutes = {
  default: string;
  opus: string;
  sonnet: string;
  haiku: string;
};

export type ClaudeProvider = {
  id: string;
  name: string;
  baseUrl: string;
  /** The key itself, in the clear.
   *
   *  Storing it plainly is a deliberate decision by the owner of this build,
   *  taken with the consequence stated: this file is plain JSON under
   *  %APPDATA%, so anything that can read the user's profile can read it. */
  apiKey: string;
  apiFormat: ClaudeApiFormat;
  authStyle: ClaudeAuthStyle;
  models: ClaudeModelRoutes;
};

export type ClaudeGatewayConfig = {
  providers: ClaudeProvider[];
  /** Provider id, or null when none is selected and the gateway stays closed. */
  current: string | null;
};

type LegacyAgentEnvPreset = {
  id?: string;
  alias?: string;
  baseUrl?: string;
  model?: string;
  token?: string;
};

export const EMPTY_MODEL_ROUTES: ClaudeModelRoutes = {
  default: "",
  opus: "",
  sonnet: "",
  haiku: "",
};

/** Carry endpoints from the parameter panel this replaced. Those were written
 *  straight into ANTHROPIC_BASE_URL, so they are Anthropic endpoints by
 *  definition. Nothing is selected: routing through the gateway is a change in
 *  behaviour and the user should opt into it. */
function migrateAgentEnvPresets(
  presets: LegacyAgentEnvPreset[] | undefined,
): ClaudeGatewayConfig {
  if (!Array.isArray(presets) || !presets.length)
    return { providers: [], current: null };
  const providers = presets
    .filter(
      (preset) =>
        preset && typeof preset.baseUrl === "string" && preset.baseUrl,
    )
    // An entry written before tokens were stored in the clear holds only DPAPI
    // ciphertext. Carry the endpoint over with an empty key rather than drop
    // it: the user re-enters one key instead of rebuilding the entry.
    .map((preset, index) => ({
      id: preset.id ?? `migrated-${index}`,
      name: preset.alias || preset.model || (preset.baseUrl as string),
      baseUrl: preset.baseUrl as string,
      apiKey: preset.token ?? "",
      apiFormat: "anthropic" as const,
      authStyle: "bearer" as const,
      models: { ...EMPTY_MODEL_ROUTES, default: preset.model ?? "" },
    }));
  return normalizePreference(
    "claudeGateway",
    { providers, current: null },
    DEFAULT_PREFERENCES,
  ) as ClaudeGatewayConfig;
}

export async function setClaudeGateway(
  value: ClaudeGatewayConfig,
): Promise<void> {
  await writePref(KEY_CLAUDE_GATEWAY, value);
}

export async function setExplorerGitDecorations(value: boolean): Promise<void> {
  await writePref(KEY_EXPLORER_GIT_DECORATIONS, value);
}

export async function setProtectedBranches(value: string[]): Promise<void> {
  await writePref(KEY_PROTECTED_BRANCHES, value);
}

export async function setTerminalWebglEnabled(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_WEBGL_ENABLED, value);
}

export async function setTerminalCursorBlink(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_CURSOR_BLINK, value);
}

export function coerceTerminalCursorStyle(value: unknown): TerminalCursorStyle {
  return value === "bar" || value === "block" || value === "underline"
    ? value
    : DEFAULT_PREFERENCES.terminalCursorStyle;
}

export async function setTerminalCursorStyle(value: unknown): Promise<void> {
  await writePref(KEY_TERMINAL_CURSOR_STYLE, coerceTerminalCursorStyle(value));
}

export async function setTerminalFontFamily(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_FONT_FAMILY, value.trim());
}

const TERMINAL_FONT_WEIGHT_VALUES = new Set(["normal", "500", "600", "bold"]);

export function coerceFontWeight(value: string): string {
  const v = value.trim();
  return TERMINAL_FONT_WEIGHT_VALUES.has(v) ? v : "normal";
}

export async function setTerminalFontWeight(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_FONT_WEIGHT, coerceFontWeight(value));
}

export async function setTerminalShell(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_SHELL, value.trim());
}

export async function setTerminalLetterSpacing(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.max(-10, Math.min(10, Math.round(value)))
    : 0;
  await writePref(KEY_TERMINAL_LETTER_SPACING, clamped);
}

export async function setTerminalFontSize(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)),
      )
    : TERMINAL_FONT_SIZE_DEFAULT;
  await writePref(KEY_TERMINAL_FONT_SIZE, clamped);
}

function clampScrollback(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_SCROLLBACK_DEFAULT;
  return Math.min(
    TERMINAL_SCROLLBACK_MAX,
    Math.max(TERMINAL_SCROLLBACK_MIN, Math.round(value)),
  );
}

export async function setTerminalScrollback(value: number): Promise<void> {
  await writePref(KEY_TERMINAL_SCROLLBACK, clampScrollback(value));
}

export async function setZoomLevel(value: number): Promise<void> {
  await writePref(KEY_ZOOM_LEVEL, value);
}

export const AUTO_SAVE_DELAY_MIN = 100;
export const AUTO_SAVE_DELAY_MAX = 60000;

export function clampAutoSaveDelay(v: number): number {
  if (!Number.isFinite(v)) return 1000;
  return Math.min(
    AUTO_SAVE_DELAY_MAX,
    Math.max(AUTO_SAVE_DELAY_MIN, Math.round(v)),
  );
}

export async function setEditorAutoSave(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_AUTO_SAVE, value);
}

export async function setEditorAutoSaveDelay(value: number): Promise<void> {
  await writePref(KEY_EDITOR_AUTO_SAVE_DELAY, clampAutoSaveDelay(value));
}

export async function setEditorFormatOnSave(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_FORMAT_ON_SAVE, value);
}

export async function setDiffCollapseUnchanged(value: boolean): Promise<void> {
  await writePref(KEY_DIFF_COLLAPSE_UNCHANGED, value);
}

export async function setEditorFormatter(
  value: EditorFormatter,
): Promise<void> {
  await writePref(KEY_EDITOR_FORMATTER, value);
}

export function setEditorFormatterByLang(
  update: (
    current: Record<string, EditorFormatter>,
  ) => Record<string, EditorFormatter>,
): Promise<void> {
  return enqueuePreferenceMutation(async () => {
    const current = normalizePreference(
      KEY_EDITOR_FORMATTER_BY_LANG,
      await store.get(KEY_EDITOR_FORMATTER_BY_LANG),
      DEFAULT_PREFERENCES,
    ) as Record<string, EditorFormatter>;
    await writeStoredPreference(
      KEY_EDITOR_FORMATTER_BY_LANG,
      update({ ...current }),
    );
  });
}

export async function setEditorCustomFormatCommand(
  value: string,
): Promise<void> {
  await writePref(KEY_EDITOR_CUSTOM_FORMAT_COMMAND, value);
}

export async function setShortcuts(
  value: Partial<Record<ShortcutId, KeyBinding[]>>,
): Promise<void> {
  await writePref(KEY_SHORTCUTS, value);
}

export type PrefKey = keyof Preferences;

/** Subscribe to changes from any window (settings → main). */
export async function onPreferencesChange(
  cb: (key: PrefKey, value: unknown) => void,
): Promise<UnlistenFn> {
  const map: Record<string, PrefKey> = {
    [KEY_THEME]: "theme",
    [KEY_THEME_ID]: "themeId",
    [KEY_BG_KIND]: "backgroundKind",
    [KEY_BG_IMAGE_ID]: "backgroundImageId",
    [KEY_BG_OPACITY]: "backgroundOpacity",
    [KEY_BG_BLUR]: "backgroundBlur",
    [KEY_EDITOR_THEME]: "editorTheme",
    [KEY_EDITOR_FONT_SIZE]: "editorFontSize",
    [KEY_AUTOSTART]: "autostart",
    [KEY_RESTORE_WINDOW]: "restoreWindowState",
    [KEY_VIM_MODE]: "vimMode",
    [KEY_EDITOR_WORD_WRAP]: "editorWordWrap",
    [KEY_SHOW_HIDDEN]: "showHidden",
    [KEY_HIDE_GIT_IGNORED]: "hideGitIgnored",
    [KEY_AGENT_KEY_PASSTHROUGH]: "agentKeyPassthrough",
    [KEY_COMPACT_FOLDERS]: "compactFolders",
    [KEY_CLAUDE_GATEWAY]: "claudeGateway",
    [KEY_EXPLORER_GIT_DECORATIONS]: "explorerGitDecorations",
    [KEY_PROTECTED_BRANCHES]: "protectedBranches",
    [KEY_TERMINAL_WEBGL_ENABLED]: "terminalWebglEnabled",
    [KEY_TERMINAL_CURSOR_BLINK]: "terminalCursorBlink",
    [KEY_TERMINAL_CURSOR_STYLE]: "terminalCursorStyle",
    [KEY_TERMINAL_FONT_FAMILY]: "terminalFontFamily",
    [KEY_TERMINAL_FONT_WEIGHT]: "terminalFontWeight",
    [KEY_TERMINAL_SHELL]: "terminalShell",
    [KEY_TERMINAL_LETTER_SPACING]: "terminalLetterSpacing",
    [KEY_TERMINAL_FONT_SIZE]: "terminalFontSize",
    [KEY_TERMINAL_SCROLLBACK]: "terminalScrollback",
    [KEY_ZOOM_LEVEL]: "zoomLevel",
    [KEY_SHORTCUTS]: "shortcuts",
    [KEY_EDITOR_AUTO_SAVE]: "editorAutoSave",
    [KEY_EDITOR_AUTO_SAVE_DELAY]: "editorAutoSaveDelay",
    [KEY_EDITOR_FORMAT_ON_SAVE]: "editorFormatOnSave",
    [KEY_DIFF_COLLAPSE_UNCHANGED]: "diffCollapseUnchanged",
    [KEY_EDITOR_FORMATTER]: "editorFormatter",
    [KEY_EDITOR_FORMATTER_BY_LANG]: "editorFormatterByLang",
    [KEY_EDITOR_CUSTOM_FORMAT_COMMAND]: "editorCustomFormatCommand",
    [KEY_LSP_ACTIVATION]: "lspActivation",
    [KEY_LSP_CUSTOM_SERVERS]: "lspCustomServers",
  };
  // Same-process writes still fire onChange immediately; cross-window writes
  // arrive via the Tauri event emitted by writePref().
  const unsubLocal = await store.onChange<unknown>((key, value) => {
    const mapped = Object.getOwnPropertyDescriptor(map, key)
      ? map[key]
      : undefined;
    if (mapped)
      cb(mapped, normalizePreference(mapped, value, DEFAULT_PREFERENCES));
  });
  let unsubEvent: UnlistenFn;
  try {
    unsubEvent = await listen<{ key: string; value: unknown }>(
      PREFS_CHANGED_EVENT,
      (e) => {
        if (!e.payload || typeof e.payload.key !== "string") return;
        const mapped = Object.getOwnPropertyDescriptor(map, e.payload.key)
          ? map[e.payload.key]
          : undefined;
        if (mapped)
          cb(
            mapped,
            normalizePreference(mapped, e.payload.value, DEFAULT_PREFERENCES),
          );
      },
    );
  } catch (error) {
    unsubLocal();
    throw error;
  }
  return () => {
    unsubLocal();
    unsubEvent();
  };
}
