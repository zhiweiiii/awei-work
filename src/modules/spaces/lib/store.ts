import { LazyStore } from "@tauri-apps/plugin-store";
import type { WorkspaceEnv } from "@/modules/workspace";
import {
  isSerializedTabs,
  type SerializedTab,
} from "@/modules/spaces/lib/serialize";
import { SPACE_COLORS } from "@/modules/spaces/lib/spaceColor";

export type SpaceMeta = {
  id: string;
  name: string;
  root: string | null;
  env: WorkspaceEnv;
  /** Opt-in accent, index into SPACE_COLORS. Undefined = theme primary. */
  color?: number;
  createdAt: number;
  updatedAt: number;
};

export type SpaceState = {
  tabs: SerializedTab[];
  activeTabIndex: number;
};

const STORE_PATH = "terax-spaces.json";
const KEY_SPACES = "spaces";
const KEY_ACTIVE = "activeId";
const STATE_PREFIX = "state:";
const stateKey = (id: string) => `${STATE_PREFIX}${id}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 500 });
type StoredSpace = Omit<SpaceMeta, "env"> & { env: { kind: string } };
let retiredSpaces: StoredSpace[] = [];
let writeQueue: Promise<void> = Promise.resolve();
let dirty = false;

function write(action: () => Promise<void>, mutates = true): Promise<void> {
  const operation = writeQueue.then(async () => {
    await action();
    if (mutates) dirty = true;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export function flushStore(): Promise<void> {
  return write(async () => {
    if (!dirty) return;
    await store.save();
    dirty = false;
  }, false);
}

export type LoadedSpaces = {
  spaces: SpaceMeta[];
  activeId: string | null;
  states: Map<string, SpaceState>;
};

export async function loadAll(): Promise<LoadedSpaces> {
  const entries = new Map(await store.entries());
  const saved = entries.has(KEY_SPACES) ? entries.get(KEY_SPACES) : [];
  if (
    !Array.isArray(saved) ||
    saved.length > 1000 ||
    !saved.every(isStoredSpace) ||
    new Set(saved.map((space) => space.id)).size !== saved.length
  )
    throw new Error(
      "Invalid saved workspace list. Original data has been retained.",
    );
  retiredSpaces = saved.filter((space) => space.env.kind !== "local");
  const spaces = saved.filter(
    (space): space is SpaceMeta => space.env.kind === "local",
  );
  const activeId = entries.get(KEY_ACTIVE) ?? null;
  if (activeId !== null && typeof activeId !== "string")
    throw new Error("Invalid saved active workspace.");
  const states = new Map<string, SpaceState>();
  for (const space of spaces) {
    const v = entries.get(stateKey(space.id));
    if (v !== undefined) {
      if (!v || typeof v !== "object")
        throw new Error("Invalid saved workspace state.");
      const state = v as SpaceState;
      if (
        !isSerializedTabs(state.tabs) ||
        !Number.isSafeInteger(state.activeTabIndex) ||
        state.activeTabIndex < 0
      )
        throw new Error(
          "Invalid saved workspace tabs. Original data has been retained.",
        );
      states.set(space.id, state);
    }
  }
  return { spaces, activeId, states };
}

function isStoredSpace(value: unknown): value is StoredSpace {
  if (!value || typeof value !== "object") return false;
  const space = value as StoredSpace;
  return (
    typeof space.id === "string" &&
    space.id.length > 0 &&
    typeof space.name === "string" &&
    (space.root === null || typeof space.root === "string") &&
    !!space.env &&
    typeof space.env.kind === "string" &&
    space.env.kind.length > 0 &&
    Number.isFinite(space.createdAt) &&
    Number.isFinite(space.updatedAt) &&
    (space.color === undefined ||
      (Number.isInteger(space.color) &&
        space.color >= 0 &&
        space.color < SPACE_COLORS.length))
  );
}

export async function saveSpacesList(spaces: SpaceMeta[]): Promise<void> {
  if (spaces.length + retiredSpaces.length > 1000)
    throw new Error("Workspace list exceeds the supported limit.");
  if (
    spaces.some((space) => retiredSpaces.some((saved) => saved.id === space.id))
  )
    throw new Error("Cannot overwrite a retired workspace.");
  await write(() => store.set(KEY_SPACES, [...spaces, ...retiredSpaces]));
}

export async function saveActiveId(id: string | null): Promise<void> {
  await write(() => store.set(KEY_ACTIVE, id));
}

export async function saveState(id: string, state: SpaceState): Promise<void> {
  if (retiredSpaces.some((space) => space.id === id))
    throw new Error("Cannot overwrite a retired workspace.");
  await write(() => store.set(stateKey(id), state));
}

export async function deleteSpaceData(id: string): Promise<void> {
  if (retiredSpaces.some((space) => space.id === id))
    throw new Error("Cannot delete a retired workspace.");
  await write(async () => {
    await store.delete(stateKey(id));
  });
}

export function newSpaceId(): string {
  return `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
