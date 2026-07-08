import type { SystemGroup, SessionSnapshot } from "./types.js";

export interface XmbClient {
  getLibrary(): Promise<SystemGroup[]>;
  scan(): Promise<SystemGroup[]>;
  getSession(): Promise<SessionSnapshot>;
  start(gameId: string): Promise<SessionSnapshot>;
  command(cmd: string): Promise<SessionSnapshot>;
  powerOff(): Promise<SessionSnapshot>;
}

// No Authorization header: xmb-api is gated by Authelia at the ingress (the
// browser is already authenticated same-origin), so the app sends no token.
export function createClient(base = ""): XmbClient {
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
  }

  return {
    getLibrary: () => request<SystemGroup[]>("GET", "/api/library"),
    scan: () => request<SystemGroup[]>("POST", "/api/library/scan"),
    getSession: () => request<SessionSnapshot>("GET", "/api/session"),
    start: (gameId: string) =>
      request<SessionSnapshot>("POST", "/api/session/start", { gameId }),
    command: (cmd: string) =>
      request<SessionSnapshot>("POST", "/api/session/command", { command: cmd }),
    powerOff: () => request<SessionSnapshot>("DELETE", "/api/session"),
  };
}
