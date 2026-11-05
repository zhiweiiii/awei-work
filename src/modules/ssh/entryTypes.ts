export type EntryBase = { id: string; groupId: string; name: string };
export type SshProfile = EntryBase & {
  kind?: "ssh";
  host: string;
  port: number;
  username: string;
  auth: "password" | "key";
  keyPath: string;
  remember: boolean;
};
export type WebStep = {
  id: string;
  action: "fill" | "click" | "wait" | "select" | "press" | "captcha";
  target: string;
  source: "text" | "username" | "password";
  value: string;
  when?: string;
};
export type WebProfile = EntryBase & {
  kind: "web";
  url: string;
  username: string;
  remember: boolean;
  steps: WebStep[];
};
export type ProgramProfile = EntryBase & {
  kind: "program";
  program: string;
  args: string[];
};
export type CodeProfile = EntryBase & {
  kind: "code";
  scriptPath: string;
  username: string;
  passwordMode: "none" | "saved" | "ask";
};
export type ConnectionProfile =
  | SshProfile
  | WebProfile
  | ProgramProfile
  | CodeProfile;
export function isSshProfile(
  profile: ConnectionProfile,
): profile is SshProfile {
  return profile.kind === undefined || profile.kind === "ssh";
}

export function validWebUrl(raw: string): boolean {
  if (raw.length > 8192 || /[\u0000-\u0020\u007f]/.test(raw)) return false;
  try {
    const url = new URL(raw);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !["tauri.localhost", "asset.localhost", "ipc.localhost"].includes(
        url.hostname.replace(/\.$/, ""),
      ) &&
      (typeof window === "undefined" || url.origin !== window.location.origin)
    );
  } catch {
    return false;
  }
}

export function validEntry(value: unknown): value is ConnectionProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as ConnectionProfile;
  const text = (value: unknown, limit = 256, empty = false): value is string =>
    typeof value === "string" &&
    value.length <= limit &&
    (empty || !!value.trim()) &&
    !/[\u0000-\u001f\u007f]/.test(value);
  if (!text(profile.name)) return false;
  if (profile.kind === "code")
    return (
      text(profile.scriptPath, 8192) &&
      /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/i.test(
        profile.scriptPath,
      ) &&
      /\.mjs$/i.test(profile.scriptPath) &&
      text(profile.username, 256, true) &&
      ["none", "saved", "ask"].includes(profile.passwordMode)
    );
  if (profile.kind === "web")
    return (
      text(profile.url, 8192) &&
      validWebUrl(profile.url) &&
      text(profile.username, 256, true) &&
      typeof profile.remember === "boolean" &&
      Array.isArray(profile.steps) &&
      profile.steps.length <= 32 &&
      new Set(profile.steps.map((step) => step?.id)).size ===
        profile.steps.length &&
      profile.steps.every(
        (step) =>
          !!step &&
          typeof step.id === "string" &&
          /^[a-zA-Z0-9-]{1,100}$/.test(step.id) &&
          ["fill", "click", "wait", "select", "press", "captcha"].includes(
            step.action,
          ) &&
          text(step.target, 2048) &&
          (step.when === undefined || text(step.when, 2048, true)) &&
          ["text", "username", "password"].includes(step.source) &&
          text(step.value, 4096, true) &&
          (step.action !== "captcha" || text(step.value, 2048)) &&
          (step.action === "fill" || step.source === "text") &&
          (step.source === "text" || step.value === "") &&
          (step.action !== "press" ||
            ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"].includes(
              step.value,
            )),
      )
    );
  if (profile.kind === "program")
    return (
      text(profile.program, 8192) &&
      /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/i.test(profile.program) &&
      /\.exe$/i.test(profile.program) &&
      Array.isArray(profile.args) &&
      profile.args.length <= 100 &&
      profile.args.every((arg) => text(arg, 8192, true))
    );
  if (!isSshProfile(profile)) return false;
  return (
    text(profile.host) &&
    text(profile.username) &&
    Number.isInteger(profile.port) &&
    profile.port >= 1 &&
    profile.port <= 65535 &&
    ["password", "key"].includes(profile.auth) &&
    text(profile.keyPath, 8192, true) &&
    typeof profile.remember === "boolean"
  );
}
