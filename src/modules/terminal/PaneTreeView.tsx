import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Fragment } from "react";
import type { WorkspaceEnv } from "@/modules/workspace";
import { useTerminalDropStore } from "./lib/dropStore";
import type { GatewayRoutes } from "./lib/gatewayRoutes";
import { focusSlot } from "./lib/rendererPool";
import { firstLeafSlotId, type PaneNode } from "./lib/panes";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";

type LeafBundle = {
  setRef: (h: TerminalPaneHandle | null) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
};

type Props = {
  workspace: WorkspaceEnv;
  node: PaneNode;
  tabVisible: boolean;
  activeLeafId: number;
  blocks: boolean;
  gatewayRoutes?: GatewayRoutes;
  onFocusLeaf: (leafId: number) => void;
  getBundle: (leafId: number) => LeafBundle;
};

export function PaneTreeView(props: Props) {
  const { node } = props;
  if (node.kind === "leaf") {
    const { tabVisible, activeLeafId, blocks, onFocusLeaf, getBundle } = props;
    const focused = node.id === activeLeafId;
    const b = getBundle(node.id);
    return (
      <section
        aria-label="Terminal pane"
        onMouseDownCapture={() => {
          if (!focused) onFocusLeaf(node.id);
          // Take DOM focus every time, not only when the ACTIVE leaf changes.
          // `onFocusLeaf` moves React state and nothing else, so clicking the
          // terminal that was already active did nothing at all - and after a
          // menu, a tab or a dialog had taken focus away, that is exactly the
          // click that was supposed to bring it back. It took two.
          focusSlot(node.id);
        }}
        // Catches focus from Tab, programmatic focus, or any path that
        // skips mousedown — keeps activeLeafId in sync with DOM focus.
        onFocus={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        data-pane-leaf={node.id}
        className="relative h-full w-full"
      >
        <TerminalPane
          workspace={props.workspace}
          leafId={node.id}
          visible={tabVisible}
          focused={focused}
          initialCwd={node.cwd}
          blocks={blocks}
          gatewayRoutes={props.gatewayRoutes}
          ref={b.setRef}
          onCwd={b.onCwd}
          onExit={b.onExit}
        />
        <DropOverlay leafId={node.id} />
      </section>
    );
  }

  return (
    <ResizablePanelGroup
      orientation={node.dir === "row" ? "horizontal" : "vertical"}
    >
      {node.children.map((child, i) => {
        const slotId = firstLeafSlotId(child);
        return (
          <Fragment key={slotId}>
            {i > 0 && <ResizableHandle />}
            <ResizablePanel id={`pane-slot-${slotId}`} minSize="10%">
              <PaneTreeView {...props} node={child} />
            </ResizablePanel>
          </Fragment>
        );
      })}
    </ResizablePanelGroup>
  );
}

function DropOverlay({ leafId }: { leafId: number }) {
  const active = useTerminalDropStore((s) => s.targetLeafId === leafId);
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-lg border border-primary/45 bg-background/70 text-xs font-medium text-foreground shadow-lg backdrop-blur-sm">
      Drop file path here
    </div>
  );
}
