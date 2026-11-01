import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { pathIdentity } from "@/lib/pathIdentity";
import { toast } from "sonner";
import type { GitStatusSnapshot } from "@/lib/native";
import type { WorkspaceEnv } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setCompactFolders,
  setHideGitIgnored,
  setShowHidden,
} from "@/modules/settings/store";
import { useGlobalShortcuts } from "@/modules/shortcuts";
import type { TerminalPathDropTarget } from "@/modules/terminal";
import {
  FileAddIcon,
  FilterIcon,
  Folder01Icon,
  FolderAddIcon,
  Refresh01Icon,
  Target01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Tabs as ExplorerTabs } from "radix-ui";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ExplorerSearch, type ExplorerSearchHandle } from "./ExplorerSearch";
import { InlineInput } from "./InlineInput";
import {
  copyToClipboard,
  openWithSystemApp,
  relativePath,
  revealInFinder,
} from "./lib/contextActions";
import type { GitStatusCode } from "./lib/gitStatusUtils";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import { useExplorerDnd } from "./lib/useExplorerDnd";
import { useExplorerFileDrop } from "./lib/useExplorerFileDrop";
import { useFileTree } from "./lib/useFileTree";
import { useGitStatus } from "./lib/useGitStatus";
import { EntryRow, PendingRow, type RowActions, StatusRow } from "./TreeRow";

export type FileExplorerHandle = {
  focus: () => void;
  isFocused: () => boolean;
  focusSearch: () => void;
};

type Props = {
  rootPath: string | null;
  activeFilePath?: string | null;
  /** Paths with an open editor tab, marked in the tree. */
  openFilePaths?: string[];
  onOpenFile: (path: string, pin?: boolean) => void;
  /** Open a content-search hit at a specific line. */
  onOpenSearchHit?: (path: string, line: number) => void;
  onPathRenamed?: (from: string, to: string, workspace: WorkspaceEnv) => void;
  onPathDeleted?: (path: string, workspace: WorkspaceEnv) => void;
  onRevealInTerminal?: (path: string) => void;
  onOpenInSourceControl?: (path: string) => void;
  onOpenGitHistory?: (path: string) => void;
  onOpenFileHistory?: (path: string) => void;
  onAttachToAgent?: (path: string) => void;
  pathDropTarget?: TerminalPathDropTarget;
  /** One snapshot per repo; each file is decorated by its containing repo. */
  gitStatuses?: GitStatusSnapshot[] | null;
};

type Row =
  | {
      kind: "entry";
      key: string;
      path: string;
      name: string;
      /** Head of a compacted chain ("com" for a row reading com/example/app).
       *  Collapsing acts here, so one click folds the whole run away. */
      collapsePath: string;
      isDir: boolean;
      isExpanded: boolean;
      depth: number;
      gitignored: boolean;
      gitStatusCode: GitStatusCode | null;
    }
  | {
      kind: "rename";
      key: string;
      path: string;
      name: string;
      isDir: boolean;
      depth: number;
      gitignored: boolean;
      gitStatusCode: GitStatusCode | null;
    }
  | { kind: "pending"; key: string; depth: number; pendingKind: "file" | "dir" }
  | {
      kind: "status";
      key: string;
      depth: number;
      tone: "muted" | "error";
      message: string;
    };

const ROW_HEIGHT = 24;
const OVERSCAN = 8;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function parentOf(path: string, fallback: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : fallback;
}

/** Flip a filter preference, and say so when the write fails.
 *
 *  These were fire-and-forget (`void setX(...)`), which meant a rejected write
 *  produced a toggle that did nothing and explained nothing. A setting that
 *  refuses to change has to say why. */
function applyFilter(
  set: (value: boolean) => Promise<void>,
  value: boolean,
): void {
  set(value).catch((e) => {
    console.error("[awei-work] filter preference write failed:", e);
    toast.error(`无法保存过滤设置：${typeof e === "string" ? e : String(e)}`);
  });
}

/** The one subdirectory a directory holds, when that is all it holds. */
type RowTree = Pick<
  ReturnType<typeof useFileTree>,
  "nodes" | "expanded" | "renaming" | "pendingCreate" | "joinPath"
>;

function soleChildDir(
  tree: RowTree,
  path: string,
): { name: string; path: string } | null {
  const node = tree.nodes[path];
  if (node?.status !== "loaded") return null;
  if (node.entries.length !== 1) return null;
  const only = node.entries[0];
  if (only.kind !== "dir") return null;
  return { name: only.name, path: tree.joinPath(path, only.name) };
}

function buildRows(
  rootPath: string,
  tree: RowTree,
  lookup: (path: string) => GitStatusCode | null,
  hideGitIgnored: boolean,
  compactFolders: boolean,
): { rows: Row[]; entryIndexByPath: Map<string, number> } {
  const rows: Row[] = [];
  const entryIndexByPath = new Map<string, number>();

  const walk = (parent: string, depth: number, parentIgnored: boolean) => {
    const node = tree.nodes[parent];
    if (node?.status !== "loaded") return;
    for (const entry of node.entries) {
      let path = tree.joinPath(parent, entry.name);
      const isDir = entry.kind === "dir";
      /* A package like com/example/app/service is four rows carrying one piece
         of information. While each level holds nothing but the next directory,
         they are folded into a single row. Only expanded, loaded levels can be
         folded: an unread directory's contents are unknown, which is why
         expanding one cascades down the run (`useFileTree.toggle`). */
      let name = entry.name;
      const collapsePath = path;
      if (compactFolders && isDir && tree.expanded.has(path)) {
        for (;;) {
          const only = soleChildDir(tree, path);
          if (!only || !tree.expanded.has(only.path)) break;
          name = `${name}/${only.name}`;
          path = only.path;
        }
      }
      const expanded = isDir && tree.expanded.has(path);
      const isRenaming = tree.renaming === path;
      const gitignored = parentIgnored || entry.gitignored;
      // An ignored directory takes its subtree with it: `parentIgnored` is
      // already the inherited answer, so skipping here skips the walk below
      // as well.
      if (hideGitIgnored && gitignored) continue;
      const gitStatusCode = gitignored ? null : lookup(path);
      if (isRenaming) {
        rows.push({
          kind: "rename",
          key: `rename:${path}`,
          path,
          name: entry.name,
          isDir,
          depth,
          gitignored,
          gitStatusCode,
        });
      } else {
        entryIndexByPath.set(path, rows.length);
        rows.push({
          kind: "entry",
          key: path,
          path,
          name,
          collapsePath,
          isDir,
          isExpanded: expanded,
          depth,
          gitignored,
          gitStatusCode,
        });
      }
      if (isDir && expanded) {
        const child = tree.nodes[path];
        if (tree.pendingCreate?.parentPath === path) {
          rows.push({
            kind: "pending",
            key: `pending:${path}`,
            depth: depth + 1,
            pendingKind: tree.pendingCreate.kind,
          });
        }
        if (child?.status === "loading") {
          rows.push({
            kind: "status",
            key: `loading:${path}`,
            depth: depth + 1,
            tone: "muted",
            message: "Loading…",
          });
        } else if (child?.status === "error") {
          rows.push({
            kind: "status",
            key: `error:${path}`,
            depth: depth + 1,
            tone: "error",
            message: child.message,
          });
        } else if (child?.status === "loaded") {
          walk(path, depth + 1, gitignored);
        }
      }
    }
  };

  walk(rootPath, 0, false);
  return { rows, entryIndexByPath };
}

export const FileExplorer = memo(
  forwardRef<FileExplorerHandle, Props>(function FileExplorer(
    {
      rootPath,
      activeFilePath,
      openFilePaths,
      onOpenFile,
      onOpenSearchHit,
      onPathRenamed,
      onPathDeleted,
      onRevealInTerminal,
      onOpenInSourceControl,
      onOpenGitHistory,
      onOpenFileHistory,
      onAttachToAgent,
      pathDropTarget,
      gitStatuses,
    },
    ref,
  ) {
    const tree = useFileTree(rootPath, { onPathRenamed, onPathDeleted });
    const gitDecorations = usePreferencesStore((s) => s.explorerGitDecorations);
    const hideGitIgnored = usePreferencesStore((s) => s.hideGitIgnored);
    const showHidden = usePreferencesStore((s) => s.showHidden);
    const compactFolders = usePreferencesStore((s) => s.compactFolders);
    const { lookup: lookupGitStatus } = useGitStatus(
      rootPath,
      gitDecorations ? gitStatuses : null,
      gitDecorations,
    );
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [viewState, setViewState] = useState<{
      root: string | null;
      value: "files" | "search";
    }>({ root: rootPath, value: "files" });
    const view = viewState.root === rootPath ? viewState.value : "files";
    const setView = useCallback(
      (value: "files" | "search") => setViewState({ root: rootPath, value }),
      [rootPath],
    );
    const searchRef = useRef<ExplorerSearchHandle>(null);
    const revealDirectoryRef = useRef<{ root: string; path: string } | null>(
      null,
    );
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const openPathSet = useMemo(
      () => new Set((openFilePaths ?? []).map(pathIdentity)),
      [openFilePaths],
    );

    const { nodes, expanded, renaming, pendingCreate, joinPath } = tree;
    const { rows, entryIndexByPath } = useMemo(() => {
      if (!rootPath)
        return {
          rows: [] as Row[],
          entryIndexByPath: new Map<string, number>(),
        };
      return buildRows(
        rootPath,
        { nodes, expanded, renaming, pendingCreate, joinPath },
        lookupGitStatus,
        hideGitIgnored,
        compactFolders,
      );
    }, [
      rootPath,
      nodes,
      expanded,
      renaming,
      pendingCreate,
      joinPath,
      lookupGitStatus,
      hideGitIgnored,
      compactFolders,
    ]);

    const rowActions = useMemo<RowActions>(
      () => ({
        toggle: tree.toggle,
        beginRename: tree.beginRename,
        commitRename: tree.commitRename,
        cancelRename: tree.cancelRename,
      }),
      [tree.toggle, tree.beginRename, tree.commitRename, tree.cancelRename],
    );
    const renameInProgress =
      tree.renaming !== null || tree.pendingCreate !== null;

    const [menuTarget, setMenuTarget] = useState<{
      path: string;
      name: string;
      isDir: boolean;
    } | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    // Bumped on every right-click so the menu content remounts and the popper
    // re-anchors to the new cursor (floating-ui won't reposition on an anchor
    // change alone, only on scroll/resize).
    const [menuNonce, setMenuNonce] = useState(0);

    const entryPaths = useMemo<string[]>(() => {
      const out: string[] = [];
      for (const row of rows) if (row.kind === "entry") out.push(row.path);
      return out;
    }, [rows]);

    const isDirAt = useCallback(
      (path: string): boolean | undefined => {
        const idx = entryIndexByPath.get(path);
        const row = idx !== undefined ? rows[idx] : undefined;
        return row?.kind === "entry" ? row.isDir : undefined;
      },
      [entryIndexByPath, rows],
    );
    const dnd = useExplorerDnd({
      rootPath: rootPath ?? "",
      isDir: isDirAt,
      onMove: tree.movePath,
      pathDropTarget,
    });

    const fileDrop = useExplorerFileDrop({
      rootPath,
      isDir: isDirAt,
      onCopied: tree.refresh,
    });

    const dropTargetDir = dnd.dropTargetDir ?? fileDrop.externalTargetDir;
    const rootIsDropTarget =
      dropTargetDir != null && dropTargetDir === rootPath;
    useEffect(() => {
      if (!dropTargetDir || dropTargetDir === rootPath) return;
      if (tree.expanded.has(dropTargetDir)) return;
      const id = window.setTimeout(() => tree.expand(dropTargetDir), 700);
      return () => window.clearTimeout(id);
    }, [dropTargetDir, rootPath, tree.expanded, tree.expand]);

    useEffect(() => {
      if (selectedPath && !entryIndexByPath.has(selectedPath)) {
        setSelectedPath(null);
      }
    }, [entryIndexByPath, selectedPath]);

    const virtualizer = useVirtualizer({
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: OVERSCAN,
      getItemKey: (index) => rows[index]?.key ?? index,
    });

    const scrollEntryIntoView = useCallback(
      (path: string) => {
        const index = entryIndexByPath.get(path);
        if (index === undefined) return;
        virtualizer.scrollToIndex(index, { align: "auto" });
      },
      [entryIndexByPath, virtualizer],
    );

    const locateActiveFile = useCallback(() => {
      if (!rootPath || !activeFilePath) return;
      setView("files");
      const target = activeFilePath.replace(/\\/g, "/");
      const root = rootPath.replace(/\\/g, "/");
      if (target === root || !target.startsWith(`${root}/`)) return;
      // Expand every ancestor dir from the root down to the file's parent so
      // the file row actually exists in the tree, then select + reveal it.
      const parts = target.slice(root.length + 1).split("/");
      let parent = root;
      for (let i = 0; i < parts.length - 1; i++) {
        parent = `${parent}/${parts[i]}`;
        tree.expand(parent);
      }
      // Clear the auto-sync guard: expansion loads children asynchronously, so
      // when the row appears the effect below must select it again (the guard
      // would otherwise skip it as "already synced").
      lastSyncedActivePathRef.current = null;
      setSelectedPath(target);
      requestAnimationFrame(() => scrollEntryIntoView(target));
    }, [rootPath, activeFilePath, tree, scrollEntryIntoView, setView]);

    useEffect(() => {
      const pending = revealDirectoryRef.current;
      if (!pending) return;
      if (pending.root !== rootPath) {
        revealDirectoryRef.current = null;
        return;
      }
      if (view !== "files" || !entryIndexByPath.has(pending.path)) return;
      revealDirectoryRef.current = null;
      setSelectedPath(pending.path);
      requestAnimationFrame(() => scrollEntryIntoView(pending.path));
    }, [rootPath, view, entryIndexByPath, scrollEntryIntoView]);

    const lastSyncedActivePathRef = useRef<string | null>(null);
    useEffect(() => {
      if (
        !activeFilePath ||
        activeFilePath === lastSyncedActivePathRef.current
      ) {
        return;
      }
      if (!entryIndexByPath.has(activeFilePath)) return;
      lastSyncedActivePathRef.current = activeFilePath;
      setSelectedPath(activeFilePath);
      requestAnimationFrame(() => scrollEntryIntoView(activeFilePath));
    }, [activeFilePath, entryIndexByPath, scrollEntryIntoView]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          setView("files");
          containerRef.current?.focus();
          if (!selectedPath && entryPaths.length > 0) {
            const first = entryPaths[0];
            setSelectedPath(first);
            requestAnimationFrame(() => scrollEntryIntoView(first));
          }
        },
        isFocused: () => {
          const c = containerRef.current;
          if (!c) return false;
          const active = document.activeElement;
          return active instanceof Node && c.contains(active);
        },
        focusSearch: () => {
          setView("search");
          searchRef.current?.focus();
        },
      }),
      [entryPaths, scrollEntryIntoView, selectedPath, setView],
    );

    useGlobalShortcuts({
      "explorer.search": () => {
        setView("search");
        if (searchRef.current?.isFocused()) {
          return;
        }
        searchRef.current?.focus();
      },
    });

    if (!rootPath) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <HugeiconsIcon
            icon={Folder01Icon}
            size={24}
            strokeWidth={1.5}
            className="text-muted-foreground"
          />
          <div className="text-xs text-muted-foreground">
            No current directory
          </div>
        </div>
      );
    }

    const root = tree.nodes[rootPath];
    const pendingAtRoot =
      tree.pendingCreate?.parentPath === rootPath ? tree.pendingCreate : null;

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        e.nativeEvent.isComposing ||
        e.nativeEvent.keyCode === 229 ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      )
        return;
      if (
        view !== "files" ||
        tree.renaming ||
        tree.pendingCreate ||
        searchRef.current?.isFocused()
      )
        return;
      const target = e.target as HTMLElement;
      if (target !== containerRef.current && !target.closest("[data-fs-path]"))
        return;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      )
        return;
      if (entryPaths.length === 0) return;

      const currentIdx = selectedPath ? entryPaths.indexOf(selectedPath) : -1;
      const move = (next: number) => {
        const clamped = Math.max(0, Math.min(entryPaths.length - 1, next));
        const path = entryPaths[clamped];
        setSelectedPath(path);
        requestAnimationFrame(() => scrollEntryIntoView(path));
      };

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          move(currentIdx < 0 ? 0 : currentIdx + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          move(currentIdx < 0 ? entryPaths.length - 1 : currentIdx - 1);
          break;
        case "ArrowRight": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir) {
            if (!row.isExpanded) tree.toggle(row.path);
            else move(currentIdx + 1);
          }
          break;
        }
        case "ArrowLeft": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir && row.isExpanded) {
            tree.toggle(row.path);
          } else {
            const parent = row.path.slice(0, row.path.lastIndexOf("/"));
            if (parent && parent !== rootPath) setSelectedPath(parent);
          }
          break;
        }
        case "Enter": {
          if (currentIdx < 0) return;
          e.preventDefault();
          const path = entryPaths[currentIdx];
          const idx = entryIndexByPath.get(path);
          if (idx === undefined) break;
          const row = rows[idx];
          if (row.kind !== "entry") break;
          if (row.isDir) tree.toggle(row.path);
          else onOpenFile(row.path);
          break;
        }
      }
    };

    const activeNormalized = activeFilePath
      ? pathIdentity(activeFilePath)
      : null;
    const openStateFor = (path: string): "active" | "open" | null => {
      const norm = pathIdentity(path);
      if (norm === activeNormalized) return "active";
      return openPathSet.has(norm) ? "open" : null;
    };

    const renderRow = (row: Row) => {
      switch (row.kind) {
        case "entry":
        case "rename": {
          return (
            <EntryRow
              path={row.path}
              collapsePath={row.kind === "entry" ? row.collapsePath : undefined}
              name={row.name}
              isDir={row.isDir}
              isExpanded={row.kind === "entry" ? row.isExpanded : false}
              depth={row.depth}
              actions={rowActions}
              renameInProgress={renameInProgress}
              isSelected={selectedPath === row.path}
              isRenaming={row.kind === "rename"}
              isDropTarget={dropTargetDir === row.path}
              onOpenFile={onOpenFile}
              onSelectPath={setSelectedPath}
              gitStatusCode={row.gitStatusCode}
              gitignored={gitDecorations && row.gitignored}
              openState={row.isDir ? null : openStateFor(row.path)}
            />
          );
        }
        case "pending":
          return (
            <PendingRow
              depth={row.depth}
              kind={row.pendingKind}
              onCommit={tree.commitCreate}
              onCancel={tree.cancelCreate}
            />
          );
        case "status":
          return (
            <StatusRow
              depth={row.depth}
              message={row.message}
              tone={row.tone}
            />
          );
      }
    };

    return (
      <ExplorerTabs.Root
        value={view}
        onValueChange={(value) =>
          setView(value === "search" ? "search" : "files")
        }
        ref={containerRef}
        role="group"
        aria-label="File explorer"
        className="flex h-full flex-col outline-none"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2">
          <ExplorerTabs.List
            className="flex h-8 min-w-0 basis-36 flex-1 items-center gap-1"
            aria-label="文件栏页面"
          >
            <ExplorerTabs.Trigger
              value="files"
              className="flex min-w-0 flex-1 items-center rounded-md px-1.5 py-0.5 text-[10.5px] text-muted-foreground outline-none hover:bg-foreground/[0.04] hover:text-foreground data-[state=active]:bg-foreground/[0.08] data-[state=active]:font-medium data-[state=active]:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              title={rootPath}
            >
              <img
                src={folderIconUrl(basename(rootPath), false)}
                alt=""
                height={15}
                width={15}
                className="mr-1.5 shrink-0"
              />
              <span className="truncate">{basename(rootPath)}</span>
            </ExplorerTabs.Trigger>
            <ExplorerTabs.Trigger
              value="search"
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] text-muted-foreground outline-none hover:bg-foreground/[0.04] hover:text-foreground data-[state=active]:bg-foreground/[0.08] data-[state=active]:font-medium data-[state=active]:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            >
              搜索结果
            </ExplorerTabs.Trigger>
          </ExplorerTabs.List>
          <div className="ml-auto flex h-8 shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={locateActiveFile}
              disabled={!activeFilePath}
              title="Locate active file"
              aria-label="Locate active file"
            >
              <HugeiconsIcon icon={Target01Icon} size={13} strokeWidth={2} />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setView("files");
                tree.beginCreate(rootPath, "file");
              }}
              title="New file"
            >
              <HugeiconsIcon icon={FileAddIcon} size={13} strokeWidth={2} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setView("files");
                tree.beginCreate(rootPath, "dir");
              }}
              title="New folder"
            >
              <HugeiconsIcon icon={FolderAddIcon} size={13} strokeWidth={2} />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "size-6 text-muted-foreground hover:text-foreground",
                    // Say so when the tree is not showing everything, or a
                    // missing file looks like a missing file.
                    (hideGitIgnored || showHidden) && "text-foreground",
                  )}
                  title="过滤"
                  aria-label="过滤"
                  disabled={view === "search"}
                >
                  <HugeiconsIcon icon={FilterIcon} size={13} strokeWidth={2} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                {/* Both items read as "hide this": checked hides, unchecked
                  shows. `showHidden` is stored the other way round, so it is
                  inverted here rather than in the store, where other readers
                  already depend on its sense. */}
                <DropdownMenuCheckboxItem
                  checked={!showHidden}
                  onCheckedChange={(v) =>
                    applyFilter(setShowHidden, v !== true)
                  }
                >
                  隐藏 隐藏文件
                </DropdownMenuCheckboxItem>
                {/* Without git decorations Rust never fills `gitignored`, so
                  every entry reads as not-ignored and this filter would
                  silently do nothing. Say why instead of pretending. */}
                <DropdownMenuCheckboxItem
                  checked={compactFolders}
                  onCheckedChange={(v) =>
                    applyFilter(setCompactFolders, v === true)
                  }
                >
                  合并单层目录
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={hideGitIgnored}
                  disabled={!gitDecorations}
                  onCheckedChange={(v) =>
                    applyFilter(setHideGitIgnored, v === true)
                  }
                >
                  隐藏 git 忽略文件
                </DropdownMenuCheckboxItem>
                {!gitDecorations ? (
                  <p className="px-3 pb-1.5 text-[10.5px] leading-snug text-muted-foreground">
                    需先在设置里开启 git 状态标记
                  </p>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={() => {
                if (view === "search") searchRef.current?.refresh();
                else tree.refresh(rootPath);
              }}
              title={view === "search" ? "刷新搜索结果" : "Refresh"}
            >
              <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={2} />
            </Button>
          </div>
        </div>

        <ExplorerSearch
          ref={searchRef}
          key={rootPath}
          rootPath={rootPath}
          onOpenFile={(path, line) => {
            if (line !== undefined && onOpenSearchHit) {
              onOpenSearchHit(path, line);
            } else {
              onOpenFile(path);
            }
          }}
          onOpenDirectory={(path) => {
            const relative = relativePath(rootPath, path);
            if (relative === path || relative === ".") return;
            revealDirectoryRef.current = { root: rootPath, path };
            setView("files");
            let parent = rootPath;
            for (const segment of relative.split(/[\\/]/)) {
              parent = tree.joinPath(parent, segment);
              tree.expand(parent);
            }
          }}
          resultsVisible={view === "search"}
          onShowResults={() => setView("search")}
        />

        <ExplorerTabs.Content
          value="files"
          forceMount
          tabIndex={-1}
          className="flex min-h-0 flex-1 flex-col outline-none data-[state=inactive]:hidden"
        >
          <ContextMenu
            onOpenChange={(open) => {
              if (!open) setDeleteConfirm(false);
            }}
          >
            <ContextMenuTrigger asChild>
              <div
                ref={scrollRef}
                data-explorer-drop=""
                className={cn(
                  "min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]",
                  rootIsDropTarget &&
                    "rounded-sm ring-1 ring-inset ring-primary/50",
                )}
                onPointerDown={dnd.onPointerDown}
                onClickCapture={dnd.onClickCapture}
                onContextMenuCapture={(e) => {
                  const el = (e.target as HTMLElement).closest<HTMLElement>(
                    "[data-fs-path]",
                  );
                  const path = el?.getAttribute("data-fs-path") ?? null;
                  const idx =
                    path != null ? entryIndexByPath.get(path) : undefined;
                  const row = idx !== undefined ? rows[idx] : undefined;
                  setMenuTarget(
                    row && row.kind === "entry"
                      ? { path: row.path, name: row.name, isDir: row.isDir }
                      : null,
                  );
                  setDeleteConfirm(false);
                  setMenuNonce((n) => n + 1);
                }}
              >
                {pendingAtRoot ? (
                  <div
                    className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
                    style={{ paddingLeft: 6 }}
                  >
                    <span className="size-3.5 shrink-0" />
                    <img
                      src={
                        pendingAtRoot.kind === "dir"
                          ? folderIconUrl("", false)
                          : fileIconUrl("untitled")
                      }
                      alt=""
                      className="size-4 shrink-0 opacity-70"
                    />
                    <InlineInput
                      initial=""
                      placeholder={
                        pendingAtRoot.kind === "dir" ? "New folder" : "New file"
                      }
                      onCommit={tree.commitCreate}
                      onCancel={tree.cancelCreate}
                    />
                  </div>
                ) : null}
                {root?.status === "loading" && (
                  <div className="px-3 py-2 text-[11px] text-muted-foreground">
                    Loading…
                  </div>
                )}
                {root?.status === "error" && (
                  <div className="px-3 py-2 text-[11px] text-destructive">
                    {root.message}
                  </div>
                )}
                {root?.status === "loaded" ? (
                  <div
                    style={{
                      height: virtualizer.getTotalSize(),
                      position: "relative",
                      width: "100%",
                    }}
                  >
                    {virtualizer.getVirtualItems().map((virtualRow) => {
                      const row = rows[virtualRow.index];
                      if (!row) return null;
                      return (
                        <div
                          key={virtualRow.key}
                          data-virtual-row-index={virtualRow.index}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            height: virtualRow.size,
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          {renderRow(row)}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent
              key={menuNonce}
              className={COMPACT_CONTENT}
              onCloseAutoFocus={(e) => {
                if (tree.renaming || tree.pendingCreate) e.preventDefault();
              }}
            >
              {menuTarget ? (
                <>
                  {!menuTarget.isDir && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onOpenFile(menuTarget.path, true)}
                    >
                      打开
                    </ContextMenuItem>
                  )}
                  {menuTarget.isDir && onRevealInTerminal && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onRevealInTerminal(menuTarget.path)}
                    >
                      在终端中打开
                    </ContextMenuItem>
                  )}
                  {menuTarget.isDir && onOpenInSourceControl && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onOpenInSourceControl(menuTarget.path)}
                    >
                      在版本控制中打开
                    </ContextMenuItem>
                  )}
                  {menuTarget.isDir && onOpenGitHistory && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onOpenGitHistory(menuTarget.path)}
                    >
                      查看提交历史
                    </ContextMenuItem>
                  )}
                  {!menuTarget.isDir && onOpenFileHistory && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onOpenFileHistory(menuTarget.path)}
                    >
                      Git 历史
                    </ContextMenuItem>
                  )}
                  {!menuTarget.isDir && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => void openWithSystemApp(menuTarget.path)}
                    >
                      直接运行
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => void revealInFinder(menuTarget.path)}
                  >
                    在文件管理器中显示
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() =>
                      tree.beginCreate(
                        menuTarget.isDir
                          ? menuTarget.path
                          : parentOf(menuTarget.path, rootPath),
                        "file",
                      )
                    }
                  >
                    新建文件
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() =>
                      tree.beginCreate(
                        menuTarget.isDir
                          ? menuTarget.path
                          : parentOf(menuTarget.path, rootPath),
                        "dir",
                      )
                    }
                  >
                    新建文件夹
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => void copyToClipboard(menuTarget.path)}
                  >
                    复制路径
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() =>
                      void copyToClipboard(
                        relativePath(rootPath, menuTarget.path),
                      )
                    }
                  >
                    复制相对路径
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => onAttachToAgent?.(menuTarget.path)}
                  >
                    发送到 agent
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    variant="destructive"
                    onSelect={(e) => {
                      if (deleteConfirm) {
                        void tree.deletePath(menuTarget.path);
                      } else {
                        // Keep the menu open on the first click so the user
                        // can confirm; let it close normally on the second.
                        e.preventDefault();
                        setDeleteConfirm(true);
                      }
                    }}
                  >
                    {deleteConfirm ? "再点一次确认删除" : "删除"}
                  </ContextMenuItem>
                </>
              ) : (
                <>
                  {onRevealInTerminal && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onRevealInTerminal(rootPath)}
                    >
                      在终端中打开
                    </ContextMenuItem>
                  )}
                  {onOpenInSourceControl && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onOpenInSourceControl(rootPath)}
                    >
                      在版本控制中打开
                    </ContextMenuItem>
                  )}
                  {onOpenGitHistory && (
                    <ContextMenuItem
                      className={COMPACT_ITEM}
                      onSelect={() => onOpenGitHistory(rootPath)}
                    >
                      查看提交历史
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => void revealInFinder(rootPath)}
                  >
                    在文件管理器中显示
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => tree.beginCreate(rootPath, "file")}
                  >
                    新建文件
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => tree.beginCreate(rootPath, "dir")}
                  >
                    新建文件夹
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => void copyToClipboard(rootPath)}
                  >
                    复制路径
                  </ContextMenuItem>
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => tree.refresh(rootPath)}
                  >
                    刷新
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        </ExplorerTabs.Content>

        {dnd.dragLabel ? (
          <div
            ref={dnd.ghostRef}
            className="pointer-events-none fixed left-0 top-0 z-50 flex items-center gap-1.5 rounded-sm border border-border/70 bg-card/95 px-2 py-1 text-[12px] text-foreground shadow-md"
          >
            {dnd.dragLabel}
          </div>
        ) : null}
      </ExplorerTabs.Root>
    );
  }),
);
