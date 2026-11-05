import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { AuthDialog } from "@/modules/ssh/AuthDialog";
import { ProfileDialog } from "@/modules/ssh/ProfileDialog";
import { SshFiles } from "@/modules/ssh/SshFiles";
import { disposeSshTerminal, SshTerminal } from "@/modules/ssh/SshTerminal";
import { disconnect, saveCredential } from "@/modules/ssh/api";
import {
  loadSsh,
  updateSsh,
  moveSshGroup,
  moveSshProfile,
  useSsh,
  type SshProfile,
  type ConnectionProfile,
} from "@/modules/ssh/store";
import "@/modules/ssh/ssh.css";
import { isSshProfile } from "@/modules/ssh/entryTypes";
import { useSpecialEntries } from "@/modules/ssh/SpecialEntries";
import { ConnectionContextMenu } from "@/modules/ssh/ConnectionContextMenu";
import { SshManagerDialog } from "@/modules/ssh/SshManagerDialog";
import { invoke } from "@tauri-apps/api/core";

type Session = { id: number; profile: SshProfile; closed: string | null };
type GroupEdit = { id: string | null; name: string };

export default function SshWorkspace({
  sidebarHost,
  workspaceHost,
}: {
  sidebarHost: HTMLElement | null;
  workspaceHost: HTMLElement | null;
}) {
  const visible = useSsh((state) => state.visible);
  const selected = useSsh((state) => state.selected);
  const workspaceId = useSsh((state) => state.workspaceId);
  const [managerOpen, setManagerOpen] = useState(false);
  const profiles = useSsh((state) => state.profiles);
  const groups = useSsh((state) => state.groups);
  const ready = useSsh((state) => state.ready);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [auth, setAuth] = useState<SshProfile | null>(null);
  const [view, setView] = useState<"terminal" | "files">("terminal");
  const [filesOpened, setFilesOpened] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const [error, setError] = useState("");
  const [groupEdit, setGroupEdit] = useState<GroupEdit | null>(null);
  const [deleting, setDeleting] = useState<ConnectionProfile | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const gate = useRef(false);
  const mounted = useRef(true);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  useEffect(() => {
    mounted.current = true;
    void loadSsh().catch((error: unknown) => {
      if (mounted.current) setError(String(error));
    });
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!visible) return;
    if (!selected || !profiles.some((profile) => profile.id === selected))
      useSsh.setState({ selected: profiles[0]?.id ?? null });
  }, [visible, selected, profiles]);
  const profile = profiles.find((profile) => profile.id === selected);
  const special = useSpecialEntries(setError);
  const activeSession = sessions.find(
    (session) => session.profile.id === workspaceId,
  );
  const removeSession = async (profileId: string) => {
    const session = sessionsRef.current.find(
      (session) => session.profile.id === profileId,
    );
    if (!session) return;
    await disconnect(session.id);
    disposeSshTerminal(session.id);
    if (useSsh.getState().workspaceId === profileId)
      useSsh.setState({ workspaceId: null });
    if (mounted.current) {
      setSessions((before) => before.filter((item) => item.id !== session.id));
      setFilesOpened((before) => {
        const next = new Set(before);
        next.delete(session.id);
        return next;
      });
    }
  };
  const action = (operation: () => Promise<void>) => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    void operation()
      .catch((error: unknown) => {
        if (mounted.current) setError(String(error));
      })
      .finally(() => {
        gate.current = false;
        if (mounted.current) setBusy(false);
      });
  };
  const openConnection = (entry: ConnectionProfile) => {
    if (gate.current || busy) return;
    setAuth(null);
    useSsh.getState().open(entry.id);
    if (isSshProfile(entry)) {
      const existing = sessionsRef.current.find(
        (session) => session.profile.id === entry.id,
      );
      if (existing && !existing.closed) {
        useSsh.setState({ workspaceId: entry.id });
        setView("terminal");
      } else {
        action(async () => {
          await removeSession(entry.id);
          if (
            mounted.current &&
            useSsh.getState().visible &&
            useSsh.getState().selected === entry.id
          )
            setAuth({ ...entry });
        });
      }
    } else if (
      entry.kind === "code" &&
      !["queued", "running"].includes(special.tasks.get(entry.id)?.phase ?? "")
    )
      special.open(entry);
  };
  const openFiles = (id: string) => {
    const existing = sessionsRef.current.find(
      (session) => session.profile.id === id && !session.closed,
    );
    if (!existing) return;
    useSsh.setState({ selected: id, workspaceId: id });
    setFilesOpened((before) => new Set([...before, existing.id]));
    setView("files");
  };
  const stopCode = (id: string) => {
    void invoke("ssh_cancel_special", { id }).catch((error: unknown) =>
      setError(String(error)),
    );
  };
  useEffect(() => {
    if (!visible) setAuth(null);
  }, [visible]);
  return (
    <>
      {sidebarHost &&
        createPortal(
          <div
            className="flex h-full min-h-0 flex-col text-xs"
            aria-hidden={!visible}
          >
            <div className="flex shrink-0 p-2">
              <button
                type="button"
                className="ssh-button"
                disabled={!ready || busy}
                onClick={() => setManagerOpen(true)}
              >
                管理
              </button>
            </div>
            {error && (
              <div
                role="alert"
                className="flex items-start gap-1 px-3 pb-2 text-destructive"
              >
                <p className="min-w-0 flex-1 break-words">{error}</p>
                <button type="button" onClick={() => setError("")}>
                  关闭
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto pb-2">
              {!ready && (
                <p className="px-3 py-2 text-muted-foreground">读取连接配置…</p>
              )}
              {groups.map((group) => (
                <section key={group.id} className="mb-1">
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-1 px-3 py-2 text-left text-muted-foreground"
                    title="点击展开或收起"
                    aria-label={group.name}
                    aria-expanded={expandedGroups.has(group.id)}
                    aria-controls={`ssh-group-${group.id}-connections`}
                    disabled={!ready || busy}
                    onClick={() =>
                      setExpandedGroups((before) => {
                        const next = new Set(before);
                        if (next.has(group.id)) next.delete(group.id);
                        else next.add(group.id);
                        return next;
                      })
                    }
                  >
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      size={12}
                      className={`shrink-0 transition-transform ${expandedGroups.has(group.id) ? "rotate-90" : ""}`}
                      aria-hidden="true"
                    />
                    <span className="truncate">{group.name}</span>
                  </button>
                  <div
                    id={`ssh-group-${group.id}-connections`}
                    hidden={!expandedGroups.has(group.id)}
                  >
                    {profiles
                      .filter((entry) => entry.groupId === group.id)
                      .map((entry) => {
                        const linked = sessions.find(
                          (session) =>
                            session.profile.id === entry.id && !session.closed,
                        );
                        const running = ["queued", "running"].includes(
                          special.tasks.get(entry.id)?.phase ?? "",
                        );
                        return (
                          <ConnectionContextMenu
                            key={entry.id}
                            code={entry.kind === "code"}
                            connected={!!linked}
                            connecting={auth?.id === entry.id}
                            running={running}
                            disabled={busy}
                            onOpen={() => openConnection(entry)}
                            onFiles={() => openFiles(entry.id)}
                            onCancel={() => setAuth(null)}
                            onDisconnect={() =>
                              action(() => removeSession(entry.id))
                            }
                            onEdit={() =>
                              useSsh.setState({ editing: entry.id })
                            }
                            onDelete={() => setDeleting(entry)}
                            onStop={() => stopCode(entry.id)}
                          >
                            <button
                              type="button"
                              className={`flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-accent ${selected === entry.id ? "bg-accent" : ""}`}
                              disabled={busy}
                              title="点击打开，右键管理"
                              onClick={() => openConnection(entry)}
                            >
                              <span className="min-w-0 flex-1 truncate">
                                {entry.name}
                              </span>
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {auth?.id === entry.id
                                  ? "连接中"
                                  : entry.kind === "code"
                                    ? running
                                      ? "执行中"
                                      : "代码"
                                    : linked
                                      ? "已连接"
                                      : ""}
                              </span>
                            </button>
                          </ConnectionContextMenu>
                        );
                      })}
                  </div>
                </section>
              ))}
            </div>
            {profile?.kind === "code" &&
              special.tasks.get(profile.id)?.message && (
                <p
                  role="status"
                  className="max-h-28 shrink-0 overflow-auto whitespace-pre-wrap break-words border-t border-border px-3 py-2 text-muted-foreground"
                >
                  {special.tasks.get(profile.id)?.message}
                </p>
              )}
          </div>,
          sidebarHost,
        )}
      {workspaceHost &&
        createPortal(
          <section
            className={`absolute inset-0 flex min-h-0 flex-col bg-background text-xs ${activeSession ? "" : "invisible pointer-events-none"}`}
            aria-hidden={!activeSession}
          >
            {activeSession && (
              <nav className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
                <button
                  type="button"
                  className={`ssh-button ${view === "terminal" ? "bg-accent" : ""}`}
                  onClick={() => setView("terminal")}
                >
                  终端
                </button>
                <button
                  type="button"
                  className={`ssh-button ${view === "files" ? "bg-accent" : ""}`}
                  disabled={!!activeSession.closed}
                  onClick={() => openFiles(activeSession.profile.id)}
                >
                  文件传输
                </button>
              </nav>
            )}
            <div className="relative min-h-0 flex-1">
              {sessions.map((item) => (
                <div
                  key={item.id}
                  className={`absolute inset-0 ${item.profile.id === workspaceId ? "" : "invisible pointer-events-none"}`}
                  aria-hidden={item.profile.id !== workspaceId}
                >
                  <div
                    className={`absolute inset-0 ${view === "terminal" ? "" : "invisible pointer-events-none"}`}
                  >
                    <SshTerminal
                      id={item.id}
                      active={
                        item.profile.id === workspaceId && view === "terminal"
                      }
                      onClosed={(closed) =>
                        setSessions((before) =>
                          before.map((session) =>
                            session.id === item.id
                              ? { ...session, closed }
                              : session,
                          ),
                        )
                      }
                    />
                  </div>
                  {filesOpened.has(item.id) && (
                    <div
                      className={`absolute inset-0 ${view === "files" ? "" : "invisible pointer-events-none"}`}
                    >
                      <SshFiles id={item.id} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>,
          workspaceHost,
        )}
      <SshManagerDialog
        open={managerOpen}
        onOpenChange={setManagerOpen}
        disabled={busy}
        onEditGroup={(group) =>
          setGroupEdit({ id: group?.id ?? null, name: group?.name ?? "" })
        }
        onDeleteGroup={setDeleteGroup}
        onDeleteProfile={setDeleting}
        onMoveGroup={(id, targetId, after) =>
          action(() => moveSshGroup(id, targetId, after))
        }
        onMoveProfile={(id, targetId, after) =>
          action(() => moveSshProfile(id, targetId, after))
        }
      />
      <ProfileDialog />
      {special.dialogs}
      {auth && (
        <AuthDialog
          key={auth.id}
          profile={auth}
          autoConnect
          onCancel={() => setAuth(null)}
          onConnected={(id) => {
            if (
              !mounted.current ||
              !useSsh.getState().visible ||
              useSsh.getState().selected !== auth.id
            ) {
              void disconnect(id);
              return;
            }
            setSessions((before) => [
              ...before.filter((session) => session.profile.id !== auth.id),
              { id, profile: auth, closed: null },
            ]);
            useSsh.setState({ selected: auth.id, workspaceId: auth.id });
            setView("terminal");
            setAuth(null);
          }}
        />
      )}
      <Dialog
        open={groupEdit !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setGroupEdit(null);
        }}
      >
        <DialogContent className="gap-4">
          <DialogTitle>
            {groupEdit?.id ? "重命名 SSH 分组" : "新建 SSH 分组"}
          </DialogTitle>
          <DialogDescription>
            SSH 连接分组与本机项目分组独立。
          </DialogDescription>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!groupEdit?.name.trim()) return;
              const edit = groupEdit;
              action(async () => {
                await updateSsh((config) => ({
                  ...config,
                  groups: edit.id
                    ? config.groups.map((group) =>
                        group.id === edit.id
                          ? { ...group, name: edit.name.trim() }
                          : group,
                      )
                    : [
                        ...config.groups,
                        { id: crypto.randomUUID(), name: edit.name.trim() },
                      ],
                }));
                if (mounted.current) setGroupEdit(null);
              });
            }}
          >
            <input
              className="ssh-input"
              aria-label="SSH 分组名称"
              required
              maxLength={256}
              value={groupEdit?.name ?? ""}
              disabled={busy}
              onChange={(event) =>
                setGroupEdit((before) =>
                  before ? { ...before, name: event.target.value } : before,
                )
              }
            />
            <button
              type="submit"
              className="ssh-button justify-self-end"
              disabled={busy}
            >
              保存
            </button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <DialogContent className="gap-4">
          <DialogTitle>删除 {deleting?.name}？</DialogTitle>
          <DialogDescription>
            {deleting?.kind === "program"
              ? "删除此入口，不会关闭已经启动的程序。"
              : deleting?.kind === "code"
                ? "删除连接会停止当前脚本，脚本文件会保留。已打开的网页和外部程序不会关闭。"
                : deleting?.kind === "web"
                  ? "停止脚本并删除登录凭据，脚本文件会保留。"
                  : "断开此连接、取消传输，并删除保存的登录凭据。"}
          </DialogDescription>
          <button
            type="button"
            className="ssh-button justify-self-end text-destructive"
            disabled={busy}
            onClick={() => {
              if (!deleting) return;
              const id = deleting.id;
              action(async () => {
                if (deleting.kind === "web" || deleting.kind === "code")
                  await invoke("ssh_cancel_special", { id });
                await removeSession(id);
                await saveCredential(id, null);
                await updateSsh((config) => ({
                  ...config,
                  profiles: config.profiles.filter(
                    (profile) => profile.id !== id,
                  ),
                }));
                if (mounted.current) setDeleting(null);
              });
            }}
          >
            删除连接
          </button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleteGroup !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteGroup(null);
        }}
      >
        <DialogContent className="gap-4">
          <DialogTitle>删除 SSH 分组？</DialogTitle>
          <DialogDescription>
            该组连接会移到其他分组，正在使用的连接不受影响。
          </DialogDescription>
          <button
            type="button"
            className="ssh-button justify-self-end text-destructive"
            disabled={busy}
            onClick={() => {
              if (!deleteGroup) return;
              const id = deleteGroup;
              action(async () => {
                await updateSsh((config) => {
                  const groups = config.groups.filter(
                    (group) => group.id !== id,
                  );
                  if (!groups.length) throw new Error("至少保留一个 SSH 分组");
                  return {
                    groups,
                    profiles: config.profiles.map((profile) =>
                      profile.groupId === id
                        ? { ...profile, groupId: groups[0].id }
                        : profile,
                    ),
                  };
                });
                if (mounted.current) setDeleteGroup(null);
              });
            }}
          >
            删除分组
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}
