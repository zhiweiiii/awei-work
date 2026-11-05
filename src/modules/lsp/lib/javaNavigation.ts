import { syntaxTree } from "@codemirror/language";
import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { readFileText } from "@/modules/editor/lib/externalFormat";
import { fileUriToPath } from "@/modules/lsp/lib/uri";

type Tree = ReturnType<typeof syntaxTree>;
type Node = ReturnType<Tree["resolveInner"]>;
export type JavaDeclaration = {
  kind: "method" | "type";
  name: string;
  namespace: string;
  abstract: boolean;
  mapper: boolean;
  line: number;
  character: number;
};

function describe(doc: Text, node: Node): JavaDeclaration | null {
  if (node.name !== "Definition" || !node.parent) return null;
  const declaration = node.parent;
  const kind =
    declaration.name === "MethodDeclaration"
      ? "method"
      : /^(?:Class|Interface|Enum|Record|AnnotationType)Declaration$/.test(
            declaration.name,
          )
        ? "type"
        : null;
  if (!kind) return null;
  let type: Node | null = null;
  let root = declaration;
  const names: string[] = [];
  for (
    let current: Node | null = declaration;
    current;
    current = current.parent
  ) {
    root = current;
    if (
      /^(?:Class|Interface|Enum|Record|AnnotationType)Declaration$/.test(
        current.name,
      )
    ) {
      type ??= current;
      const name = current.getChild("Definition");
      if (name) names.unshift(doc.sliceString(name.from, name.to));
    }
  }
  if (!type || !names.length) return null;
  const packageNode = root.getChild("PackageDeclaration");
  const packageName =
    packageNode?.getChild("ScopedIdentifier") ??
    packageNode?.getChild("Identifier");
  const prefix = packageName
    ? `${doc.sliceString(packageName.from, packageName.to).replace(/\s/g, "")}.`
    : "";
  const modifiers = type.getChild("Modifiers");
  const modifierText = modifiers
    ? doc.sliceString(modifiers.from, modifiers.to)
    : "";
  const line = doc.lineAt(node.from);
  return {
    kind,
    name: doc.sliceString(node.from, node.to),
    namespace: prefix + names.join("$"),
    abstract:
      kind === "method"
        ? !declaration.getChild("Block")
        : type.name === "InterfaceDeclaration" ||
          /\babstract\b/.test(modifierText),
    mapper:
      /(?:Mapper|Dao|DAO)$/.test(names[names.length - 1] ?? "") ||
      /@\s*(?:[\w$]+\.)*Mapper\b/.test(modifierText),
    line: line.number,
    character: node.from - line.from,
  };
}

export function javaDeclarationAt(
  doc: Text,
  position: number,
  tree: Tree,
): JavaDeclaration | null {
  return describe(doc, tree.resolveInner(position, 1));
}

export async function readJavaDeclaration(
  uri: string,
  position: { line: number; character: number },
  tracked: EditorView | null,
): Promise<JavaDeclaration | null> {
  let doc: Text;
  let tree: Tree;
  if (tracked) {
    doc = tracked.state.doc;
    tree = syntaxTree(tracked.state);
  } else {
    const path = fileUriToPath(uri);
    if (!path || !/\.java$/i.test(path)) return null;
    const file = await readFileText(path, { kind: "local" });
    if (!file || file.text.length > 4 * 1024 * 1024) return null;
    doc = Text.of(file.text.split(/\r\n?|\n/));
    const { javaLanguage } = await import("@codemirror/lang-java");
    tree = javaLanguage.parser.parse(doc.toString());
  }
  if (position.line >= doc.lines) return null;
  const line = doc.line(position.line + 1);
  return javaDeclarationAt(
    doc,
    Math.min(line.from + position.character, line.to),
    tree,
  );
}

export async function javaMapperLocations(
  text: string,
  namespace: string,
  method?: string,
) {
  const doc = Text.of(text.split(/\r\n?|\n/));
  const { javaLanguage } = await import("@codemirror/lang-java");
  const tree = javaLanguage.parser.parse(doc.toString());
  const locations: { line: number; character: number }[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== "Definition") return;
      const declaration = describe(doc, node.node);
      if (
        declaration?.namespace === namespace &&
        (method
          ? declaration.kind === "method" && declaration.name === method
          : declaration.kind === "type")
      )
        locations.push({
          line: declaration.line,
          character: declaration.character,
        });
    },
  });
  return locations;
}
