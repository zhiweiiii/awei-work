import { WindowControls } from "@/components/WindowControls";
import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import type { Tab } from "@/modules/tabs";
import { TabBar } from "@/modules/tabs";
import type { ReactNode } from "react";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** Active file tab's owning terminal, so the command line stays highlighted. */
  activeOwnerTabId?: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onClose: (id: number) => void;
  onPin: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onReorder?: (fromId: number, toGapIndex: number) => void;
  onOverrideLanguage?: (id: number, lang: string | null) => void;
  headerTabs?: ReactNode;
  /** Group (space) switcher rendered before the tab strip. */
  groupSwitcher?: ReactNode;
  /** Sits at the far right, before the window controls. */
  headerRight?: ReactNode;
};

export function Header({
  tabs,
  activeId,
  activeOwnerTabId,
  onSelect,
  onNew,
  onNewBlock,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onClose,
  onPin,
  onRename,
  onReorder,
  onOverrideLanguage,
  headerTabs,
  groupSwitcher,
  headerRight,
}: Props) {
  return (
    <div
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-card select-none pr-0 pl-2"
    >
      <div className="flex shrink-0 items-center gap-0.5">{headerTabs}</div>

      <span className="mx-1 h-full w-px shrink-0 bg-border/70" />

      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        data-tauri-drag-region
      >
        {groupSwitcher}
        <TabBar
          tabs={tabs}
          activeId={activeId}
          activeOwnerTabId={activeOwnerTabId}
          onSelect={onSelect}
          onNew={onNew}
          onNewBlock={onNewBlock}
          onNewPrivate={onNewPrivate}
          onNewPreview={onNewPreview}
          onNewEditor={onNewEditor}
          onNewGitGraph={onNewGitGraph}
          onClose={onClose}
          onPin={onPin}
          onRename={onRename}
          onReorder={onReorder}
          onOverrideLanguage={onOverrideLanguage}
        />
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
      </div>

      {headerRight ? (
        <div className="flex shrink-0 items-center gap-0.5">{headerRight}</div>
      ) : null}

      {USE_CUSTOM_WINDOW_CONTROLS && (
        <>
          <span className="ml-1 h-5 w-px shrink-0 bg-border/60" />
          <WindowControls />
        </>
      )}
    </div>
  );
}
