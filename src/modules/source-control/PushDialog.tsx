import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useRef, useState } from "react";
import { useRepositoryOperation } from "@/modules/source-control/useRepositoryOperation";
import { DialogSyncProgress } from "./DialogSyncProgress";
import { gitDialogLayout } from "./gitDialogLayout";
import { parseUpstreamRemote } from "./remoteHelpers";
import type {
  PushAdvancedOptions,
  PushAllResult,
  PushPlan,
  PushPlanCommitDiff,
  SyncProgress,
} from "./useMultiRepoSourceControl";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: PushPlan | null;
  onPush: (
    plan: PushPlan,
    options: PushAdvancedOptions,
  ) => Promise<PushAllResult>;
  syncProgress?: SyncProgress | null;
};

function PushCommitDiff({ diff }: { diff: PushPlanCommitDiff }) {
  return (
    <div className="ml-5 mt-1">
      {diff.diffText ? (
        <pre className="max-h-48 overflow-y-auto rounded-md bg-muted/40 p-2 font-mono text-[10px] leading-snug whitespace-pre-wrap wrap-anywhere text-foreground/85">
          {diff.diffText}
        </pre>
      ) : (
        <div className="text-[10.5px] text-muted-foreground/60">
          Patch unavailable.
        </div>
      )}
      {diff.truncated ? (
        <div className="mt-0.5 text-[10px] text-muted-foreground/60">
          Patch truncated.
        </div>
      ) : null}
    </div>
  );
}

export function PushDialog({
  open,
  onOpenChange,
  plan,
  onPush,
  syncProgress,
}: Props) {
  const [options, setOptions] = useState({ force: false });
  // Commit patches currently unfolded, keyed by repo:sha.
  const [expandedDiffs, setExpandedDiffs] = useState<Set<string>>(new Set());
  const planRef = useRef({ plan, generation: 0 });
  if (planRef.current.plan !== plan)
    planRef.current = { plan, generation: planRef.current.generation + 1 };
  const {
    busy: running,
    run,
    scopeKey,
  } = useRepositoryOperation(
    open && !!plan,
    String(planRef.current.generation),
  );
  const forceId = useId();
  const [failed, setFailed] = useState<PushAllResult["failed"]>([]);
  const [rejected, setRejected] = useState<PushAllResult["rejected"]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset confirmation state when its workspace changes.
  useEffect(() => {
    if (!open || !plan) return;
    setOptions({ force: false });
    setFailed([]);
    setRejected([]);
    setExpandedDiffs(
      new Set(
        plan.entries.flatMap((e) =>
          e.diffs[0] ? [`${e.repoRoot}:${e.diffs[0].sha}`] : [],
        ),
      ),
    );
  }, [open, plan, scopeKey]);

  const count = plan?.entries.length ?? 0;
  const anyForceNeeded =
    plan?.entries.some((e) => (e.behind ?? 0) > 0) ?? false;
  const canPush = count > 0 && !running && failed.length === 0;

  const confirmPush = async () => {
    if (!plan || !canPush) return;
    await run(
      () => onPush(plan, { ...options, noVerify: false, tags: "none" }),
      (result) => {
        setRejected(result.rejected);
        setFailed(result.failed);
        if (result.failed.length === 0) onOpenChange(false);
      },
      "Could not push repositories",
    );
  };

  const retryWithForce = async (repoRoot: string) => {
    if (!plan || !rejected.some((item) => item.repoRoot === repoRoot)) return;
    const entry = plan.entries.find((item) => item.repoRoot === repoRoot);
    if (!entry) return;
    await run(
      () =>
        onPush(
          { ...plan, entries: [entry] },
          { ...options, force: true, noVerify: false, tags: "none" },
        ),
      (result) => {
        const remaining = [
          ...failed.filter((item) => item.repoRoot !== repoRoot),
          ...result.failed,
        ];
        setFailed(remaining);
        setRejected([
          ...rejected.filter((item) => item.repoRoot !== repoRoot),
          ...result.rejected,
        ]);
        if (remaining.length === 0) onOpenChange(false);
      },
      "Could not force push repository",
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(gitDialogLayout.content, "sm:max-w-2xl")}
        showCloseButton={!running}
        onEscapeKeyDown={(event) => {
          if (running) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (running) event.preventDefault();
        }}
      >
        <DialogHeader className="min-w-0 shrink-0 pr-9">
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon icon={ArrowUp01Icon} size={15} strokeWidth={1.9} />
            {count > 0
              ? `Push to ${count} ${count === 1 ? "repository" : "repositories"}?`
              : "Nothing to push"}
          </DialogTitle>
          <DialogDescription>
            {count > 0
              ? "Repositories are pushed one at a time, in this order. Expand a commit to see its patch."
              : "No repository has local commits ready for its upstream."}
          </DialogDescription>
        </DialogHeader>

        <div className={cn(gitDialogLayout.body, "space-y-3")}>
          {count > 0 ? (
            <div className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <label
                    htmlFor={forceId}
                    className={cn(
                      "flex min-w-0 cursor-pointer items-center gap-1.5 text-[10.5px]",
                      anyForceNeeded
                        ? "text-muted-foreground"
                        : "cursor-not-allowed text-muted-foreground/50",
                    )}
                  >
                    <Checkbox
                      id={forceId}
                      aria-label="Force push with --force-with-lease"
                      checked={options.force}
                      disabled={running || !anyForceNeeded}
                      onCheckedChange={(checked) =>
                        setOptions((current) => ({
                          ...current,
                          force: checked === true,
                        }))
                      }
                      className="size-3.5 shrink-0"
                    />
                    Force push (--force-with-lease)
                  </label>
                </TooltipTrigger>
                {!anyForceNeeded ? (
                  <TooltipContent
                    side="bottom"
                    className="max-w-56 border border-border/70 bg-zinc-950 text-[10.5px] text-zinc-100"
                  >
                    Repositories are strictly ahead of their remotes; force push
                    has nothing to force. If a push is rejected, the progress
                    list offers Force push.
                  </TooltipContent>
                ) : null}
              </Tooltip>
            </div>
          ) : null}

          <div className="min-w-0">
            {plan?.entries.map((entry) => {
              const upstreamRemote =
                entry.remote ?? parseUpstreamRemote(entry.upstream);
              return (
                <div
                  key={entry.repoRoot}
                  className="mb-2 rounded-lg border border-border/50 px-2.5 py-2"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="min-w-0 text-[12px] font-medium">
                      {entry.name}
                    </span>
                    <span className="min-w-0 text-[10.5px] text-muted-foreground">
                      {entry.branch} → {entry.upstream}
                    </span>
                    <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      ↑{entry.ahead}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
                    <span className="text-[10px] text-muted-foreground/70">
                      Push to
                    </span>
                    <span className="min-w-0 text-[10.5px] text-muted-foreground/60">
                      {upstreamRemote ?? "No tracking remote"}
                    </span>
                  </div>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {entry.commits.map((c) => {
                      const diff = entry.diffs.find((d) => d.sha === c.sha);
                      const diffKey = `${entry.repoRoot}:${c.sha}`;
                      const expanded = expandedDiffs.has(diffKey);
                      return (
                        <li key={c.sha} className="text-[10.5px]">
                          <div className="flex items-baseline gap-2">
                            <button
                              type="button"
                              disabled={!diff}
                              onClick={() => {
                                if (!diff) return;
                                setExpandedDiffs((current) => {
                                  const next = new Set(current);
                                  if (next.has(diffKey)) next.delete(diffKey);
                                  else next.add(diffKey);
                                  return next;
                                });
                              }}
                              className={cn(
                                "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded text-left disabled:cursor-default disabled:opacity-40",
                                "transition-colors hover:bg-foreground/5",
                              )}
                              title={diff ? "Show patch" : "No patch available"}
                            >
                              <HugeiconsIcon
                                icon={ArrowUp01Icon}
                                size={9}
                                strokeWidth={2}
                                className={cn(
                                  "shrink-0 text-muted-foreground transition-transform",
                                  expanded && "rotate-180",
                                )}
                              />
                              <code className="text-muted-foreground/70">
                                {c.shortSha}
                              </code>
                            </button>
                            <span className="min-w-0 flex-1">{c.subject}</span>
                          </div>
                          {expanded && diff ? (
                            <PushCommitDiff diff={diff} />
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  {entry.moreCommits > 0 ? (
                    <div className="mt-1 text-[10px] text-muted-foreground/60">
                      +{entry.moreCommits} more{" "}
                      {entry.moreCommits === 1 ? "commit" : "commits"} pushed
                      (patch not shown)
                    </div>
                  ) : null}
                </div>
              );
            })}
            {plan && plan.skipped.length > 0 ? (
              <div className="mt-1 rounded-lg bg-muted/40 px-2.5 py-2">
                <div className="mb-1 text-[10.5px] font-medium text-muted-foreground">
                  Skipped
                </div>
                <ul className="flex flex-col gap-0.5">
                  {plan.skipped.map((sk) => (
                    <li
                      key={sk.name}
                      className="flex items-baseline gap-2 text-[10.5px] text-muted-foreground"
                    >
                      <span className="min-w-0 flex-1">{sk.name}</span>
                      <span className="min-w-0 max-w-[60%] text-right">
                        {sk.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {syncProgress && syncProgress.items.length > 0 ? (
            <DialogSyncProgress progress={syncProgress} />
          ) : null}
          {failed.length > 0 ? (
            <div
              className="rounded-lg border border-destructive/30 p-2 text-[11px]"
              role="status"
            >
              <p className="mb-1 text-muted-foreground">
                Some repositories were not pushed. Close and review a new plan
                before retrying.
              </p>
              {failed.map((item) => (
                <div key={item.repoRoot} className="mb-1">
                  <p className="select-text whitespace-pre-wrap text-destructive">
                    {item.repoRoot}: {item.error}
                  </p>
                  {rejected.some(
                    (rejection) => rejection.repoRoot === item.repoRoot,
                  ) ? (
                    <Button
                      size="xs"
                      variant="outline"
                      className="h-auto min-h-6 max-w-full whitespace-normal"
                      disabled={running}
                      onClick={() => void retryWithForce(item.repoRoot)}
                    >
                      Force push (--force-with-lease)
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <DialogFooter className={gitDialogLayout.footer}>
          <Button
            variant="ghost"
            disabled={running}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={!canPush} onClick={() => void confirmPush()}>
            {running ? (
              <>
                <Spinner className="size-3" />
                Pushing…
              </>
            ) : (
              `Push ${count}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
