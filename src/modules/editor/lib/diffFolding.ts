import {
  ensureSyntaxTree,
  language,
  syntaxTree,
  syntaxTreeAvailable,
} from "@codemirror/language";
import { getChunks } from "@codemirror/merge";
import { type EditorState, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

type Lines = { from: number; to: number };
type Fold = Lines & { id: string };
type Options = {
  context: number;
  enabled: boolean;
};
type FoldState = {
  ranges: Fold[];
  revealed: Set<string>;
  decorations: DecorationSet;
  tree: ReturnType<typeof syntaxTree>;
};

const declarations = new Set([
  "ClassDeclaration",
  "ClassExpression",
  "InterfaceDeclaration",
  "EnumDeclaration",
  "AnnotationTypeDeclaration",
  "RecordDeclaration",
  "MethodDeclaration",
  "ConstructorDeclaration",
  "CompactConstructorDeclaration",
  "FunctionDeclaration",
  "FunctionDefinition",
  "ClassDefinition",
  "NamespaceDeclaration",
  "ModuleDeclaration",
  "MethodType",
  "FunctionItem",
  "ImplItem",
  "TraitItem",
  "StructItem",
  "EnumItem",
]);
const bodies = new Set([
  "Block",
  "ClassBody",
  "InterfaceBody",
  "EnumBody",
  "ConstructorBody",
  "ModuleBody",
  "DeclarationList",
  "Body",
]);
const namedExpressions = new Set([
  "VariableDeclaration",
  "PropertyDeclaration",
  "Property",
  "AssignmentExpression",
]);

export function diffFoldRevision(original: string, modified: string): string {
  const hash = (text: string) => {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++)
      value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    return `${text.length}:${value >>> 0}`;
  };
  return `${hash(original)}:${hash(modified)}`;
}

function structuralLines(state: EditorState, changes: Lines[]) {
  const visible: Lines[] = [];
  const hidden: Lines[] = [];
  if (!state.facet(language)) return { visible, hidden };
  ensureSyntaxTree(state, state.doc.length, 50);
  if (!syntaxTreeAvailable(state, state.doc.length)) return null;
  const line = (pos: number) => state.doc.lineAt(pos).number;
  syntaxTree(state).iterate({
    enter(ref) {
      const node = ref.node;
      const expression =
        node.name === "ArrowFunction" || node.name === "FunctionExpression";
      if (
        !declarations.has(node.name) &&
        !(expression && node.parent && namedExpressions.has(node.parent.name))
      )
        return;
      let start = expression ? (node.parent?.from ?? node.from) : node.from;
      if (
        node.parent?.name === "ExportDeclaration" ||
        node.parent?.name === "DecoratedStatement"
      )
        start = node.parent.from;
      const changed = changes.some((change) =>
        change.from === change.to
          ? change.from > start && change.from < node.to
          : change.from < node.to && change.to > start,
      );
      if (!changed) {
        hidden.push({
          from: line(start),
          to: line(Math.max(start, node.to - 1)) + 1,
        });
        return false;
      }
      let body = node.firstChild;
      while (body && !bodies.has(body.name)) body = body.nextSibling;
      const end = body?.from ?? Math.max(node.from, node.to - 1);
      visible.push({ from: line(start), to: line(end) + 1 });
      if (body && state.doc.sliceString(body.to - 1, body.to) === "}") {
        const closing = line(body.to - 1);
        visible.push({ from: closing, to: closing + 1 });
      }
    },
  });
  return { visible, hidden };
}

function diffFoldRanges(state: EditorState, context: number): Fold[] {
  const chunks = getChunks(state)?.chunks;
  if (!chunks?.length) return [];
  const changes = chunks.flatMap((chunk) =>
    chunk.changes.map((change) => ({
      from: chunk.fromB + change.fromB,
      to: chunk.fromB + change.toB,
    })),
  );
  const structural = structuralLines(state, changes);
  if (structural === null) return [];
  let visible = [...structural.visible];
  const changedLines: Lines[] = [];
  for (const chunk of chunks) {
    const start = state.doc.lineAt(
      Math.min(state.doc.length, chunk.fromB),
    ).number;
    const end =
      chunk.toB > state.doc.length
        ? state.doc.lines + 1
        : state.doc.lineAt(chunk.toB).number;
    changedLines.push({ from: start, to: Math.max(start + 1, end) });
    visible.push({
      from: Math.max(1, start - context),
      to: Math.min(state.doc.lines + 1, end + context),
    });
  }
  for (const hidden of structural.hidden) {
    visible = visible.flatMap((range) => {
      if (range.to <= hidden.from || range.from >= hidden.to) return [range];
      const kept: Lines[] = [];
      if (range.from < hidden.from)
        kept.push({ from: range.from, to: hidden.from });
      if (range.to > hidden.to) kept.push({ from: hidden.to, to: range.to });
      return kept;
    });
  }
  visible.push(...changedLines);
  visible.sort((a, b) => a.from - b.from || a.to - b.to);
  const ranges: Fold[] = [];
  let from = 1;
  const add = (to: number) => {
    if (to > from) ranges.push({ from, to, id: `${from}:${to}` });
  };
  for (const range of visible) {
    add(range.from);
    from = Math.max(from, range.to);
  }
  add(state.doc.lines + 1);
  return ranges;
}

class FoldWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const row = document.createElement("div");
    row.className = "cm-diff-fold";
    row.setAttribute("aria-hidden", "true");
    return row;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function decorations(
  state: EditorState,
  ranges: Fold[],
  revealed: Set<string>,
): DecorationSet {
  const result = [];
  for (const fold of ranges) {
    if (revealed.has(fold.id)) continue;
    result.push(
      Decoration.replace({
        block: true,
        widget: new FoldWidget(),
      }).range(state.doc.line(fold.from).from, state.doc.line(fold.to - 1).to),
    );
  }
  return Decoration.set(result);
}

export function structuralDiffFolding(options: Options) {
  const field = StateField.define<FoldState>({
    create(state) {
      const revealed = new Set<string>();
      const ranges = options.enabled
        ? diffFoldRanges(state, options.context)
        : [];
      return {
        ranges,
        revealed,
        decorations: decorations(state, ranges, revealed),
        tree: syntaxTree(state),
      };
    },
    update(value, tr) {
      if (!options.enabled) return value;
      const changed =
        tr.docChanged ||
        syntaxTree(tr.state) !== value.tree ||
        getChunks(tr.state)?.chunks !== getChunks(tr.startState)?.chunks;
      const ranges = changed
        ? diffFoldRanges(tr.state, options.context)
        : value.ranges;
      let revealed = changed ? new Set<string>() : value.revealed;
      let expanded = false;
      if (tr.selection) {
        for (const range of tr.state.selection.ranges) {
          const from = tr.state.doc.lineAt(range.from).number;
          const to = tr.state.doc.lineAt(range.to).number;
          for (const fold of ranges) {
            if (revealed.has(fold.id) || from >= fold.to || to < fold.from)
              continue;
            revealed = new Set(revealed);
            revealed.add(fold.id);
            expanded = true;
          }
        }
      }
      if (!changed && !expanded) return value;
      return {
        ranges,
        revealed,
        decorations: decorations(tr.state, ranges, revealed),
        tree: syntaxTree(tr.state),
      };
    },
    provide: (current) =>
      EditorView.decorations.from(current, (value) => value.decorations),
  });
  return field;
}
