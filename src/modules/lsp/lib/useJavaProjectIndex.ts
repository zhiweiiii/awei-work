import { useEffect } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { warmJavaProject } from "@/modules/lsp/lib/sessionManager";

export function useJavaProjectIndex(path: string | null | undefined): void {
  const activation = usePreferencesStore((state) => state.lspActivation.jdtls);
  useEffect(() => {
    if (!path || activation !== "enabled") return;
    void warmJavaProject(path).catch((error) =>
      console.warn("[lsp:java] project index preparation failed", error),
    );
  }, [path, activation]);
}
