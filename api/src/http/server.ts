// api/src/http/server.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { SystemGroup, Game } from "../types.js";
import { tokenMatches } from "./auth.js";

export interface LibraryProvider {
  get(): SystemGroup[];
  scan(): Promise<SystemGroup[]>;
}
export interface SessionLike {
  snapshot(): unknown;
  start(game: Game): Promise<void>;
  command(cmd: "pause" | "save_state" | "load_state" | "quit"): Promise<void>;
  powerOff(): Promise<void>;
}

const COMMANDS = new Set(["pause", "save_state", "load_state", "quit"]);

export function createApp(deps: { library: LibraryProvider; session: SessionLike; token: string; webDir?: string }): Express {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Static SPA (UNGATED). The built web/dist is bundled into the image at
  // WEB_DIR (default /app/web). index.html + JS must be fetchable WITHOUT the
  // bearer token so the user can load the app and THEN enter the PIN; the
  // bearer gate below stays on /api/* only. Guarded on the presence of a real
  // index.html so the process still starts (and /healthz works) when the dir is
  // absent — e.g. local dev and unit tests.
  const webDir = deps.webDir ?? process.env.WEB_DIR ?? "/app/web";
  const indexHtml = join(webDir, "index.html");
  const serveStatic = existsSync(indexHtml);
  if (serveStatic) {
    app.use(express.static(webDir));
  }

  // Bearer gate — scoped to /api/* so static assets, /healthz, /turn and
  // /webrtc (the stream proxy, attached separately) stay ungated.
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (tokenMatches(provided, deps.token)) return next();
    res.status(401).json({ error: "unauthorized" });
  });

  const findGame = (id: string): Game | undefined =>
    deps.library.get().flatMap(g => g.games).find(g => g.id === id);

  app.get("/api/library", (_req, res) => res.json(deps.library.get()));
  app.post("/api/library/scan", async (_req, res) => res.json(await deps.library.scan()));
  app.get("/api/session", (_req, res) => res.json(deps.session.snapshot()));

  app.post("/api/session/start", async (req, res) => {
    const game = findGame(req.body?.gameId);
    if (!game) return res.status(404).json({ error: "unknown gameId" });
    deps.session.start(game).catch(() => {}); // async; progress via WS
    res.status(202).json(deps.session.snapshot());
  });

  app.post("/api/session/command", async (req, res) => {
    const cmd = req.body?.command;
    if (!COMMANDS.has(cmd)) return res.status(400).json({ error: "bad command" });
    await deps.session.command(cmd);
    res.json(deps.session.snapshot());
  });

  app.delete("/api/session", async (_req, res) => {
    await deps.session.powerOff();
    res.json(deps.session.snapshot());
  });

  // SPA fallback (UNGATED): serve index.html for any GET that isn't an /api,
  // /healthz, /turn or /webrtc route and didn't match a real static file, so
  // client-side routes (e.g. /game/123) resolve to the app shell. Registered
  // before attachStreamProxy's /turn route runs, so the explicit next() lets
  // /turn fall through to that handler.
  if (serveStatic) {
    app.get(/.*/, (req: Request, res: Response, next: NextFunction) => {
      const p = req.path;
      if (p.startsWith("/api") || p === "/healthz" || p === "/turn" || p.startsWith("/webrtc")) {
        return next();
      }
      res.sendFile(indexHtml);
    });
  }

  return app;
}
