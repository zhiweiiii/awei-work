import { invoke } from "@tauri-apps/api/core";
import type { SshProfile } from "@/modules/ssh/store";

export type ConnectResult =
  | { status: "hostKey"; key: { fingerprint: string; previous: string | null } }
  | { status: "connected"; id: number };
export type SshEntry = {
  name: string;
  kind: "file" | "dir" | "link" | "special";
  size: number;
  modified: number;
};
export type SshListing = { path: string; entries: SshEntry[] };
export type TransferProgress = {
  taskId: string;
  file: string;
  bytes: number;
  files: number;
};
export type Side = "local" | "remote";

export function connect(
  profile: SshProfile,
  secret: string,
  acceptedFingerprint?: string,
) {
  return invoke<ConnectResult>("ssh_connect", {
    login: {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      auth: profile.auth,
      keyPath: profile.keyPath || null,
      secret,
      acceptedFingerprint: acceptedFingerprint ?? null,
    },
  });
}
export const disconnect = (id: number) =>
  invoke<void>("ssh_disconnect", { id });
export const readCredential = (id: string) =>
  invoke<string | null>("ssh_credential_read", { id });
export const saveCredential = (id: string, secret: string | null) =>
  invoke<void>("ssh_credential_save", { id, secret });
export async function saveLogin(
  id: string,
  secret: string | null,
  save: () => Promise<void>,
): Promise<void> {
  const previous = await readCredential(id);
  await saveCredential(id, secret);
  try {
    await save();
  } catch (error) {
    try {
      await saveCredential(id, previous);
    } catch {
      throw new Error(`连接配置保存失败，原凭据恢复也未成功：${String(error)}`);
    }
    throw error;
  }
}
export const listDirectory = (id: number, side: Side, directory?: string) =>
  invoke<SshListing>("ssh_list_dir", {
    id,
    side,
    directory: directory ?? null,
  });

export function parentDirectory(path: string, side: Side): string {
  const normalized = side === "local" ? path.replace(/\\/g, "/") : path;
  if (normalized === "/" || /^[a-z]:\/?$/i.test(normalized)) return normalized;
  if (
    side === "local" &&
    normalized.startsWith("//") &&
    normalized.split("/").filter(Boolean).length <= 2
  )
    return normalized;
  const parent = normalized.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
  return /^[a-z]:$/i.test(parent) ? `${parent}/` : parent || "/";
}
export const joinPath = (directory: string, name: string) =>
  `${directory.replace(/[\\/]+$/, "")}/${name}`;
export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}
