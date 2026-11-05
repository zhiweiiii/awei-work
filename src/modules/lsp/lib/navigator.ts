import type { EditorLocation } from "@/modules/editor/lib/navigationHistory";

export type LspNavigator = {
  openFile: (
    path: string,
    line: number,
    character?: number,
    origin?: EditorLocation,
  ) => void;
  getDocument?: (path: string) => string | null;
};

let current: LspNavigator | null = null;

export function setLspNavigator(nav: LspNavigator | null): void {
  current = nav;
}

export function getLspNavigator(): LspNavigator | null {
  return current;
}
