import type { SourceControlFileEntry } from "@/modules/source-control/useSourceControlPanel";

export function folderStagePlan(
  files: readonly SourceControlFileEntry[],
  repoRoot: string,
  path: string,
) {
  if (!repoRoot || !path) return null;
  const prefix = `${path.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  const entries = files.filter(
    (entry) =>
      entry.repoRoot === repoRoot &&
      entry.path.replace(/\\/g, "/").startsWith(prefix),
  );
  if (!entries.length) return null;
  const unstage = entries.every((entry) => entry.checkState === "checked");
  const paths = [
    ...new Set(
      entries
        .filter((entry) => (unstage ? entry.staged : entry.unstaged))
        .map((entry) => entry.path),
    ),
  ];
  return paths.length ? { unstage, paths } : null;
}
