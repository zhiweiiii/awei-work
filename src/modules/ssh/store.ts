import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { validEntry, type ConnectionProfile } from "@/modules/ssh/entryTypes";
export type {
  SshProfile,
  ConnectionProfile,
  WebProfile,
  ProgramProfile,
  WebStep,
  CodeProfile,
} from "@/modules/ssh/entryTypes";

export type SshGroup = { id: string; name: string };
type Config = { groups: SshGroup[]; profiles: ConnectionProfile[] };
type State = Config & {
  ready: boolean;
  visible: boolean;
  selected: string | null;
  workspaceId: string | null;
  editing: string | "new" | null;
  open: (id?: string) => void;
  hide: () => void;
};
const defaults: Config = {
  groups: [{ id: "default", name: "默认分组" }],
  profiles: [],
};
const disk = new LazyStore("awei-work-ssh.json", {
  defaults: {},
  autoSave: false,
});
let loading: Promise<void> | null = null;
let saving: Promise<void> = Promise.resolve();
export const useSsh = create<State>((set) => ({
  ...defaults,
  ready: false,
  visible: false,
  selected: null,
  workspaceId: null,
  editing: null,
  open: (id) =>
    set((state) => ({ visible: true, selected: id ?? state.selected })),
  hide: () => set({ visible: false, workspaceId: null }),
}));

function validConfig(value: unknown): value is Config {
  if (!value || typeof value !== "object") return false;
  const data = value as Config;
  if (
    !Array.isArray(data.groups) ||
    !data.groups.length ||
    data.groups.length > 100 ||
    !Array.isArray(data.profiles) ||
    data.profiles.length > 1000
  )
    return false;
  const id = (value: unknown) =>
    typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value);
  const text = (value: unknown) =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f]/.test(value);
  return (
    data.groups.every((group) => id(group.id) && text(group.name)) &&
    new Set(data.groups.map((group) => group.id)).size === data.groups.length &&
    data.profiles.every(
      (profile) =>
        validEntry(profile) &&
        id(profile.id) &&
        data.groups.some((group) => group.id === profile.groupId) &&
        text(profile.name),
    ) &&
    new Set(data.profiles.map((profile) => profile.id)).size ===
      data.profiles.length
  );
}

export function loadSsh(): Promise<void> {
  if (!loading)
    loading = (async () => {
      const saved = await disk.get<unknown>("connections");
      if (saved !== undefined && saved !== null && !validConfig(saved))
        throw new Error("SSH 配置格式错误，已保留原文件");
      let config = saved ? (saved as Config) : defaults;
      if (
        config.profiles.some(
          (profile) => profile.kind === "web" || profile.kind === "program",
        )
      ) {
        const profiles: ConnectionProfile[] = [];
        for (const profile of config.profiles) {
          profiles.push(
            profile.kind === "web" || profile.kind === "program"
              ? await invoke<ConnectionProfile>("ssh_code_migrate", {
                  entry: profile,
                })
              : profile,
          );
        }
        config = { ...config, profiles };
        if (!validConfig(config))
          throw new Error("动态代码配置转换失败，已保留原配置");
        await disk.set("connections", config);
        await disk.save();
      }
      useSsh.setState({
        ...config,
        ready: true,
      });
    })().catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

export function updateSsh(change: (config: Config) => Config): Promise<void> {
  const operation = saving.then(async () => {
    const { groups, profiles } = useSsh.getState();
    const config = change({ groups, profiles });
    if (!useSsh.getState().ready || !validConfig(config))
      throw new Error("SSH 配置无效");
    await disk.set("connections", config);
    await disk.save();
    useSsh.setState(config);
  });
  saving = operation.catch(() => {});
  return operation;
}

export function moveSshGroup(
  id: string,
  targetId: string,
  after: boolean,
): Promise<void> {
  return updateSsh((config) => {
    const group = config.groups.find((group) => group.id === id);
    if (
      !group ||
      id === targetId ||
      !config.groups.some((group) => group.id === targetId)
    )
      return config;
    const groups = config.groups.filter((group) => group.id !== id);
    const index = groups.findIndex((group) => group.id === targetId);
    groups.splice(index + Number(after), 0, group);
    return { ...config, groups };
  });
}

export function moveSshProfile(
  id: string,
  targetId: string,
  after: boolean,
): Promise<void> {
  return updateSsh((config) => {
    const profile = config.profiles.find((profile) => profile.id === id);
    if (!profile || targetId === id) return config;
    const anchor = config.profiles.find((profile) => profile.id === targetId);
    if (!anchor || anchor.groupId !== profile.groupId)
      throw new Error("目标连接已变更，请重新调整顺序");
    const profiles = config.profiles.filter((profile) => profile.id !== id);
    const index = profiles.findIndex((profile) => profile.id === targetId);
    profiles.splice(index + Number(after), 0, profile);
    return { ...config, profiles };
  });
}
