import type { ClusterPort, SupervisorPort } from "./ports.js";
import type { Game, SessionSnapshot } from "../types.js";

interface Options { pollMs?: number; timeoutMs?: number; now?: () => number; }

export class SessionManager {
  private snap: SessionSnapshot = { state: "off", game: null, node: null, since: 0 };
  private listeners = new Set<(s: SessionSnapshot) => void>();
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private busy = false;
  private generation = 0;

  constructor(
    private cluster: ClusterPort,
    private supervisor: SupervisorPort,
    opts: Options = {},
  ) {
    this.pollMs = opts.pollMs ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 600_000;
    this.now = opts.now ?? (() => Date.now());
    this.snap.since = this.now();
  }

  snapshot(): SessionSnapshot { return { ...this.snap }; }

  onChange(cb: (s: SessionSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(patch: Partial<SessionSnapshot>): void {
    const next = { ...this.snap, ...patch };
    const unchanged =
      next.state === this.snap.state &&
      next.substate === this.snap.substate &&
      next.node === this.snap.node &&
      next.error === this.snap.error &&
      JSON.stringify(next.game) === JSON.stringify(this.snap.game);
    if (unchanged) return;
    this.snap = { ...next, since: this.now() };
    for (const cb of this.listeners) cb(this.snapshot());
  }

  private async waitForReady(gen: number): Promise<string> {
    const deadline = this.now() + this.timeoutMs;
    while (this.now() < deadline) {
      // Bail immediately if this start() was superseded (e.g. powerOff mid-boot),
      // rather than polling a doomed pod until the full timeout — which would
      // otherwise hold `busy` and lock out new starts for the whole timeout.
      if (gen !== this.generation) throw new Error("superseded");
      const st = await this.cluster.podStatus();
      if (st.phase === "Pending") this.set({ substate: "pulling/scheduling" });
      if (st.phase === "Running" && st.ready && st.hostIP) {
        this.set({ substate: "pod-ready", node: st.hostIP });
        return st.hostIP;
      }
      await new Promise(r => setTimeout(r, this.pollMs));
    }
    throw new Error("no GPU available or pod not ready before timeout");
  }

  async start(game: Game): Promise<void> {
    if (this.busy) throw new Error("session busy");
    this.busy = true;
    const gen = ++this.generation;
    try {
      this.set({ state: "starting", substate: undefined,
        game: { id: game.id, title: game.title, system: game.system }, error: undefined });
      const st = await this.cluster.podStatus();
      if (!(st.phase === "Running" && st.ready)) {
        this.set({ substate: "scaling" });
        await this.cluster.scale(1);
      }
      const hostIP = await this.waitForReady(gen);
      if (gen !== this.generation) return;            // superseded (e.g. powerOff)
      this.set({ substate: "loading-game" });
      await this.supervisor.startGame(hostIP, game.core, game.path);
      if (gen !== this.generation) return;            // superseded
      this.set({ state: "in-game", substate: undefined });
    } catch (e) {
      if (gen !== this.generation) return;            // superseded; don't clobber authoritative state
      const msg = e instanceof Error ? e.message : String(e);
      const st = await this.cluster.podStatus().catch(() => null);
      const warm = st?.phase === "Running" && st.ready;
      if (!warm) await this.cluster.scale(0).catch(() => {}); // don't leave a Pending pod burning a GPU slot
      this.set({ state: warm ? "idle" : "off", substate: undefined,
        game: null, node: warm ? this.snap.node : null, error: msg });
      throw e;
    } finally {
      this.busy = false;
    }
  }

  async command(cmd: "pause" | "save_state" | "load_state" | "quit"): Promise<void> {
    const node = this.snap.node;
    if (!node) throw new Error("no active session");
    if (cmd === "quit") {
      this.generation++;                              // invalidate any in-flight start
      await this.supervisor.stopGame(node);
      this.set({ state: "idle", substate: undefined, game: null, error: undefined });
      return;
    }
    await this.supervisor.command(node, cmd);
  }

  async powerOff(): Promise<void> {
    this.generation++;                                // invalidate any in-flight start
    const node = this.snap.node;
    if (node) await this.supervisor.stopGame(node).catch(() => {});
    await this.cluster.scale(0);
    this.set({ state: "off", substate: undefined, game: null, node: null, error: undefined });
  }
}
