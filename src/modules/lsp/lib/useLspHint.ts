import { errorToast } from "@/lib/errorToast";
import { resolveLanguage } from "@/modules/editor/lib/languageResolver";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect, useMemo, useRef, useState } from "react";
import { detectBinary } from "./detect";
import { type LspPreset, serverForLanguage } from "./presets";
import { type LspSessionStatus, useLspRuntimeStore } from "./runtimeStore";

export type LspHint =
  | { kind: "enable"; preset: LspPreset }
  | { kind: "install"; preset: LspPreset }
  | { kind: "active"; preset: LspPreset; status: LspSessionStatus }
  | { kind: "error"; preset: LspPreset; reason: string };

export function useLspHint(filePath: string | null): LspHint | null {
  const scopeRef = useRef({ path: filePath });
  if (scopeRef.current.path !== filePath) scopeRef.current = { path: filePath };
  const scope = scopeRef.current;
  const [resolved, setResolved] = useState<{
    scope: typeof scope | null;
    langId: string | null;
  }>({ scope: null, langId: null });
  const langId = resolved.scope === scope ? resolved.langId : null;

  useEffect(() => {
    if (!filePath) {
      setResolved({ scope, langId: null });
      return;
    }
    let cancelled = false;
    void resolveLanguage(filePath)
      .then((result) => {
        if (cancelled || scopeRef.current !== scope) return;
        const ext = filePath.split(".").pop()?.toLowerCase() ?? null;
        setResolved({ scope, langId: result?.id || ext });
      })
      .catch((error) => {
        if (!cancelled && scopeRef.current === scope)
          errorToast("Could not resolve editor language", error);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, scope]);

  const customServers = usePreferencesStore((s) => s.lspCustomServers);
  const lspActivation = usePreferencesStore((s) => s.lspActivation);
  const preset = useMemo(
    () => serverForLanguage(langId, customServers, lspActivation),
    [langId, customServers, lspActivation],
  );
  const activation = preset ? lspActivation[preset.id] : undefined;
  const detected = useLspRuntimeStore((s) =>
    preset ? s.detected[preset.command] : undefined,
  );
  const session = useLspRuntimeStore((s) =>
    preset
      ? Object.values(s.sessions)
          .filter((session) => {
            if (session.presetId !== preset.id || !filePath) return false;
            const root = session.root
              .replace(/\\/g, "/")
              .replace(/\/+$/, "")
              .toLowerCase();
            const path = filePath.replace(/\\/g, "/").toLowerCase();
            return path === root || path.startsWith(`${root}/`);
          })
          .sort((a, b) => b.root.length - a.root.length)[0]
      : undefined,
  );
  const failure = useLspRuntimeStore((s) =>
    preset ? s.failed[preset.id] : undefined,
  );

  useEffect(() => {
    if (preset && activation === undefined) {
      void detectBinary(preset.command).catch((error) =>
        errorToast("Could not detect language server", error),
      );
    }
  }, [preset, activation]);

  if (!preset) return null;
  if (activation === "dismissed") return null;
  if (activation === "enabled") {
    if (session?.status === "error")
      return {
        kind: "error",
        preset,
        reason: failure ?? "Language server failed",
      };
    if (session) return { kind: "active", preset, status: session.status };
    if (failure) return { kind: "error", preset, reason: failure };
    return null;
  }
  if (detected === undefined) return null;
  return detected ? { kind: "enable", preset } : { kind: "install", preset };
}
