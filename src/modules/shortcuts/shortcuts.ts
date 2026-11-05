import { MOD_PROP } from "@/lib/platform";

/**
 * Single source of truth for keyboard shortcuts.
 */

export type ShortcutId =
  | "commandPalette.open"
  | "commandPalette.content"
  | "tab.new"
  | "tab.newBlock"
  | "tab.newPrivate"
  | "tab.newPreview"
  | "tab.newEditor"
  | "tab.close"
  | "tab.next"
  | "tab.prev"
  | "tab.selectByIndex"
  | "space.next"
  | "space.prev"
  | "space.overview"
  | "pane.splitRight"
  | "pane.splitDown"
  | "pane.focusNext"
  | "pane.focusPrev"
  | "pane.swapLeft"
  | "pane.swapRight"
  | "pane.swapUp"
  | "pane.swapDown"
  | "pane.source"
  | "terminal.clear"
  | "terminal.toggleInput"
  | "blocks.prev"
  | "blocks.next"
  | "search.focus"
  | "explorer.search"
  | "explorer.focus"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  | "view.zenMode"
  | "selection.sendToAgent"
  | "settings.open"
  | "sidebar.toggle"
  | "editor.undo"
  | "editor.redo"
  | "editor.navigateBack"
  | "editor.navigateForward";

export type ShortcutGroup =
  | "General"
  | "Tabs"
  | "Spaces"
  | "Panes"
  | "Terminal"
  | "Search"
  | "View"
  | "Editor";

export type KeyBinding = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
};

export type Shortcut = {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  defaultBindings: KeyBinding[];
  allowRepeat?: boolean;
};

export const SHORTCUTS: Shortcut[] = [
  {
    id: "commandPalette.open",
    label: "打开命令面板",
    group: "General",
    defaultBindings: [{ [MOD_PROP]: true, key: "p" }],
  },
  {
    id: "commandPalette.content",
    label: "在文件中查找",
    group: "General",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "p" }],
  },
  {
    id: "settings.open",
    label: "打开设置",
    group: "General",
    defaultBindings: [{ [MOD_PROP]: true, key: "," }],
  },
  {
    id: "tab.new",
    label: "新建标签页",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "t" }],
  },
  {
    id: "tab.newBlock",
    label: "新建 Blocks 终端",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "t" }],
  },
  {
    id: "tab.newPrivate",
    label: "新建隐私终端",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "r" }],
  },
  {
    id: "tab.newPreview",
    label: "新建网页预览",
    group: "Tabs",
    // Cmd/Ctrl+P now opens the command palette, so web preview moves here.
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "o" }],
  },
  {
    id: "tab.newEditor",
    label: "新建编辑器标签页",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "e" }],
  },
  {
    id: "tab.close",
    label: "关闭标签页或窗格",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "w" }],
  },
  {
    id: "pane.splitRight",
    label: "向右拆分窗格",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "d" }],
  },
  {
    id: "pane.splitDown",
    label: "向下拆分窗格",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "d" }],
  },
  {
    id: "pane.focusNext",
    label: "聚焦下一个窗格",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "]" }],
  },
  {
    id: "pane.focusPrev",
    label: "聚焦上一个窗格",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "[" }],
  },
  {
    id: "pane.swapLeft",
    label: "窗格左移",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "ArrowLeft" }],
  },
  {
    id: "pane.swapRight",
    label: "窗格右移",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "ArrowRight" }],
  },
  {
    id: "pane.swapUp",
    label: "窗格上移",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "ArrowUp" }],
  },
  {
    id: "pane.swapDown",
    label: "窗格下移",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "ArrowDown" }],
  },
  {
    id: "pane.source",
    label: "切换源代码面板",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "g" }],
  },
  {
    id: "terminal.clear",
    label: "清空终端",
    group: "Terminal",
    // Ctrl+K is readline's kill-line, so we leave it unbound and let users
    // assign their own in settings.
    defaultBindings: [],
  },
  {
    id: "terminal.toggleInput",
    label: "切换 Shell / AI 输入",
    group: "Terminal",
    defaultBindings: [{ [MOD_PROP]: true, key: "u" }],
  },
  {
    id: "blocks.prev",
    label: "上一个命令块",
    group: "Terminal",
    defaultBindings: [{ [MOD_PROP]: true, key: "ArrowUp" }],
    allowRepeat: true,
  },
  {
    id: "blocks.next",
    label: "下一个命令块",
    group: "Terminal",
    defaultBindings: [{ [MOD_PROP]: true, key: "ArrowDown" }],
    allowRepeat: true,
  },
  {
    id: "tab.next",
    label: "下一个标签页",
    group: "Tabs",
    defaultBindings: [{ ctrl: true, key: "Tab" }],
    allowRepeat: true,
  },
  {
    id: "tab.prev",
    label: "上一个标签页",
    group: "Tabs",
    defaultBindings: [{ ctrl: true, shift: true, key: "Tab" }],
    allowRepeat: true,
  },
  {
    id: "tab.selectByIndex",
    label: "跳转到标签页 1-9",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "1" }],
  },
  {
    id: "space.next",
    label: "下一个工作区",
    group: "Spaces",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "]" }],
  },
  {
    id: "space.prev",
    label: "上一个工作区",
    group: "Spaces",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "[" }],
  },
  {
    id: "space.overview",
    label: "打开工作区列表",
    group: "Spaces",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "s" }],
  },
  {
    id: "explorer.search",
    label: "搜索文件",
    group: "Search",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "f" }],
  },
  {
    id: "search.focus",
    label: "搜索工作区文件内容",
    group: "Search",
    defaultBindings: [{ [MOD_PROP]: true, key: "f" }],
  },
  {
    id: "selection.sendToAgent",
    label: "把选中内容发送到 agent",
    group: "Search",
    // Keep Mod+L available to the shell for clear-screen, including when
    // terminal text is selected and this shortcut is otherwise eligible.
    defaultBindings: [{ [MOD_PROP]: true, key: "j" }],
  },
  {
    id: "sidebar.toggle",
    label: "切换文件浏览器",
    group: "View",
    // Plain Mod+B toggles the sidebar everywhere EXCEPT a focused terminal,
    // where it's handed to the shell / Claude Code (its "run in background"
    // key). Mod+Shift+B always toggles, including from inside a terminal.
    defaultBindings: [
      { [MOD_PROP]: true, key: "b" },
      { [MOD_PROP]: true, shift: true, key: "b" },
    ],
  },
  {
    id: "explorer.focus",
    label: "切换文件浏览器焦点",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "e" }],
  },
  {
    id: "view.zoomIn",
    label: "放大",
    group: "View",
    defaultBindings: [
      { [MOD_PROP]: true, key: "=" },
      { [MOD_PROP]: true, shift: true, key: "+" },
    ],
    allowRepeat: true,
  },
  {
    id: "view.zoomOut",
    label: "缩小",
    group: "View",
    defaultBindings: [
      { [MOD_PROP]: true, key: "-" },
      { [MOD_PROP]: true, shift: true, key: "_" },
    ],
    allowRepeat: true,
  },
  {
    id: "view.zoomReset",
    label: "重置缩放",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, key: "0" }],
  },
  {
    id: "view.zenMode",
    label: "切换禅模式",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "'" }],
  },
  {
    id: "editor.navigateBack",
    label: "后退跳转位置",
    group: "Editor",
    defaultBindings: [{ [MOD_PROP]: true, key: "ArrowLeft" }],
  },
  {
    id: "editor.navigateForward",
    label: "前进跳转位置",
    group: "Editor",
    defaultBindings: [{ [MOD_PROP]: true, key: "ArrowRight" }],
  },
  // Editor entries are display-only: CodeMirror's historyKeymap binds these
  // keys natively. We register them here so the shortcuts dialog can surface
  // them — they don't have App-level handlers, so `useGlobalShortcuts` falls
  // through without `preventDefault`, leaving CodeMirror to handle the event.
  // Also excluded from the customization UI in ShortcutsSection.
  {
    id: "editor.undo",
    label: "撤销",
    group: "Editor",
    defaultBindings: [{ [MOD_PROP]: true, key: "z" }],
  },
  {
    id: "editor.redo",
    label: "重做",
    group: "Editor",
    defaultBindings: [{ [MOD_PROP]: true, key: "y" }],
  },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  "General",
  "Tabs",
  "Spaces",
  "Panes",
  "Terminal",
  "View",
  "Search",
  "Editor",
];

// Group ids stay English so they keep working as stable keys; only display text is localized.
export const SHORTCUT_GROUP_LABELS: Record<ShortcutGroup, string> = {
  General: "通用",
  Tabs: "标签页",
  Spaces: "工作区",
  Panes: "窗格",
  Terminal: "终端",
  Search: "搜索",
  View: "视图",
  Editor: "编辑器",
};

/**
 * Matching logic: checks if a KeyboardEvent matches a KeyBinding.
 */
const CODE_TO_KEY: Record<string, string> = {
  Backslash: "\\",
  Slash: "/",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Space: " ",
};

// macOS Option combinations rewrite e.key ("«", "…", dead keys); the
// physical key survives in e.code.
function keyFromCode(code: string): string | null {
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  return CODE_TO_KEY[code] ?? null;
}

export function matchBinding(
  e: KeyboardEvent,
  binding: KeyBinding,
  id?: ShortcutId,
): boolean {
  if (e.isComposing || e.keyCode === 229) return false;
  const eventKey = e.key.toLowerCase();
  const bindingKey = binding.key.toLowerCase();

  // Special case for Jump to Tab 1-9
  if (id === "tab.selectByIndex") {
    if (!/^[1-9]$/.test(e.key)) return false;
  } else if (eventKey !== bindingKey) {
    if (!binding.alt || keyFromCode(e.code) !== bindingKey) return false;
  }

  return (
    !!e.ctrlKey === !!binding.ctrl &&
    !!e.shiftKey === !!binding.shift &&
    !!e.altKey === !!binding.alt &&
    !!e.metaKey === !!binding.meta
  );
}

/**
 * Display helpers
 */
export function getBindingTokens(binding?: KeyBinding): string[] {
  if (!binding) return [];
  const tokens: string[] = [];
  if (binding.ctrl) tokens.push("Ctrl");
  if (binding.alt) tokens.push("Alt");
  if (binding.shift) tokens.push("Shift");
  if (binding.meta) tokens.push("Win");

  let keyLabel = binding.key;
  if (keyLabel === " ") keyLabel = "Space";
  else if (keyLabel === "ArrowUp") keyLabel = "↑";
  else if (keyLabel === "ArrowDown") keyLabel = "↓";
  else if (keyLabel === "ArrowLeft") keyLabel = "←";
  else if (keyLabel === "ArrowRight") keyLabel = "→";
  else if (keyLabel.length === 1) keyLabel = keyLabel.toUpperCase();

  tokens.push(keyLabel);
  return tokens;
}
