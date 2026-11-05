export function pathToFileUri(path: string): string {
  let p = path.replace(/\\/g, "/");
  if (p.startsWith("//")) {
    const [authority, ...parts] = p.slice(2).split("/");
    return `file://${authority}/${parts.map(encodeURIComponent).join("/")}`;
  }
  if (!p.startsWith("/")) p = `/${p}`;
  return `file://${p
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(/%3A/g, ":").replace(/%2B/g, "+"),
    )
    .join("/")}`;
}

export function fileUriToPath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:" || parsed.search || parsed.hash)
      return null;
    let p = decodeURIComponent(parsed.pathname);
    if (/[\u0000-\u001f]/.test(p)) return null;
    if (parsed.hostname && parsed.hostname !== "localhost")
      return `//${parsed.hostname}${p}`;
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p;
  } catch {
    return null;
  }
}
