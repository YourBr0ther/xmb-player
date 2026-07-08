// web/src/api/client.test.ts
import { it, expect, vi, beforeEach } from "vitest";
import { createClient } from "./client.js";

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
  })) as any;
}

beforeEach(() => { vi.restoreAllMocks(); });

it("getLibrary returns json and sends no Authorization header", async () => {
  const f = mockFetch(200, [{ system: "gba", games: [] }]);
  vi.stubGlobal("fetch", f);
  const c = createClient();
  const lib = await c.getLibrary();
  expect(lib[0].system).toBe("gba");
  const [url, init] = f.mock.calls[0];
  expect(url).toBe("/api/library");
  expect(init.headers.Authorization).toBeUndefined();
});

it("start posts gameId", async () => {
  const f = mockFetch(202, { state: "starting" });
  vi.stubGlobal("fetch", f);
  await createClient().start("abc");
  const [url, init] = f.mock.calls[0];
  expect(url).toBe("/api/session/start");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ gameId: "abc" });
});

it("command posts the command", async () => {
  const f = mockFetch(200, { state: "idle" });
  vi.stubGlobal("fetch", f);
  await createClient().command("quit");
  expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ command: "quit" });
});

it("powerOff deletes the session", async () => {
  const f = mockFetch(200, { state: "off" });
  vi.stubGlobal("fetch", f);
  await createClient().powerOff();
  expect(f.mock.calls[0][0]).toBe("/api/session");
  expect(f.mock.calls[0][1].method).toBe("DELETE");
});

it("throws on a non-2xx response", async () => {
  vi.stubGlobal("fetch", mockFetch(500, { error: "boom" }));
  await expect(createClient().getLibrary()).rejects.toThrow(/500/);
});
