import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { errorToast } from "@/lib/errorToast";
import { invoke } from "@tauri-apps/api/core";
import {
  type WorkspaceEnv,
  workspaceScopeKey,
  currentWorkspaceScopeKey,
  parseWorkspaceScopeKey,
} from "@/modules/workspace";
import { joinPath } from "@/modules/explorer/lib/useFileTree";
import {
  setDiffCollapseUnchanged,
  setDiffContextLines,
} from "@/modules/settings/store";
import {
  diffFoldRevision,
  structuralDiffFolding,
} from "@/modules/editor/lib/diffFolding";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  RefreshIcon,
  SparklesIcon,
  UnfoldLessIcon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { unifiedMergeView } from "@codemirror/merge";
import { openSearchPanel } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { toast } from "sonner";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  commitDiffKey,
  fetchCommitDiff,
  fetchWorkingDiff,
  getCachedDiff,
  invalidateDiff,
  invalidateRepoDiffs,
  workingDiffKey,
} from "./lib/diffCache";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  languageCompartment,
} from "./lib/extensions";
import { detectEol, normalizeToLf, restoreEol } from "./lib/eol";
import { resolveLanguage, resolveLanguageSync } from "./lib/languageResolver";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";

type WorkingSource = {
  kind: "working";
  repoRoot: string;
  path: string;
  mode: "-" | "+";
  originalPath: string | null;
};

type CommitSource = {
  kind: "commit";
  repoRoot: string;
  sha: string;
  path: string;
  originalPath: string | null;
};

type Props = {
  source: WorkingSource | CommitSource;
  workspace: WorkspaceEnv;
  chipLabel?: string;
  active: boolean;
  /** Hand this file to the agent, the same way the explorer's menu does. */
  onAttachToAgent?: (absolutePath: string) => void;
};

const LARGE_FILE_THRESHOLD = 256 * 1024;

const SHARED_EXT = buildSharedExtensions();
/* Read-only facets also disable custom widgets; explicit chunk reverts are
   available only for unstaged working-tree content. */
const READONLY_EXT = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
];
const DIFF_THEME = EditorView.theme({
  "&.cm-merge-b .cm-changedText, .cm-changedText": {
    background: "rgba(110, 200, 120, 0.20) !important",
    borderRadius: "3px",
    padding: "0 1px",
  },
  ".cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText": {
    background: "rgba(220, 90, 90, 0.22) !important",
    borderRadius: "3px",
    padding: "0 1px",
  },
  "&.cm-merge-b .cm-changedLine, .cm-changedLine, .cm-inlineChangedLine": {
    backgroundColor: "rgba(110, 200, 120, 0.05) !important",
  },
  ".cm-deletedChunk": {
    backgroundColor: "rgba(220, 90, 90, 0.05) !important",
    paddingTop: "1px",
    paddingBottom: "1px",
  },
  "&.cm-merge-b .cm-changedLineGutter, .cm-changedLineGutter": {
    background: "rgba(110, 200, 120, 0.55) !important",
  },
  ".cm-deletedLineGutter, &.cm-merge-a .cm-changedLineGutter": {
    background: "rgba(220, 90, 90, 0.5) !important",
  },
  ".cm-changeGutter": {
    width: "2px !important",
    paddingLeft: "0 !important",
  },
  /* The revert button sits on the chunk it acts on. Quiet until hovered:
     it is an escape hatch, not the main thing on the line. */
  ".cm-terax-revert": {
    marginLeft: "6px",
    padding: "0 6px",
    border: "1px solid rgba(127, 127, 127, 0.35)",
    borderRadius: "5px",
    background: "transparent",
    color: "var(--muted-foreground, #9ca3af)",
    font: "inherit",
    fontSize: "10.5px",
    lineHeight: "16px",
    cursor: "pointer",
    opacity: 0.65,
  },
  ".cm-terax-revert:hover": {
    opacity: 1,
    background: "rgba(220, 90, 90, 0.12)",
    borderColor: "rgba(220, 90, 90, 0.55)",
  },
  ".cm-diff-fold": {
    height: "4px",
    borderTop: "1px solid var(--border)",
  },
});

function countDiffLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let hunk = false;
  for (let start = 0; start < patch.length; ) {
    const next = patch.indexOf("\n", start);
    const end = next < 0 ? patch.length : next;
    const line = patch.slice(start, end);
    if (line.startsWith("diff --git ")) hunk = false;
    else if (line.startsWith("@@ ")) hunk = true;
    else if (hunk && line.startsWith("+")) added++;
    else if (hunk && line.startsWith("-")) removed++;
    start = end + 1;
  }
  return { added, removed };
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "loaded";
      originalContent: string;
      modifiedContent: string;
      isBinary: boolean;
      fallbackPatch: string;
      /** Resolved before mount: a late compartment reconfigure would leave
       * the merge view's deleted-chunk widgets unhighlighted. */
      langExt: Extension | null;
    }
  | { kind: "error"; message: string };

function cacheKey(
  source: WorkingSource | CommitSource,
  workspace: WorkspaceEnv,
): string {
  return source.kind === "working"
    ? workingDiffKey(
        source.repoRoot,
        source.path,
        source.mode,
        source.originalPath,
        workspace,
      )
    : commitDiffKey(
        source.repoRoot,
        source.sha,
        source.path,
        source.originalPath,
        workspace,
      );
}

function loadStateFromCache(
  source: WorkingSource | CommitSource,
  workspace: WorkspaceEnv,
): LoadState {
  const hit = getCachedDiff(cacheKey(source, workspace));
  if (!hit) return { kind: "idle" };
  return {
    kind: "loaded",
    originalContent: hit.originalContent,
    modifiedContent: hit.modifiedContent,
    isBinary: hit.isBinary,
    fallbackPatch: hit.fallbackPatch,
    langExt: resolveLanguageSync(source.path)?.ext ?? null,
  };
}

export type GitDiffPaneHandle = {
  openSearch: () => void;
  /** Selected text, so a diff can hand a snippet to the agent the same way an
   *  editor does. Null when nothing is selected. */
  getSelection: () => string | null;
};

export const GitDiffPane = forwardRef<GitDiffPaneHandle, Props>(
  function GitDiffPane(
    { source: incomingSource, workspace, chipLabel, active, onAttachToAgent },
    ref,
  ) {
    const scope = workspaceScopeKey(workspace);
    const env = useMemo(() => parseWorkspaceScopeKey(scope), [scope]);
    const sourceJson = JSON.stringify(incomingSource);
    const source = useMemo(
      () => JSON.parse(sourceJson) as WorkingSource | CommitSource,
      [sourceJson],
    );
    const key = cacheKey(source, env);
    const identityRef = useRef(key);
    identityRef.current = key;
    const loadedKeyRef = useRef(key);
    const cmRef = useRef<ReactCodeMirrorRef>(null);
    const themeExt = useEditorThemeExt();
    const collapseUnchanged = usePreferencesStore(
      (s) => s.diffCollapseUnchanged,
    );
    const contextLines = usePreferencesStore((s) => s.diffContextLines);
    const [storedState, setState] = useState<LoadState>(() =>
      active ? loadStateFromCache(source, env) : { kind: "idle" },
    );
    const state: LoadState =
      loadedKeyRef.current === key ? storedState : { kind: "idle" };

    const openSearch = useCallback(() => {
      const view = cmRef.current?.view;
      if (view) openSearchPanel(view);
    }, []);

    const getSelection = useCallback(() => {
      const view = cmRef.current?.view;
      if (!view) return null;
      const { from, to } = view.state.selection.main;
      return from === to ? null : view.state.sliceDoc(from, to);
    }, []);

    useImperativeHandle(ref, () => ({ openSearch, getSelection }), [
      openSearch,
      getSelection,
    ]);

    const [reloadNonce, setReloadNonce] = useState(0);

    /* Read the file again from scratch.
       The pane normally refreshes itself when the working tree changes; this
       is the way out of the case where it did not. The cached entry is dropped
       first, otherwise the load below would answer from it and the click would
       appear to do nothing. */
    const reload = useCallback(() => {
      invalidateDiff(cacheKey(source, env));
      setReloadNonce((n) => n + 1);
    }, [source, env]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: The reload revision forces a new read after cache invalidation.
    useEffect(() => {
      if (!active) return;
      loadedKeyRef.current = key;
      const cached = loadStateFromCache(source, env);
      if (cached.kind === "loaded") {
        setState(cached);
        return;
      }
      let cancelled = false;
      setState({ kind: "loading" });
      const promise =
        source.kind === "working"
          ? fetchWorkingDiff(
              source.repoRoot,
              source.path,
              source.mode,
              source.originalPath,
              env,
            )
          : fetchCommitDiff(
              source.repoRoot,
              source.sha,
              source.path,
              source.originalPath,
              env,
            );
      Promise.all([promise, resolveLanguage(source.path).catch(() => null)])
        .then(([res, lang]) => {
          if (cancelled || identityRef.current !== key) return;
          setState({
            kind: "loaded",
            originalContent: res.originalContent,
            modifiedContent: res.modifiedContent,
            isBinary: res.isBinary,
            fallbackPatch: res.fallbackPatch,
            langExt: lang?.ext ?? null,
          });
        })
        .catch((err) => {
          if (cancelled || identityRef.current !== key) return;
          setState({
            kind: "error",
            message:
              err && typeof err === "object" && "message" in err
                ? String((err as { message: unknown }).message)
                : String(err),
          });
        });
      return () => {
        cancelled = true;
      };
    }, [active, key, source, reloadNonce, env]);

    const path = source.path;
    const repoRoot = source.repoRoot;
    const mode = source.kind === "working" ? source.mode : "+";
    const loaded = state.kind === "loaded" ? state : null;
    /* The two sides do not arrive on equal footing: `original` is the blob
       from git's object store, `modified` is the file on disk. With
       `core.autocrlf=true` - the Git for Windows default - the blob holds LF
       and the working tree holds CRLF, so EVERY line compares unequal, the
       whole file becomes one chunk, and there is nothing left to collapse.
       That is why the fold appeared to work in some repositories and not
       others: it follows the line endings, not the file type. `git ls-files
       --eol` reports 343 such files in this repository alone.

       Both sides are compared in LF space. The worktree's own ending is kept
       so a revert can write the file back the way it was found. */
    const rawOriginal = loaded?.originalContent ?? "";
    const rawModified = loaded?.modifiedContent ?? "";
    const fileEol = useMemo(() => detectEol(rawModified), [rawModified]);
    const originalContent = useMemo(
      () => normalizeToLf(rawOriginal),
      [rawOriginal],
    );
    const modifiedContent = useMemo(
      () => normalizeToLf(rawModified),
      [rawModified],
    );
    const foldRevision = useMemo(
      () => diffFoldRevision(originalContent, modifiedContent),
      [originalContent, modifiedContent],
    );
    const isBinary = loaded?.isBinary ?? false;
    const fallbackPatch = loaded?.fallbackPatch ?? "";

    const isTooLarge =
      originalContent.length > LARGE_FILE_THRESHOLD ||
      modifiedContent.length > LARGE_FILE_THRESHOLD;
    const useFallback = isBinary || isTooLarge;

    const langExt = loaded?.langExt ?? null;

    // Staged and historical diffs must never overwrite working-tree content.
    const revertable = source.kind === "working" && source.mode === "-";
    const absolutePath = useMemo(
      () => joinPath(source.repoRoot, source.path),
      [source.repoRoot, source.path],
    );

    /* Write the doc back to the file after a chunk was reverted.
       The revert itself is the merge extension's own action, which knows which
       chunk the button belongs to; it applies synchronously, so by the time
       this runs the doc already holds the reverted text. Saving the doc rather
       than recomputing the file keeps what lands on disk identical to what is
       on screen.

       Nothing is staged or committed: this is the same edit the user could
       have made by hand in the editor. */
    const revertBusyRef = useRef(false);
    const persistedContentRef = useRef(rawModified);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Changing files resets the save baseline even when their content is identical.
    useEffect(() => {
      persistedContentRef.current = rawModified;
    }, [rawModified, key]);

    const persistRevert = useCallback(
      async (action: () => void) => {
        const view = cmRef.current?.view;
        if (!view || !revertable || revertBusyRef.current) return;
        const before = view.state.doc;
        const current = () =>
          identityRef.current === key &&
          cmRef.current?.view === view &&
          currentWorkspaceScopeKey() === scope;
        if (!current()) return;
        revertBusyRef.current = true;
        try {
          const disk = await invoke<{
            kind: string;
            content?: string;
            mtime?: number;
          }>("fs_read_file", { path: absolutePath, workspace: env });
          if (!current() || view.state.doc !== before) return;
          if (
            disk.kind !== "text" ||
            disk.content !== persistedContentRef.current ||
            typeof disk.mtime !== "number"
          )
            throw new Error("文件已被其他程序修改，请刷新差异后再回滚");
          action();
          const content = restoreEol(view.state.doc.toString(), fileEol);
          await invoke<number>("fs_write_file", {
            path: absolutePath,
            content,
            workspace: env,
            expectedMtime: disk.mtime,
            source: "git-diff",
          });
          if (identityRef.current === key)
            persistedContentRef.current = content;
          invalidateRepoDiffs(source.repoRoot, env);
          if (current()) toast.success("已回滚该处改动");
        } catch (error) {
          if (current()) {
            errorToast("回滚失败", error);
            reload();
          }
        } finally {
          revertBusyRef.current = false;
        }
      },
      [
        absolutePath,
        source.repoRoot,
        fileEol,
        revertable,
        key,
        scope,
        env,
        reload,
      ],
    );

    const extensions = useMemo(
      () => [
        ...SHARED_EXT,
        DEFAULT_INDENT,
        languageCompartment.of(langExt ?? []),
        ...READONLY_EXT,
        unifiedMergeView({
          original: originalContent,
          highlightChanges: true,
          // The default scan budget collapses sparse edits in larger files.
          diffConfig: { scanLimit: 10000, timeout: 200 },
          gutter: true,
          syntaxHighlightDeletions: true,
          // One button, labelled for what it does here. The library's default
          // pair is Accept/Reject, which is merge-conflict vocabulary: there
          // is no conflict on screen, only a change the user may want undone.
          // "Accept" would mean nothing, so it is not rendered.
          mergeControls: revertable
            ? (type, action) => {
                const btn = document.createElement("button");
                btn.className = "cm-terax-revert";
                if (type === "accept") {
                  btn.style.display = "none";
                  return btn;
                }
                btn.textContent = "回滚";
                btn.title = "把这一处改回提交时的内容";
                btn.onclick = (e) => {
                  if (e.button !== 0) return;
                  void persistRevert(() => action(e));
                };
                return btn;
              }
            : false,
        }),
        structuralDiffFolding({
          context: contextLines,
          enabled: collapseUnchanged,
        }),
        DIFF_THEME,
      ],
      [
        originalContent,
        langExt,
        collapseUnchanged,
        revertable,
        persistRevert,
        contextLines,
      ],
    );

    // Cache-hit path only: the diff came from the cache before the language
    // pack was imported. Resolve and reconfigure once the view exists.
    useEffect(() => {
      if (useFallback || state.kind !== "loaded" || state.langExt) return;
      let cancelled = false;
      resolveLanguage(path)
        .then((res) => {
          if (cancelled || identityRef.current !== key || !res) return;
          setState((s) =>
            s.kind === "loaded" ? { ...s, langExt: res.ext } : s,
          );
        })
        .catch((error) => {
          if (!cancelled) errorToast("加载差异语言支持失败", error);
        });
      return () => {
        cancelled = true;
      };
    }, [useFallback, path, state, key]);

    const stats = useMemo(
      () =>
        useFallback ? countDiffLines(fallbackPatch) : { added: 0, removed: 0 },
      [useFallback, fallbackPatch],
    );

    return (
      <div className="flex h-full min-h-0 flex-col rounded-md border border-border/60 bg-background">
        <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3">
          <div className="flex min-w-0 items-center gap-2">
            <Badge
              variant="outline"
              className="text-[10px] uppercase tracking-wide"
            >
              {chipLabel ?? mode}
            </Badge>
            {isBinary ? (
              <Badge variant="secondary" className="text-[10px]">
                Binary / patch fallback
              </Badge>
            ) : isTooLarge ? (
              <Badge variant="secondary" className="text-[10px]">
                Large file / patch view
              </Badge>
            ) : null}
            <span
              className="truncate font-mono text-[11px] text-muted-foreground"
              title={path}
            >
              {path}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-[10.5px] tabular-nums text-muted-foreground">
            <span className="truncate max-w-60 font-mono">{repoRoot}</span>
            {useFallback ? (
              <>
                <span className="text-emerald-600 dark:text-emerald-400">
                  +{stats.added}
                </span>
                <span className="text-rose-600 dark:text-rose-400">
                  −{stats.removed}
                </span>
              </>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[10.5px]"
              title="重新读取文件内容"
              disabled={state.kind === "loading"}
              onClick={reload}
            >
              <HugeiconsIcon icon={RefreshIcon} size={13} strokeWidth={1.75} />
              刷新
            </Button>
            {/* The fold has nothing to act on in the patch fallback: that view
                is the patch, which is already only the changes. */}
            {!useFallback ? (
              <>
                <select
                  aria-label="差异上下文行数"
                  title="改动前后保留的行数；自动保留可识别的类和方法声明"
                  className="h-6 rounded border border-border/60 bg-background px-1 text-[10.5px]"
                  value={contextLines}
                  disabled={!collapseUnchanged}
                  onChange={(event) =>
                    void setDiffContextLines(Number(event.target.value)).catch(
                      (error) => errorToast("保存上下文行数失败", error),
                    )
                  }
                >
                  {[4, 8, 16, 32].map((count) => (
                    <option key={count} value={count}>
                      {count} 行上下文
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-[10.5px]"
                  /* Labelled with the VERB, and the tooltip says where you are.
                   The old labels were bare nouns ("完整文件" / "仅变动"), which
                   read as a description of what is on screen rather than as
                   what the click does: with the fold off the button said
                   "仅变动" next to a fully expanded file, so a working toggle
                   looked broken. */
                  title={
                    collapseUnchanged
                      ? "当前：保留改动、上下文和相关声明，隐藏未改动方法。点击展开为完整文件"
                      : "当前：完整文件。点击折叠未变动的部分"
                  }
                  onClick={() => {
                    void setDiffCollapseUnchanged(!collapseUnchanged).catch(
                      (error) => errorToast("保存差异显示设置失败", error),
                    );
                  }}
                >
                  <HugeiconsIcon
                    icon={collapseUnchanged ? UnfoldMoreIcon : UnfoldLessIcon}
                    size={13}
                    strokeWidth={1.75}
                  />
                  {collapseUnchanged ? "展开全文" : "折叠未变动"}
                </Button>
              </>
            ) : null}
            {onAttachToAgent ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[10.5px]"
                title="发送到 agent"
                onClick={() =>
                  onAttachToAgent(
                    joinPath(
                      repoRoot.replace(/\\/g, "/"),
                      path.replace(/\\/g, "/"),
                    ),
                  )
                }
              >
                <HugeiconsIcon
                  icon={SparklesIcon}
                  size={13}
                  strokeWidth={1.75}
                />
                发送到 agent
              </Button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {state.kind === "loading" || state.kind === "idle" ? (
            <div className="flex h-full items-center justify-center gap-2 text-[11px] text-muted-foreground">
              <Spinner className="size-3" />
              Loading diff…
            </div>
          ) : state.kind === "error" ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[11.5px] text-destructive">
              {state.message}
            </div>
          ) : useFallback ? (
            <ScrollArea className="h-full">
              <pre className="min-h-full whitespace-pre-wrap wrap-break-word p-4 font-mono text-[12px] leading-relaxed text-muted-foreground">
                {fallbackPatch ||
                  "Diff preview is not available for this file."}
              </pre>
            </ScrollArea>
          ) : (
            <CodeMirror
              key={`${foldRevision}:${collapseUnchanged}:${contextLines}:${langExt ? "lang" : "nolang"}`}
              ref={cmRef}
              value={modifiedContent}
              theme={themeExt}
              extensions={extensions}
              editable={false}
              height="100%"
              className="h-full"
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: false,
                highlightActiveLineGutter: false,
                searchKeymap: true,
              }}
            />
          )}
        </div>
      </div>
    );
  },
);
