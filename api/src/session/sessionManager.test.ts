import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "./sessionManager.js";
import type { ClusterPort, SupervisorPort, PodStatus } from "./ports.js";
import type { Game } from "../types.js";

const GAME: Game = {
  id: "abc", system: "gba", title: "Celeste", core: "mgba",
  size: 1, path: "/roms/gba/celeste.gba", artwork: null,
};

function fakeCluster(seq: PodStatus[]): ClusterPort & { replicas: number; calls: number } {
  let i = 0;
  return {
    replicas: 0,
    calls: 0,
    async scale(r) { this.replicas = r; },
    async podStatus() {
      this.calls++;
      return seq[Math.min(i++, seq.length - 1)];
    },
  };
}

function fakeSupervisor(): SupervisorPort & { started: any[] } {
  return {
    started: [],
    async status() { return { state: "running", game: { core: "mgba", rom: "/roms/gba/celeste.gba" } }; },
    async startGame(_ip, core, rom) { this.started.push({ core, rom }); },
    async stopGame() {},
    async command() {},
  };
}

const ready: PodStatus = { phase: "Running", ready: true, hostIP: "10.0.2.198" };

describe("SessionManager.start", () => {
  it("scales up, waits for ready, loads the game, ends in-game", async () => {
    const cluster = fakeCluster([
      { phase: "None", ready: false, hostIP: null },
      { phase: "Pending", ready: false, hostIP: null },
      ready,
    ]);
    const sup = fakeSupervisor();
    const m = new SessionManager(cluster, sup, { pollMs: 1, timeoutMs: 1000 });
    const events: string[] = [];
    m.onChange(s => events.push(s.substate ?? s.state));

    await m.start(GAME);

    expect(cluster.replicas).toBe(1);
    expect(sup.started).toEqual([{ core: "mgba", rom: "/roms/gba/celeste.gba" }]);
    const snap = m.snapshot();
    expect(snap.state).toBe("in-game");
    expect(snap.game).toEqual({ id: "abc", title: "Celeste", system: "gba" });
    expect(snap.node).toBe("10.0.2.198");
    expect(events).toContain("starting");
    expect(events).toContain("in-game");
  });

  it("swaps game without re-scaling when pod already running", async () => {
    const cluster = fakeCluster([ready]);
    cluster.replicas = 1;
    const sup = fakeSupervisor();
    const m = new SessionManager(cluster, sup, { pollMs: 1, timeoutMs: 1000 });
    const scaleSpy = vi.spyOn(cluster, "scale");
    await m.start(GAME);
    expect(scaleSpy).not.toHaveBeenCalled();
    expect(sup.started).toHaveLength(1);
  });

  it("reports 'no GPU available' when the pod stays Pending past timeout", async () => {
    const cluster = fakeCluster([{ phase: "Pending", ready: false, hostIP: null }]);
    const sup = fakeSupervisor();
    const m = new SessionManager(cluster, sup, { pollMs: 1, timeoutMs: 20 });
    await expect(m.start(GAME)).rejects.toThrow(/no GPU|timeout/i);
    const snap = m.snapshot();
    expect(snap.state).toBe("off");
    expect(snap.error).toMatch(/GPU|timeout/i);
  });

  it("goes to crashed/error if supervisor startGame throws", async () => {
    const cluster = fakeCluster([ready]);
    cluster.replicas = 1;
    const sup = fakeSupervisor();
    sup.startGame = async () => { throw new Error("boom"); };
    const m = new SessionManager(cluster, sup, { pollMs: 1, timeoutMs: 1000 });
    await expect(m.start(GAME)).rejects.toThrow();
    expect(["idle", "crashed"]).toContain(m.snapshot().state);
    expect(m.snapshot().error).toBeTruthy();
  });
});

describe("SessionManager.command", () => {
  it("quit keeps the pod warm and returns to idle", async () => {
    const cluster = fakeCluster([ready]);
    cluster.replicas = 1;
    const sup = fakeSupervisor();
    const stopSpy = vi.spyOn(sup, "stopGame");
    const m = new SessionManager(cluster, sup, { pollMs: 1, timeoutMs: 1000 });
    await m.start(GAME);
    await m.command("quit");
    expect(stopSpy).toHaveBeenCalled();
    expect(cluster.replicas).toBe(1);       // still warm
    expect(m.snapshot().state).toBe("idle");
    expect(m.snapshot().game).toBeNull();
  });

  it("pause/save_state/load_state forward to the supervisor without changing state", async () => {
    const cluster = fakeCluster([ready]);
    cluster.replicas = 1;
    const sup = fakeSupervisor();
    const cmdSpy = vi.spyOn(sup, "command");
    const m = new SessionManager(cluster, sup, { pollMs: 1, timeoutMs: 1000 });
    await m.start(GAME);
    await m.command("save_state");
    expect(cmdSpy).toHaveBeenCalledWith("10.0.2.198", "save_state");
    expect(m.snapshot().state).toBe("in-game");
  });
});

describe("SessionManager.powerOff", () => {
  it("scales to 0 and returns to off", async () => {
    const cluster = fakeCluster([ready]);
    cluster.replicas = 1;
    const sup = fakeSupervisor();
    const m = new SessionManager(cluster, sup, { pollMs: 1, timeoutMs: 1000 });
    await m.start(GAME);
    await m.powerOff();
    expect(cluster.replicas).toBe(0);
    expect(m.snapshot().state).toBe("off");
    expect(m.snapshot().game).toBeNull();
  });
});

describe("SessionManager concurrency & subscription", () => {
  it("rejects a concurrent start with 'session busy'", async () => {
    const cluster = fakeCluster([ready]); cluster.replicas = 1;
    const sup = fakeSupervisor();
    const m = new SessionManager(cluster, sup, { pollMs: 1, timeoutMs: 1000 });
    const p1 = m.start(GAME);
    await expect(m.start(GAME)).rejects.toThrow(/busy/i);
    await p1;
  });

  it("powerOff during an in-flight start does not leave state in-game", async () => {
    const cluster = fakeCluster([ready]); cluster.replicas = 1;
    const sup = fakeSupervisor();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    sup.startGame = async () => { await gate; };
    const m = new SessionManager(cluster, sup, { pollMs: 1, timeoutMs: 1000 });
    const starting = m.start(GAME);
    await new Promise(r => setTimeout(r, 20));  // let start() park inside startGame
    await m.powerOff();
    release();
    await starting;
    expect(m.snapshot().state).toBe("off");
    expect(cluster.replicas).toBe(0);
  });

  it("onChange unsubscribe stops delivery", async () => {
    const cluster = fakeCluster([ready]); cluster.replicas = 1;
    const sup = fakeSupervisor();
    const m = new SessionManager(cluster, sup, { pollMs: 1, timeoutMs: 1000 });
    const seen: string[] = [];
    const off = m.onChange(s => seen.push(s.state));
    off();
    await m.start(GAME);
    expect(seen).toEqual([]);
  });

  it("command without an active session throws", async () => {
    const cluster = fakeCluster([{ phase: "None", ready: false, hostIP: null }]);
    const sup = fakeSupervisor();
    const m = new SessionManager(cluster, sup, { pollMs: 1, timeoutMs: 1000 });
    await expect(m.command("pause")).rejects.toThrow(/no active session/i);
  });
});
