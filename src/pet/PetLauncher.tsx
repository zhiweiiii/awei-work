import { type PointerEvent, useRef } from "react";
import { PetSprite } from "./PetSprite";

export function PetLauncher({
  phase,
  label,
  pending,
  onActivate,
  onDrag,
}: {
  phase: "working" | "attention" | "idle";
  label: string;
  pending: boolean;
  onActivate: () => void;
  onDrag: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const dragged = useRef(false);
  return (
    <button
      type="button"
      className="pet-launcher pet-drag"
      aria-label={label}
      aria-disabled={pending}
      onKeyDown={(event) => {
        if (pending && (event.key === "Enter" || event.key === " "))
          event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (pending || event.button !== 0 || !event.isPrimary) return;
        dragged.current = false;
        pointer.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const origin = pointer.current;
        if (
          !origin ||
          origin.id !== event.pointerId ||
          Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 6
        )
          return;
        dragged.current = true;
        pointer.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onDrag(event);
      }}
      onPointerUp={() => {
        pointer.current = null;
      }}
      onPointerCancel={() => {
        pointer.current = null;
        dragged.current = true;
      }}
      onLostPointerCapture={() => {
        pointer.current = null;
      }}
      onClick={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        if (event.detail === 0 || !dragged.current) onActivate();
      }}
    >
      <PetSprite phase={phase} />
    </button>
  );
}
