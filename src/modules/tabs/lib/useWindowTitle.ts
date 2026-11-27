import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { pathBasename } from "@/lib/pathIdentity";
import { findLeafCwd } from "@/modules/terminal/lib/panes";
import type { Tab } from "./useTabs";

const APP_NAME = "awei-work";

/** Label of the focused tab, using the active terminal pane's folder. */
function tabLabel(tab: Tab | undefined): string {
  if (!tab) return "";
  if (tab.kind === "terminal") {
    const cwd = findLeafCwd(tab.paneTree, tab.activeLeafId) ?? tab.cwd;
    return cwd ? pathBasename(cwd, "/") : tab.title;
  }
  return tab.title;
}

export function useWindowTitle(
  activeTab: Tab | undefined,
  explorerRoot: string | null,
): void {
  const project = explorerRoot ? pathBasename(explorerRoot, "/") : "";
  const label = tabLabel(activeTab);

  useEffect(() => {
    let title: string;
    if (project && label && label !== project) title = `${project} - ${label}`;
    else title = project || label || APP_NAME;

    document.title = title;
    void getCurrentWindow()
      .setTitle(title)
      .catch((error) =>
        console.warn("[awei-work] window title update failed:", error),
      );
  }, [project, label]);
}
