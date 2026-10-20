import { homeDir } from "@tauri-apps/api/path";
import { useEffect, useState } from "react";
import { native } from "@/lib/native";

export function useWorkspaceHome() {
  const [home, setHome] = useState<string | null>(null);
  const [launchCwd, setLaunchCwd] = useState<string | null>(null);
  const [launchCwdResolved, setLaunchCwdResolved] = useState(false);

  useEffect(() => {
    let alive = true;
    void homeDir()
      .then(async (path) => {
        const normalized = path.replace(/\\/g, "/");
        if (!alive) return;
        setHome(normalized);
        await native.workspaceAuthorize(normalized).catch(() => undefined);
      })
      .catch(() => undefined);
    void native
      .workspaceCurrentDir()
      .then((cwd) => {
        if (alive) setLaunchCwd(cwd);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLaunchCwdResolved(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { home, launchCwd, launchCwdResolved };
}
