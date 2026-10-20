import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { GitBranchEntry } from "@/lib/native";
import { FolderOpenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { errorToast } from "@/lib/errorToast";
import { toast } from "sonner";
import { defaultWorktreePath, gitWorktreeAdd } from "./worktreeOps";
import {
  currentWorkspaceScopeKey,
  LOCAL_WORKSPACE,
  workspaceScopeKey,
} from "@/modules/workspace";

/**
 * Add a linked worktree: pick a target path and an existing branch, or give a
 * new branch name so the new branch is created and checked out there.
 */
export function WorktreeDialog({
  open,
  onOpenChange,
  repoRoot,
  repoName,
  branches,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoRoot: string;
  repoName: string;
  branches: GitBranchEntry[];
  onCreated: () => void;
}) {
  const workspace = LOCAL_WORKSPACE;
  const scope = workspaceScopeKey(workspace);
  const identity = JSON.stringify([open, repoRoot, scope]);
  const identityRef = useRef(identity);
  const epochRef = useRef(0);
  if (identityRef.current !== identity) epochRef.current++;
  identityRef.current = identity;
  const epoch = epochRef.current;
  const aliveRef = useRef(false);
  const busyRef = useRef(false);
  const initializedRef = useRef<string | null>(null);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  // The checked-out branch cannot be shared with a linked worktree ("already
  // checked out"), so it is not pickable; with nothing else left the Select
  // disables and `git worktree add <path>` auto-creates a fresh branch.
  const pickable = branches.filter(
    (b) => b.kind === "local" && !b.isHead && !b.name.startsWith("("),
  );
  const defaultBranch = pickable[0]?.name ?? "";
  const [path, setPath] = useState("");
  const [branchName, setBranchName] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [pathTouched, setPathTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      initializedRef.current = null;
      return;
    }
    if (initializedRef.current === identity) return;
    initializedRef.current = identity;
    setBranchName(defaultBranch);
    setPath(defaultWorktreePath(repoRoot, defaultBranch));
    setNewBranch("");
    setPathTouched(false);
    setBusy(busyRef.current);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open, repoRoot, defaultBranch, identity]);

  const selectBranch = (name: string) => {
    setBranchName(name);
    if (!pathTouched) setPath(defaultWorktreePath(repoRoot, name));
  };

  const submit = async () => {
    const target = path.trim();
    const created = newBranch.trim();
    if (
      !target ||
      busyRef.current ||
      !open ||
      !aliveRef.current ||
      identityRef.current !== identity ||
      epochRef.current !== epoch ||
      currentWorkspaceScopeKey() !== scope
    )
      return;
    busyRef.current = true;
    setBusy(true);
    try {
      await gitWorktreeAdd(
        repoRoot,
        target,
        {
          branch: created || undefined,
          commit: branchName || undefined,
        },
        workspace,
      );
      if (
        !aliveRef.current ||
        identityRef.current !== identity ||
        epochRef.current !== epoch ||
        currentWorkspaceScopeKey() !== scope
      )
        return;
      toast.success(
        created
          ? `Created worktree for ${created} in ${repoName}`
          : `Created worktree in ${repoName}`,
      );
      onOpenChange(false);
      onCreated();
    } catch (e) {
      if (
        aliveRef.current &&
        identityRef.current === identity &&
        epochRef.current === epoch
      )
        errorToast(`Could not create worktree in ${repoName}`, e);
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex gap-1.75">
            <HugeiconsIcon icon={FolderOpenIcon} size={16} strokeWidth={1.75} />
            New worktree
          </AlertDialogTitle>
          <AlertDialogDescription>
            Add a linked worktree for {repoName}. Its files live in a separate
            directory that shares the same .git.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label
              htmlFor="worktree-path"
              className="text-xs text-muted-foreground"
            >
              Target path
            </Label>
            <Input
              id="worktree-path"
              ref={inputRef}
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setPathTouched(true);
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229
                ) {
                  e.preventDefault();
                  void submit();
                }
              }}
              className="font-mono"
              placeholder="/path/to/worktree"
            />
          </div>
          <div className="grid gap-1.5">
            <Label
              htmlFor="worktree-branch"
              className="text-xs text-muted-foreground"
            >
              Branch
            </Label>
            <Select
              value={branchName}
              onValueChange={selectBranch}
              disabled={pickable.length === 0}
            >
              <SelectTrigger
                id="worktree-branch"
                className="w-full rounded-lg text-xs"
              >
                <SelectValue placeholder="No local branches" />
              </SelectTrigger>
              <SelectContent>
                {pickable.map((b) => (
                  <SelectItem key={b.name} value={b.name} className="text-xs">
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label
              htmlFor="worktree-new-branch"
              className="text-xs text-muted-foreground"
            >
              New branch (optional)
            </Label>
            <Input
              id="worktree-new-branch"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.nativeEvent.isComposing &&
                  e.keyCode !== 229
                ) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="feature/from-worktree"
            />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            disabled={busy || path.trim().length === 0}
            onClick={() => void submit()}
          >
            {busy ? <Spinner className="size-3" /> : "Create"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
