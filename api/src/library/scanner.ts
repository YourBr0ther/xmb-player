// api/src/library/scanner.ts
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Game, SystemGroup, SystemId } from "../types.js";

export const SYSTEM_CORES: Record<SystemId, string> = {
  psp: "ppsspp",
  ps: "swanstation",
  n64: "mupen64plus-next",
  ngc: "dolphin",
  dc: "flycast",
  snes: "snes9x",
  megadrive: "genesis_plus_gx",
  gba: "mgba",
};

const SYSTEMS = Object.keys(SYSTEM_CORES) as SystemId[];

export function cleanTitle(filename: string): string {
  const noExt = filename.replace(/\.[^.]+$/, "");
  return noExt
    .replace(/[._]+/g, " ")           // underscores/dots -> spaces
    .replace(/\s*[([][^)\]]*[)\]]/g, "") // (USA), [!], etc.
    .replace(/\s+/g, " ")
    .trim();
}

function gameId(system: string, path: string): string {
  return createHash("sha1").update(`${system}:${path}`).digest("hex").slice(0, 16);
}

export async function scanLibrary(romsDir: string): Promise<SystemGroup[]> {
  const groups: SystemGroup[] = [];
  for (const system of SYSTEMS) {
    const dir = join(romsDir, system);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // missing folder
    }
    const games: Game[] = [];
    for (const name of entries.sort()) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      const s = await stat(path);
      if (!s.isFile()) continue;
      games.push({
        id: gameId(system, path),
        system,
        title: cleanTitle(name),
        core: SYSTEM_CORES[system],
        size: s.size,
        path,
        artwork: null,
      });
    }
    if (games.length > 0) groups.push({ system, games });
  }
  return groups;
}
