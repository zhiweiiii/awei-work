import { cn } from "@/lib/utils";
import { EditorStack, GitDiffStack } from "@/modules/editor";
import { GitHistoryStack } from "@/modules/git-history";
import { MarkdownStack } from "@/modules/markdown";
import { PreviewStack } from "@/modules/preview";
import type { Tab } from "@/modules/tabs";
import { TerminalStack } from "@/modules/terminal";
import type { ComponentProps } from "react";

type TerminalStackProps = ComponentProps<typeof TerminalStack>;
type EditorStackProps = ComponentProps<typeof EditorStack>;
type PreviewStackProps = ComponentProps<typeof PreviewStack>;
type GitDiffStackProps = ComponentProps<typeof GitDiffStack>;
type GitHistoryStackProps = ComponentProps<typeof GitHistoryStack>;

type Props = {
  onReopenProject: (id: number) => void;
  onNewProject: () => void;
  spaces: TerminalStackProps["spaces"];
  tabs: Tab[];
  activeId: number;
  activeTab: Tab | undefined;
  registerTerminalHandle: TerminalStackProps["registerHandle"];
  onCwd: TerminalStackProps["onCwd"];
  onExit: TerminalStackProps["onExit"];
  onFocusLeaf: TerminalStackProps["onFocusLeaf"];
  registerEditorHandle: EditorStackProps["registerHandle"];
  onEditorDirtyChange: EditorStackProps["onDirtyChange"];
  onEditorCloseTab: EditorStackProps["onCloseTab"];
  registerPreviewHandle: PreviewStackProps["registerHandle"];
  onPreviewUrlChange: PreviewStackProps["onUrlChange"];
  registerMarkdownHandle: ComponentProps<
    typeof MarkdownStack
  >["registerHandle"];
  registerGitDiffHandle: GitDiffStackProps["registerHandle"];
  onAttachToAgent?: GitDiffStackProps["onAttachToAgent"];
  registerGitHistoryHandle: GitHistoryStackProps["registerHandle"];
  onOpenCommitFile: GitHistoryStackProps["onOpenCommitFile"];
  gitHistoryRepos?: GitHistoryStackProps["repos"];
  onSwitchGitHistoryRepo?: GitHistoryStackProps["onSwitchRepo"];
  onSetMarkdownView: EditorStackProps["onSetMarkdownView"];
  /** Opens a project file from a relative markdown link. */
  onOpenMarkdownPath: (path: string) => void;
};

/**
 * Stacks every tab-kind surface absolutely on top of each other and toggles
 * visibility off the active tab, so panes keep their mounted state (terminal
 * buffers, editor scroll, ...) when switching tabs.
 */
export function WorkspaceSurface({
  onReopenProject,
  onNewProject,
  spaces,
  tabs,
  activeId,
  activeTab,
  registerTerminalHandle,
  onCwd,
  onExit,
  onFocusLeaf,
  registerEditorHandle,
  onEditorDirtyChange,
  onEditorCloseTab,
  registerPreviewHandle,
  onPreviewUrlChange,
  registerMarkdownHandle,
  registerGitDiffHandle,
  onAttachToAgent,
  registerGitHistoryHandle,
  onOpenCommitFile,
  gitHistoryRepos,
  onSwitchGitHistoryRepo,
  onSetMarkdownView,
  onOpenMarkdownPath,
}: Props) {
  const kind = activeTab?.kind;
  const isTerminalTab = kind === "terminal";
  const isEditorTab = kind === "editor";
  const isPreviewTab = kind === "preview";
  const isMarkdownTab = kind === "markdown";
  const isGitDiffTab = kind === "git-diff" || kind === "git-commit-file";
  const isGitHistoryTab = kind === "git-history";

  return (
    <div className="relative h-full min-h-0">
      {!activeTab ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <p>此分组暂无打开的项目</p>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-foreground hover:bg-accent"
            onClick={onNewProject}
          >
            新建项目
          </button>
        </div>
      ) : null}
      {activeTab?.kind === "terminal" && activeTab.parked ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <p>项目已收纳，可从分组重新打开</p>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-foreground hover:bg-accent"
            onClick={() => onReopenProject(activeTab.id)}
          >
            重新打开项目
          </button>
        </div>
      ) : null}
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isTerminalTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isTerminalTab}
      >
        <TerminalStack
          spaces={spaces}
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerTerminalHandle}
          onCwd={onCwd}
          onExit={onExit}
          onFocusLeaf={onFocusLeaf}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isEditorTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isEditorTab}
      >
        <EditorStack
          spaces={spaces}
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerEditorHandle}
          onDirtyChange={onEditorDirtyChange}
          onCloseTab={onEditorCloseTab}
          onSetMarkdownView={onSetMarkdownView}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isPreviewTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isPreviewTab}
      >
        <PreviewStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerPreviewHandle}
          onUrlChange={onPreviewUrlChange}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isMarkdownTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isMarkdownTab}
      >
        <MarkdownStack
          spaces={spaces}
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerMarkdownHandle}
          onSetMarkdownView={onSetMarkdownView}
          onOpenPath={onOpenMarkdownPath}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isGitDiffTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitDiffTab}
      >
        <GitDiffStack
          spaces={spaces}
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerGitDiffHandle}
          onAttachToAgent={onAttachToAgent}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0",
          !isGitHistoryTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitHistoryTab}
      >
        <GitHistoryStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerGitHistoryHandle}
          repos={gitHistoryRepos}
          onSwitchRepo={onSwitchGitHistoryRepo}
          onOpenCommitFile={onOpenCommitFile}
        />
      </div>
    </div>
  );
}
