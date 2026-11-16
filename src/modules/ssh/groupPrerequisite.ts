import type { CodeProfile, ConnectionProfile } from "@/modules/ssh/entryTypes";

export type ConnectionGroup = {
  id: string;
  name: string;
  beforeConnectCodeId?: string;
};

export function groupPrerequisite(
  entry: ConnectionProfile,
  groups: readonly ConnectionGroup[],
  profiles: readonly ConnectionProfile[],
): CodeProfile | null {
  const group = groups.find((group) => group.id === entry.groupId);
  if (!group) throw new Error("连接所属分组不存在，请重新选择连接");
  if (!group.beforeConnectCodeId) return null;
  const code = profiles.find(
    (profile) => profile.id === group.beforeConnectCodeId,
  );
  if (code?.kind !== "code")
    throw new Error(`分组“${group.name}”的前置代码不存在，请先修改分组设置`);
  return code.id === entry.id ? null : code;
}

export function prerequisiteIsCurrent(
  entry: ConnectionProfile,
  group: ConnectionGroup,
  code: CodeProfile,
  groups: readonly ConnectionGroup[],
  profiles: readonly ConnectionProfile[],
): boolean {
  return (
    profiles.find((profile) => profile.id === entry.id) === entry &&
    groups.find((item) => item.id === group.id)?.beforeConnectCodeId ===
      code.id &&
    profiles.find((profile) => profile.id === code.id) === code
  );
}
