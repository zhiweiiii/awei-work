import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceEnv } from "@/modules/workspace";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { pathIdentity } from "@/lib/pathIdentity";
import type { AweiWorkLspClient } from "./client";
import { detectBinary } from "./detect";
import { getLspNavigator } from "./navigator";
import { type LspPreset, serverForLanguage } from "./presets";
import { useLspRuntimeStore } from "./runtimeStore";
import type { TauriLspTransport } from "./transport";
import { fileUriToPath, pathToFileUri } from "./uri";

const IDLE_SHUTDOWN_MS = 3 * 60 * 1000;
const CRASH_WINDOW_MS = 5 * 60 * 1000;
const MAX_CRASHES = 3;
const MAX_SESSIONS_PER_PRESET = 4;
const CRASH_COOLDOWN_MS = [2_000, 10_000, 30_000];
const EVICTION_MIN_AGE_MS = 10_000;

type Managed = {
  key: string;
  preset: LspPreset;
  root: string;
  client: AweiWorkLspClient;
  transport: TauriLspTransport;
  refs: Map<string, number>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  bornAt: number;
};

export type LspDocHandle = {
  extension: Extension;
  release: () => void;
};

const sessions = new Map<string, Managed>();
const creating = new Map<string, Promise<Managed | null>>();
const presetEpochs = new Map<string, number>();
const crashTimes = new Map<string, number[]>();

function currentEpoch(presetId: string): number {
  return presetEpochs.get(presetId) ?? 0;
}

function canAcquire(presetId: string, epoch: number): boolean {
  return (
    currentEpoch(presetId) === epoch &&
    currentWorkspaceEnv().kind === "local" &&
    usePreferencesStore.getState().lspActivation[presetId] === "enabled"
  );
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function crashedOut(key: string): boolean {
  const now = Date.now();
  const times = (crashTimes.get(key) ?? []).filter(
    (t) => now - t < CRASH_WINDOW_MS,
  );
  crashTimes.set(key, times);
  return times.length >= MAX_CRASHES;
}

function recordCrash(key: string): void {
  const times = crashTimes.get(key) ?? [];
  times.push(Date.now());
  crashTimes.set(key, times);
}

async function acquireManaged(
  path: string,
  langId: string,
  warm = false,
): Promise<{ managed: Managed; preset: LspPreset; epoch: number } | null> {
  if (currentWorkspaceEnv().kind !== "local") return null;
  const prefs = usePreferencesStore.getState();
  const preset = serverForLanguage(
    langId,
    prefs.lspCustomServers,
    prefs.lspActivation,
  );
  if (!preset) return null;
  const epoch = currentEpoch(preset.id);
  if (prefs.lspActivation[preset.id] !== "enabled") return null;
  if (!(await detectBinary(preset.command))) return null;
  if (!canAcquire(preset.id, epoch)) return null;

  // No project root means no session: a per-directory fallback multiplied
  // servers per open file and burned gigabytes.
  const markers = preset.rootMarkers.length > 0 ? preset.rootMarkers : [".git"];
  const root = await invoke<string | null>("lsp_resolve_root", {
    path,
    markers,
    language: langId,
  }).catch(() => null);
  if (!root) return null;
  if (warm && (await invoke<boolean>("lsp_java_cached", { root }))) return null;
  if (!canAcquire(preset.id, epoch)) return null;
  const key = `${preset.id}\u0000${pathIdentity(root)}`;
  if (crashedOut(key)) return null;
  // Evict idle sessions of other roots; the age guard keeps simultaneous
  // multi-root opens from evicting each other's newborn sessions.
  if (!sessions.has(key)) {
    const now = Date.now();
    const evictions: Promise<void>[] = [];
    for (const m of sessions.values()) {
      if (
        m.preset.id === preset.id &&
        m.refs.size === 0 &&
        m.client.javaStatus !== "indexing" &&
        !m.closing &&
        now - m.bornAt > EVICTION_MIN_AGE_MS
      ) {
        evictions.push(closeSession(m));
      }
    }
    await Promise.all(evictions);
    if (!canAcquire(preset.id, epoch)) return null;
  }

  const managed =
    sessions.get(key) ?? (await getOrCreateSession(key, preset, root, epoch));
  if (!managed || managed.closing) {
    if (warm && canAcquire(preset.id, epoch)) deferredWarmProjects.add(path);
    return null;
  }
  return { managed, preset, epoch };
}

export async function acquireDocExtension(
  path: string,
  langId: string,
): Promise<LspDocHandle | null> {
  const acquired = await acquireManaged(path, langId);
  if (!acquired) return null;
  const { managed, preset, epoch } = acquired;
  const uri = pathToFileUri(path);
  const languageId = preset.languages[langId] ?? langId;
  const mod = await import("./client");
  if (
    !canAcquire(preset.id, epoch) ||
    managed.closing ||
    sessions.get(managed.key) !== managed
  )
    return null;
  const extension: Extension = [
    mod.lspInteractions({
      client: managed.client,
      documentUri: uri,
      languageId,
      rootPath: managed.root.replace(/\\/g, "/"),
      onExternal: (extUri, line, character, origin) => {
        const target = fileUriToPath(extUri);
        if (target)
          getLspNavigator()?.openFile(target, line, character, origin);
        else toast.info("该目标是语言服务的虚拟源码，暂不能作为本地文件打开");
      },
    }),
    mod.languageServerWithTransport({
      client: managed.client,
      transport: managed.transport,
      rootUri: pathToFileUri(managed.root),
      workspaceFolders: [
        { uri: pathToFileUri(managed.root), name: basename(managed.root) },
      ],
      documentUri: uri,
      languageId,
      allowHTMLContent: false,
      synchronizationMethod: mod.SynchronizationMethod.Incremental,
    }) as Extension,
  ];

  addRef(managed, uri);
  let released = false;
  return {
    extension,
    release: () => {
      if (released) return;
      released = true;
      releaseRef(managed, uri);
    },
  };
}

export async function warmJavaProject(path: string): Promise<void> {
  const existing = warmRequests.get(pathIdentity(path));
  if (existing) return existing;
  const operation = warmTail.then(() => prepareJavaProject(path));
  warmRequests.set(pathIdentity(path), operation);
  warmTail = operation.catch(() => {});
  try {
    await operation;
  } finally {
    warmRequests.delete(pathIdentity(path));
  }
}

const warmRequests = new Map<string, Promise<void>>();
const deferredWarmProjects = new Set<string>();
let warmTail = Promise.resolve();

async function prepareJavaProject(path: string): Promise<void> {
  const prefs = usePreferencesStore.getState();
  const preset = serverForLanguage(
    "java",
    prefs.lspCustomServers,
    prefs.lspActivation,
  );
  if (preset?.id !== "jdtls" || prefs.lspActivation.jdtls !== "enabled") return;
  const acquired = await acquireManaged(path, "java", true);
  if (acquired) {
    try {
      await acquired.managed.client.waitUntilReady(
        new AbortController().signal,
      );
    } finally {
      scheduleIdle(acquired.managed);
    }
  }
}

function getOrCreateSession(
  key: string,
  preset: LspPreset,
  root: string,
  epoch: number,
): Promise<Managed | null> {
  const creationKey = `${key}\u0000${epoch}`;
  let inflight = creating.get(creationKey);
  if (!inflight) {
    if (!canAcquire(preset.id, epoch)) return Promise.resolve(null);
    const count =
      [...sessions.values()].filter((m) => m.preset.id === preset.id).length +
      [...creating.keys()].filter((k) => k.startsWith(`${preset.id}\u0000`))
        .length;
    if (count >= MAX_SESSIONS_PER_PRESET) return Promise.resolve(null);
    inflight = createSession(key, preset, root, epoch).finally(() =>
      creating.delete(creationKey),
    );
    creating.set(creationKey, inflight);
  }
  return inflight;
}

async function createSession(
  key: string,
  preset: LspPreset,
  root: string,
  epoch: number,
): Promise<Managed | null> {
  const existing = sessions.get(key);
  if (existing) return existing;

  const store = useLspRuntimeStore.getState();
  const removeStarting = () => {
    if (
      !sessions.has(key) &&
      (currentEpoch(preset.id) === epoch ||
        !creating.has(`${key}\u0000${currentEpoch(preset.id)}`))
    )
      store.removeSessionQuiet(key);
  };
  store.upsertSession({ key, presetId: preset.id, root, status: "starting" });

  const [{ TauriLspTransport }, { AweiWorkLspClient }] = await Promise.all([
    import("./transport"),
    import("./client"),
  ]);

  if (AweiWorkLspClient.hostPid === null) {
    AweiWorkLspClient.hostPid = await invoke<number>("lsp_host_pid").catch(
      () => null,
    );
  }

  const transport = new TauriLspTransport();
  if (!canAcquire(preset.id, epoch)) {
    removeStarting();
    return null;
  }
  try {
    let args = preset.args;
    let cacheGeneration: number | undefined;
    if (preset.id === "jdtls") {
      const launch = await invoke<{
        args: string[];
        warning: string | null;
        cacheGeneration: number;
      }>("lsp_java_launch", { root, args });
      args = launch.args;
      cacheGeneration = launch.cacheGeneration;
      if (!canAcquire(preset.id, epoch)) {
        removeStarting();
        return null;
      }
      if (launch.warning) toast.warning(launch.warning);
    }
    await transport.start({
      command: preset.command,
      args,
      root,
      env: preset.env,
      maxMemoryMb: preset.maxMemoryMb,
      cacheGeneration,
      configuration:
        typeof preset.initializationOptions === "object" &&
        preset.initializationOptions !== null &&
        "settings" in preset.initializationOptions
          ? preset.initializationOptions.settings
          : undefined,
    });
  } catch (e) {
    transport.close();
    if (!canAcquire(preset.id, epoch)) {
      removeStarting();
      return null;
    }
    recordCrash(key);
    store.removeSession(key, preset.id);
    toast.error(`${preset.name} language server failed to start`, {
      description: String(e),
    });
    return null;
  }
  if (!canAcquire(preset.id, epoch)) {
    transport.close();
    removeStarting();
    return null;
  }

  const rootUri = pathToFileUri(root);
  const client = new AweiWorkLspClient({
    transport,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: basename(root) }],
    documentUri: rootUri,
    languageId: "",
    initializationOptions: preset.initializationOptions,
    onClose: () => handleServerExit(key, transport),
    onError: (e) => console.error(`[lsp:${preset.id}]`, e),
  });

  const managed: Managed = {
    key,
    preset,
    root,
    client,
    transport,
    refs: new Map(),
    idleTimer: null,
    closing: false,
    bornAt: Date.now(),
  };
  sessions.set(key, managed);
  if (preset.id === "jdtls") {
    client.watchNavigationChanges(root);
    client.enableJavaStatus((status) => {
      if (sessions.get(key) !== managed || managed.closing) return;
      useLspRuntimeStore.getState().upsertSession({
        key,
        presetId: preset.id,
        root,
        status: status === "ready" ? "running" : status,
      });
      if (status !== "indexing") scheduleIdle(managed);
    });
  }
  // Exit can beat the map insert when the binary dies instantly (e.g. a
  // rustup proxy for an uninstalled component); reap it here.
  if (transport.exitInfo) {
    handleServerExit(key, transport);
    return null;
  }

  void client.initializePromise.then(() => {
    if (sessions.get(key) === managed) {
      if (!client.ready) {
        toast.error(`${preset.name} language server failed to initialize`);
        handleServerExit(key, transport);
        return;
      }
      const runtime = useLspRuntimeStore.getState();
      runtime.clearFailed(preset.id);
      runtime.upsertSession({
        key,
        presetId: preset.id,
        root,
        status:
          preset.id === "jdtls" && client.javaStatus !== "ready"
            ? client.javaStatus === "error"
              ? "error"
              : "indexing"
            : "running",
      });
    }
  });

  return managed;
}

function handleServerExit(key: string, transport: TauriLspTransport): void {
  const managed = sessions.get(key);
  if (!managed || managed.closing || managed.transport !== transport) return;
  managed.closing = true;
  if (managed.idleTimer) clearTimeout(managed.idleTimer);
  recordCrash(key);
  sessions.delete(key);
  managed.client.close();
  useLspRuntimeStore.getState().removeSessionQuiet(key);
  const info = managed.transport.exitInfo;
  if (info?.reason === "cache-deleted" || info?.reason === "app-closing") {
    crashTimes.delete(key);
    if (info.reason === "cache-deleted")
      toast.info("Java 索引缓存已删除，重新打开 Java 文件后重建");
    return;
  }
  // Budget kills don't respawn: reloading would repay the startup peak
  // that got the server killed. Restart from the pill is explicit.
  if (info?.reason) {
    crashTimes.set(
      key,
      Array.from({ length: MAX_CRASHES }, () => Date.now()),
    );
    useLspRuntimeStore.getState().setFailed(managed.preset.id, info.reason);
    toast.error(`${managed.preset.name} language server stopped`, {
      description: info.reason,
    });
    return;
  }
  const tail = info?.stderrTail;
  if (crashedOut(key)) {
    useLspRuntimeStore
      .getState()
      .setFailed(
        managed.preset.id,
        tail ? tail.slice(-300) : "The server kept crashing.",
      );
    toast.error(`${managed.preset.name} language server keeps crashing`, {
      description: tail ? tail.slice(-300) : "Giving up for this workspace.",
    });
    return;
  }
  if (tail) {
    toast.error(`${managed.preset.name} language server exited`, {
      description: tail.slice(-300),
    });
  }
  // Delay the re-acquire trigger so an OOM-killed server doesn't respawn
  // into an instant second memory spike.
  const crashes = crashTimes.get(key)?.length ?? 1;
  const delay =
    CRASH_COOLDOWN_MS[Math.min(crashes - 1, CRASH_COOLDOWN_MS.length - 1)];
  setTimeout(
    () => useLspRuntimeStore.getState().bumpGeneration(managed.preset.id),
    delay,
  );
}

function addRef(managed: Managed, uri: string): void {
  if (managed.idleTimer) {
    clearTimeout(managed.idleTimer);
    managed.idleTimer = null;
  }
  managed.refs.set(uri, (managed.refs.get(uri) ?? 0) + 1);
}

function releaseRef(managed: Managed, uri: string): void {
  const count = managed.refs.get(uri);
  if (count === undefined) return;
  if (count > 1) {
    managed.refs.set(uri, count - 1);
    return;
  }
  managed.refs.delete(uri);
  if (!managed.closing) managed.client.textDocumentDidClose(uri);
  scheduleIdle(managed);
}

function scheduleIdle(managed: Managed): void {
  if (
    managed.refs.size === 0 &&
    !managed.closing &&
    managed.client.javaStatus !== "indexing"
  ) {
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    managed.idleTimer = setTimeout(() => {
      void closeSession(managed);
    }, IDLE_SHUTDOWN_MS);
  }
}

async function closeSession(managed: Managed): Promise<void> {
  if (managed.closing) return;
  managed.closing = true;
  managed.client.releaseNavigationCache();
  if (managed.idleTimer) {
    clearTimeout(managed.idleTimer);
    managed.idleTimer = null;
  }
  useLspRuntimeStore.getState().removeSession(managed.key, managed.preset.id);
  try {
    await managed.transport.shutdown();
  } catch (error) {
    console.warn(`[lsp:${managed.preset.id}] shutdown failed`, error);
  } finally {
    managed.transport.close();
    managed.client.close();
    if (sessions.get(managed.key) === managed) sessions.delete(managed.key);
    if (deferredWarmProjects.size) {
      const pending = [...deferredWarmProjects];
      deferredWarmProjects.clear();
      for (const path of pending)
        void warmJavaProject(path).catch((error) =>
          console.warn("[lsp:java] deferred index failed", error),
        );
    }
    if (
      usePreferencesStore.getState().lspActivation[managed.preset.id] ===
      "enabled"
    )
      useLspRuntimeStore.getState().bumpGeneration(managed.preset.id);
  }
}

export function notifyDocumentSaved(path: string): void {
  const uri = pathToFileUri(path);
  for (const managed of sessions.values()) {
    if (managed.refs.has(uri) && !managed.closing) {
      managed.client.textDocumentDidSave(uri);
    }
  }
}

export function notifyNavigationSourceChanged(path: string): void {
  for (const managed of sessions.values())
    if (!managed.closing) managed.client.invalidateNavigationForPath(path);
}

export async function stopPresetSessions(presetId: string): Promise<void> {
  presetEpochs.set(presetId, currentEpoch(presetId) + 1);
  if (presetId === "jdtls") deferredWarmProjects.clear();
  const targets = [...sessions.values()].filter(
    (m) => m.preset.id === presetId,
  );
  await Promise.all(targets.map((m) => closeSession(m)));
  for (const key of crashTimes.keys()) {
    if (key.startsWith(`${presetId}\u0000`)) crashTimes.delete(key);
  }
}

export async function lspFormatDocument(
  view: EditorView,
): Promise<"done" | "unsupported"> {
  if (sessions.size === 0) return "unsupported";
  const { formatDocumentAndWait } = await import("./client");
  return formatDocumentAndWait(view);
}

// Open docs re-acquire automatically via the generation bump, so a stop
// while still enabled is a restart.
export async function restartPresetSessions(presetId: string): Promise<void> {
  await stopPresetSessions(presetId);
  const store = useLspRuntimeStore.getState();
  store.clearFailed(presetId);
  store.bumpGeneration(presetId);
}

// Disabling can happen in the Settings window; sessions live here. React to
// the mirrored preference change instead of a direct call.
usePreferencesStore.subscribe((state, prev) => {
  if (state.lspActivation === prev.lspActivation) return;
  for (const presetId of Object.keys(prev.lspActivation)) {
    if (
      prev.lspActivation[presetId] === "enabled" &&
      state.lspActivation[presetId] !== "enabled"
    ) {
      void stopPresetSessions(presetId);
    }
  }
});
