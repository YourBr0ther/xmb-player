// api/src/http/server.test.ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "./server.js";
import type { SystemGroup } from "../types.js";

const LIB: SystemGroup[] = [
  { system: "gba", games: [
    { id: "abc", system: "gba", title: "Celeste", core: "mgba", size: 1, path: "/roms/gba/celeste.gba", artwork: null }] },
];

function fakes() {
  const session = {
    snapshot: () => ({ state: "off", game: null, node: null, since: 0 }),
    start: async (_g: any) => {},
    command: async (_c: any) => {},
    powerOff: async () => {},
  };
  const started: string[] = [];
  session.start = async (g: any) => { started.push(g.id); };
  const library = { get: () => LIB, scan: async () => LIB };
  return { session, library, started };
}

const TOKEN = "tok";
function app() { const f = fakes(); return { app: createApp({ ...f, token: TOKEN }), f }; }
const auth = { Authorization: `Bearer ${TOKEN}` };

it("healthz needs no auth", async () => {
  const { app: a } = app();
  const res = await request(a).get("/healthz");
  expect(res.status).toBe(200);
});

it("library requires auth", async () => {
  const { app: a } = app();
  expect((await request(a).get("/api/library")).status).toBe(401);
  const ok = await request(a).get("/api/library").set(auth);
  expect(ok.status).toBe(200);
  expect(ok.body[0].system).toBe("gba");
});

it("scan returns fresh catalog", async () => {
  const { app: a } = app();
  const res = await request(a).post("/api/library/scan").set(auth);
  expect(res.status).toBe(200);
  expect(res.body[0].games[0].title).toBe("Celeste");
});

it("session start resolves the game id and returns the snapshot", async () => {
  const { app: a, f } = app();
  const res = await request(a).post("/api/session/start").set(auth).send({ gameId: "abc" });
  expect(res.status).toBe(202);
  expect(f.started).toEqual(["abc"]);
});

it("session start with unknown game id is 404", async () => {
  const { app: a } = app();
  const res = await request(a).post("/api/session/start").set(auth).send({ gameId: "nope" });
  expect(res.status).toBe(404);
});

it("command validates the command name", async () => {
  const { app: a } = app();
  expect((await request(a).post("/api/session/command").set(auth).send({ command: "bogus" })).status).toBe(400);
  expect((await request(a).post("/api/session/command").set(auth).send({ command: "pause" })).status).toBe(200);
});

it("GET session returns the snapshot", async () => {
  const { app: a } = app();
  const res = await request(a).get("/api/session").set(auth);
  expect(res.body.state).toBe("off");
});

it("DELETE session powers off", async () => {
  const { app: a } = app();
  expect((await request(a).delete("/api/session").set(auth)).status).toBe(200);
});
