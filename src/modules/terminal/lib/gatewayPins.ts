/**
 * Which relay each command line runs Claude Code against.
 *
 * Two answers can apply, and they are deliberately different in lifetime:
 *
 * - A pin belongs to one terminal. It is not persisted: routing one shell
 *   through a relay is a local choice, and it cannot outlive the terminal it
 *   was made for, because leaf ids are not reused.
 * - The global choice belongs to the app. "Use this everywhere" is a standing
 *   instruction, so it is a preference, and it is what every new shell
 *   inherits without anyone touching the panel again.
 *
 * A pin always wins, including an explicit "off": that is how one terminal can
 * stay unrouted while everything else goes through a relay.
 *
 * Read at spawn time by `useTerminalSession`, written by the status bar panel,
 * which restarts the terminal so the new value takes effect.
 */
const pins = new Map<number, string | null>();

let globalProvider: string | null = null;

/** Mirror of the persisted preference, kept here because the spawn path is not
 *  a React component and cannot subscribe. Set from `preferences.ts`. */
export function setGlobalGatewayProvider(providerId: string | null): void {
  globalProvider = providerId;
}

export function globalGatewayProvider(): string | null {
  return globalProvider;
}

/** The relay a new shell for this leaf should use, and why. */
export type GatewayRoute = {
  providerId: string;
  source: "pin" | "global";
};

export function gatewayRoute(leafId: number): GatewayRoute | null {
  if (pins.has(leafId)) {
    const pinned = pins.get(leafId);
    return pinned ? { providerId: pinned, source: "pin" } : null;
  }
  return globalProvider
    ? { providerId: globalProvider, source: "global" }
    : null;
}

/** What a leaf is explicitly pinned to, or `undefined` when it has no opinion
 *  of its own and follows the global choice. */
export function gatewayPin(leafId: number): string | null | undefined {
  return pins.get(leafId);
}

/** `null` is an explicit opt-out, which suppresses the global choice for this
 *  one terminal. */
export function setGatewayPin(leafId: number, providerId: string | null): void {
  pins.set(leafId, providerId);
}

/** Forget the pin so the terminal goes back to following the global choice. */
export function clearGatewayPin(leafId: number): void {
  pins.delete(leafId);
}
