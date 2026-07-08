// Mirrors the xmb-api contract (api/src/types.ts).
export type SystemId =
  | "psp" | "ps" | "n64" | "ngc" | "dc" | "snes" | "megadrive" | "gba";

export interface Game {
  id: string;          // stable hash of system + relative path
  system: SystemId;
  title: string;       // cleaned display name
  core: string;        // libretro core (e.g. "mgba")
  size: number;        // bytes
  path: string;        // absolute path in the pod (/roms/<system>/<file>)
  artwork: string | null; // filled in 2b; null for now
}

export interface SystemGroup {
  system: SystemId;
  games: Game[];
}

export type SessionState =
  | "off" | "starting" | "in-game" | "idle" | "crashed";

export interface SessionSnapshot {
  state: SessionState;
  substate?: string;               // e.g. "scaling", "pod-ready", "loading-game"
  game: { id: string; title: string; system: SystemId } | null;
  node: string | null;             // node hostIP when known
  since: number;                   // epoch ms of last transition
  error?: string;
}
