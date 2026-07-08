// web/src/session/useSession.ts
//
// Live session state over the xmb-api WebSocket. Opens `/api/ws?token=…` on the
// current origin (ws:// or wss:// mirroring http/https), parses each frame as a
// SessionSnapshot, and reconnects with a short exponential backoff if the socket
// drops. Returns null until the first frame arrives (the server pushes a snapshot
// immediately on connect). Cleans up on unmount / token change.
//
// jsdom has no WebSocket; when the global is absent the hook is a no-op so unit
// tests that render the app don't blow up.

import { useEffect, useState } from "react";
import type { SessionSnapshot } from "../api/types.js";

const INITIAL_BACKOFF = 500;
const MAX_BACKOFF = 8000;

/** Build the same-origin ws(s):// URL for the session socket. */
function wsUrl(token: string): string {
  const url = new URL("/api/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

export function useSession(token: string | null): SessionSnapshot | null {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);

  useEffect(() => {
    setSnapshot(null);
    if (!token) return;
    if (typeof WebSocket === "undefined") return; // jsdom / SSR guard

    let disposed = false;
    let socket: WebSocket | null = null;
    let backoff = INITIAL_BACKOFF;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(wsUrl(token));
      socket = ws;

      ws.onopen = () => {
        backoff = INITIAL_BACKOFF;
      };
      ws.onmessage = (event) => {
        try {
          setSnapshot(JSON.parse(String(event.data)) as SessionSnapshot);
        } catch {
          // Ignore malformed frames; keep the last good snapshot.
        }
      };
      ws.onerror = () => {
        ws.close();
      };
      ws.onclose = () => {
        if (disposed) return;
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (socket) {
        socket.onclose = null; // don't schedule a reconnect on intentional close
        socket.close();
      }
    };
  }, [token]);

  return snapshot;
}
