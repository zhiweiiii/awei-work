import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { readCredential, saveLogin } from "@/modules/ssh/api";
import { updateSsh, useSsh, type SshProfile } from "@/modules/ssh/store";
import { isSshProfile } from "@/modules/ssh/entryTypes";
import { SpecialProfileForm } from "@/modules/ssh/SpecialProfileForm";

export function ProfileDialog() {
  const editing = useSsh((state) => state.editing);
  const previousFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => {
        if (!open) useSsh.setState({ editing: null });
      }}
    >
      <DialogContent
        className="max-h-[90vh] gap-4 overflow-y-auto sm:max-w-xl"
        onOpenAutoFocus={() => {
          previousFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          if (previousFocus.current?.isConnected) {
            event.preventDefault();
            previousFocus.current.focus();
          }
        }}
      >
        <DialogTitle>{editing === "new" ? "新建连接" : "编辑连接"}</DialogTitle>
        <DialogDescription>
          SSH 和动态代码按分组保存，密码单独存入 Windows 凭据管理器。
        </DialogDescription>
        {editing && <ProfileEditor key={editing} editing={editing} />}
      </DialogContent>
    </Dialog>
  );
}

function ProfileEditor({ editing }: { editing: string }) {
  const original = useSsh
    .getState()
    .profiles.find((profile) => profile.id === editing);
  const [kind, setKind] = useState<"ssh" | "code">(
    original && !isSshProfile(original) ? "code" : "ssh",
  );
  return (
    <>
      <label className="ssh-field text-xs">
        连接类型
        <select
          value={kind}
          disabled={!!original}
          onChange={(event) => setKind(event.target.value as typeof kind)}
        >
          <option value="ssh">SSH 终端</option>
          <option value="code">动态执行代码</option>
        </select>
      </label>
      {kind === "ssh" ? (
        <ProfileForm editing={editing} />
      ) : (
        <SpecialProfileForm editing={editing} />
      )}
    </>
  );
}

function ProfileForm({ editing }: { editing: string }) {
  const groups = useSsh((state) => state.groups);
  const saved = useSsh
    .getState()
    .profiles.find((profile) => profile.id === editing);
  const original = saved && isSshProfile(saved) ? saved : undefined;
  const [profile, setProfile] = useState<SshProfile>(
    () =>
      original ?? {
        id: crypto.randomUUID(),
        groupId: groups[0].id,
        name: "",
        host: "",
        port: 22,
        username: "root",
        auth: "password",
        keyPath: "",
        remember: false,
      },
  );
  const [secret, setSecret] = useState("");
  const [loaded, setLoaded] = useState(!original?.remember);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const live = useRef(true);
  const gate = useRef(false);
  useEffect(() => {
    live.current = true;
    if (original?.remember)
      void readCredential(original.id)
        .then((value) => {
          if (live.current) {
            setSecret(value ?? "");
            setLoaded(true);
          }
        })
        .catch((error: unknown) => {
          if (live.current) {
            setError(String(error));
            setLoaded(true);
          }
        });
    return () => {
      live.current = false;
    };
  }, [original?.id, original?.remember]);
  const field = (key: keyof SshProfile, value: string | number | boolean) =>
    setProfile((before) => ({ ...before, [key]: value }));
  return (
    <form
      className="grid gap-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (gate.current || !loaded) return;
        gate.current = true;
        setBusy(true);
        setError("");
        const next = {
          ...profile,
          name: profile.name.trim(),
          host: profile.host.trim(),
          username: profile.username.trim(),
          keyPath: profile.keyPath.trim(),
        };
        void (async () => {
          if (/[\s/@\\]/.test(next.host))
            throw new Error("主机只填写 IP 或域名，不包含用户名、路径或空格");
          if (next.auth === "key" && !next.keyPath)
            throw new Error("请输入私钥文件的完整路径");
          await saveLogin(next.id, next.remember ? secret : null, () =>
            updateSsh((config) => ({
              ...config,
              profiles: original
                ? config.profiles.map((item) =>
                    item.id === next.id ? next : item,
                  )
                : [...config.profiles, next],
            })),
          );
          if (live.current)
            useSsh.setState({ editing: null, selected: next.id });
        })()
          .catch((error: unknown) => {
            if (live.current) setError(String(error));
          })
          .finally(() => {
            gate.current = false;
            if (live.current) setBusy(false);
          });
      }}
    >
      <label className="ssh-field">
        连接名称
        <input
          required
          maxLength={256}
          value={profile.name}
          onChange={(event) => field("name", event.target.value)}
          placeholder="生产服务器"
        />
      </label>
      <label className="ssh-field">
        分组
        <select
          value={profile.groupId}
          onChange={(event) => field("groupId", event.target.value)}
        >
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-[1fr_80px] gap-3">
        <label className="ssh-field">
          主机
          <input
            required
            maxLength={253}
            value={profile.host}
            onChange={(event) => field("host", event.target.value)}
            placeholder="IP 或域名"
          />
        </label>
        <label className="ssh-field">
          端口
          <input
            required
            type="number"
            min={1}
            max={65535}
            value={profile.port}
            onChange={(event) => field("port", Number(event.target.value))}
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="ssh-field">
          用户名
          <input
            required
            maxLength={256}
            value={profile.username}
            onChange={(event) => field("username", event.target.value)}
          />
        </label>
        <label className="ssh-field">
          认证方式
          <select
            value={profile.auth}
            onChange={(event) => {
              field("auth", event.target.value);
              setSecret("");
            }}
          >
            <option value="password">密码</option>
            <option value="key">私钥（ED25519 / ECDSA）</option>
          </select>
        </label>
      </div>
      {profile.auth === "key" && (
        <label className="ssh-field">
          私钥路径
          <input
            required
            value={profile.keyPath}
            onChange={(event) => field("keyPath", event.target.value)}
            placeholder="C:\Users\用户名\.ssh\id_ed25519"
          />
        </label>
      )}
      <label className="ssh-field">
        {profile.auth === "key" ? "密钥口令（可留空）" : "密码"}
        <input
          type="password"
          autoComplete="off"
          disabled={!loaded}
          maxLength={2000}
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={profile.remember}
          onChange={(event) => field("remember", event.target.checked)}
        />
        记住{profile.auth === "key" ? "密钥口令" : "密码"}
      </label>
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="ssh-button justify-self-end bg-primary text-primary-foreground"
        disabled={busy || !loaded}
      >
        {busy ? "保存中…" : "保存连接"}
      </button>
    </form>
  );
}
