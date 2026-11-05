import type {
  CheckState,
  SourceControlFileEntry,
} from "../useSourceControlPanel";

export type ChangeTreeRow =
  | {
      kind: "folder-header";
      key: string;
      label: string;
      path: string;
      count: number;
      collapsed: boolean;
      depth: number;
      repoRoot: string;
      checkState: CheckState;
    }
  | {
      kind: "entry";
      key: string;
      entry: SourceControlFileEntry;
      depth: number;
    };

type Directory = {
  name: string;
  path: string;
  count: number;
  checked: number;
  staged: number;
  files: SourceControlFileEntry[];
  children: Map<string, Directory>;
};

export function changeTreeRows(
  files: readonly SourceControlFileEntry[],
  repoKey: string,
  collapsedGroups: ReadonlySet<string>,
): ChangeTreeRow[] {
  const root: Directory = {
    name: "",
    path: "",
    count: 0,
    checked: 0,
    staged: 0,
    files: [],
    children: new Map(),
  };
  for (const entry of files) {
    const parts = entry.path.split(/[\\/]/);
    parts.pop();
    let node = root;
    for (const name of parts.filter(Boolean)) {
      let child = node.children.get(name);
      if (!child) {
        child = {
          name,
          path: node.path ? `${node.path}/${name}` : name,
          count: 0,
          checked: 0,
          staged: 0,
          files: [],
          children: new Map(),
        };
        node.children.set(name, child);
      }
      child.count++;
      if (entry.checkState === "checked") child.checked++;
      if (entry.checkState !== "unchecked") child.staged++;
      node = child;
    }
    node.files.push(entry);
  }

  const result: ChangeTreeRow[] = [];
  const keyFor = (node: Directory) => `${repoKey}:folder:${node.path}`;
  const pushFiles = (entries: SourceControlFileEntry[], depth: number) => {
    for (const entry of entries)
      result.push({ kind: "entry", key: entry.key, entry, depth });
  };
  pushFiles(root.files, 0);

  const childrenOf = (node: Directory) =>
    [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  const stack = childrenOf(root)
    .reverse()
    .map((node) => ({ node, depth: 0 }));
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    let { node } = item;
    let label = node.name;
    while (
      node.files.length === 0 &&
      node.children.size === 1 &&
      !collapsedGroups.has(keyFor(node))
    ) {
      const child = node.children.values().next().value;
      if (!child) break;
      node = child;
      label += `/${node.name}`;
    }
    const key = keyFor(node);
    const collapsed = collapsedGroups.has(key);
    result.push({
      kind: "folder-header",
      key,
      label,
      path: node.path,
      count: node.count,
      collapsed,
      depth: item.depth,
      repoRoot: files[0]?.repoRoot ?? "",
      checkState:
        node.checked === node.count
          ? "checked"
          : node.staged
            ? "indeterminate"
            : "unchecked",
    });
    if (collapsed) continue;
    pushFiles(node.files, item.depth + 1);
    for (const child of childrenOf(node).reverse())
      stack.push({ node: child, depth: item.depth + 1 });
  }
  return result;
}
