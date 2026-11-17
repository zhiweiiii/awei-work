import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorToast } from "@/lib/errorToast";
import { native, type GitBranchEntry } from "@/lib/native";
import { useAsyncQuery } from "@/modules/command-palette/hooks/useAsyncQuery";
import { remoteBranchUrl } from "@/modules/source-control/lib/remoteBranchUrl";
import { LOCAL_WORKSPACE, workspaceScopeKey } from "@/modules/workspace";
import { Copy01Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback } from "react";
import { toast } from "sonner";

export function RemoteBranchUrlDialog({
  open,
  onOpenChange,
  repoRoot,
  repoName,
  branch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoRoot: string;
  repoName: string;
  branch: GitBranchEntry | null;
}) {
  const workspace = LOCAL_WORKSPACE;
  const run = useCallback(
    async () =>
      branch
        ? [
            remoteBranchUrl(
              branch,
              await native.gitRemoteList(repoRoot, workspace),
            ),
          ]
        : [],
    [repoRoot, branch],
  );
  const { results, loading, error, retry } = useAsyncQuery({
    enabled: open && branch !== null,
    term: "",
    minLength: 0,
    debounceMs: 0,
    run,
    scopeKey: JSON.stringify([
      repoRoot,
      branch?.name,
      branch?.upstream,
      workspaceScopeKey(workspace),
    ]),
  });
  const target = results[0];
  const copy = async () => {
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.url);
      toast.success("已复制远程分支地址");
    } catch (error) {
      errorToast("复制远程分支地址失败", error);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>远程分支地址</DialogTitle>
          <DialogDescription>
            {repoName} · {branch?.name}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div
            role="status"
            className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground"
          >
            <Spinner className="size-3" />
            读取远程仓库中…
          </div>
        ) : error ? (
          <div className="grid gap-2 text-xs">
            <p className="text-destructive">{error}</p>
            <Button
              variant="ghost"
              size="sm"
              className="justify-self-start"
              onClick={retry}
            >
              重试
            </Button>
          </div>
        ) : target ? (
          <div className="grid min-w-0 gap-3">
            <p className="break-all text-xs text-muted-foreground">
              {target.ref}
            </p>
            <Input
              aria-label="远程分支地址"
              readOnly
              value={target.url}
              onFocus={(event) => event.currentTarget.select()}
              className="font-mono text-xs"
            />
            {target.inferred && (
              <p className="text-xs text-muted-foreground">
                未设置上游，按远程仓库和当前分支名生成；请确认该分支已推送。
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void openUrl(target.url).catch((error) =>
                    errorToast("打开远程分支失败", error),
                  )
                }
              >
                <HugeiconsIcon icon={LinkSquare02Icon} size={13} />
                浏览器打开
              </Button>
              <Button size="sm" onClick={() => void copy()}>
                <HugeiconsIcon icon={Copy01Icon} size={13} />
                复制地址
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
