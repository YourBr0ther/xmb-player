// api/src/store/jsonStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./jsonStore.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "store-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("returns fallback when file is missing", async () => {
  const v = await readJson(join(dir, "nope.json"), { a: 1 });
  expect(v).toEqual({ a: 1 });
});

it("round-trips a value", async () => {
  const p = join(dir, "x.json");
  await writeJsonAtomic(p, { hello: "world", n: 2 });
  expect(await readJson(p, null)).toEqual({ hello: "world", n: 2 });
});

it("leaves no temp files behind", async () => {
  const p = join(dir, "y.json");
  await writeJsonAtomic(p, { ok: true });
  const files = await readdir(dir);
  expect(files).toEqual(["y.json"]);
});

it("returns fallback when file holds invalid JSON", async () => {
  const p = join(dir, "bad.json");
  await writeJsonAtomic(p, { ok: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(p, "not json");
  expect(await readJson(p, { fallback: true })).toEqual({ fallback: true });
});
