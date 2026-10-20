import { errorToast } from "@/lib/errorToast";
import {
  currentWorkspaceScopeKey,
  LOCAL_WORKSPACE,
  workspaceScopeKey,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { useCallback, useEffect, useRef, useState } from "react";

export function useRepositoryOperation(open: boolean, target: string) {
  const workspace = LOCAL_WORKSPACE;
  const key = JSON.stringify([open, target, workspaceScopeKey(workspace)]);
  const scopeRef = useRef({ key });
  if (scopeRef.current.key !== key) scopeRef.current = { key };
  const scope = scopeRef.current;
  const mountedRef = useRef(true);
  const pendingRef = useRef(false);
  const generationRef = useRef(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current++;
    };
  }, []);
  const current = useCallback(
    () =>
      open &&
      mountedRef.current &&
      scopeRef.current === scope &&
      currentWorkspaceScopeKey() === workspaceScopeKey(workspace),
    [open, scope],
  );
  const run = useCallback(
    async <T>(
      work: (workspace: WorkspaceEnv) => Promise<T>,
      success: (result: T) => void,
      errorTitle: string,
      failure?: (error: unknown) => void,
    ) => {
      if (pendingRef.current || !current()) return false;
      pendingRef.current = true;
      const generation = ++generationRef.current;
      setBusy(true);
      try {
        const result = await work(workspace);
        if (generation === generationRef.current && current()) {
          success(result);
          return true;
        }
      } catch (error) {
        if (failure && generation === generationRef.current && current())
          failure(error);
        else errorToast(errorTitle, error);
      } finally {
        pendingRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
      return false;
    },
    [current],
  );
  return { busy, run, scopeKey: key, isCurrent: current };
}
