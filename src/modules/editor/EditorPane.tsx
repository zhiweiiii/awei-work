import { cn } from "@/lib/utils";
import { lspFormatDocument, useLspExtension } from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { type WorkspaceEnv, workspaceScopeKey } from "@/modules/workspace";
import { redo, undo } from "@codemirror/commands";
import {
  findNext,
  findPrevious,
  gotoLine,
  openSearchPanel,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import { diagnosticsReporter } from "./lib/diagnosticsReporter";
import { useDiagnosticsStore } from "./lib/diagnosticsStore";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  indentCompartment,
  indentExtension,
  languageCompartment,
  lspCompartment,
  vimCompartment,
  wrapCompartment,
} from "./lib/extensions";
import {
  applyFormattedContent,
  readFileText,
  resolveFormatter,
  runExternalFormatter,
} from "./lib/externalFormat";
import { detectIndentUnit } from "./lib/indent";
import { type LanguageResult, resolveLanguage } from "./lib/languageResolver";
import { FORCE_READ_LIMIT, useDocument } from "./lib/useDocument";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";
import { initVimGlobals, vimHandlersExtension } from "./lib/vim";
import type { EditorLocation } from "@/modules/editor/lib/navigationHistory";
import { mapperNavigation } from "@/modules/lsp/lib/mapperNavigation";

initVimGlobals();

export type EditorPaneHandle = {
  setQuery: (q: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
  /** Open CodeMirror's find/replace panel. */
  openSearch: () => void;
  focus: () => void;
  getSelection: () => string | null;
  /** 1-based start/end line of the current selection, or null when empty. */
  getSelectionRange: () => { startLine: number; endLine: number } | null;
  getPath: () => string;
  getLocation: () => EditorLocation | null;
  getText: () => string | null;
  /** Re-read the file from disk. Skips silently if the buffer is dirty. */
  reload: () => boolean;
  /** Stat the file and reload only if its mtime moved. For periodic polling. */
  revalidate: () => void;
  /** Move the cursor to a 1-based line and center it, once content is ready. */
  gotoLine: (
    line: number,
    options?: { focus?: boolean; character?: number },
  ) => void;
  /** Apply CodeMirror's undo/redo commands. */
  undo: () => void;
  redo: () => void;
};

type Props = {
  path: string;
  workspace: WorkspaceEnv;
  overrideLanguage?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
};

// Above this, syntax highlighting and LSP are disabled: a multi-MB lezer
// parse tree and a didOpen of that size cost far more than they give.
const SYNTAX_MAX_BYTES = 4 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// memo: EditorStack passes identity-stable props, so background editors
// skip re-rendering entirely when App re-renders (terminal events, tab churn).
export const EditorPane = memo(
  forwardRef<EditorPaneHandle, Props>(function EditorPane(props, ref) {
    const {
      path,
      workspace,
      overrideLanguage,
      onDirtyChange,
      onSaved,
      onClose,
    } = props;
    const documentIdentity = `${workspaceScopeKey(workspace)}\0${path}`;
    const documentIdentityRef = useRef(documentIdentity);
    documentIdentityRef.current = documentIdentity;
    const workspaceRef = useRef(workspace);
    workspaceRef.current = workspace;

    const {
      doc,
      onChange,
      save,
      reload,
      revalidate,
      adoptDiskText,
      openAnyway,
    } = useDocument({
      path,
      workspace,
      onDirtyChange,
    });
    const reloadRef = useRef(reload);
    reloadRef.current = reload;
    const revalidateRef = useRef(revalidate);
    revalidateRef.current = revalidate;
    const adoptDiskTextRef = useRef(adoptDiskText);
    adoptDiskTextRef.current = adoptDiskText;
    const cmRef = useRef<ReactCodeMirrorRef>(null);
    const themeExt = useEditorThemeExt();
    const vimMode = usePreferencesStore((s) => s.vimMode);
    const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap);
    const languageRef = useRef<string | null>(null);
    const [langId, setLangId] = useState<string | null>(null);
    const documentSize = doc.status === "ready" ? doc.size : 0;

    // Stabilize save + onSaved via refs so the extensions array never changes
    // identity — a new identity makes @uiw/react-codemirror reconfigure the
    // whole state, wiping the language compartment.
    const saveRef = useRef(save);
    saveRef.current = save;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const lspActiveRef = useRef(false);
    const warnedNoLspRef = useRef(false);
    const warnedNoFormatRef = useRef(false);
    const saveBusyRef = useRef(false);
    const saveAgainRef = useRef(false);

    const performSave = useCallback(async () => {
      if (saveBusyRef.current) {
        saveAgainRef.current = true;
        return false;
      }
      saveBusyRef.current = true;
      try {
        const targetPath = pathRef.current;
        const targetIdentity = documentIdentityRef.current;
        const targetWorkspace = { ...workspaceRef.current };
        const stillCurrent = () =>
          documentIdentityRef.current === targetIdentity &&
          cmRef.current?.view === view;
        const view = cmRef.current?.view;
        const prefs = usePreferencesStore.getState();
        const formatter = resolveFormatter(languageRef.current, prefs);
        if (prefs.editorFormatOnSave && formatter === "lsp" && view) {
          if (lspActiveRef.current) {
            let res: "done" | "unsupported" = "done";
            try {
              res = await lspFormatDocument(view);
            } catch (e) {
              toast.error("Language server format failed", {
                description: String(e),
              });
            }
            if (res === "unsupported" && !warnedNoFormatRef.current) {
              warnedNoFormatRef.current = true;
              toast.warning("Format on save skipped", {
                description:
                  "The active language server has no formatter. Pick an external one in Settings (Ruff for Python, Prettier, rustfmt, ...).",
              });
            }
          } else if (!warnedNoLspRef.current) {
            warnedNoLspRef.current = true;
            toast.warning("Format on save skipped", {
              description:
                "No active language server for this file. Enable one in the statusbar, or pick an external formatter in Settings.",
            });
          }
        }
        // Snapshot before save: edits typed during the formatter round-trip
        // must not be clobbered by the disk read-back.
        const docAtSave = view?.state.doc;
        if (!stillCurrent()) return false;
        const saved = await saveRef.current();
        if (!saved || !stillCurrent()) return false;
        if (prefs.editorFormatOnSave && formatter !== "lsp") {
          const error = await runExternalFormatter(
            formatter,
            targetPath,
            prefs.editorCustomFormatCommand,
            targetWorkspace,
          );
          if (error) {
            toast.error(`${formatter} format failed`, { description: error });
            return false;
          } else {
            if (!stillCurrent()) return false;
            const readBack = await readFileText(targetPath, targetWorkspace);
            if (
              stillCurrent() &&
              readBack !== null &&
              view &&
              cmRef.current?.view === view &&
              view.state.doc === docAtSave
            ) {
              applyFormattedContent(
                view,
                adoptDiskTextRef.current(readBack.text, readBack.mtime),
              );
            }
          }
        }
        if (stillCurrent()) onSavedRef.current?.();
        return stillCurrent();
      } catch (error) {
        if (cmRef.current?.view)
          toast.error("保存或格式化失败", { description: String(error) });
        return false;
      } finally {
        saveBusyRef.current = false;
        if (saveAgainRef.current) {
          saveAgainRef.current = false;
          void performSaveRef.current();
        }
      }
    }, []);
    const performSaveRef = useRef(performSave);
    performSaveRef.current = performSave;

    const pathRef = useRef(path);
    pathRef.current = path;

    const pendingLineRef = useRef<{
      path: string;
      line: number;
      character?: number;
      focus: boolean;
    } | null>(null);
    const pendingFocusRef = useRef<string | null>(null);
    const statusRef = useRef(doc.status);
    useLayoutEffect(() => {
      statusRef.current = doc.status;
    }, [doc.status]);

    useEffect(() => {
      if (pendingLineRef.current?.path !== path) {
        pendingLineRef.current = null;
      }
      if (pendingFocusRef.current !== path) {
        pendingFocusRef.current = null;
      }
    }, [path]);

    const focusWhenRendered = useCallback(
      (view: EditorView, targetPath: string) => {
        requestAnimationFrame(() => {
          if (cmRef.current?.view === view && pathRef.current === targetPath) {
            view.focus();
          }
        });
      },
      [],
    );

    const applyPendingGoto = useCallback(
      (createdView?: EditorView) => {
        const view = createdView ?? cmRef.current?.view;
        const pending = pendingLineRef.current;
        if (!view || pending == null || statusRef.current !== "ready") return;
        if (pending.path !== path) {
          pendingLineRef.current = null;
          return;
        }
        const target = Math.max(
          1,
          Math.min(pending.line, view.state.doc.lines),
        );
        const targetLine = view.state.doc.line(target);
        const character = Number.isSafeInteger(pending.character)
          ? Math.max(0, pending.character ?? 0)
          : 0;
        const at = Math.min(targetLine.from + character, targetLine.to);
        view.dispatch({
          selection: { anchor: at },
          effects: EditorView.scrollIntoView(at, { y: "center" }),
        });
        if (pending.focus) focusWhenRendered(view, pending.path);
        pendingLineRef.current = null;
      },
      [focusWhenRendered, path],
    );

    const applyPendingFocus = useCallback(
      (createdView?: EditorView) => {
        const view = createdView ?? cmRef.current?.view;
        const pendingPath = pendingFocusRef.current;
        if (!view || pendingPath === null || statusRef.current !== "ready")
          return;
        pendingFocusRef.current = null;
        if (pendingPath === path) focusWhenRendered(view, pendingPath);
      },
      [focusWhenRendered, path],
    );

    useEffect(() => {
      if (doc.status !== "ready") return;
      applyPendingGoto();
      applyPendingFocus();
    }, [doc.status, applyPendingFocus, applyPendingGoto]);

    const extensions = useMemo(
      () => [
        // basicSetup is added before user extensions by @uiw/react-codemirror,
        // so we must elevate vim's precedence to win the keymap.
        vimCompartment.of(
          usePreferencesStore.getState().vimMode ? Prec.highest(vim()) : [],
        ),
        wrapCompartment.of(
          usePreferencesStore.getState().editorWordWrap
            ? EditorView.lineWrapping
            : [],
        ),
        vimHandlersExtension(() => ({
          save: () => performSaveRef.current(),
          close: () => onCloseRef.current?.(),
        })),
        ...buildSharedExtensions(),
        indentCompartment.of(DEFAULT_INDENT),
        languageCompartment.of([]),
        lspCompartment.of([]),
        mapperNavigation(() => ({
          path: pathRef.current,
          workspace: workspaceRef.current,
        })),
        diagnosticsReporter(() => pathRef.current),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              void performSaveRef.current();
              return true;
            },
          },
          { key: "Ctrl-g", run: gotoLine },
        ]),
      ],
      [],
    );

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: vimCompartment.reconfigure(vimMode ? Prec.highest(vim()) : []),
      });
    }, [vimMode]);

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: wrapCompartment.reconfigure(
          editorWordWrap ? EditorView.lineWrapping : [],
        ),
      });
    }, [editorWordWrap]);

    useEffect(() => {
      if (doc.status !== "ready") return;
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: indentCompartment.reconfigure(
          indentExtension(detectIndentUnit(doc.content)),
        ),
      });
    }, [doc]);

    const lspExt = useLspExtension(
      path,
      langId,
      doc.status === "ready" && workspace.kind === "local",
    );
    useEffect(() => {
      lspActiveRef.current = lspExt !== null;
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: lspCompartment.reconfigure(lspExt ?? []),
      });
    }, [lspExt]);

    useEffect(
      () => () => useDiagnosticsStore.getState().report(path, null),
      [path],
    );

    // Warm the language chunk while the file is still being read; the
    // ready-gated effect below then resolves from cache.
    useEffect(() => {
      const resolvePath = overrideLanguage ? `dummy.${overrideLanguage}` : path;
      void resolveLanguage(resolvePath).catch(() => {});
    }, [path, overrideLanguage]);

    useEffect(() => {
      const ext =
        overrideLanguage || (path.split(".").pop()?.toLowerCase() ?? null);
      languageRef.current = ext;
      if (doc.status !== "ready") return;
      if (documentSize > SYNTAX_MAX_BYTES) {
        setLangId(null);
        const view = cmRef.current?.view;
        view?.dispatch({ effects: languageCompartment.reconfigure([]) });
        return;
      }
      let cancelled = false;
      const resolve = async (): Promise<LanguageResult> => {
        const resolvePath = overrideLanguage
          ? `dummy.${overrideLanguage}`
          : path;
        return (
          (await resolveLanguage(resolvePath)) ?? { ext: [], name: "", id: "" }
        );
      };
      void resolve()
        .then((result) => {
          if (cancelled) return;
          if (result.id) languageRef.current = result.id;
          setLangId(result.id || ext);
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: languageCompartment.reconfigure(result.ext),
          });
        })
        .catch((error) => {
          if (!cancelled)
            toast.error("加载语言支持失败", { description: String(error) });
        });
      return () => {
        cancelled = true;
      };
    }, [path, doc.status, documentSize, overrideLanguage]);

    useImperativeHandle(
      ref,
      () => ({
        setQuery: (q: string) => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(
              new SearchQuery({ search: q, caseSensitive: false }),
            ),
          });
          if (q) findNext(view);
        },
        findNext: () => {
          const view = cmRef.current?.view;
          if (view) findNext(view);
        },
        findPrevious: () => {
          const view = cmRef.current?.view;
          if (view) findPrevious(view);
        },
        clearQuery: () => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(new SearchQuery({ search: "" })),
          });
        },
        openSearch: () => {
          const view = cmRef.current?.view;
          if (view) openSearchPanel(view);
        },
        focus: () => {
          pendingFocusRef.current = path;
          applyPendingFocus();
        },
        getSelection: () => {
          const view = cmRef.current?.view;
          if (!view) return null;
          const { from, to } = view.state.selection.main;
          if (from === to) return null;
          return view.state.sliceDoc(from, to);
        },
        getSelectionRange: () => {
          const view = cmRef.current?.view;
          if (!view) return null;
          const { from, to } = view.state.selection.main;
          if (from === to) return null;
          return {
            startLine: view.state.doc.lineAt(from).number,
            endLine: view.state.doc.lineAt(to).number,
          };
        },
        getPath: () => path,
        getText: () =>
          statusRef.current === "ready"
            ? (cmRef.current?.view?.state.doc.toString() ?? null)
            : null,
        getLocation: () => {
          const view = cmRef.current?.view;
          if (!view || statusRef.current !== "ready") return null;
          const position = view.state.selection.main.head;
          const line = view.state.doc.lineAt(position);
          return { path, line: line.number, character: position - line.from };
        },
        reload: () => reloadRef.current(),
        revalidate: () => void revalidateRef.current(),
        gotoLine: (line: number, options) => {
          pendingLineRef.current = {
            path,
            line,
            character: options?.character,
            focus: options?.focus ?? true,
          };
          applyPendingGoto();
        },
        undo: () => {
          const view = cmRef.current?.view;
          if (view) undo(view);
        },
        redo: () => {
          const view = cmRef.current?.view;
          if (view) redo(view);
        },
      }),
      [path, applyPendingFocus, applyPendingGoto],
    );

    if (doc.status === "loading") {
      return (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      );
    }
    if (doc.status === "error") {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
          {doc.message}
        </div>
      );
    }
    if (doc.status === "binary" || doc.status === "toolarge") {
      const canForce =
        doc.status === "toolarge" && doc.size <= FORCE_READ_LIMIT;
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">
            {doc.status === "binary" ? "Binary file" : "File too large"}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} ·{" "}
            {canForce ? "syntax features disabled" : "preview not supported"}
          </div>
          {canForce && (
            <button
              type="button"
              onClick={openAnyway}
              className="mt-2 rounded-md border border-border bg-muted/60 px-3 py-1 text-xs text-foreground hover:bg-accent"
            >
              Open anyway
            </button>
          )}
        </div>
      );
    }

    return (
      <div className="group/pane relative flex h-full min-h-0 flex-col zoom-exempt">
        {/* Re-read from disk. The pane already polls the file's mtime
            (`revalidate`), so this is the way out of the case where that did
            not fire. Floating rather than in a header bar: an editor pane has
            no chrome, and adding a row to every one of them to carry a button
            used occasionally is the wrong trade. Hidden until the pointer is
            in the pane, and skipped while the buffer is dirty, which is the
            same rule `reload` itself enforces. */}
        <button
          type="button"
          title="重新读取文件内容"
          onClick={() => {
            if (!reloadRef.current()) {
              toast.info("有未保存的修改，已跳过刷新");
            }
          }}
          className={cn(
            "absolute right-2 top-2 z-10 flex size-6 items-center justify-center rounded-md",
            "border border-border/50 bg-background/80 text-muted-foreground backdrop-blur",
            "opacity-0 transition-opacity hover:bg-accent hover:text-foreground",
            "focus-visible:opacity-100 group-hover/pane:opacity-100",
          )}
        >
          <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
        </button>
        <CodeMirror
          ref={cmRef}
          onCreateEditor={(view) => {
            applyPendingGoto(view);
            applyPendingFocus(view);
          }}
          value={doc.content}
          onChange={onChange}
          theme={themeExt}
          extensions={extensions}
          height="100%"
          className="flex-1 min-h-0 overflow-hidden"
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            foldGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            searchKeymap: true,
          }}
        />
      </div>
    );
  }),
);
