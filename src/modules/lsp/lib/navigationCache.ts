export type NavigationResult = {
  title: string;
  locations: {
    uri: string;
    range: { start: { line: number; character: number } };
  }[];
};

export class NavigationResultCache {
  private entries = new Map<
    string,
    { result: NavigationResult; bytes: number; expiresAt: number }
  >();
  private bytes = 0;
  generation = 0;

  get(key: string): NavigationResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= Date.now()) {
      this.bytes -= entry.bytes;
      return undefined;
    }
    this.entries.set(key, entry);
    return entry.result;
  }

  set(key: string, result: NavigationResult, generation: number): void {
    if (generation !== this.generation || !result.locations.length) return;
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(key);
    }
    const compact: NavigationResult = {
      title: result.title,
      locations: result.locations.map(({ uri, range }) => ({
        uri,
        range: {
          start: { line: range.start.line, character: range.start.character },
        },
      })),
    };
    const bytes =
      key.length * 2 +
      JSON.stringify(compact).length * 2 +
      compact.locations.length * 64 +
      128;
    if (bytes > 128 * 1024) return;
    this.entries.set(key, {
      result: compact,
      bytes,
      expiresAt: Date.now() + 30_000,
    });
    this.bytes += bytes;
    while (this.entries.size > 2048 || this.bytes > 1024 * 1024) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.bytes -= oldest[1].bytes;
      this.entries.delete(oldest[0]);
    }
  }

  clear(): void {
    this.generation++;
    this.entries.clear();
    this.bytes = 0;
  }
}
