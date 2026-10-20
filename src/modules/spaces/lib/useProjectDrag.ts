import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { TerminalTab } from "@/modules/tabs/lib/useTabs";

export type ProjectDropTarget = {
  spaceId: string;
  projectId: number | null;
  beforeId: number | null;
  after: boolean;
};

type Gesture = {
  id: number;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  source: HTMLElement;
};

export function projectDropTarget(
  container: HTMLElement,
  x: number,
  y: number,
  projects: readonly TerminalTab[],
): ProjectDropTarget | null {
  const element = container.ownerDocument
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>("[data-project-drop-space]");
  if (!element || !container.contains(element)) return null;
  const spaceId = element.dataset.projectDropSpace;
  if (!spaceId) return null;
  const projectId = Number(element.dataset.projectDropId);
  if (!element.dataset.projectDropId)
    return { spaceId, projectId: null, beforeId: null, after: false };
  const list = projects.filter((project) => project.spaceId === spaceId);
  const index = list.findIndex((project) => project.id === projectId);
  if (index < 0) return null;
  const bounds = element.getBoundingClientRect();
  const after = y >= bounds.top + bounds.height / 2;
  return {
    spaceId,
    projectId,
    beforeId: after ? (list[index + 1]?.id ?? null) : projectId,
    after,
  };
}

export function useProjectDrag({
  open,
  containerRef,
  projects,
  onMove,
  onExpand,
}: {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  projects: readonly TerminalTab[];
  onMove: (id: number, spaceId: string, beforeId: number | null) => void;
  onExpand: (spaceId: string) => void;
}) {
  const latest = useRef({ projects, onMove, onExpand });
  latest.current = { projects, onMove, onExpand };
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [target, setTarget] = useState<ProjectDropTarget | null>(null);

  useEffect(() => {
    if (!open) return;
    suppressClick.current = false;
    let frame = 0;
    const updateTarget = (current: Gesture) => {
      const container = containerRef.current;
      const next = container
        ? projectDropTarget(
            container,
            current.x,
            current.y,
            latest.current.projects,
          )
        : null;
      setTarget((previous) =>
        previous?.spaceId === next?.spaceId &&
        previous?.projectId === next?.projectId &&
        previous?.after === next?.after
          ? previous
          : next,
      );
      if (next?.projectId === null) latest.current.onExpand(next.spaceId);
      return next;
    };
    const scroll = () => {
      frame = 0;
      const current = gesture.current;
      const container = containerRef.current;
      if (!current?.active || !container) return;
      const bounds = container.getBoundingClientRect();
      if (
        current.x < bounds.left ||
        current.x > bounds.right ||
        current.y < bounds.top ||
        current.y > bounds.bottom
      )
        return;
      const speed =
        current.y < bounds.top + 28
          ? -10
          : current.y > bounds.bottom - 28
            ? 10
            : 0;
      if (!speed) return;
      const previous = container.scrollTop;
      container.scrollTop += speed;
      updateTarget(current);
      if (previous !== container.scrollTop)
        frame = requestAnimationFrame(scroll);
    };
    const clear = () => {
      const current = gesture.current;
      gesture.current = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (current?.source.hasPointerCapture(current.pointerId))
        current.source.releasePointerCapture(current.pointerId);
      setDraggingId(null);
      setTarget(null);
    };
    const move = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (
        !current.source.isConnected ||
        !latest.current.projects.some((project) => project.id === current.id)
      ) {
        suppressClick.current = true;
        event.preventDefault();
        event.stopPropagation();
        clear();
        return;
      }
      if (!(event.buttons & 1)) {
        clear();
        return;
      }
      current.x = event.clientX;
      current.y = event.clientY;
      if (!current.active) {
        if (
          Math.hypot(current.x - current.startX, current.y - current.startY) < 6
        )
          return;
        current.active = true;
        suppressClick.current = true;
        setDraggingId(current.id);
        try {
          current.source.setPointerCapture(current.pointerId);
        } catch {
          clear();
          return;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      updateTarget(current);
      if (!frame) frame = requestAnimationFrame(scroll);
    };
    const up = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.active) {
        clear();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      current.x = event.clientX;
      current.y = event.clientY;
      const next = updateTarget(current);
      clear();
      if (next) latest.current.onMove(current.id, next.spaceId, next.beforeId);
    };
    const cancel = () => clear();
    const keydown = (event: KeyboardEvent) => {
      if (!gesture.current?.active) {
        suppressClick.current = false;
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      clear();
    };
    const click = (event: MouseEvent) => {
      if (!suppressClick.current || event.detail === 0) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const pointerdown = () => {
      if (!gesture.current?.active) suppressClick.current = false;
    };
    window.addEventListener("pointermove", move, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("click", click, true);
    window.addEventListener("pointerdown", pointerdown, true);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("pointerdown", pointerdown, true);
      clear();
    };
  }, [open, containerRef]);

  return {
    draggingId,
    target,
    isDragging: () => gesture.current?.active === true || suppressClick.current,
    begin: (id: number, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || !event.isPrimary || gesture.current) return;
      if ((event.target as Element).closest("button, input, a")) return;
      gesture.current = {
        id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false,
        source: event.currentTarget,
      };
    },
  };
}
