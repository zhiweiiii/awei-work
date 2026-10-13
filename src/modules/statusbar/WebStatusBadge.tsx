import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorToast } from "@/lib/errorToast";
import { native, type WebStatus } from "@/lib/native";
import { Key01Icon, RouterIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";

const POLL_MS = 2000;

export function WebStatusBadge() {
  const [status, setStatus] = useState<WebStatus | null>(null);
  const [error, setError] = useState(false);
  const opening = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const s = await native.webStatus();
        if (!disposed) {
          setStatus(s);
          setError(false);
        }
      } catch {
        if (!disposed) {
          setStatus(null);
          setError(true);
        }
      }
      if (!disposed) timer = window.setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      mounted.current = false;
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const running = status?.running ?? false;
  const count = status?.connections ?? 0;
  const failedLogins = status?.failed_logins ?? 0;
  const openMobilePage = async () => {
    if (!running || opening.current) return;
    opening.current = true;
    try {
      const current = await native.webStatus();
      if (!mounted.current) return;
      if (!current.running) {
        setStatus(current);
        throw new Error("远程服务未启动");
      }
      if (
        !Number.isInteger(current.port) ||
        current.port < 1 ||
        current.port > 65535
      ) {
        throw new Error("远程服务端口无效");
      }
      await openUrl(`http://127.0.0.1:${current.port}/`);
    } catch (cause) {
      if (mounted.current) errorToast("打开手机端网页失败", cause);
    } finally {
      opening.current = false;
    }
  };
  const description =
    status === null
      ? error
        ? "远程服务状态暂不可用"
        : "正在读取远程服务状态"
      : running
        ? `远程服务运行中，当前连接 ${count} 个${failedLogins > 0 ? `，密码错误 ${failedLogins} 次` : ""}，点击打开手机端网页`
        : "远程服务未启动";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={description}
          aria-disabled={!running}
          onClick={() => void openMobilePage()}
          className={`terax-pill-in ml-1.5 flex h-6 shrink-0 ${running ? "cursor-pointer hover:text-foreground" : "cursor-default"} items-center gap-1 rounded-full border border-border/50 bg-accent/50 px-2 text-[10.5px] font-medium text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring`}
        >
          {running ? (
            <span className="size-1.5 rounded-full bg-emerald-500" />
          ) : (
            <span
              className={`size-1.5 rounded-full ${status === null ? "bg-amber-500" : "bg-destructive"}`}
            />
          )}
          <HugeiconsIcon icon={RouterIcon} size={11} strokeWidth={2} />
          <span>{status === null ? "?" : count}</span>
          {failedLogins > 0 ? (
            <span className="flex items-center gap-0.5 text-amber-500">
              <HugeiconsIcon icon={Key01Icon} size={10} strokeWidth={2} />
              <span>{failedLogins}</span>
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-64 text-[11px] leading-relaxed"
      >
        {description}
      </TooltipContent>
    </Tooltip>
  );
}
