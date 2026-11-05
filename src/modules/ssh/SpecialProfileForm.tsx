import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readCredential, saveLogin } from "@/modules/ssh/api";
import { updateSsh, useSsh } from "@/modules/ssh/store";
import { validEntry, type CodeProfile } from "@/modules/ssh/entryTypes";

type Document = { path: string; source: string; hash: string | null };
const templates = {
  blank: "export default async ({ log }) => {\n  log('Ready');\n};\n",
  program: `export default async ({ launch }) => {
  await launch("C:/Windows/System32/notepad.exe", []);
};
`,
};
export function SpecialProfileForm({ editing }: { editing: string }) {
  const groups = useSsh((state) => state.groups);
  const original = useSsh
    .getState()
    .profiles.find((profile) => profile.id === editing);
  const [profile, setProfile] = useState<CodeProfile>(() =>
    original?.kind === "code"
      ? original
      : {
          id: crypto.randomUUID(),
          kind: "code",
          groupId: groups[0].id,
          name: "",
          scriptPath: "",
          username: "",
          passwordMode: "none",
        },
  );
  const [document, setDocument] = useState<Document | null>(null);
  const [path, setPath] = useState(profile.scriptPath);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const gate = useRef(true);
  const live = useRef(true);
  const rememberedId =
    original?.kind === "code" && original.passwordMode === "saved"
      ? original.id
      : null;
  const initial = useRef({
    id: profile.id,
    path: profile.scriptPath,
    rememberedId,
  });
  useEffect(() => {
    let cancelled = false;
    live.current = true;
    const identity = initial.current;
    void Promise.all([
      invoke<Document>("ssh_code_read", {
        id: identity.id,
        path: identity.path || null,
      }),
      identity.rememberedId
        ? readCredential(identity.rememberedId)
        : Promise.resolve(null),
    ])
      .then(([file, password]) => {
        if (cancelled) return;
        setDocument(file);
        setPath(file.path);
        setSecret(password ?? "");
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(String(error));
      })
      .finally(() => {
        if (!cancelled) {
          gate.current = false;
          setBusy(false);
        }
      });
    return () => {
      cancelled = true;
      live.current = false;
    };
  }, []);
  const readFile = () => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    void invoke<Document>("ssh_code_read", {
      id: profile.id,
      path: path || null,
    })
      .then((file) => {
        if (live.current) {
          setDocument(file);
          setPath(file.path);
        }
      })
      .catch((error: unknown) => {
        if (live.current) setError(String(error));
      })
      .finally(() => {
        gate.current = false;
        if (live.current) setBusy(false);
      });
  };
  return (
    <form
      className="grid max-h-[65vh] gap-3 overflow-y-auto pr-1 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (gate.current || !document) return;
        gate.current = true;
        setBusy(true);
        setError("");
        void (async () => {
          if (path !== document.path) throw new Error("请先加载所选脚本文件");
          const next = {
            ...profile,
            name: profile.name.trim(),
            username: profile.username.trim(),
            scriptPath: document.path,
          };
          if (!validEntry(next)) throw new Error("请检查名称和 .mjs 脚本路径");
          if (next.passwordMode === "saved" && !secret)
            throw new Error("请填写要保存的密码");
          const file = await invoke<Document>("ssh_code_write", {
            path: document.path,
            source: document.source,
            expectedHash: document.hash,
          });
          if (live.current) setDocument(file);
          await invoke("ssh_cancel_special", { id: next.id });
          await saveLogin(
            next.id,
            next.passwordMode === "saved" ? secret : null,
            () =>
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
      <div className="grid grid-cols-2 gap-3">
        <label className="ssh-field">
          名称
          <input
            required
            maxLength={256}
            value={profile.name}
            onChange={(event) =>
              setProfile({ ...profile, name: event.target.value })
            }
          />
        </label>
        <label className="ssh-field">
          分组
          <select
            value={profile.groupId}
            onChange={(event) =>
              setProfile({ ...profile, groupId: event.target.value })
            }
          >
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-muted-foreground">
        需要 Node.js 22+。脚本以当前用户权限执行；agent
        可直接修改下方文件，下次执行使用最新代码。
      </p>
      <label className="ssh-field">
        脚本文件
        <input
          value={path}
          disabled={busy}
          maxLength={8192}
          placeholder=".mjs 完整路径"
          onChange={(event) => setPath(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="ssh-button"
          disabled={busy}
          onClick={readFile}
        >
          加载 / 重新读取
        </button>
        <button
          type="button"
          className="ssh-button"
          disabled={!document}
          onClick={() => {
            void navigator.clipboard
              .writeText(document?.path ?? "")
              .catch((error: unknown) => setError(String(error)));
          }}
        >
          复制脚本路径
        </button>
        <select
          className="ssh-input ml-auto"
          aria-label="插入代码模板"
          value=""
          disabled={busy || !document}
          onChange={(event) => {
            const source =
              templates[event.target.value as keyof typeof templates];
            if (source)
              setDocument((before) =>
                before ? { ...before, source } : before,
              );
          }}
        >
          <option value="" disabled>
            使用模板
          </option>
          <option value="blank">空白代码</option>
          <option value="program">启动程序</option>
        </select>
      </div>
      <label className="ssh-field">
        执行代码
        <textarea
          className="min-h-64 font-mono text-[11px]"
          spellCheck={false}
          disabled={busy || !document}
          value={document?.source ?? ""}
          onChange={(event) =>
            setDocument((before) =>
              before ? { ...before, source: event.target.value } : before,
            )
          }
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="ssh-field">
          用户名（可选）
          <input
            maxLength={256}
            value={profile.username}
            onChange={(event) =>
              setProfile({ ...profile, username: event.target.value })
            }
          />
        </label>
        <label className="ssh-field">
          密码
          <select
            value={profile.passwordMode}
            onChange={(event) =>
              setProfile({
                ...profile,
                passwordMode: event.target.value as CodeProfile["passwordMode"],
              })
            }
          >
            <option value="none">不使用</option>
            <option value="saved">凭据管理器保存</option>
            <option value="ask">每次执行时输入</option>
          </select>
        </label>
      </div>
      {profile.passwordMode === "saved" && (
        <label className="ssh-field">
          登录密码
          <input
            type="password"
            autoComplete="off"
            maxLength={2000}
            disabled={busy}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </label>
      )}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="ssh-button justify-self-end bg-primary text-primary-foreground"
        disabled={busy || !document}
      >
        {busy ? "处理中…" : "保存代码和连接"}
      </button>
    </form>
  );
}
