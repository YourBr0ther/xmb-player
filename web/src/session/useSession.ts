// web/src/session/useSession.ts
//
// Live session state, tracked two ways so the UI stays correct even in hostile
// network conditions:
//   1. A WebSocket (`/api/ws`) for instant push updates.
//   2. A poll of `GET /api/session` every POLL_MS as a fallback.
// Whichever delivers the newer snapshot (by `since`) wins. The poll matters
// because a plain fetch survives some ingress/auth setups where a long-lived
// WebSocket upgrade does not (e.g. forwardAuth quirks) — so launches still
// reflect in the UI even if the socket never connects.
//
// Returns null until the first update. Cleans up on unmount. No token in the
// URL — access is gated by Authelia at the ingress. jsdom has no WebSocket /
// fetch guards keep unit tests that render the app from blowing up.

import { useEffect, useRef, useState } from "react";
import type { SessionSnapshot } from "../api/types.js";

const INITIAL_BACKOFF = 500;
const MAX_BACKOFF = 8000;
const POLL_MS = 2000;

/** Build the same-origin ws(s):// URL for the session socket. */
function wsUrl(): string {
  const url = new URL("/api/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function useSession(): SessionSnapshot | null {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  // `since` of the newest snapshot applied, so a stale poll can't clobber a
  // fresher WS frame (or vice-versa).
  const latestSince = useRef(-1);

  useEffect(() => {
    setSnapshot(null);
    latestSince.current = -1;
    let disposed = false;

    const apply = (s: SessionSnapshot) => {
      if (disposed) return;
      if (typeof s.since === "number" && s.since < latestSince.current) return;
      latestSince.current = typeof s.since === "number" ? s.since : latestSince.current;
      setSnapshot(s);
    };

    // --- 1. WebSocket (instant) ---
    let socket: WebSocket | null = null;
    let backoff = INITIAL_BACKOFF;
    let retry: ReturnType<typeof setTimeout> | null = null;
    if (typeof WebSocket !== "undefined") {
      const connect = () => {
        if (disposed) return;
        const ws = new WebSocket(wsUrl());
        socket = ws;
        ws.onopen = () => { backoff = INITIAL_BACKOFF; };
        ws.onmessage = (event) => {
          try { apply(JSON.parse(String(event.data)) as SessionSnapshot); } catch { /* ignore */ }
        };
        ws.onerror = () => ws.close();
        ws.onclose = () => {
          if (disposed) return;
          retry = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
        };
      };
      connect();
    }

    // --- 2. Polling fallback (reliable) ---
    let poll: ReturnType<typeof setInterval> | null = null;
    if (typeof fetch !== "undefined") {
      const tick = () => {
        fetch("/api/session")
          .then((r) => (r.ok ? r.json() : null))
          .then((s) => { if (s) apply(s as SessionSnapshot); })
          .catch(() => { /* transient; next tick retries */ });
      };
      tick();
      poll = setInterval(tick, POLL_MS);
    }

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (poll) clearInterval(poll);
      if (socket) {
        socket.onclose = null; // don't schedule a reconnect on intentional close
        socket.close();
      }
    };
  }, []);

  return snapshot;
}
