import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  currentWorkspaceScopeKey,
  LOCAL_WORKSPACE,
  workspaceScopeKey,
} from "@/modules/workspace";
import { File02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rootPath: string | null;
  onCreated: (path: string) => void;
};

function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/")) return `${parent}${name}`;
  return `${parent}/${name}`;
}

export function NewEditorDialog({
  open,
  onOpenChange,
  rootPath,
  onCreated,
}: Props) {
  const [name, setName] = useState("untitled.txt");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const composingRef = useRef(false);
  const workspace = LOCAL_WORKSPACE;
  const scopeKey = workspaceScopeKey(workspace);
  const identity = open ? `${scopeKey}\0${rootPath}` : null;
  const scopeRef = useRef({ identity });
  if (scopeRef.current.identity !== identity) scopeRef.current = { identity };
  const scope = scopeRef.current;
  const mountedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!identity) return;
    setName("untitled.txt");
    setError(null);
    // Pre-select the basename so the user can quickly retype the filename
    // while keeping the extension handy.
    const timer = setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const dot = el.value.lastIndexOf(".");
      el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
    }, 0);
    return () => clearTimeout(timer);
  }, [identity]);

  const submit = async () => {
    if (
      !open ||
      busyRef.current ||
      !mountedRef.current ||
      scopeRef.current !== scope ||
      currentWorkspaceScopeKey() !== scopeKey
    )
      return;
    const trimmed = name.trim().replace(/\\/g, "/");
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    if (
      trimmed.startsWith("/") ||
      /^[A-Za-z]:/.test(trimmed) ||
      /[\u0000-\u001f]/.test(trimmed) ||
      trimmed.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      setError("Path must be relative");
      return;
    }
    if (!rootPath) {
      setError("No workspace root");
      return;
    }
    const path = joinPath(rootPath.replace(/\\/g, "/"), trimmed);
    busyRef.current = true;
    setBusy(true);
    const current = () =>
      mountedRef.current &&
      scopeRef.current === scope &&
      currentWorkspaceScopeKey() === scopeKey;
    try {
      await invoke("fs_create_file", {
        path,
        workspace,
      });
      if (!current()) return;
      onCreated(path);
      onOpenChange(false);
    } catch (e) {
      if (current()) setError(String(e));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex gap-1.75">
            <HugeiconsIcon icon={File02Icon} size={16} strokeWidth={1.75} />
            New file
          </DialogTitle>
          <DialogDescription>
            Filename (relative to workspace root). The extension determines the
            language mode.
          </DialogDescription>
        </DialogHeader>
        <Input
          ref={inputRef}
          aria-label="Filename"
          value={name}
          disabled={busy}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !composingRef.current &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="example.ts"
        />
        {error ? (
          <div role="alert" className="text-xs text-destructive">
            {error}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground truncate">
            {rootPath ? joinPath(rootPath, name.trim() || "...") : "..."}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
