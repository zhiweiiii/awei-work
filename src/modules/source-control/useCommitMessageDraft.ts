import { pathIdentity } from "@/lib/pathIdentity";
import { useCallback } from "react";
import { create } from "zustand";

type CommitMessageDraft = Readonly<{ message: string }>;

type CommitMessageDrafts = {
  drafts: Map<string, CommitMessageDraft>;
  generations: Map<string, CommitMessageDraft>;
  write: (key: string, message: string) => void;
  clear: (key: string, expected: CommitMessageDraft) => void;
  begin: (key: string) => boolean;
  finish: (key: string, message?: string) => boolean;
};

const EMPTY_DRAFT: CommitMessageDraft = { message: "" };

export function commitMessageDraftKey(
  workspaceKey: string,
  repoRoot: string | null,
): string | null {
  return repoRoot
    ? JSON.stringify([workspaceKey, pathIdentity(repoRoot)])
    : null;
}

export const useCommitMessageDraftStore = create<CommitMessageDrafts>(
  (set) => ({
    drafts: new Map(),
    generations: new Map(),
    write: (key, message) =>
      set((state) => {
        if ((state.drafts.get(key)?.message ?? "") === message) return state;
        const drafts = new Map(state.drafts);
        if (message || state.generations.has(key)) drafts.set(key, { message });
        else drafts.delete(key);
        return { drafts };
      }),
    clear: (key, expected) =>
      set((state) => {
        if (state.drafts.get(key) !== expected) return state;
        const drafts = new Map(state.drafts);
        if (state.generations.has(key)) drafts.set(key, { message: "" });
        else drafts.delete(key);
        return { drafts };
      }),
    begin: (key) => {
      let started = false;
      set((state) => {
        if (state.generations.has(key)) return state;
        const drafts = new Map(state.drafts);
        const draft = drafts.get(key) ?? { message: "" };
        drafts.set(key, draft);
        const generations = new Map(state.generations);
        generations.set(key, draft);
        started = true;
        return { drafts, generations };
      });
      return started;
    },
    finish: (key, message) => {
      let applied = false;
      set((state) => {
        const expected = state.generations.get(key);
        if (!expected) return state;
        const generations = new Map(state.generations);
        generations.delete(key);
        const drafts = new Map(state.drafts);
        if (message && drafts.get(key) === expected) {
          drafts.set(key, { message });
          applied = true;
        } else if (!drafts.get(key)?.message) drafts.delete(key);
        return { drafts, generations };
      });
      return applied;
    },
  }),
);

export function useCommitMessageDraft(
  workspaceKey: string,
  repoRoot: string | null,
) {
  const key = commitMessageDraftKey(workspaceKey, repoRoot);
  const draft = useCommitMessageDraftStore((state) =>
    key ? (state.drafts.get(key) ?? EMPTY_DRAFT) : EMPTY_DRAFT,
  );
  const setCommitMessage = useCallback(
    (message: string) => {
      if (key) useCommitMessageDraftStore.getState().write(key, message);
    },
    [key],
  );
  const clearCommittedDraft = useCallback(() => {
    if (key) useCommitMessageDraftStore.getState().clear(key, draft);
  }, [key, draft]);
  return {
    commitMessage: draft.message,
    setCommitMessage,
    clearCommittedDraft,
  };
}
