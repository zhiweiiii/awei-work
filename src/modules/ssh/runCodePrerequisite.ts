export type CodeTask = {
  taskId: string;
  id: string;
  phase: string;
  message: string;
};

type Operations = {
  subscribe: (accept: (task: CodeTask) => void) => Promise<() => void>;
  start: () => Promise<string | null>;
  cancel: (taskId: string) => Promise<unknown>;
};

export async function runCodePrerequisite(
  id: string,
  signal: AbortSignal,
  operations: Operations,
): Promise<void> {
  if (signal.aborted) throw new Error("已取消分组前置执行");
  let taskId: string | null = null;
  const terminal = new Map<string, CodeTask>();
  let resolve!: (task: CodeTask) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<CodeTask>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  void completion.catch(() => {});
  const aborted = () => reject(new Error("已取消分组前置执行"));
  signal.addEventListener("abort", aborted, { once: true });
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    unsubscribe = await operations.subscribe((task) => {
      if (
        task.id !== id ||
        !["done", "failed", "cancelled"].includes(task.phase)
      )
        return;
      terminal.set(task.taskId, task);
      if (task.taskId === taskId) resolve(task);
    });
    if (signal.aborted) throw new Error("已取消分组前置执行");
    taskId = await operations.start();
    if (!taskId || !/^[a-f0-9]{32}$/.test(taskId))
      throw new Error("前置代码未返回有效的执行任务");
    if (signal.aborted) throw new Error("已取消分组前置执行");
    const finished = terminal.get(taskId);
    if (finished) resolve(finished);
    timer = setTimeout(
      () => reject(new Error("等待前置代码结果超时，请检查执行状态后重试")),
      310_000,
    );
    const task = await completion;
    if (signal.aborted) throw new Error("已取消分组前置执行");
    if (task.phase !== "done")
      throw new Error(task.message || "分组前置代码未成功完成");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", aborted);
    unsubscribe?.();
    if (signal.aborted && taskId) await operations.cancel(taskId);
  }
}
