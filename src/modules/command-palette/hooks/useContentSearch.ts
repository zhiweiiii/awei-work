import {
  currentWorkspaceScopeKey,
  LOCAL_WORKSPACE,
  workspaceScopeKey,
} from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import { type AsyncQueryState, useAsyncQuery } from "./useAsyncQuery";

export const CONTENT_SEARCH_MIN_QUERY = 2;
const LIMIT = 80;
const DEBOUNCE_MS = 140;

export type ContentHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

type GrepResponse = {
  hits: ContentHit[];
  truncated: boolean;
  files_scanned: number;
};

type Options = {
  /** Shortest term worth a full-tree grep. Defaults to CONTENT_SEARCH_MIN_QUERY. */
  minLength?: number;
  /** Idle time before the walk starts. Defaults to DEBOUNCE_MS. */
  debounceMs?: number;
};

export function useContentSearch(
  root: string | null,
  term: string,
  enabled: boolean,
  options?: Options,
): AsyncQueryState<ContentHit> {
  const workspace = LOCAL_WORKSPACE;
  const workspaceKey = workspaceScopeKey(workspace);
  const run = useCallback(
    async (q: string): Promise<ContentHit[]> => {
      if (!root) return [];
      if (currentWorkspaceScopeKey() !== workspaceKey)
        throw new Error("Workspace changed");
      const res = await invoke<GrepResponse>("fs_grep_interactive", {
        pattern: q,
        root,
        maxResults: LIMIT,
        workspace,
      });
      if (currentWorkspaceScopeKey() !== workspaceKey)
        throw new Error("Workspace changed");
      return res.hits;
    },
    [root, workspaceKey],
  );

  return useAsyncQuery({
    enabled: enabled && !!root,
    term,
    minLength: options?.minLength ?? CONTENT_SEARCH_MIN_QUERY,
    debounceMs: options?.debounceMs ?? DEBOUNCE_MS,
    run,
    scopeKey: `${workspaceKey}\0${root ?? ""}`,
  });
}
