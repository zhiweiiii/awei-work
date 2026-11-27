export function pathIdentity(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const normalized = slashed === "/" ? slashed : slashed.replace(/\/+$/, "");
  return /^[A-Za-z]:(?:\/|$)/.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

export function pathBasename(path: string, fallback = path): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : fallback;
}
