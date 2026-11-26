import { native } from "@/lib/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorToast } from "@/lib/errorToast";
import { toast } from "sonner";
import { parseWorkspaceScopeKey } from "@/modules/workspace";
import {
  clearRepositoryTargetForSpace,
  repositoryTargetForSpace,
  type SourceControlRepositoryTargets,
  setRepositoryTargetForSpace,
} from "./repositoryTarget";

type RequestCounter = { current: number };

type Params = {
  spaceId: string;
  workspaceKey: string;
  isContextCurrent: (spaceId: string, workspaceKey: string) => boolean;
  openSourceControl: () => void;
  openCommitHistoryTab: (input: {
    repoRoot: string;
    branch: string | null;
  }) => void;
};

export function useRepositoryTargeting({
  spaceId,
  workspaceKey,
  isContextCurrent,
  openSourceControl,
  openCommitHistoryTab,
}: Params) {
  const [targets, setTargets] = useState<SourceControlRepositoryTargets>({});
  const sourceControlRequestRef = useRef(0);
  const historyRequestRef = useRef(0);
  const requestScope = `${spaceId}\0${workspaceKey}`;
  const requestScopeRef = useRef(requestScope);
  const repositoryTarget = useMemo(
    () => repositoryTargetForSpace(targets, spaceId, workspaceKey),
    [spaceId, targets, workspaceKey],
  );

  if (requestScopeRef.current !== requestScope) {
    requestScopeRef.current = requestScope;
    sourceControlRequestRef.current += 1;
    historyRequestRef.current += 1;
  }
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sourceControlRequestRef.current++;
      historyRequestRef.current++;
    };
  }, []);

  const resolveRepository = useCallback(
    async (path: string, requestRef: RequestCounter) => {
      if (!mountedRef.current || !isContextCurrent(spaceId, workspaceKey))
        return null;
      const requestId = ++requestRef.current;
      try {
        const repo = await native.gitResolveRepo(
          path,
          parseWorkspaceScopeKey(workspaceKey),
        );
        if (
          !mountedRef.current ||
          requestId !== requestRef.current ||
          !isContextCurrent(spaceId, workspaceKey)
        ) {
          return null;
        }
        if (!repo) {
          toast.info("No Git repository contains this folder.");
        }
        return repo;
      } catch (error) {
        if (
          mountedRef.current &&
          requestId === requestRef.current &&
          isContextCurrent(spaceId, workspaceKey)
        ) {
          errorToast("Could not resolve Git repository", error);
        }
        return null;
      }
    },
    [isContextCurrent, spaceId, workspaceKey],
  );

  const openInSourceControl = useCallback(
    async (path: string) => {
      const repo = await resolveRepository(path, sourceControlRequestRef);
      if (
        !repo ||
        !mountedRef.current ||
        !isContextCurrent(spaceId, workspaceKey)
      )
        return;
      setTargets((current) =>
        setRepositoryTargetForSpace(
          current,
          spaceId,
          workspaceKey,
          repo.repoRoot,
        ),
      );
      openSourceControl();
    },
    [
      openSourceControl,
      resolveRepository,
      spaceId,
      workspaceKey,
      isContextCurrent,
    ],
  );

  const openGitHistory = useCallback(
    async (path: string) => {
      const repo = await resolveRepository(path, historyRequestRef);
      if (
        !repo ||
        !mountedRef.current ||
        !isContextCurrent(spaceId, workspaceKey)
      )
        return;
      openCommitHistoryTab({ repoRoot: repo.repoRoot, branch: repo.branch });
    },
    [
      openCommitHistoryTab,
      resolveRepository,
      isContextCurrent,
      spaceId,
      workspaceKey,
    ],
  );

  const followActiveContext = useCallback(() => {
    sourceControlRequestRef.current += 1;
    setTargets((current) =>
      clearRepositoryTargetForSpace(current, spaceId, workspaceKey),
    );
  }, [spaceId, workspaceKey]);

  const retargetFixedRepository = useCallback(
    (repoRoot: string) => {
      if (!isContextCurrent(spaceId, workspaceKey)) return;
      sourceControlRequestRef.current += 1;
      setTargets((current) =>
        repositoryTargetForSpace(current, spaceId, workspaceKey).mode === "fixed"
          ? setRepositoryTargetForSpace(current, spaceId, workspaceKey, repoRoot)
          : current,
      );
    },
    [isContextCurrent, spaceId, workspaceKey],
  );

  return {
    repositoryTarget,
    openInSourceControl,
    openGitHistory,
    followActiveContext,
    retargetFixedRepository,
  };
}
