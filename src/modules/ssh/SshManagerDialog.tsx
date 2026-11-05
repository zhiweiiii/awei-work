import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useSsh,
  type ConnectionProfile,
  type SshGroup,
} from "@/modules/ssh/store";

export function SshManagerDialog({
  open,
  onOpenChange,
  disabled,
  onEditGroup,
  onDeleteGroup,
  onDeleteProfile,
  onMoveGroup,
  onMoveProfile,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  onEditGroup: (group: SshGroup | null) => void;
  onDeleteGroup: (id: string) => void;
  onDeleteProfile: (profile: ConnectionProfile) => void;
  onMoveGroup: (id: string, targetId: string, after: boolean) => void;
  onMoveProfile: (id: string, targetId: string, after: boolean) => void;
}) {
  const groups = useSsh((state) => state.groups);
  const profiles = useSsh((state) => state.profiles);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-3 sm:max-w-xl">
        <DialogTitle>管理连接</DialogTitle>
        <DialogDescription>
          管理分组、SSH 连接和动态执行代码。
        </DialogDescription>
        <div className="flex gap-2 text-xs">
          <button
            type="button"
            className="ssh-button"
            disabled={disabled}
            onClick={() => onEditGroup(null)}
          >
            新建分组
          </button>
          <button
            type="button"
            className="ssh-button"
            disabled={disabled}
            onClick={() => useSsh.setState({ editing: "new" })}
          >
            新建连接
          </button>
        </div>
        <div className="min-h-0 space-y-3 overflow-auto text-xs">
          {groups.map((group, groupIndex) => (
            <section key={group.id} className="rounded-md border border-border">
              <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-medium">
                  {group.name}
                </span>
                <button
                  type="button"
                  className="ssh-button"
                  aria-label={`上移分组 ${group.name}`}
                  disabled={disabled || groupIndex === 0}
                  onClick={() =>
                    onMoveGroup(group.id, groups[groupIndex - 1].id, false)
                  }
                >
                  上移
                </button>
                <button
                  type="button"
                  className="ssh-button"
                  aria-label={`下移分组 ${group.name}`}
                  disabled={disabled || groupIndex === groups.length - 1}
                  onClick={() =>
                    onMoveGroup(group.id, groups[groupIndex + 1].id, true)
                  }
                >
                  下移
                </button>
                <button
                  type="button"
                  className="ssh-button"
                  disabled={disabled}
                  onClick={() => onEditGroup(group)}
                >
                  改名
                </button>
                <button
                  type="button"
                  className="ssh-button text-destructive"
                  disabled={disabled || groups.length < 2}
                  onClick={() => onDeleteGroup(group.id)}
                >
                  删除
                </button>
              </div>
              {profiles
                .filter((profile) => profile.groupId === group.id)
                .map((profile, profileIndex, siblings) => (
                  <div
                    key={profile.id}
                    className="flex items-center gap-2 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {profile.name}
                    </span>
                    <button
                      type="button"
                      className="ssh-button"
                      aria-label={`上移连接 ${profile.name}`}
                      disabled={disabled || profileIndex === 0}
                      onClick={() =>
                        onMoveProfile(
                          profile.id,
                          siblings[profileIndex - 1].id,
                          false,
                        )
                      }
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      className="ssh-button"
                      aria-label={`下移连接 ${profile.name}`}
                      disabled={
                        disabled || profileIndex === siblings.length - 1
                      }
                      onClick={() =>
                        onMoveProfile(
                          profile.id,
                          siblings[profileIndex + 1].id,
                          true,
                        )
                      }
                    >
                      下移
                    </button>
                    <span className="text-muted-foreground">
                      {profile.kind === "code" ? "代码" : "SSH"}
                    </span>
                    <button
                      type="button"
                      className="ssh-button"
                      disabled={disabled}
                      onClick={() => useSsh.setState({ editing: profile.id })}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="ssh-button text-destructive"
                      disabled={disabled}
                      onClick={() => onDeleteProfile(profile)}
                    >
                      删除
                    </button>
                  </div>
                ))}
              {!profiles.some((profile) => profile.groupId === group.id) && (
                <p className="px-3 py-2 text-muted-foreground">暂无连接</p>
              )}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
