import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorToast } from "@/lib/errorToast";

type IndexCache = {
  id: string;
  projectRoot: string | null;
  path: string;
  bytes: number;
  files: number;
  lastUsedAt: number | null;
  indexedAt: number | null;
  active: boolean;
};

function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KiB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function title(entry: IndexCache): string {
  if (entry.id === "shared") return "公共依赖索引";
  return (
    entry.projectRoot?.split(/[\\/]/).pop() ||
    `旧项目缓存 ${entry.id.slice(0, 8)}`
  );
}

export function JavaIndexCaches() {
  const [entries, setEntries] = useState<IndexCache[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<IndexCache | null>(null);
  const [deleting, setDeleting] = useState(false);
  const busy = useRef(false);
  const revision = useRef(0);
  const reload = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true);
    setError(false);
    try {
      const result = await invoke<IndexCache[]>("lsp_java_caches");
      if (request === revision.current) setEntries(result);
    } catch (error) {
      if (request === revision.current) {
        setError(true);
        errorToast("读取 Java 索引缓存失败", error);
      }
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    return () => {
      revision.current++;
    };
  }, [reload]);

  const remove = async () => {
    if (!selected || busy.current) return;
    busy.current = true;
    setDeleting(true);
    revision.current++;
    try {
      await invoke("lsp_java_cache_delete", { id: selected.id });
      setSelected(null);
      await reload();
    } catch (error) {
      errorToast("删除 Java 索引缓存失败", error);
    } finally {
      busy.current = false;
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Java 索引缓存</Label>
        <div className="flex items-center gap-3">
          {!loading && !error && (
            <span className="text-xs text-muted-foreground">
              共 {size(entries.reduce((sum, entry) => sum + entry.bytes, 0))}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={loading || deleting}
            onClick={() => void reload()}
          >
            刷新
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        启用 Java
        语言服务后，首次打开项目自动准备索引，完成后持久保存；再次打开复用缓存，共同依赖跨项目共享。
      </p>
      {loading ? (
        <p className="py-3 text-xs text-muted-foreground">正在读取缓存…</p>
      ) : error ? (
        <p className="py-3 text-xs text-destructive">读取失败，请重试刷新。</p>
      ) : entries.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">
          暂无 Java 索引缓存。
        </p>
      ) : (
        <div className="max-h-80 overflow-y-auto rounded-md border divide-y">
          {entries.map((entry) => (
            <div key={entry.id} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="truncate" title={title(entry)}>
                    {title(entry)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {entry.active
                      ? "使用中"
                      : entry.indexedAt || entry.id === "shared"
                        ? "已缓存"
                        : "待确认"}
                  </span>
                </div>
                <p
                  className="truncate text-xs text-muted-foreground"
                  title={entry.projectRoot ?? entry.path}
                >
                  {entry.projectRoot ?? entry.path}
                </p>
                <p className="text-xs text-muted-foreground">
                  {size(entry.bytes)} · {entry.files} 个文件
                  {entry.indexedAt
                    ? ` · 索引于 ${new Date(entry.indexedAt).toLocaleString()}`
                    : entry.id !== "shared"
                      ? " · 打开项目后更新索引信息"
                      : ""}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={deleting}
                onClick={() => setSelected(entry)}
                aria-label={`删除${title(entry)}`}
              >
                删除
              </Button>
            </div>
          ))}
        </div>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !busy.current) setSelected(null);
        }}
      >
        <DialogContent showCloseButton={!deleting}>
          <DialogHeader>
            <DialogTitle>删除索引缓存</DialogTitle>
            <DialogDescription>
              删除“{selected ? title(selected) : ""}
              ”的索引缓存，不影响项目文件。若缓存正在使用，会先停止相关 Java
              语言服务；下次重新打开项目或 Java 文件时重建。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleting}
              onClick={() => setSelected(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void remove()}
            >
              {deleting ? "正在删除…" : "删除缓存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
