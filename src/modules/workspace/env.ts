export type WorkspaceEnv = { kind: "local" };

export const LOCAL_WORKSPACE: WorkspaceEnv = Object.freeze({ kind: "local" });

export function currentWorkspaceEnv(): WorkspaceEnv {
  return LOCAL_WORKSPACE;
}

export function workspaceScopeKey(_env: WorkspaceEnv): string {
  return "local";
}

export function parseWorkspaceScopeKey(key: string): WorkspaceEnv {
  if (key !== "local") throw new Error("Unsupported workspace environment");
  return LOCAL_WORKSPACE;
}

export function currentWorkspaceScopeKey(): string {
  return "local";
}
