// api/src/http/wsBroadcaster.ts
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { SessionSnapshot } from "../types.js";

interface SessionEvents {
  snapshot(): SessionSnapshot;
  onChange(cb: (s: SessionSnapshot) => void): () => void;
}

// No token gate: access is controlled by Authelia at the ingress (xmb-api is
// ClusterIP-only), so the socket needs no query-string token — which also keeps
// secrets out of URLs/logs.
export function attachWs(server: Server, deps: { session: SessionEvents; path: string }): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== deps.path) return;
    wss.handleUpgrade(req, socket, head, ws => {
      ws.send(JSON.stringify(deps.session.snapshot()));
      const off = deps.session.onChange(s => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(s));
      });
      ws.on("close", off);
    });
  });
}
