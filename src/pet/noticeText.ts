import { labelOf, type Notice, type PetSession } from "./agents";

function excerpt(text: string, limit: number): string {
  const plain = text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\s+/g, " ")
    .trim();
  const first = plain.split(/[。！？]|[!?](?:\s|$)|\.(?=\s+\S)/, 1)[0] ?? "";
  const chars = Array.from(first.replace(/[，,;；:：.。!！?？]+$/, ""));
  return chars.length > limit
    ? `${chars.slice(0, limit - 1).join("")}…`
    : chars.join("");
}

export function noticeSentence(session: PetSession, notice: Notice): string {
  const project = excerpt(labelOf(session), 22) || "这个项目";
  const detail = excerpt(notice.text, 64);
  if (notice.kind === "attention") return `${project} 在等你确认，点开看看。`;
  if (notice.failed)
    return `${project} 这一步遇到了问题${detail ? `：${detail}` : ""}。`;
  if (notice.kind === "finished")
    return !detail || detail === "点击查看本轮结果"
      ? `${project} 这轮结束了，点开看看结果。`
      : `${project} 这轮结束了，${detail}。`;
  if (notice.kind === "working") return `${project} 开始处理了。`;
  const action = excerpt(notice.title, 18);
  if (action && action !== "正在处理")
    return `${project} ${action}${detail ? `：${detail}` : ""}。`;
  return detail && detail !== "正在处理你的任务"
    ? `${project} 有新进展：${detail}。`
    : `${project} 还在处理中。`;
}
