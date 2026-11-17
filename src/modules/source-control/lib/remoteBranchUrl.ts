import type { GitBranchEntry, GitRemoteEntry } from "@/lib/native";
import { parseRemoteWebUrl } from "@/modules/git-history/lib/remoteWebUrl";

export function remoteBranchUrl(
  branch: GitBranchEntry,
  remotes: readonly GitRemoteEntry[],
): { url: string; ref: string; inferred: boolean } {
  if (branch.isDetached)
    throw new Error("当前处于分离 HEAD，没有对应的远程分支");
  const tracking = branch.kind === "remote" ? branch.name : branch.upstream;
  const remote = tracking
    ? [...remotes]
        .sort((a, b) => b.name.length - a.name.length)
        .find((item) => tracking.startsWith(`${item.name}/`))
    : (remotes.find((item) => item.name === "origin") ??
      (remotes.length === 1 ? remotes[0] : undefined));
  if (!remote)
    throw new Error(
      tracking
        ? "找不到该上游对应的远程仓库"
        : "当前分支未设置上游，且无法确定远程仓库",
    );
  const name = tracking ? tracking.slice(remote.name.length + 1) : branch.name;
  if (!name || name === "HEAD") throw new Error("无法确定远程分支名称");
  const info = parseRemoteWebUrl(remote.url);
  if (!info)
    throw new Error(
      "暂不支持该托管平台的分支网页地址，可在远程仓库管理中查看仓库地址",
    );
  const path =
    info.host === "gitlab"
      ? "/-/tree/"
      : info.host === "bitbucket"
        ? "/src/"
        : "/tree/";
  return {
    url: `${info.baseUrl}${path}${encodeURIComponent(name)}`,
    ref: `${remote.name}/${name}`,
    inferred: !tracking,
  };
}
