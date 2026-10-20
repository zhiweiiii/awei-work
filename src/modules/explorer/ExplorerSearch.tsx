import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useContentSearch } from "@/modules/command-palette/hooks/useContentSearch";
import { useAsyncQuery } from "@/modules/command-palette/hooks/useAsyncQuery";
import {
  currentWorkspaceScopeKey,
  LOCAL_WORKSPACE,
  workspaceScopeKey,
} from "@/modules/workspace";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { fileIconUrl } from "./lib/iconResolver";

type Props = {
  rootPath: string;
  onOpenFile: (path: string, line?: number) => void;
  onActiveChange?: (active: boolean) => void;
};

export type ExplorerSearchHandle = {
  focus: () => void;
  isFocused: () => boolean;
};

type FileHit = {
  path: string;
  rel: string;
  name: string;
  is_dir: boolean;
};

type FileSearchResult = {
  hits: FileHit[];
  truncated: boolean;
};

function basename(rel: string): string {
  const parts = rel.split(/[\\/]/);
  return parts[parts.length - 1] || rel;
}

const MIN_QUERY_LEN = 1;
const FILE_SEARCH_DEBOUNCE_MS = 250;
const FILE_SEARCH_LIMIT = 50;

// A content search walks the whole tree, so it costs far more than the
// file-name pass. Hold off until the term is specific enough to be worth it
// and until typing has actually settled.
const CONTENT_MIN_QUERY = 3;
const CONTENT_DEBOUNCE_MS = 300;

/**
 * Persistent search bar in the explorer sidebar. Matches both file names
 * (fuzzy) and file contents, so it behaves like the Ctrl+Shift+P "find in
 * files" search but also surfaces file-name hits.
 */
export const ExplorerSearch = forwardRef<ExplorerSearchHandle, Props>(
  function ExplorerSearch({ rootPath, onOpenFile, onActiveChange }, ref) {
    const [q, setQ] = useState("");
    const [activeIndex, setActiveIndex] = useState(0);
    const workspace = LOCAL_WORKSPACE;
    const workspaceKey = workspaceScopeKey(workspace);
    const inputRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const lastKeyboardNavAt = useRef(0);

    // Trim once: keeping the raw value out of the effect deps stops a trailing
    // space from re-firing both searches.
    const query = q.trim();
    const active = query.length > 0;

    useEffect(() => {
      onActiveChange?.(active);
    }, [active, onActiveChange]);

    const runFileSearch = useCallback(
      async (query: string) => {
        if (currentWorkspaceScopeKey() !== workspaceKey)
          throw new Error("Workspace changed");
        const result = await invoke<FileSearchResult>("fs_search", {
          root: rootPath,
          query,
          limit: FILE_SEARCH_LIMIT,
          showHidden: false,
          workspace,
        });
        if (currentWorkspaceScopeKey() !== workspaceKey)
          throw new Error("Workspace changed");
        return result.hits;
      },
      [rootPath, workspaceKey],
    );
    const files = useAsyncQuery({
      enabled: active,
      term: query,
      minLength: MIN_QUERY_LEN,
      debounceMs: FILE_SEARCH_DEBOUNCE_MS,
      run: runFileSearch,
      scopeKey: `${workspaceKey}\0${rootPath}`,
    });
    const fileHits = files.results;

    // File-content search (same backend as Ctrl+Shift+P).
    const content = useContentSearch(rootPath, query, active, {
      minLength: CONTENT_MIN_QUERY,
      debounceMs: CONTENT_DEBOUNCE_MS,
    });
    const contentHits = content.results;

    // Merged list: file-name hits first, then content hits.
    const results: (
      | { kind: "file"; hit: FileHit }
      | { kind: "content"; hit: (typeof contentHits)[number] }
    )[] = useMemo(
      () => [
        ...fileHits.map((hit) => ({ kind: "file" as const, hit })),
        ...contentHits.map((hit) => ({ kind: "content" as const, hit })),
      ],
      [fileHits, contentHits],
    );

    const loading = files.loading || content.loading;
    const searchError = files.error ?? content.error;
    const retry = () => {
      if (files.error) files.retry();
      if (content.error) content.retry();
    };
    useEffect(() => {
      setActiveIndex((current) =>
        Math.min(current, Math.max(0, results.length - 1)),
      );
    }, [results.length]);

    useEffect(() => {
      if (active && results.length > 0) {
        const el = scrollRef.current?.querySelector(
          `[data-index="${activeIndex}"]`,
        );
        el?.scrollIntoView({ block: "nearest" });
      }
    }, [activeIndex, results, active]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          requestAnimationFrame(() => {
            inputRef.current?.focus();
          });
        },
        isFocused: () => document.activeElement === inputRef.current,
      }),
      [],
    );

    const openHit = useCallback(
      (r: (typeof results)[number]) => {
        if (r.kind === "file") onOpenFile(r.hit.path);
        else onOpenFile(r.hit.path, r.hit.line);
      },
      [onOpenFile],
    );

    return (
      <div
        className={cn("flex min-h-0 flex-col", active ? "flex-1" : "shrink-0")}
      >
        <div className="relative shrink-0 px-2 py-1.5">
          <HugeiconsIcon
            icon={Search01Icon}
            size={13}
            strokeWidth={2}
            className="absolute top-1/2 left-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            ref={inputRef}
            value={q}
            placeholder="Search files & contents…"
            onChange={(e) => {
              setQ(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (results.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  lastKeyboardNavAt.current = Date.now();
                  setActiveIndex((prev) => (prev + 1) % results.length);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  lastKeyboardNavAt.current = Date.now();
                  setActiveIndex(
                    (prev) => (prev - 1 + results.length) % results.length,
                  );
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const r = results[activeIndex];
                  if (r) openHit(r);
                }
              }
            }}
            className="h-7 w-full rounded-md border border-border/60 bg-muted/60 pr-7 pl-6.5 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-border focus:bg-muted/80"
          />
          {q ? (
            <button
              type="button"
              onClick={() => {
                setQ("");
                inputRef.current?.focus();
              }}
              className="absolute top-1/2 right-3.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Clear search"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
            </button>
          ) : null}
        </div>

        {active ? (
          <div className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="py-1" ref={scrollRef}>
                {loading && results.length === 0 ? (
                  <div className="px-3 py-2 text-[11px] text-muted-foreground">
                    Searching…
                  </div>
                ) : searchError && results.length === 0 ? (
                  <button
                    type="button"
                    onClick={retry}
                    className="w-full px-3 py-2 text-left text-[11px] text-destructive hover:bg-accent/50"
                  >
                    Search failed — retry
                  </button>
                ) : results.length === 0 ? (
                  <div className="px-3 py-2 text-[11px] text-muted-foreground">
                    No matches
                  </div>
                ) : (
                  results.map((r, index) => {
                    const isSelected = index === activeIndex;
                    if (r.kind === "file") {
                      const url = r.hit.is_dir ? null : fileIconUrl(r.hit.name);
                      return (
                        <button
                          key={`file:${r.hit.path}`}
                          type="button"
                          data-index={index}
                          onClick={() => openHit(r)}
                          onMouseEnter={() => {
                            if (Date.now() - lastKeyboardNavAt.current > 250) {
                              setActiveIndex(index);
                            }
                          }}
                          className={cn(
                            "flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors",
                            isSelected
                              ? "bg-accent text-foreground"
                              : "hover:bg-accent/50 text-foreground/80",
                          )}
                          title={r.hit.path}
                        >
                          {url ? (
                            <img
                              src={url}
                              alt=""
                              className="size-3.5 shrink-0"
                            />
                          ) : (
                            <HugeiconsIcon
                              icon={Search01Icon}
                              size={12}
                              strokeWidth={1.75}
                              className="shrink-0 text-muted-foreground"
                            />
                          )}
                          <span className="truncate">{r.hit.name}</span>
                          <span className="ml-auto truncate text-[10px] text-muted-foreground">
                            {r.hit.rel}
                          </span>
                        </button>
                      );
                    }
                    const hit = r.hit;
                    const url = fileIconUrl(basename(hit.rel));
                    return (
                      <button
                        key={`content:${hit.path}:${hit.line}`}
                        type="button"
                        data-index={index}
                        onClick={() => openHit(r)}
                        onMouseEnter={() => {
                          if (Date.now() - lastKeyboardNavAt.current > 250) {
                            setActiveIndex(index);
                          }
                        }}
                        className={cn(
                          "flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors",
                          isSelected
                            ? "bg-accent text-foreground"
                            : "hover:bg-accent/50 text-foreground/80",
                        )}
                        title={`${hit.rel}:${hit.line}`}
                      >
                        <img src={url} alt="" className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                          {hit.text.trim()}
                        </span>
                        <span className="shrink-0 truncate text-[10px] text-muted-foreground">
                          {basename(hit.rel)}:{hit.line}
                        </span>
                      </button>
                    );
                  })
                )}
                {loading && results.length > 0 ? (
                  <div className="px-3 py-1.5 text-[10px] text-muted-foreground">
                    Updating results…
                  </div>
                ) : null}
                {searchError && results.length > 0 ? (
                  <button
                    type="button"
                    onClick={retry}
                    className="w-full px-3 py-1.5 text-left text-[11px] text-destructive hover:bg-accent/50"
                  >
                    Some results could not be loaded. Retry
                  </button>
                ) : null}
              </div>
            </ScrollArea>
          </div>
        ) : null}
      </div>
    );
  },
);
