import type { Tab } from "./useTabs";

/**
 * The label shown on a tab. Non-terminal tabs use their stored title; terminal
 * tabs prefer a user-set custom name, then fall back to the last segment of the
 * cwd. Keeping this pure makes the "custom name survives a cd" invariant
 * testable without rendering the bar.
 */
export function labelFor(t: Tab): string {
  if (t.kind === "editor") return t.title;
  if (t.kind === "preview") return t.title;
  if (t.kind === "markdown") return t.title;
  if (t.kind === "git-diff") return t.title;
  if (t.kind === "git-history") return t.title;
  if (t.kind === "git-commit-file") return t.title;
  if (t.customTitle) return t.customTitle;
  if (!t.cwd) return t.title;
  const parts = t.cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}

export function splitProjectBadge(label: string): {
  icon: string;
  rest: string;
} {
  const chars = Array.from(label.trim());
  if (chars.length === 0) return { icon: "?", rest: "" };
  return {
    icon: chars.slice(0, 2).join(""),
    rest: chars.slice(2).join(""),
  };
}
