import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export function ConnectionContextMenu({
  children,
  code,
  connected,
  connecting,
  running,
  disabled,
  onOpen,
  onFiles,
  onCancel,
  onDisconnect,
  onEdit,
  onDelete,
  onStop,
}: {
  children: ReactNode;
  code: boolean;
  connected: boolean;
  connecting: boolean;
  running: boolean;
  disabled: boolean;
  onOpen: () => void;
  onFiles: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onStop: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-36">
        <ContextMenuItem
          disabled={disabled || connecting || (code && running)}
          onSelect={onOpen}
        >
          {code ? "执行代码" : connected ? "打开终端" : "连接"}
        </ContextMenuItem>
        {connecting && (
          <ContextMenuItem onSelect={onCancel}>取消连接</ContextMenuItem>
        )}
        {connected && (
          <>
            <ContextMenuItem onSelect={onFiles}>文件传输</ContextMenuItem>
            <ContextMenuItem disabled={disabled} onSelect={onDisconnect}>
              断开
            </ContextMenuItem>
          </>
        )}
        {code && running && (
          <ContextMenuItem onSelect={onStop}>停止执行</ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem disabled={disabled} onSelect={onEdit}>
          编辑
        </ContextMenuItem>
        <ContextMenuItem
          disabled={disabled}
          className="text-destructive"
          onSelect={onDelete}
        >
          删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
