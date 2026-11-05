import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Extension } from "@codemirror/state";
import { useEffect, useMemo, useRef, useState } from "react";
import { serverForLanguage } from "./presets";
import { useLspRuntimeStore } from "./runtimeStore";
import { acquireDocExtension, type LspDocHandle } from "./sessionManager";
import { startingNavigation } from "./startingNavigation";

export function useLspExtension(
  path: string,
  langId: string | null,
  ready: boolean,
): Extension | null {
  const customServers = usePreferencesStore((s) => s.lspCustomServers);
  const lspActivation = usePreferencesStore((s) => s.lspActivation);
  const preset = serverForLanguage(langId, customServers, lspActivation);
  const activation = preset ? lspActivation[preset.id] : undefined;
  const generation = useLspRuntimeStore((s) =>
    preset ? (s.generations[preset.id] ?? 0) : 0,
  );

  const presetId = preset?.id;
  const identity = useMemo(
    () => ({ path, langId, ready, activation, generation, presetId }),
    [path, langId, ready, activation, generation, presetId],
  );
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [bound, setBound] = useState<{
    identity: typeof identity;
    extension: Extension;
  } | null>(null);
  const [waiting, setWaiting] = useState<typeof identity | null>(null);
  const starting = useMemo(
    () => startingNavigation(preset?.name ?? ""),
    [preset?.name],
  );

  useEffect(() => {
    const { path, langId, ready, activation } = identity;
    if (!ready || !langId || activation !== "enabled") return;
    let cancelled = false;
    let handle: LspDocHandle | null = null;
    setWaiting(identity);
    acquireDocExtension(path, langId)
      .then((h) => {
        if (!h) return;
        if (cancelled || identityRef.current !== identity) {
          h.release();
          return;
        }
        handle = h;
        setBound({ identity, extension: h.extension });
      })
      .catch((e) => console.error("[lsp] acquire failed", e))
      .finally(() => {
        if (!cancelled) setWaiting(null);
      });
    return () => {
      cancelled = true;
      handle?.release();
    };
  }, [identity]);

  return bound?.identity === identity
    ? bound.extension
    : waiting === identity
      ? starting
      : null;
}
