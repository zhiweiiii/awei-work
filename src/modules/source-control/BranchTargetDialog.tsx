import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState } from "react";

export const BRANCH_TARGET_LABELS = {
  merge: "合并",
  rebase: "变基到",
  compare: "比较",
} as const;

export type BranchTargetAction = keyof typeof BRANCH_TARGET_LABELS;

export function BranchTargetDialog({
  action,
  current,
  repoName,
  targets,
  onClose,
  onSelect,
}: {
  action: BranchTargetAction;
  current: string;
  repoName: string;
  targets: string[];
  onClose: () => void;
  onSelect: (target: string) => void;
}) {
  const [target, setTarget] = useState("");
  const label = BRANCH_TARGET_LABELS[action];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{label} · 选择目标分支</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {repoName} · 当前分支 {current}
          </DialogDescription>
        </DialogHeader>
        {targets.length > 0 ? (
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger aria-label="目标本地分支" className="w-full min-w-0">
              <SelectValue placeholder="选择目标本地分支" />
            </SelectTrigger>
            <SelectContent>
              {targets.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-sm text-muted-foreground">
            当前仓库没有其他本地分支可选。
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {targets.length > 0 ? "取消" : "关闭"}
          </Button>
          {targets.length > 0 ? (
            <Button
              disabled={!targets.includes(target)}
              onClick={() => onSelect(target)}
            >
              {action === "rebase" ? "变基" : label}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
