// api/src/http/server.ts
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { SystemGroup, Game } from "../types.js";

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

export function createApp(deps: { library: LibraryProvider; session: SessionLike; token: string }): Express {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization === `Bearer ${deps.token}`) return next();
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

  return app;
}
