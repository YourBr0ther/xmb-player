// api/src/library/scanner.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanLibrary, cleanTitle, SYSTEM_CORES } from "./scanner.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "roms-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function put(sys: string, name: string, bytes = 8) {
  await mkdir(join(root, sys), { recursive: true });
  await writeFile(join(root, sys, name), Buffer.alloc(bytes));
}

describe("cleanTitle", () => {
  it("strips extension", () => {
    expect(cleanTitle("Celeste.gba")).toBe("Celeste");
  });
  it("strips region and dump tags", () => {
    expect(cleanTitle("Chrono Trigger (USA) [!].sfc")).toBe("Chrono Trigger");
  });
  it("collapses underscores and dots to spaces", () => {
    expect(cleanTitle("Final_Fantasy.VII.iso")).toBe("Final Fantasy VII");
  });
});

describe("SYSTEM_CORES", () => {
  it("maps all 8 v1 systems", () => {
    expect(SYSTEM_CORES).toEqual({
      psp: "ppsspp", ps: "swanstation", n64: "mupen64plus-next",
      ngc: "dolphin", dc: "flycast", snes: "snes9x",
      megadrive: "genesis_plus_gx", gba: "mgba",
    });
  });
});

describe("scanLibrary", () => {
  it("returns games grouped by system with core + size", async () => {
    await put("gba", "Celeste.gba", 16);
    await put("snes", "Chrono Trigger (USA).sfc", 32);
    const groups = await scanLibrary(root);
    const gba = groups.find(g => g.system === "gba")!;
    expect(gba.games).toHaveLength(1);
    expect(gba.games[0]).toMatchObject({
      system: "gba", title: "Celeste", core: "mgba", size: 16,
      path: join(root, "gba", "Celeste.gba"), artwork: null,
    });
    expect(gba.games[0].id).toMatch(/^[a-f0-9]{16}$/);
  });

  it("ignores unknown system folders", async () => {
    await put("switch", "game.nsp");
    await put("gba", "ok.gba");
    const groups = await scanLibrary(root);
    expect(groups.map(g => g.system)).toEqual(["gba"]);
  });

  it("tolerates empty and missing folders", async () => {
    await mkdir(join(root, "psp"), { recursive: true });
    const groups = await scanLibrary(root);
    expect(groups).toEqual([]); // empty system folders produce no group
  });

  it("gives stable ids across scans", async () => {
    await put("gba", "A.gba");
    const a = (await scanLibrary(root))[0].games[0].id;
    const b = (await scanLibrary(root))[0].games[0].id;
    expect(a).toBe(b);
  });

  it("skips dotfiles and directories inside system folders", async () => {
    await put("gba", ".DS_Store");
    await mkdir(join(root, "gba", "subdir"), { recursive: true });
    await put("gba", "real.gba");
    const groups = await scanLibrary(root);
    expect(groups[0].games.map(g => g.title)).toEqual(["real"]);
  });
});
