import {
  highlightingFor,
  indentUnit,
  language,
  syntaxTree,
} from "@codemirror/language";
import {
  type Extension,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
} from "@codemirror/view";
import { highlightCode } from "@lezer/highlight";
import {
  LanguageServerClient,
  languageServerWithTransport as baseLanguageServerWithTransport,
  languageServerPlugin,
  renameSymbol,
} from "codemirror-languageserver";
import {
  type LocationItem,
  locationsPanel,
  openLocationsPanel,
} from "./locationsPanel";
import { fileUriToPath } from "./uri";
import { errorToast } from "@/lib/errorToast";
import { pathIdentity } from "@/lib/pathIdentity";
import { toast } from "sonner";
import { onEvent } from "@/modules/events";
import {
  NavigationResultCache,
  type NavigationResult,
} from "@/modules/lsp/lib/navigationCache";
import type { EditorLocation } from "@/modules/editor/lib/navigationHistory";
import {
  javaDeclarationAt,
  readJavaDeclaration,
  type JavaDeclaration,
} from "@/modules/lsp/lib/javaNavigation";
import { resolveMapperTargets } from "@/modules/lsp/lib/mapperNavigation";
import { getLspNavigator } from "@/modules/lsp/lib/navigator";
import { pathToFileUri } from "@/modules/lsp/lib/uri";
type DidOpenTextDocumentParams = Parameters<
  LanguageServerClient["textDocumentDidOpen"]
>[0];
type DidChangeTextDocumentParams = Parameters<
  LanguageServerClient["textDocumentDidChange"]
>[0];
type PublishDiagnosticsParams = Parameters<
  Parameters<LanguageServerClient["attachPlugin"]>[0]["processDiagnostics"]
>[0];

export { SynchronizationMethod } from "codemirror-languageserver";

export function languageServerWithTransport(
  options: Parameters<typeof baseLanguageServerWithTransport>[0],
): Extension {
  const client = options.client;
  if (!(client instanceof AweiWorkLspClient))
    return baseLanguageServerWithTransport(options);
  return [
    ViewPlugin.define((view) => {
      client.trackDocument(options.documentUri, view);
      return {
        destroy: () => client.untrackDocument(options.documentUri, view),
      };
    }),
    baseLanguageServerWithTransport(options),
  ];
}

type LspLocation = NavigationResult["locations"][number];
type LspRange = LspLocation["range"];
type LspPos = LspRange["start"];
type LspLocationLink = {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
};
type DefinitionResult =
  | LspLocation
  | LspLocation[]
  | LspLocationLink[]
  | null
  | undefined;

function normalizeLocations(result: DefinitionResult): LspLocation[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const out: LspLocation[] = [];
  for (const loc of list.slice(0, 10000)) {
    if (!loc || typeof loc !== "object") continue;
    if ("uri" in loc) {
      if (typeof loc.uri === "string" && validPosition(loc.range?.start))
        out.push(loc);
    } else if (loc.targetUri) {
      const range = loc.targetSelectionRange ?? loc.targetRange;
      if (typeof loc.targetUri !== "string" || !validPosition(range?.start))
        continue;
      out.push({
        uri: loc.targetUri,
        range,
      });
    }
  }
  const unique = new Map<string, LspLocation>();
  for (const loc of out) {
    const key = JSON.stringify([
      pathIdentity(fileUriToPath(loc.uri) ?? loc.uri),
      loc.range.start.line,
      loc.range.start.character,
    ]);
    if (!unique.has(key)) unique.set(key, loc);
  }
  return [...unique.values()];
}

function validPosition(pos: LspPos | null | undefined): pos is LspPos {
  return (
    !!pos &&
    Number.isSafeInteger(pos.line) &&
    pos.line >= 0 &&
    Number.isSafeInteger(pos.character) &&
    pos.character >= 0
  );
}

function offsetOf(doc: Text, pos: LspPos): number {
  if (!validPosition(pos))
    throw new Error("Language server returned an invalid document position");
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(pos.line + 1);
  return Math.min(line.from + pos.character, line.to);
}

export type LspFormatResult = "done" | "unsupported";

// The lib's formatDocument command fires and forgets; save needs to await
// the edits before writing to disk. "unsupported" surfaces servers that
// simply have no formatter (pyright) so the UI can say so instead of
// silently doing nothing.
export async function formatDocumentAndWait(
  view: EditorView,
): Promise<LspFormatResult> {
  const plugin = view.plugin(languageServerPlugin);
  if (!plugin) return "unsupported";
  const { client } = plugin;
  if (!client.ready || !client.capabilities?.documentFormattingProvider) {
    return "unsupported";
  }
  const doc = view.state.doc;
  if (view.state.readOnly) return "unsupported";
  const pluginIdentity = plugin;
  const edits = await client.textDocumentFormatting({
    textDocument: { uri: plugin.documentUri },
    options: {
      tabSize: view.state.tabSize,
      insertSpaces: view.state.facet(indentUnit) !== "\t",
    },
  });
  if (!edits || edits.length === 0) return "done";
  // Edits are offsets into the requested snapshot; typing during the
  // round-trip would corrupt the document.
  if (
    view.state.doc !== doc ||
    view.state.readOnly ||
    view.plugin(languageServerPlugin) !== pluginIdentity ||
    !view.dom.isConnected
  )
    return "done";
  if (!Array.isArray(edits) || edits.length > 10000)
    throw new Error("Language server returned an invalid formatting response");
  const changes = edits.map((edit) => {
    if (!edit || typeof edit.newText !== "string")
      throw new Error("Language server returned invalid formatting text");
    return {
      from: offsetOf(doc, edit.range.start),
      to: offsetOf(doc, edit.range.end),
      insert: edit.newText,
    };
  });
  view.dispatch({ changes });
  return "done";
}

function highlightBlock(el: HTMLElement, view: EditorView): void {
  const lang = view.state.facet(language);
  const code = el.textContent;
  if (!lang || !code || code.length > 16384) return;
  const frag = document.createDocumentFragment();
  highlightCode(
    code,
    lang.parser.parse(code),
    { style: (tags) => highlightingFor(view.state, tags) },
    (text, classes) => {
      if (!classes) {
        frag.appendChild(document.createTextNode(text));
        return;
      }
      const span = document.createElement("span");
      span.className = classes;
      span.textContent = text;
      frag.appendChild(span);
    },
    () => frag.appendChild(document.createTextNode("\n")),
  );
  el.replaceChildren(frag);
}

// Tooltip docs arrive as plain markdown-rendered code; tokenize them with
// the file's own parser so signatures match the editor theme. Tooltips are
// direct children of the editor DOM, so the outer observer never fires on
// typing; the subtree observer lives only while a tooltip is mounted.
const hoverCodeHighlight = ViewPlugin.define((view) => {
  const seen = new WeakMap<HTMLElement, string>();
  const inner = new Map<Element, MutationObserver>();

  const scan = (root: Element) => {
    const blocks = root.querySelectorAll<HTMLElement>(
      ".documentation pre code",
    );
    for (const el of blocks) {
      const code = el.textContent ?? "";
      if (seen.get(el) === code) continue;
      seen.set(el, code);
      highlightBlock(el, view);
    }
  };

  const outer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (
          !(node instanceof Element) ||
          !node.classList.contains("cm-tooltip")
        ) {
          continue;
        }
        scan(node);
        const ob = new MutationObserver(() => scan(node));
        ob.observe(node, { childList: true, subtree: true });
        inner.set(node, ob);
      }
      for (const node of m.removedNodes) {
        if (!(node instanceof Element)) continue;
        inner.get(node)?.disconnect();
        inner.delete(node);
      }
    }
  });
  outer.observe(view.dom, { childList: true });

  return {
    destroy: () => {
      outer.disconnect();
      for (const ob of inner.values()) ob.disconnect();
      inner.clear();
    },
  };
});

const setLinkRange = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: "cm-lsp-link" });

const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setLinkRange)) {
        return e.value
          ? Decoration.set([linkMark.range(e.value.from, e.value.to)])
          : Decoration.none;
      }
    }
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function currentLink(view: EditorView): { from: number; to: number } | null {
  const iter = view.state.field(linkField).iter();
  return iter.value ? { from: iter.from, to: iter.to } : null;
}

function updateLink(view: EditorView, event: MouseEvent | null): void {
  const prev = currentLink(view);
  let next: { from: number; to: number } | null = null;
  if (event && (event.metaKey || event.ctrlKey)) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos != null) next = view.state.wordAt(pos);
  }
  if (prev?.from === next?.from && prev?.to === next?.to) return;
  view.dispatch({ effects: setLinkRange.of(next) });
}

// Cmd/Ctrl-hover underlines the symbol under the pointer, matching the
// mod-click go-to-definition affordance.
const linkHover: Extension = [
  linkField,
  EditorView.domEventHandlers({
    mousemove: (event, view) => updateLink(view, event),
    keyup: (event, view) => {
      if (event.key === "Meta" || event.key === "Control") {
        updateLink(view, null);
      }
    },
    mouseleave: (_e, view) => updateLink(view, null),
  }),
  EditorView.theme({
    ".cm-lsp-link": {
      textDecoration: "underline",
      textUnderlineOffset: "2.5px",
      color: "var(--primary)",
      cursor: "pointer",
    },
  }),
];

export function lspInteractions(opts: {
  client: AweiWorkLspClient;
  documentUri: string;
  languageId?: string;
  rootPath: string;
  onExternal: (
    uri: string,
    line: number,
    character: number,
    origin?: EditorLocation,
  ) => void;
}): Extension {
  let requestId = 0;
  let disposed = false;
  let pending: {
    view: EditorView;
    document: Text;
    pos: number;
    mode: string;
    abort: AbortController;
    cacheKey: string;
    cacheGeneration: number;
  } | null = null;
  const cancelNavigation = () => {
    if (!pending) return;
    pending.abort.abort();
    pending = null;
    requestId++;
  };
  const currentView = (view: EditorView) => {
    const window = view.dom.ownerDocument.defaultView;
    return (
      !disposed &&
      view.dom.isConnected &&
      view.plugin(languageServerPlugin)?.client === opts.client &&
      view.plugin(languageServerPlugin)?.documentUri === opts.documentUri &&
      !!window &&
      window.getComputedStyle(view.dom).visibility === "visible" &&
      view.dom.getClientRects().length > 0
    );
  };
  const navigate = (
    view: EditorView,
    loc: LspLocation,
    originPos = view.state.selection.main.head,
  ): void => {
    if (!currentView(view) || !validPosition(loc.range.start)) return;
    const sourcePath = fileUriToPath(opts.documentUri);
    if (sourcePath && fileUriToPath(loc.uri) && getLspNavigator()) {
      const originLine = view.state.doc.lineAt(originPos);
      opts.onExternal(
        loc.uri,
        loc.range.start.line + 1,
        loc.range.start.character,
        {
          path: sourcePath,
          line: originLine.number,
          character: originPos - originLine.from,
        },
      );
      return;
    }
    if (
      pathIdentity(fileUriToPath(loc.uri) ?? loc.uri) ===
      pathIdentity(fileUriToPath(opts.documentUri) ?? opts.documentUri)
    ) {
      const targetLine = Math.min(
        loc.range.start.line + 1,
        view.state.doc.lines,
      );
      const lineObj = view.state.doc.line(targetLine);
      const target = Math.min(
        lineObj.from + loc.range.start.character,
        lineObj.to,
      );
      view.dispatch({
        selection: { anchor: target },
        effects: EditorView.scrollIntoView(target, { y: "center" }),
      });
      view.focus();
    } else {
      opts.onExternal(
        loc.uri,
        loc.range.start.line + 1,
        loc.range.start.character,
      );
    }
  };

  const label = (loc: LspLocation): string => {
    const path = fileUriToPath(loc.uri) ?? loc.uri;
    const rel = path.startsWith(`${opts.rootPath}/`)
      ? path.slice(opts.rootPath.length + 1)
      : path;
    return `${rel}:${loc.range.start.line + 1}`;
  };

  const showResults = (
    view: EditorView,
    title: string,
    locs: LspLocation[],
    originPos = view.state.selection.main.head,
  ): void => {
    if (locs.length === 0) return;
    if (pending?.view === view) {
      if (opts.languageId === "java") {
        if (pending.cacheGeneration !== opts.client.navigationCache.generation)
          return;
        opts.client.navigationCache.set(
          pending.cacheKey,
          { title, locations: locs },
          pending.cacheGeneration,
        );
      }
      pending = null;
    }
    const document = view.state.doc;
    const request = requestId;
    if (locs.length === 1) {
      navigate(view, locs[0], originPos);
      return;
    }
    const byLoc = new Map<string, LspLocation>();
    for (const loc of locs)
      byLoc.set(
        JSON.stringify([
          loc.uri,
          loc.range.start.line,
          loc.range.start.character,
        ]),
        loc,
      );
    const items: LocationItem[] = [...byLoc.entries()]
      .map(([, loc]) => ({
        uri: loc.uri,
        line: loc.range.start.line,
        character: loc.range.start.character,
        label: `${label(loc)}:${loc.range.start.character + 1}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    openLocationsPanel(view, {
      title,
      items,
      onPick: (item) => {
        if (request !== requestId || view.state.doc !== document) return;
        navigate(
          view,
          {
            uri: item.uri,
            range: { start: { line: item.line, character: item.character } },
          },
          originPos,
        );
      },
    });
  };

  const positionAt = (view: EditorView, pos: number) => {
    const line = view.state.doc.lineAt(pos);
    return { line: line.number - 1, character: pos - line.from };
  };

  const gotoDefinition = async (
    view: EditorView,
    pos: number,
    mode: "auto" | "definition" | "implementation" | "references" = "auto",
  ): Promise<void> => {
    const wordPos = view.state.wordAt(pos)?.from ?? pos;
    if (
      pending?.view === view &&
      pending.document === view.state.doc &&
      pending.pos === wordPos &&
      pending.mode === mode
    )
      return;
    cancelNavigation();
    const abort = new AbortController();
    const operation = {
      view,
      document: view.state.doc,
      pos: wordPos,
      mode,
      abort,
      cacheKey: `${opts.documentUri}\0${opts.languageId ?? ""}\0${mode}\0${wordPos}`,
      cacheGeneration: opts.client.navigationCache.generation,
    };
    pending = operation;
    const request = ++requestId;
    const document = view.state.doc;
    const stillCurrent = () =>
      !abort.signal.aborted &&
      request === requestId &&
      currentView(view) &&
      view.state.doc === document;
    let progress: string | number | undefined;
    const showProgress = () => {
      progress = toast.loading(
        !opts.client.ready
          ? "语言服务正在初始化，完成后继续跳转"
          : opts.client.javaStatus === "indexing"
            ? "Java 项目正在初始化索引，完成后继续跳转"
            : "正在查找跳转目标…",
      );
    };
    if (!opts.client.ready || opts.client.javaStatus === "indexing")
      showProgress();
    const progressTimer = setTimeout(() => {
      if (progress === undefined) showProgress();
    }, 200);
    const dismissProgress = () => {
      clearTimeout(progressTimer);
      if (progress !== undefined) toast.dismiss(progress);
    };
    abort.signal.addEventListener("abort", dismissProgress, { once: true });
    const showMapper = async (
      declaration: JavaDeclaration | null,
    ): Promise<boolean> => {
      if (!declaration?.mapper) return false;
      const targets = await resolveMapperTargets(
        opts.rootPath,
        {
          kind: "xml",
          namespace: declaration.namespace,
          symbol: declaration.kind === "method" ? declaration.name : undefined,
          tag: "statement",
        },
        { kind: "local" },
      );
      if (!stillCurrent()) return true;
      if (!targets.length) return false;
      showResults(
        view,
        "Mapper SQL",
        targets.map((target) => ({
          uri: pathToFileUri(target.path),
          range: {
            start: { line: target.line - 1, character: target.character ?? 0 },
          },
        })),
        pos,
      );
      return true;
    };
    try {
      await opts.client.waitUntilReady(abort.signal);
      if (!stillCurrent()) return;
      operation.cacheGeneration = opts.client.navigationCache.generation;
      const cached =
        opts.languageId === "java"
          ? opts.client.navigationCache.get(operation.cacheKey)
          : undefined;
      if (cached) {
        pending = null;
        showResults(view, cached.title, cached.locations, pos);
        return;
      }
      if (progress !== undefined)
        toast.loading("正在查找跳转目标…", { id: progress });
      const params = {
        textDocument: { uri: opts.documentUri },
        position: positionAt(view, pos),
      };
      const declaration =
        mode === "auto" && opts.languageId === "java"
          ? javaDeclarationAt(document, wordPos, syntaxTree(view.state))
          : null;
      if (mode === "auto" && (await showMapper(declaration))) return;
      if (!stillCurrent()) return;
      if (
        mode === "references" ||
        (mode === "auto" && declaration?.kind === "method")
      ) {
        if (!opts.client.capabilities?.referencesProvider) {
          toast.info("当前语言服务不支持查找引用");
          return;
        }
        const references = normalizeLocations(
          await opts.client.textDocumentReferences({
            ...params,
            context: { includeDeclaration: false },
          }),
        );
        if (!stillCurrent()) return;
        if (!references.length) {
          toast.info(
            opts.client.javaStatus === "indexing"
              ? "Java 项目正在索引，请稍后重试查找引用"
              : "未找到引用方",
          );
          return;
        }
        showResults(view, "引用", references, pos);
        return;
      }
      if (mode === "implementation") {
        if (opts.client.capabilities?.implementationProvider) {
          const implementations = normalizeLocations(
            await opts.client.textDocumentImplementation(params),
          );
          if (!stillCurrent()) return;
          if (implementations.length) {
            showResults(view, "实现", implementations, pos);
            return;
          }
        }
        toast.info(
          opts.client.capabilities?.implementationProvider
            ? opts.client.javaStatus === "indexing"
              ? "Java 项目正在索引，请稍后重试查找实现"
              : "未找到实现"
            : "当前语言服务不支持查找实现",
        );
        return;
      }
      const locations = normalizeLocations(
        await opts.client.textDocumentDefinition(params),
      );
      if (!stillCurrent()) return;
      if (
        mode === "auto" &&
        opts.languageId === "java" &&
        locations.length === 1
      ) {
        const target = locations[0];
        const targetDeclaration = await readJavaDeclaration(
          target.uri,
          target.range.start,
          opts.client.documentView(target.uri),
        );
        if (!stillCurrent()) return;
        if (await showMapper(targetDeclaration)) return;
        if (!stillCurrent()) return;
        if (
          targetDeclaration?.abstract &&
          !targetDeclaration.mapper &&
          opts.client.capabilities?.implementationProvider
        ) {
          try {
            const implementations = normalizeLocations(
              await opts.client.textDocumentImplementation(params),
            );
            if (!stillCurrent()) return;
            if (implementations.length) {
              showResults(view, "实现", implementations, pos);
              return;
            }
          } catch {
            if (!stillCurrent()) return;
          }
        }
      }
      if (!locations.length) {
        toast.info(
          opts.client.javaStatus === "indexing"
            ? "Java 项目正在索引，请稍后重试跳转"
            : "未找到跳转目标",
        );
        return;
      }
      showResults(view, "定义", locations, pos);
    } catch (error) {
      if (stillCurrent())
        errorToast(
          mode === "implementation"
            ? "查找实现失败"
            : mode === "references"
              ? "查找引用失败"
              : "跳转失败",
          error,
        );
      return;
    } finally {
      dismissProgress();
      abort.signal.removeEventListener("abort", dismissProgress);
      if (pending === operation) pending = null;
    }
  };

  return [
    ViewPlugin.define(() => {
      disposed = false;
      return {
        update(update) {
          if (
            update.docChanged ||
            (update.focusChanged && !update.view.hasFocus)
          )
            cancelNavigation();
        },
        destroy() {
          disposed = true;
          cancelNavigation();
        },
      };
    }),
    locationsPanel,
    hoverCodeHighlight,
    linkHover,
    keymap.of([
      {
        key: "F12",
        preventDefault: true,
        run: (view) => {
          void gotoDefinition(view, view.state.selection.main.head);
          return true;
        },
      },
      {
        key: "Mod-F12",
        preventDefault: true,
        run: (view) => {
          void gotoDefinition(
            view,
            view.state.selection.main.head,
            "implementation",
          );
          return true;
        },
      },
      {
        key: "Alt-F12",
        preventDefault: true,
        run: (view) => {
          void gotoDefinition(
            view,
            view.state.selection.main.head,
            "definition",
          );
          return true;
        },
      },
      {
        key: "Shift-F12",
        preventDefault: true,
        run: (view) => {
          void gotoDefinition(
            view,
            view.state.selection.main.head,
            "references",
          );
          return true;
        },
      },
      {
        key: "F2",
        preventDefault: true,
        run: renameSymbol,
      },
      {
        key: "Shift-Alt-f",
        preventDefault: true,
        run: (view) => {
          void formatDocumentAndWait(view).catch((error) =>
            errorToast("Could not format document", error),
          );
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (!(event.metaKey || event.ctrlKey) || event.button !== 0) {
          return false;
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        event.preventDefault();
        void gotoDefinition(view, pos, event.altKey ? "definition" : "auto");
        return true;
      },
    }),
  ];
}

type RawRpc = {
  notify(method: string, params: unknown): Promise<void>;
  request(method: string, params: unknown, timeout: number): Promise<unknown>;
};

// The lib's notify/request maps omit didClose, didSave and the
// shutdown/exit handshake; servers need all three for correct lifecycle.
export class AweiWorkLspClient extends LanguageServerClient {
  static hostPid: number | null = null;
  readonly navigationCache = new NavigationResultCache();
  private navigationChanged?: (
    paths: readonly string[],
    rescan?: boolean,
  ) => void;
  private stopNavigationWatch?: () => void;
  javaStatus: "indexing" | "ready" | "error" | null = null;
  private javaMessage = "";
  private javaStatusHandler?: (status: "indexing" | "ready" | "error") => void;
  private javaWaiters = new Set<() => void>();
  private documents = new Map<
    string,
    { views: Set<EditorView>; version: number | null }
  >();

  documentView(uri: string): EditorView | null {
    const views = this.documents.get(uri)?.views;
    if (!views) return null;
    for (const view of views) if (view.hasFocus) return view;
    return views.values().next().value ?? null;
  }

  watchNavigationChanges(root: string): void {
    this.releaseNavigationCache();
    const identity = pathIdentity(root).replace(/\/$/, "");
    const inside = (path: string) =>
      path === identity || path.startsWith(`${identity}/`);
    const changed = (paths: readonly string[], rescan = false) => {
      const affected = paths.some((path) => {
        const normalized = pathIdentity(path);
        return (
          (rescan &&
            (inside(normalized) || identity.startsWith(`${normalized}/`))) ||
          (inside(normalized) &&
            /\.(java|xml|gradle|kts|jar)$/i.test(normalized))
        );
      });
      if (affected || (rescan && paths.length === 0))
        this.navigationCache.clear();
    };
    this.navigationChanged = changed;
    const stopChanged = onEvent("fs:changed", (event) =>
      changed(event.paths, event.rescan),
    );
    const stopWritten = onEvent("fs:written", (event) => changed([event.path]));
    this.stopNavigationWatch = () => {
      stopChanged();
      stopWritten();
    };
  }

  invalidateNavigationForPath(path: string): void {
    this.navigationChanged?.([path]);
  }

  releaseNavigationCache(): void {
    this.stopNavigationWatch?.();
    this.stopNavigationWatch = undefined;
    this.navigationChanged = undefined;
    this.navigationCache.clear();
  }

  trackDocument(uri: string, view: EditorView): void {
    const document = this.documents.get(uri) ?? {
      views: new Set(),
      version: null,
    };
    document.views.add(view);
    this.documents.set(uri, document);
  }

  untrackDocument(uri: string, view: EditorView): void {
    const document = this.documents.get(uri);
    if (!document) return;
    document.views.delete(view);
    if (!document.views.size) {
      this.textDocumentDidClose(uri);
      this.documents.delete(uri);
    }
  }

  override textDocumentDidOpen(
    params: DidOpenTextDocumentParams,
  ): Promise<void> {
    const document = this.documents.get(params.textDocument.uri);
    const view = document?.views.values().next().value;
    if (!document || !view || document.version !== null || !this.ready)
      return Promise.resolve();
    this.navigationCache.clear();
    document.version = 0;
    return super.textDocumentDidOpen({
      ...params,
      textDocument: {
        ...params.textDocument,
        text: view.state.doc.toString(),
        version: 0,
      },
    });
  }

  override textDocumentDidChange(
    params: DidChangeTextDocumentParams,
  ): Promise<void> {
    const document = this.documents.get(params.textDocument.uri);
    if (!document || document.version === null) return Promise.resolve();
    this.navigationCache.clear();
    return super.textDocumentDidChange({
      ...params,
      textDocument: { ...params.textDocument, version: ++document.version },
    });
  }

  enableJavaStatus(
    handler: (status: "indexing" | "ready" | "error") => void,
  ): void {
    this.javaStatus ??= "indexing";
    this.javaStatusHandler = handler;
    handler(this.javaStatus);
  }

  waitForJavaReady(signal: AbortSignal): Promise<void> {
    if (signal.aborted)
      return Promise.reject(new DOMException("Cancelled", "AbortError"));
    if (this.javaStatus === null || this.javaStatus === "ready")
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.javaWaiters.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (this.javaStatus === "ready") finish();
        else if (this.javaStatus === "error")
          finish(
            new Error(
              this.javaMessage || "Java 项目初始化失败，请重启语言服务",
            ),
          );
      };
      const abort = () => finish(new DOMException("Cancelled", "AbortError"));
      const timer = setTimeout(
        () => finish(new Error("Java 项目仍在初始化索引，请稍后重试")),
        120_000,
      );
      this.javaWaiters.add(check);
      signal.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  async waitUntilReady(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new DOMException("Cancelled", "AbortError"));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      void this.initializePromise.then(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
    if (!this.ready) throw new Error("语言服务尚未就绪，请重启语言服务后重试");
    await this.waitForJavaReady(signal);
  }

  protected override processNotification(notification: {
    jsonrpc: "2.0";
    method: string;
    params?: unknown;
  }): void {
    if (notification.method === "language/status") {
      const report = notification.params as {
        type?: string;
        message?: string;
      } | null;
      const status =
        report?.type === "Started" || report?.type === "ServiceReady"
          ? "ready"
          : report?.type === "Starting"
            ? "indexing"
            : report?.type === "Error"
              ? "error"
              : null;
      if (status) {
        this.navigationCache.clear();
        this.javaStatus = status;
        this.javaMessage =
          typeof report?.message === "string" ? report.message : "";
        this.javaStatusHandler?.(status);
        for (const waiter of this.javaWaiters) waiter();
      }
    }
    if (notification.method === "textDocument/publishDiagnostics")
      super.processNotification({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: notification.params as PublishDiagnosticsParams,
      });
  }

  override close(): void {
    this.releaseNavigationCache();
    this.javaStatus = "error";
    this.javaMessage = "语言服务已停止，请重试跳转";
    for (const waiter of this.javaWaiters) waiter();
    this.documents.clear();
    super.close();
  }

  // The lib omits the publishDiagnostics capability and servers like
  // typescript-language-server push no diagnostics without it. processId
  // enables the server-side parent watchdog.
  protected override getInitializeParams() {
    const params = super.getInitializeParams();
    params.processId = AweiWorkLspClient.hostPid;
    params.capabilities.workspace = {
      ...params.capabilities.workspace,
      configuration: true,
      workspaceFolders: true,
    };
    params.capabilities.textDocument = {
      ...params.capabilities.textDocument,
      publishDiagnostics: { relatedInformation: true },
      references: { dynamicRegistration: false },
      definition: { dynamicRegistration: false, linkSupport: true },
      implementation: { dynamicRegistration: false, linkSupport: true },
    };
    return params;
  }

  textDocumentImplementation(params: {
    textDocument: { uri: string };
    position: LspPos;
  }): Promise<DefinitionResult> {
    return this.raw.request(
      "textDocument/implementation",
      params,
      15_000,
    ) as Promise<DefinitionResult>;
  }

  textDocumentReferences(params: {
    textDocument: { uri: string };
    position: LspPos;
    context: { includeDeclaration: boolean };
  }): Promise<LspLocation[] | null> {
    return this.raw.request(
      "textDocument/references",
      params,
      10_000,
    ) as Promise<LspLocation[] | null>;
  }

  textDocumentDidClose(uri: string): void {
    const document = this.documents.get(uri);
    if (!document || document.version === null) return;
    this.navigationCache.clear();
    document.version = null;
    void this.raw
      .notify("textDocument/didClose", { textDocument: { uri } })
      .catch((error) => console.warn("[awei-work] LSP didClose failed", error));
  }

  textDocumentDidSave(uri: string): void {
    this.navigationCache.clear();
    void this.raw
      .notify("textDocument/didSave", { textDocument: { uri } })
      .catch((error) => console.warn("[awei-work] LSP didSave failed", error));
  }

  private get raw(): RawRpc {
    return this as unknown as RawRpc;
  }
}
