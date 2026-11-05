import { Text, type Extension } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { readFileText } from "@/modules/editor/lib/externalFormat";
import type { EditorLocation } from "@/modules/editor/lib/navigationHistory";
import type { WorkspaceEnv } from "@/modules/workspace";
import { errorToast } from "@/lib/errorToast";
import { javaMapperLocations } from "@/modules/lsp/lib/javaNavigation";
import {
  locationsPanel,
  openLocationsPanel,
} from "@/modules/lsp/lib/locationsPanel";
import { getLspNavigator } from "@/modules/lsp/lib/navigator";
import { fileUriToPath, pathToFileUri } from "@/modules/lsp/lib/uri";

type Attribute = {
  tag: string;
  name: string;
  value: string;
  from: number;
  to: number;
};
export type MapperQuery = {
  namespace: string;
  kind: "java" | "xml";
  symbol?: string;
  tag?: "statement" | "sql" | "resultMap";
};
const statementTags = new Set(["select", "insert", "update", "delete"]);

export function mapperAttributes(
  source: string,
): { namespace: string; attributes: Attribute[] } | null {
  const attributes: Attribute[] = [];
  let root = "";
  const tags =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<([A-Za-z_][\w:.-]*)(?:"[^"]*"|'[^']*'|[^'">])*>/g;
  for (const match of source.matchAll(tags)) {
    if (!match[1]) continue;
    root ||= match[1];
    if (root !== "mapper") return null;
    for (const attribute of match[0].matchAll(
      /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    )) {
      const value = attribute[2] ?? attribute[3];
      const quote = attribute[2] !== undefined ? '"' : "'";
      const from =
        (match.index ?? 0) +
        (attribute.index ?? 0) +
        attribute[0].indexOf(quote) +
        1;
      attributes.push({
        tag: match[1],
        name: attribute[1],
        value,
        from,
        to: from + value.length,
      });
    }
  }
  const namespace = attributes.find(
    (attribute) => attribute.tag === "mapper" && attribute.name === "namespace",
  )?.value;
  return namespace ? { namespace, attributes } : null;
}

export function mapperQueryAt(
  source: string,
  position: number,
): MapperQuery | null {
  const parsed = mapperAttributes(source);
  const attribute = parsed?.attributes.find(
    (attribute) => attribute.from <= position && position <= attribute.to,
  );
  if (!parsed || !attribute) return null;
  const { name, value, tag } = attribute;
  if (name === "namespace" && tag === "mapper")
    return { kind: "java", namespace: value };
  if (name === "id" && statementTags.has(tag))
    return { kind: "java", namespace: parsed.namespace, symbol: value };
  if (
    ["type", "resultType", "parameterType"].includes(name) &&
    value.includes(".")
  )
    return { kind: "java", namespace: value };
  if (name === "refid" || name === "resultMap" || name === "select") {
    if (value.includes(",")) return null;
    const split = value.lastIndexOf(".");
    return {
      kind: "xml",
      namespace: split < 0 ? parsed.namespace : value.slice(0, split),
      symbol: split < 0 ? value : value.slice(split + 1),
      tag:
        name === "refid"
          ? "sql"
          : name === "resultMap"
            ? "resultMap"
            : "statement",
    };
  }
  return null;
}

export function mapperXmlLocations(text: string, query: MapperQuery) {
  const source = text.replace(/\r\n?/g, "\n");
  const parsed = mapperAttributes(source);
  if (!parsed || parsed.namespace !== query.namespace) return [];
  const doc = Text.of(source.split("\n"));
  return parsed.attributes
    .filter((attribute) => {
      if (!query.symbol)
        return attribute.tag === "mapper" && attribute.name === "namespace";
      return (
        attribute.name === "id" &&
        attribute.value === query.symbol &&
        (query.tag === "sql" || query.tag === "resultMap"
          ? attribute.tag === query.tag
          : statementTags.has(attribute.tag))
      );
    })
    .map((attribute) => {
      const line = doc.lineAt(attribute.from);
      return { line: line.number, character: attribute.from - line.from };
    });
}

export async function resolveMapperTargets(
  root: string,
  query: MapperQuery,
  workspace?: WorkspaceEnv,
): Promise<EditorLocation[]> {
  const paths = await invoke<string[]>("lsp_mapper_files", {
    root,
    namespace: query.namespace,
    kind: query.kind,
  });
  const targets: EditorLocation[] = [];
  for (const path of paths) {
    const openText = getLspNavigator()?.getDocument?.(path);
    const text = openText ?? (await readFileText(path, workspace))?.text;
    if (text == null || text.length > 4 * 1024 * 1024) continue;
    const locations =
      query.kind === "xml"
        ? mapperXmlLocations(text, query)
        : await javaMapperLocations(text, query.namespace, query.symbol);
    targets.push(...locations.map((location) => ({ path, ...location })));
  }
  return targets;
}

export function mapperNavigation(
  getContext: () => { path: string; workspace: WorkspaceEnv },
): Extension {
  let request = 0;
  let pending: { doc: Text; position: number } | null = null;
  const start = (view: EditorView, position: number): boolean => {
    const context = getContext();
    if (!/\.xml$/i.test(context.path)) return false;
    const doc = view.state.doc;
    const query = mapperQueryAt(doc.toString(), position);
    if (!query) return false;
    if (pending?.doc === doc && pending.position === position) return true;
    pending = { doc, position };
    const currentRequest = ++request;
    const line = doc.lineAt(position);
    const origin = {
      path: context.path,
      line: line.number,
      character: position - line.from,
    };
    const current = () =>
      request === currentRequest &&
      view.state.doc === doc &&
      getContext().path === context.path &&
      view.dom.isConnected &&
      view.dom.getClientRects().length > 0 &&
      view.dom.ownerDocument.defaultView?.getComputedStyle(view.dom)
        .visibility === "visible";
    let progress: string | number | undefined;
    const timer = setTimeout(() => {
      if (current()) progress = toast.loading("正在查找 Mapper 跳转目标…");
    }, 200);
    const open = (location: EditorLocation) => {
      if (current())
        getLspNavigator()?.openFile(
          location.path,
          location.line,
          location.character,
          origin,
        );
    };
    void (async () => {
      let targets: EditorLocation[] =
        query.kind === "xml"
          ? mapperXmlLocations(doc.toString(), query).map((location) => ({
              path: context.path,
              ...location,
            }))
          : [];
      if (!targets.length) {
        const root = await invoke<string | null>("lsp_resolve_root", {
          path: context.path,
          language: "java",
          markers: [
            "pom.xml",
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
            ".git",
          ],
        });
        if (!current()) return;
        if (!root) throw new Error("未找到 Mapper 所属项目根目录");
        targets = await resolveMapperTargets(root, query, context.workspace);
      }
      if (!current()) return;
      if (!targets.length) {
        toast.info("未找到 Mapper 跳转目标");
        return;
      }
      if (targets.length === 1) {
        open(targets[0]);
        return;
      }
      openLocationsPanel(view, {
        title: "Mapper 映射",
        items: targets.map((target) => ({
          uri: pathToFileUri(target.path),
          line: target.line - 1,
          character: target.character ?? 0,
          label: `${target.path}:${target.line}`,
        })),
        onPick: (item) => {
          const path = fileUriToPath(item.uri);
          if (path)
            open({ path, line: item.line + 1, character: item.character });
        },
      });
    })()
      .catch((error: unknown) => {
        if (current()) errorToast("Mapper 跳转失败", error);
      })
      .finally(() => {
        clearTimeout(timer);
        if (progress !== undefined) toast.dismiss(progress);
        if (currentRequest === request) pending = null;
      });
    return true;
  };
  return [
    locationsPanel,
    ViewPlugin.define(() => ({
      update(update) {
        if (update.docChanged) {
          request++;
          pending = null;
        }
      },
      destroy() {
        request++;
        pending = null;
      },
    })),
    keymap.of([
      {
        key: "F12",
        preventDefault: true,
        run: (view) => start(view, view.state.selection.main.head),
      },
    ]),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey))
          return false;
        const position = view.posAtCoords({
          x: event.clientX,
          y: event.clientY,
        });
        if (position === null || !start(view, position)) return false;
        event.preventDefault();
        return true;
      },
    }),
  ];
}
