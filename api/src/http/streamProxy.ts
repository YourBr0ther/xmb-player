// api/src/http/streamProxy.ts
//
// Bridges the SPA (served from this origin) to the running game-session pod so
// the browser can stream over a single origin:
//   - GET /turn                -> proxied to http://<nodeIP>:8080/turn (RTCConfiguration JSON)
//   - WS  /webrtc/signalling/  -> proxied to ws://<nodeIP>:8080/webrtc/signalling/
//
// AUTH: xmb-api is a ClusterIP service reachable only through the Authelia-gated
// ingress, so access control lives at the ingress (single sign-on). /turn and
// /webrtc/signalling carry no app-level token — the Selkies client fetches them
// with no Authorization header anyway, and the game-session pod itself has no
// auth. Nothing here is directly LAN-reachable (unlike the hostNetwork pod).
import type { Server } from "node:http";
import type { Express, Request, Response } from "express";
import { WebSocketServer, WebSocket } from "ws";

const SIGNALING_PREFIX = "/webrtc/signalling";
const POD_PORT = 8080;

/**
 * True for the Selkies signalling endpoint: `/webrtc/signalling`,
 * `/webrtc/signalling/` (trailing slash), and any `/webrtc/signalling/...`
 * sub-path. False for everything else (notably `/api/ws`, which the
 * wsBroadcaster owns, and prefix impostors like `/webrtc/signallingX`).
 */
export function isSignalingPath(pathname: string): boolean {
  return pathname === SIGNALING_PREFIX || pathname.startsWith(SIGNALING_PREFIX + "/");
}

/** True only for the exact `/turn` path. */
export function isTurnPath(pathname: string): boolean {
  return pathname === "/turn";
}

/**
 * Returns the pod's HTTP base URL (`http://<nodeIP>:8080`) or THROWS when there
 * is no active session node. Callers that can respond gracefully (the /turn
 * route) should check `nodeIP()` for null first and return 503.
 */
export function pickUpstream(nodeIP: string | null): string {
  if (!nodeIP) throw new Error("no active session node");
  return `http://${nodeIP}:${POD_PORT}`;
}

/**
 * Manual WebSocket proxy: pipes text/binary frames both ways between the
 * browser-facing socket (`client`) and a fresh upstream connection to the pod.
 * Buffers client frames sent before the upstream connection opens.
 */
function proxyWs(client: WebSocket, upstreamUrl: string): void {
  const upstream = new WebSocket(upstreamUrl);
  const pending: Array<string | Buffer> = [];

  client.on("message", (data, isBinary) => {
    const payload = isBinary ? (data as Buffer) : data.toString();
    if (upstream.readyState === WebSocket.OPEN) upstream.send(payload);
    else pending.push(payload);
  });

  upstream.on("open", () => {
    for (const m of pending) upstream.send(m);
    pending.length = 0;
  });

  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(isBinary ? (data as Buffer) : data.toString());
    }
  });

  const closeClient = () => {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close();
  };
  const closeUpstream = () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
  };

  client.on("close", closeUpstream);
  upstream.on("close", closeClient);
  client.on("error", () => { closeUpstream(); });
  upstream.on("error", () => { closeClient(); });
}

/**
 * Attaches the /turn HTTP route and the /webrtc/signalling WS upgrade proxy.
 *
 * Upgrade-handler coexistence: this registers its OWN `server.on("upgrade")`
 * listener that acts ONLY on signalling paths and ignores everything else. The
 * wsBroadcaster's listener acts ONLY on `/api/ws` and ignores everything else.
 * Both run for every upgrade, each no-ops on paths it does not own, so exactly
 * one of them consumes the socket. Unmatched upgrades are left untouched.
 */
export function attachStreamProxy(
  server: Server,
  app: Express,
  deps: { nodeIP: () => string | null },
): void {
  // GET /turn -> pod's RTCConfiguration JSON. UNGATED (see auth note above).
  app.get("/turn", async (_req: Request, res: Response) => {
    const ip = deps.nodeIP();
    if (!ip) return res.status(503).json({ error: "no active session" });
    try {
      const upstream = await fetch(`${pickUpstream(ip)}/turn`);
      const body = await upstream.text();
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.type(contentType);
      res.status(upstream.status).send(body);
    } catch {
      res.status(502).json({ error: "turn upstream unreachable" });
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    // Only handle signalling upgrades; leave /api/ws (broadcaster) and all
    // other paths alone so the other upgrade listener can handle them.
    if (!isSignalingPath(url.pathname)) return;

    const ip = deps.nodeIP();
    // Can't cleanly 503 a raw upgrade — just close the socket.
    if (!ip) { socket.destroy(); return; }

    // Preserve the original path (trailing slash) AND query string verbatim.
    const upstreamUrl = `ws://${ip}:${POD_PORT}${req.url}`;
    wss.handleUpgrade(req, socket, head, (client) => {
      proxyWs(client, upstreamUrl);
    });
  });
}
