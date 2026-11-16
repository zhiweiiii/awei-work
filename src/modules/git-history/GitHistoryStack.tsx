import type { GitRepoHead } from "@/lib/native";
import type { GitHistoryTab, Tab } from "@/modules/tabs";
import { useCallback, useRef } from "react";
import {
  GitHistoryPane,
  type GitHistoryPaneHandle,
} from "@/modules/git-history/GitHistoryPane";

type CommitFileDiffOpenInput = {
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

type Props = {
  tabs: Tab[];
  activeId: number;
  registerHandle: (id: number, handle: GitHistoryPaneHandle | null) => void;
  /** Workspace repos; >1 enables switching the active history tab in place. */
  repos?: GitRepoHead[];
  /** Re-target the active git-history tab to another repo. */
  onSwitchRepo?: (
    tabId: number,
    repoRoot: string,
    branch: string | null,
  ) => void;
  onOpenCommitFile: (input: CommitFileDiffOpenInput) => void;
};

export function GitHistoryStack({
  tabs,
  activeId,
  registerHandle,
  repos,
  onSwitchRepo,
  onOpenCommitFile,
}: Props) {
  const active = tabs.find(
    (t): t is GitHistoryTab => t.kind === "git-history" && t.id === activeId,
  );
  const registerRef = useRef(registerHandle);
  registerRef.current = registerHandle;

  const tabId = active?.id;
  const setRef = useCallback(
    (h: GitHistoryPaneHandle | null) => {
      if (tabId !== undefined) registerRef.current(tabId, h);
    },
    [tabId],
  );

  if (!active) return null;
  return (
    <GitHistoryPane
      key={active.id}
      ref={setRef}
      repoRoot={active.repoRoot}
      initialBranch={active.branch}
      graphRequest={active.graphRequest}
      repos={repos}
      onSwitchRepo={
        onSwitchRepo
          ? (repoRoot, branch) => onSwitchRepo(active.id, repoRoot, branch)
          : undefined
      }
      onOpenCommitFile={onOpenCommitFile}
    />
  );
}
