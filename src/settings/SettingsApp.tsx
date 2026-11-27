import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WindowControls } from "@/components/WindowControls";
import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import type { SettingsTab } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  GitBranchIcon,
  InformationCircleIcon,
  KeyboardIcon,
  PaintBoardIcon,
  Settings01Icon,
  SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type JSX, useEffect, useState } from "react";
import { errorToast } from "@/lib/errorToast";
import { AboutSection } from "./sections/AboutSection";
import { EditorSection } from "./sections/EditorSection";
import { GeneralSection } from "./sections/GeneralSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";
import { ThemesSection } from "./sections/ThemesSection";
import { VersionControlSection } from "./sections/VersionControlSection";

const TABS: {
  id: SettingsTab;
  label: string;
  icon: typeof Settings01Icon;
  component: () => JSX.Element;
}[] = [
  {
    id: "general",
    label: "通用",
    icon: Settings01Icon,
    component: GeneralSection,
  },
  {
    id: "editor",
    label: "编辑器",
    icon: SourceCodeIcon,
    component: EditorSection,
  },
  {
    id: "version-control",
    label: "版本管理",
    icon: GitBranchIcon,
    component: VersionControlSection,
  },
  {
    id: "themes",
    label: "主题",
    icon: PaintBoardIcon,
    component: ThemesSection,
  },
  {
    id: "shortcuts",
    label: "快捷键",
    icon: KeyboardIcon,
    component: ShortcutsSection,
  },
  {
    id: "about",
    label: "关于",
    icon: InformationCircleIcon,
    component: AboutSection,
  },
];

const VALID_TABS: SettingsTab[] = [
  "general",
  "editor",
  "version-control",
  "themes",
  "shortcuts",
  "about",
];

function readInitialTab(): SettingsTab {
  if (typeof window === "undefined") return "general";
  const url = new URL(window.location.href);
  const t = url.searchParams.get("tab");
  if (t && (VALID_TABS as string[]).includes(t)) return t as SettingsTab;
  return "general";
}

export function SettingsApp() {
  const [active, setActive] = useState<SettingsTab>(readInitialTab);
  const init = usePreferencesStore((s) => s.init);
  const ActiveSection = TABS.find((t) => t.id === active)?.component;

  useEffect(() => {
    void init().catch((error) =>
      errorToast("Could not load preferences", error),
    );
  }, [init]);

  useEffect(() => {
    let alive = true;
    let cleanup: (() => void) | undefined;
    const apply = (detail: string) => {
      if (alive && (VALID_TABS as string[]).includes(detail)) {
        setActive(detail as SettingsTab);
      }
    };
    void getCurrentWebviewWindow()
      .listen<string>("terax:settings-tab", (e) => apply(e.payload))
      .then((unlisten) => {
        if (alive) cleanup = unlisten;
        else unlisten();
      })
      .catch((error) =>
        errorToast("Could not listen for settings navigation", error),
      );
    return () => {
      alive = false;
      cleanup?.();
    };
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header
        data-tauri-drag-region
        className="flex h-11 shrink-0 select-none items-center border-b border-border/60 bg-card/60 pr-0 pl-3"
      >
        <Tabs
          value={active}
          onValueChange={(v) => setActive(v as SettingsTab)}
          orientation="horizontal"
          className="flex-1 items-center"
          data-tauri-drag-region
        >
          <TabsList className="mx-auto h-7 bg-muted/40 px-2">
            {TABS.map((t) => (
              <TabsTrigger
                key={t.id}
                value={t.id}
                className="h-6 gap-1.5 px-2.5 text-[11.5px]"
              >
                <HugeiconsIcon icon={t.icon} size={12} strokeWidth={1.75} />
                <span>{t.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {USE_CUSTOM_WINDOW_CONTROLS && <WindowControls closeOnly />}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-7 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mx-auto w-full max-w-160">
          {ActiveSection && <ActiveSection />}
        </div>
      </main>
    </div>
  );
}
