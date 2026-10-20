import { create } from "zustand";
import { errorToast } from "@/lib/errorToast";
import { LOCAL_WORKSPACE, type WorkspaceEnv } from "@/modules/workspace";
import {
  deleteSpaceData,
  newSpaceId,
  saveActiveId,
  saveSpacesList,
  type SpaceMeta,
} from "./store";

type CreateInput = {
  id?: string;
  name: string;
  root: string | null;
  env?: WorkspaceEnv;
};

type State = {
  spaces: SpaceMeta[];
  activeId: string | null;
  hydrated: boolean;
  // Per-space active tab index loaded from disk, so persistence preserves it
  // for spaces the user never visits this session.
  initialActiveIndex: Record<string, number>;
  hydrate: (
    spaces: SpaceMeta[],
    activeId: string | null,
    initialActiveIndex?: Record<string, number>,
  ) => void;
  create: (input: CreateInput) => SpaceMeta;
  rename: (id: string, name: string) => void;
  setColor: (id: string, color: number | undefined) => void;
  reorder: (orderedIds: string[]) => void;
  remove: (id: string) => string | null;
  setActive: (id: string) => void;
};

function persist(operation: Promise<unknown>): void {
  void operation.catch((error) => errorToast("保存工作区失败", error));
}

export const useSpaces = create<State>((set, get) => ({
  spaces: [],
  activeId: null,
  hydrated: false,
  initialActiveIndex: {},

  hydrate: (spaces, activeId, initialActiveIndex = {}) => {
    set({ spaces, activeId, initialActiveIndex, hydrated: true });
  },

  create: (input) => {
    const now = Date.now();
    const meta: SpaceMeta = {
      id: input.id ?? newSpaceId(),
      name: input.name,
      root: input.root,
      env: LOCAL_WORKSPACE,
      createdAt: now,
      updatedAt: now,
    };
    const spaces = [...get().spaces, meta];
    set({ spaces });
    persist(saveSpacesList(spaces));
    return meta;
  },

  rename: (id, name) => {
    const spaces = get().spaces.map((s) =>
      s.id === id ? { ...s, name, updatedAt: Date.now() } : s,
    );
    set({ spaces });
    persist(saveSpacesList(spaces));
  },

  setColor: (id, color) => {
    const spaces = get().spaces.map((s) =>
      s.id === id ? { ...s, color, updatedAt: Date.now() } : s,
    );
    set({ spaces });
    persist(saveSpacesList(spaces));
  },

  reorder: (orderedIds) => {
    const byId = new Map(get().spaces.map((s) => [s.id, s]));
    const next: SpaceMeta[] = [];
    for (const id of orderedIds) {
      const s = byId.get(id);
      if (s) next.push(s);
    }
    for (const s of get().spaces) {
      if (!next.includes(s)) next.push(s);
    }
    if (next.length !== get().spaces.length) return;
    set({ spaces: next });
    persist(saveSpacesList(next));
  },

  remove: (id) => {
    const prev = get();
    if (
      prev.spaces.length <= 1 ||
      !prev.spaces.some((space) => space.id === id)
    )
      return prev.activeId;
    const spaces = prev.spaces.filter((s) => s.id !== id);
    let activeId = prev.activeId;
    if (activeId === id) activeId = spaces[0]?.id ?? null;
    set({ spaces, activeId });
    persist(saveSpacesList(spaces));
    persist(deleteSpaceData(id));
    if (activeId !== prev.activeId) persist(saveActiveId(activeId));
    return activeId;
  },

  setActive: (id) => {
    if (get().activeId === id || !get().spaces.some((space) => space.id === id))
      return;
    set({ activeId: id });
    persist(saveActiveId(id));
  },
}));
