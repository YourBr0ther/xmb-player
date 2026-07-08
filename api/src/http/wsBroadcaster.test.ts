// api/src/http/wsBroadcaster.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { attachWs } from "./wsBroadcaster.js";
import type { SessionSnapshot } from "../types.js";

let server: Server;
afterEach(() => new Promise<void>(r => server?.close(() => r())));

function fakeSession() {
  let cb: ((s: SessionSnapshot) => void) | null = null;
  const snap: SessionSnapshot = { state: "off", game: null, node: null, since: 0 };
  return {
    snapshot: () => snap,
    onChange: (fn: (s: SessionSnapshot) => void) => { cb = fn; return () => { cb = null; }; },
    emit: (s: SessionSnapshot) => cb?.(s),
  };
}

async function listen(): Promise<number> {
  await new Promise<void>(r => server.listen(0, r));
  return (server.address() as any).port;
}

it("sends a snapshot on connect and pushes transitions", async () => {
  const session = fakeSession();
  server = createServer();
  attachWs(server, { session, path: "/api/ws" });
  const port = await listen();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  const messages: any[] = [];
  // Attach the message listener BEFORE awaiting "open": on loopback the initial
  // snapshot frame is coalesced with the 101 upgrade, so a listener attached
  // after "open" would miss it. (A real client sets onmessage synchronously too.)
  ws.on("message", d => messages.push(JSON.parse(d.toString())));
  await new Promise<void>(res => ws.on("open", () => res()));
  await new Promise(r => setTimeout(r, 20)); // receive initial snapshot
  session.emit({ state: "in-game", game: null, node: "10.0.2.198", since: 1 });
  await new Promise(r => setTimeout(r, 20));
  expect(messages[0].state).toBe("off");
  expect(messages.at(-1).state).toBe("in-game");
  ws.close();
});
