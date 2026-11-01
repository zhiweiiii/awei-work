import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { errorToast } from "@/lib/errorToast";
import {
  DEFAULT_THEME_ID,
  loadPreferences,
  onPreferencesChange,
  setTheme as persistTheme,
  setThemeId as persistThemeId,
  type ThemePref,
} from "@/modules/settings/store";
import { applyTheme, clearTheme } from "./applyTheme";
import { listCustomThemes, onCustomThemesChange } from "./customThemes";
import { SurfaceLayer } from "./SurfaceLayer";
import { getBuiltinTheme, getDefaultTheme } from "./themes";
import type { Theme } from "./types";

export type { Theme };
export type ThemeModePref = ThemePref;

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultMode?: ThemePref;
  showBackground?: boolean;
};

type ThemeProviderState = {
  mode: ThemePref;
  resolvedMode: "dark" | "light";
  themeId: string;
  activeTheme: Theme;
  customThemes: Theme[];
  setMode: (mode: ThemePref) => void;
  setThemeId: (id: string) => void;
  /** Apply a theme transiently without persisting; null reverts to committed. */
  previewThemeId: (id: string | null) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

const FAST_PATH_KEY = "terax-ui-theme-shadow";
const FAST_PATH_THEME_ID = "terax-ui-theme-id-shadow";

function readFastMode(fallback: ThemePref): ThemePref {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(FAST_PATH_KEY);
    return v === "dark" || v === "light" || v === "system" ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeFastMode(t: ThemePref): void {
  try {
    window.localStorage.setItem(FAST_PATH_KEY, t);
  } catch {
    /* ignore */
  }
}

function readFastThemeId(): string {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;
  try {
    return window.localStorage.getItem(FAST_PATH_THEME_ID) ?? DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

function writeFastThemeId(id: string): void {
  try {
    window.localStorage.setItem(FAST_PATH_THEME_ID, id);
  } catch {
    /* ignore */
  }
}

function resolveTheme(id: string, custom: Theme[]): Theme {
  return (
    custom.find((t) => t.id === id) ?? getBuiltinTheme(id) ?? getDefaultTheme()
  );
}

export function ThemeProvider({
  children,
  defaultMode = "system",
  showBackground = true,
}: ThemeProviderProps) {
  const [mode, setModeState] = useState<ThemePref>(() =>
    readFastMode(defaultMode),
  );
  const [themeId, setThemeIdState] = useState<string>(() => readFastThemeId());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const preferenceRevision = useRef({ mode: 0, id: 0 });
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    const subscribe = onPreferencesChange((key, value) => {
      if (!alive) return;
      if (
        key === "theme" &&
        (value === "system" || value === "light" || value === "dark")
      ) {
        preferenceRevision.current.mode++;
        setModeState(value);
        writeFastMode(value);
      } else if (key === "themeId" && typeof value === "string") {
        preferenceRevision.current.id++;
        setThemeIdState(value);
        writeFastThemeId(value);
      }
    });
    void (async () => {
      try {
        const release = await subscribe;
        if (!alive) {
          release();
          return;
        }
        unlisten = release;
        const revision = { ...preferenceRevision.current };
        const p = await loadPreferences();
        if (!alive) return;
        if (revision.mode === preferenceRevision.current.mode) {
          setModeState(p.theme);
          writeFastMode(p.theme);
        }
        if (revision.id === preferenceRevision.current.id) {
          setThemeIdState(p.themeId);
          writeFastThemeId(p.themeId);
        }
      } catch (error) {
        if (alive) errorToast("加载主题设置失败", error);
      }
    })();
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let request = 0;
    let unlisten: (() => void) | undefined;
    const reload = async () => {
      const id = ++request;
      try {
        const list = await listCustomThemes();
        if (alive && id === request) setCustomThemes(list);
      } catch (error) {
        if (alive && id === request) errorToast("加载自定义主题失败", error);
      }
    };
    void onCustomThemesChange(() => {
      if (alive) void reload();
    })
      .then((release) => {
        if (!alive) {
          release();
          return;
        }
        unlisten = release;
        void reload();
      })
      .catch((error) => {
        if (alive) errorToast("注册自定义主题监听失败", error);
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedMode: "dark" | "light" =
    mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedMode);
  }, [resolvedMode]);

  const effectiveId = previewId ?? themeId;
  const activeTheme = useMemo(
    () => resolveTheme(effectiveId, customThemes),
    [effectiveId, customThemes],
  );
  useEffect(() => {
    if (activeTheme === getDefaultTheme()) {
      clearTheme();
      return;
    }
    applyTheme(activeTheme, resolvedMode);
  }, [activeTheme, resolvedMode]);

  const setMode = useCallback((next: ThemePref) => {
    preferenceRevision.current.mode++;
    setModeState(next);
    writeFastMode(next);
    void persistTheme(next).catch((error) =>
      errorToast("保存主题模式失败", error),
    );
  }, []);

  const setThemeId = useCallback((id: string) => {
    preferenceRevision.current.id++;
    setPreviewId(null);
    setThemeIdState(id);
    writeFastThemeId(id);
    void persistThemeId(id).catch((error) => errorToast("保存主题失败", error));
  }, []);

  const previewThemeId = useCallback((id: string | null) => {
    setPreviewId(id);
  }, []);

  const value = useMemo<ThemeProviderState>(
    () => ({
      mode,
      resolvedMode,
      themeId,
      activeTheme,
      customThemes,
      setMode,
      setThemeId,
      previewThemeId,
    }),
    [
      mode,
      resolvedMode,
      themeId,
      activeTheme,
      customThemes,
      setMode,
      setThemeId,
      previewThemeId,
    ],
  );

  return (
    <ThemeProviderContext.Provider value={value}>
      {showBackground ? <SurfaceLayer /> : null}
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme(): ThemeProviderState {
  const ctx = useContext(ThemeProviderContext);
  if (!ctx) throw new Error("useTheme must be used within a <ThemeProvider>");
  return ctx;
}
