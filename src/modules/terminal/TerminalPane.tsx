import {
  FindBox,
  type FindBoxHandle,
  type FindMatch,
} from "@/components/FindBox";
import { useTheme } from "@/modules/theme";
import type { WorkspaceEnv } from "@/modules/workspace";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { BlockOverlay } from "./block/BlockOverlay";
import { BlockWatermark } from "./block/BlockWatermark";
import type { GatewayRoutes } from "./lib/gatewayRoutes";
import type { TermMatch } from "./lib/terminalFind";
import {
  focusLeafInput,
  submitToLeaf,
  useTerminalSession,
} from "./lib/useTerminalSession";

export type TerminalPaneHandle = {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
  openSearch: () => void;
};

type Props = {
  workspace: WorkspaceEnv;
  /** Stable identifier for this leaf (passed back through callbacks). */
  leafId: number;
  /** Tab containing this pane is on screen. */
  visible: boolean;
  /** This leaf is the active pane within its tab — receives auto-focus. */
  focused?: boolean;
  initialCwd?: string;
  /** Enable command-block decorations (OSC 133) for this terminal. */
  blocks?: boolean;
  gatewayRoutes?: GatewayRoutes;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string) => void;
};

export const TerminalPane = memo(
  forwardRef<TerminalPaneHandle, Props>(function TerminalPane(
    {
      workspace,
      leafId,
      visible,
      focused = true,
      initialCwd,
      blocks = false,
      gatewayRoutes,
      onExit,
      onCwd,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const downYRef = useRef<number | null>(null);
    const { resolvedMode, activeTheme } = useTheme();
    const [findOpen, setFindOpen] = useState(false);
    const [findMatches, setFindMatches] = useState<TermMatch[]>([]);
    const findBoxRef = useRef<FindBoxHandle>(null);

    const session = useTerminalSession({
      workspace,
      leafId,
      container: containerRef,
      visible,
      focused,
      initialCwd,
      blocks,
      gatewayRoutes,
      onExit: (c) => onExit?.(leafId, c),
      onCwd: (c) => onCwd?.(leafId, c),
    });

    // biome-ignore lint/correctness/useExhaustiveDependencies: Theme tokens are read from CSS by applyTheme, so mode and theme changes trigger it.
    useEffect(() => {
      // Defer one frame so CSS-variable token resolution sees the new class.
      const id = requestAnimationFrame(() => session.applyTheme());
      return () => cancelAnimationFrame(id);
    }, [resolvedMode, activeTheme, session]);

    const openSearch = useCallback(() => {
      setFindOpen(true);
      requestAnimationFrame(() => findBoxRef.current?.focus());
    }, []);

    const runFind = useCallback(
      (q: string) => {
        const matches = q.trim() ? session.findAll(q.trim()) : [];
        setFindMatches(matches);
        if (matches.length > 0) session.revealFind(matches[0]);
        else session.clearFind();
      },
      [session],
    );

    const jumpFind = useCallback(
      (i: number) => {
        const m = findMatches[i];
        if (m) session.revealFind(m);
      },
      [findMatches, session],
    );

    const closeFind = useCallback(() => {
      setFindOpen(false);
      setFindMatches([]);
      session.clearFind();
    }, [session]);

    useImperativeHandle(
      ref,
      () => ({
        write: (data: string) => session.write(data),
        focus: () => session.focus(),
        getBuffer: (max?: number) => session.getBuffer(max),
        getSelection: () => session.getSelection(),
        openSearch,
      }),
      [session, openSearch],
    );

    const hideStyle = {
      visibility: visible ? ("visible" as const) : ("hidden" as const),
      pointerEvents: visible ? ("auto" as const) : ("none" as const),
    };

    const promptReady = session.blockMode === "prompt";

    const findDropdown: FindMatch[] = findMatches.map((m) => ({
      key: `${m.line}:${m.col}`,
      line: m.line + 1,
      text: m.text,
      hint: `行 ${m.line + 1}`,
    }));

    if (blocks) {
      return (
        <div
          className="zoom-exempt flex h-full w-full flex-col"
          style={hideStyle}
        >
          <div className="relative min-h-0 flex-1">
            {/* biome-ignore lint/a11y/noStaticElementInteractions: terminal surface; pointer selects command blocks */}
            <div
              ref={containerRef}
              className="absolute inset-0 z-0"
              onMouseDown={(e) => {
                downYRef.current = e.clientY;
              }}
              onMouseUp={(e) => {
                const moved =
                  downYRef.current != null &&
                  Math.abs(e.clientY - downYRef.current) > 4;
                downYRef.current = null;
                if (!moved) session.selectBlockAt(e.clientY);
                if (session.blockMode === "prompt") focusLeafInput(leafId);
              }}
            />
            <BlockWatermark
              leafId={leafId}
              subscribe={session.subscribeBlocks}
            />
            <BlockOverlay
              subscribe={session.subscribeBlocks}
              getVisible={session.visibleBlocks}
              readOutput={(id) => session.readBlockId(id)?.output ?? null}
              searchBlock={session.searchBlock}
              revealMatch={session.revealMatch}
              clearSearch={session.clearSearch}
              promptReady={promptReady}
              onRunAgain={(cmd) => submitToLeaf(leafId, cmd)}
              onRestoreFocus={() => {
                if (session.blockMode === "prompt") focusLeafInput(leafId);
              }}
            />
            {findOpen ? (
              <FindBox
                ref={findBoxRef}
                placeholder="Find in terminal"
                matches={findDropdown}
                onSearch={runFind}
                onJump={jumpFind}
                onClose={closeFind}
              />
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <div className="relative h-full w-full" style={hideStyle}>
        <div ref={containerRef} className="zoom-exempt h-full w-full" />
        {findOpen ? (
          <FindBox
            ref={findBoxRef}
            placeholder="Find in terminal"
            matches={findDropdown}
            onSearch={runFind}
            onJump={jumpFind}
            onClose={closeFind}
          />
        ) : null}
      </div>
    );
  }),
);
