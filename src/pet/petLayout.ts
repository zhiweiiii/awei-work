import type { CSSProperties } from "react";

export type PetMode = "compact" | "notice";
type Rect = { x: number; y: number; width: number; height: number };
export type PetLayout = {
  revision: number;
  mode: PetMode;
  icon: Rect;
  bubble: Rect | null;
  below: boolean;
  tail: number;
};
type Style = CSSProperties & Record<`--${string}`, string>;

export function layoutStyles(layout: PetLayout | undefined) {
  const icon = layout?.icon ?? { x: 360, y: 452, width: 76, height: 96 };
  const bubble = layout?.bubble ?? { x: 116, y: 344, width: 312, height: 98 };
  const below = layout?.below ?? false;
  const notice: Style = {
    left: bubble.x,
    width: bubble.width,
    ...(below
      ? { top: bubble.y }
      : { bottom: 1000 - bubble.y - bubble.height }),
    maxHeight: bubble.height,
    "--pet-tail-left": `${layout?.tail ?? icon.x + icon.width / 2 - bubble.x - 6}px`,
    "--pet-bubble-height": `${bubble.height}px`,
  };
  return {
    below,
    icon: { left: icon.x + 4, top: icon.y + 4 } satisfies CSSProperties,
    notice,
  };
}
