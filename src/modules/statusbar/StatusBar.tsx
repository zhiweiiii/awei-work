import { Button } from "@/components/ui/button";
import { Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getVersion } from "@tauri-apps/api/app";
import { type ReactNode, useEffect, useState } from "react";
import { ClaudeProviderButton } from "./ClaudeProviderButton";
import { ClaudeUsageButton } from "./ClaudeUsageButton";
import { PetToggle } from "./PetToggle";
import { ScheduleButton } from "./ScheduleButton";
import { WebStatusBadge } from "./WebStatusBadge";
import { LspStatusPill } from "@/modules/lsp";

type Props = {
  windowBar: ReactNode;
  onOpenSettings: () => void;
  /** The terminal a queued command runs in. Null when there is none. */
  activeLeafId?: number | null;
  activeFilePath?: string | null;
};

export function StatusBar({
  windowBar,
  onOpenSettings,
  activeLeafId,
  activeFilePath,
}: Props) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getVersion()
      .then((value) => {
        if (alive) setVersion(value);
      })
      .catch((error) => {
        if (alive) console.warn("[awei-work] version query failed:", error);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <footer className="flex min-h-8 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/60 bg-card/60 py-0.5 pl-3 pr-4 text-[11px]">
      <div className="flex min-w-0 flex-1 basis-60 items-center gap-2">
        {windowBar}
      </div>
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
        <LspStatusPill filePath={activeFilePath ?? null} />
        <PetToggle />
        <ClaudeUsageButton />
        <ClaudeProviderButton leafId={activeLeafId ?? null} />
        <ScheduleButton leafId={activeLeafId ?? null} />
        <WebStatusBadge />
        <span
          className="select-text px-1 text-[10px] tabular-nums text-muted-foreground"
          title="awei-work 版本"
        >
          v{version ?? "--"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onOpenSettings}
          title="Settings"
        >
          <HugeiconsIcon icon={Settings01Icon} size={13} strokeWidth={1.75} />
        </Button>
      </div>
    </footer>
  );
}
