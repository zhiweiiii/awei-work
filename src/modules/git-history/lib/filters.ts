import type { GitLogEntry } from "@/lib/native";

export type SearchOptions = {
  regex?: boolean;
  caseSensitive?: boolean;
};

export type DatePreset = "all" | "24h" | "7d" | "30d";

export const DATE_PRESETS: { id: DatePreset; label: string }[] = [
  { id: "all", label: "All time" },
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
];

export type HistoryFilters = {
  /** Author name pattern passed to gitLogFiltered; null = any. */
  author: string | null;
  date: DatePreset;
  /** Branch name passed to gitLogFiltered; null = any. */
  branch: string | null;
  noMerges: boolean;
  /** Client-side graph/parents transform, never sent to the backend. */
  firstParent: boolean;
};

export const EMPTY_HISTORY_FILTERS: HistoryFilters = {
  author: null,
  date: "all",
  branch: null,
  noMerges: false,
  firstParent: false,
};

/** Options forwarded to the git log backend. */
export type GitLogFilterOptions = {
  all?: boolean;
  branch?: string;
  author?: string;
  since?: string;
  until?: string;
  noMerges?: boolean;
  maxCount?: number;
  skip?: number;
};

const PRESET_MS: Record<DatePreset, number> = {
  all: 0,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function sinceForPreset(preset: DatePreset, now: number): string | null {
  const ms = PRESET_MS[preset];
  if (ms === 0) return null;
  return new Date(now - ms).toISOString();
}

export function hasServerFilters(filters: HistoryFilters): boolean {
  return (
    filters.author !== null ||
    filters.date !== "all" ||
    filters.branch !== null ||
    filters.noMerges
  );
}

export function serverFilterOptions(
  filters: Pick<HistoryFilters, "author" | "date" | "branch" | "noMerges">,
  now = Date.now(),
): GitLogFilterOptions | null {
  const options: GitLogFilterOptions = {};
  if (filters.author) options.author = filters.author;
  if (filters.branch) options.branch = filters.branch;
  if (filters.noMerges) options.noMerges = true;
  const since = sinceForPreset(filters.date, now);
  if (since) options.since = since;
  return Object.keys(options).length === 0 ? null : options;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the regex backing a search. Plain queries are escaped so they always
 * match literally; an invalid regex source yields null, which callers treat
 * as "matches nothing".
 */
export function compileSearch(
  query: string,
  options: SearchOptions,
): RegExp | null {
  if (!query) return null;
  const flags = options.caseSensitive ? "" : "i";
  const source = options.regex ? query : escapeRegExp(query);
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

export function uniqueAuthors(entries: readonly GitLogEntry[]): string[] {
  const seen = new Set<string>();
  const authors: string[] = [];
  for (const entry of entries) {
    const name = (entry.author || "Unknown").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    authors.push(name);
  }
  return authors;
}
