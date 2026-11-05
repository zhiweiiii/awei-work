import { pathIdentity } from "@/lib/pathIdentity";

export type EditorLocation = { path: string; line: number; character?: number };

const sameFile = (a: EditorLocation, b: EditorLocation) =>
  pathIdentity(a.path) === pathIdentity(b.path);
const sameLocation = (a: EditorLocation, b: EditorLocation) =>
  sameFile(a, b) &&
  a.line === b.line &&
  (a.character ?? 0) === (b.character ?? 0);

export class NavigationHistory {
  private entries: EditorLocation[] = [];
  private index = -1;

  record(origin: EditorLocation | null, target: EditorLocation): void {
    const entries = this.entries.slice(0, this.index + 1);
    const current = entries[entries.length - 1];
    if (origin) {
      if (current && sameFile(current, origin))
        entries[entries.length - 1] = origin;
      else entries.push(origin);
    }
    const last = entries[entries.length - 1];
    if (!last || !sameLocation(last, target)) entries.push(target);
    this.entries = entries.slice(-100);
    this.index = this.entries.length - 1;
  }

  go(direction: -1 | 1, current: EditorLocation | null): EditorLocation | null {
    const active = this.entries[this.index];
    if (current) {
      if (active && sameFile(current, active))
        this.entries[this.index] = current;
      else this.record(null, current);
    }
    const index = this.index + direction;
    if (index < 0 || index >= this.entries.length) return null;
    this.index = index;
    return this.entries[index];
  }
}
