// api/src/http/wsBroadcaster.ts
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { SessionSnapshot } from "../types.js";
import { tokenMatches } from "./auth.js";

interface SessionEvents {
  snapshot(): SessionSnapshot;
  onChange(cb: (s: SessionSnapshot) => void): () => void;
}

export function attachWs(server: Server, deps: { session: SessionEvents; token: string; path: string }): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== deps.path) return;
    const token = url.searchParams.get("token") ??
      (req.headers.authorization?.replace(/^Bearer\s+/, "") ?? "");
    wss.handleUpgrade(req, socket, head, ws => {
      if (!tokenMatches(token, deps.token)) { ws.close(1008, "unauthorized"); return; }
      ws.send(JSON.stringify(deps.session.snapshot()));
      const off = deps.session.onChange(s => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(s));
      });
      ws.on("close", off);
    });
  });
}
