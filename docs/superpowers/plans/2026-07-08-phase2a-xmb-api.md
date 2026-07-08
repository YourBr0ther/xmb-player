# Phase 2a: xmb-api — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and test the `xmb-api` backend — scans the ROM library, orchestrates the game-session pod's lifecycle over the Kubernetes API + supervisor, and broadcasts session state over WebSocket — with no visual UI (that is Phase 2b).

**Architecture:** A Node + TypeScript service in the `psp-xmb` namespace. Pure domain logic (library scanner, session state machine) is isolated behind small interfaces so it is unit-tested with fakes and no cluster. Thin adapters implement those interfaces against the real Kubernetes API (`@kubernetes/client-node`) and the Phase 1 supervisor HTTP/UDP endpoints. An Express HTTP server + `ws` WebSocket expose the API; a bearer token gates everything except `/healthz`. Metadata/settings persist as atomic JSON files on a `/config` PVC.

**Tech Stack:** Node 20 (LTS), TypeScript (ESM, strict), Express 4, `ws`, `@kubernetes/client-node`, vitest + supertest, Docker buildx (linux/amd64), Docker Hub, k3s.

## Global Constraints

- All images build for `--platform linux/amd64` (cluster is x86_64; dev Mac is arm64).
- Namespace: `psp-xmb`. New Deployment/Service name: `xmb-api`, label `app: xmb-api`.
- Image: `docker.io/yourbr0ther/psp-xmb-api:phase2a`.
- Consumes Phase 1: game-session Deployment `game-session` (scaled 0↔1), supervisor HTTP `hostIP:9090` (bearer `SUPERVISOR_TOKEN`), RetroArch UDP `hostIP:55355`, ROM NFS PV mounted read-only at `/roms`.
- The 8 v1 systems and their cores are fixed (see the design doc `docs/superpowers/specs/2026-07-08-xmb-api-phase2a-design.md`):
  `psp→ppsspp, ps→swanstation, n64→mupen64plus-next, ngc→dolphin, dc→flycast, snes→snes9x, megadrive→genesis_plus_gx, gba→mgba`.
- Auth: one shared bearer token in a k8s Secret; all routes except `/healthz` require `Authorization: Bearer <token>` (WS via `?token=` query or `Authorization` header). Env `XMB_API_TOKEN`.
- Secrets never committed. Only `*.example.yaml` in git.
- TDD throughout: failing test first, minimal impl, green, commit. Frequent commits.
- No box-art scraping, no save/load-state UI, no visual UI in this phase.

---

### Task 1: Project scaffold

**Files:**
- Create: `api/package.json`, `api/tsconfig.json`, `api/vitest.config.ts`, `api/.gitignore`, `api/src/index.ts` (placeholder), `api/src/types.ts`

**Interfaces:**
- Produces: a buildable, testable TS project. Later tasks add modules under `api/src/`.

- [ ] **Step 1: Write `api/package.json`**

```json
{
  "name": "xmb-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@kubernetes/client-node": "^0.22.0",
    "express": "^4.21.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.0",
    "@types/supertest": "^6.0.2",
    "@types/ws": "^8.5.12",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `api/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `api/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 4: Write `api/.gitignore`**

```gitignore
node_modules/
dist/
*.log
```

- [ ] **Step 5: Write `api/src/types.ts`** (shared domain types)

```ts
export type SystemId =
  | "psp" | "ps" | "n64" | "ngc" | "dc" | "snes" | "megadrive" | "gba";

export interface Game {
  id: string;          // stable hash of system + relative path
  system: SystemId;
  title: string;       // cleaned display name
  core: string;        // libretro core (e.g. "mgba")
  size: number;        // bytes
  path: string;        // absolute path in the pod (/roms/<system>/<file>)
  artwork: string | null; // filled in 2b; null for now
}

export interface SystemGroup {
  system: SystemId;
  games: Game[];
}

export type SessionState =
  | "off" | "starting" | "in-game" | "idle" | "crashed";

export interface SessionSnapshot {
  state: SessionState;
  substate?: string;               // e.g. "scaling", "pod-ready", "loading-game"
  game: { id: string; title: string; system: SystemId } | null;
  node: string | null;             // node hostIP when known
  since: number;                   // epoch ms of last transition
  error?: string;
}
```

- [ ] **Step 6: Write `api/src/index.ts`** (placeholder, replaced in Task 8)

```ts
export const PLACEHOLDER = true;
```

- [ ] **Step 7: Install and verify**

Run:
```bash
cd api && npm install && npm run typecheck && npm test
```
Expected: typecheck passes; vitest runs with "no test files found" (exit 0). If npm registry access is blocked, STOP and report.

- [ ] **Step 8: Commit**

```bash
git add api/
git commit -m "feat(xmb-api): project scaffold (TS, express, ws, vitest)"
```

---

### Task 2: Library scanner (TDD)

**Files:**
- Test: `api/src/library/scanner.test.ts`
- Create: `api/src/library/scanner.ts`

**Interfaces:**
- Consumes: `types.ts`; a base directory (the `/roms` mount) passed in for testability.
- Produces: `scanLibrary(romsDir): Promise<SystemGroup[]>`, `cleanTitle(filename): string`, `SYSTEM_CORES` map. Used by the HTTP layer (Task 8) and persisted by Task 3.

- [ ] **Step 1: Write the failing tests**

```ts
// api/src/library/scanner.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanLibrary, cleanTitle, SYSTEM_CORES } from "./scanner.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "roms-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function put(sys: string, name: string, bytes = 8) {
  await mkdir(join(root, sys), { recursive: true });
  await writeFile(join(root, sys, name), Buffer.alloc(bytes));
}

describe("cleanTitle", () => {
  it("strips extension", () => {
    expect(cleanTitle("Celeste.gba")).toBe("Celeste");
  });
  it("strips region and dump tags", () => {
    expect(cleanTitle("Chrono Trigger (USA) [!].sfc")).toBe("Chrono Trigger");
  });
  it("collapses underscores and dots to spaces", () => {
    expect(cleanTitle("Final_Fantasy.VII.iso")).toBe("Final Fantasy VII");
  });
});

describe("SYSTEM_CORES", () => {
  it("maps all 8 v1 systems", () => {
    expect(SYSTEM_CORES).toEqual({
      psp: "ppsspp", ps: "swanstation", n64: "mupen64plus-next",
      ngc: "dolphin", dc: "flycast", snes: "snes9x",
      megadrive: "genesis_plus_gx", gba: "mgba",
    });
  });
});

describe("scanLibrary", () => {
  it("returns games grouped by system with core + size", async () => {
    await put("gba", "Celeste.gba", 16);
    await put("snes", "Chrono Trigger (USA).sfc", 32);
    const groups = await scanLibrary(root);
    const gba = groups.find(g => g.system === "gba")!;
    expect(gba.games).toHaveLength(1);
    expect(gba.games[0]).toMatchObject({
      system: "gba", title: "Celeste", core: "mgba", size: 16,
      path: join(root, "gba", "Celeste.gba"), artwork: null,
    });
    expect(gba.games[0].id).toMatch(/^[a-f0-9]{16}$/);
  });

  it("ignores unknown system folders", async () => {
    await put("switch", "game.nsp");
    await put("gba", "ok.gba");
    const groups = await scanLibrary(root);
    expect(groups.map(g => g.system)).toEqual(["gba"]);
  });

  it("tolerates empty and missing folders", async () => {
    await mkdir(join(root, "psp"), { recursive: true });
    const groups = await scanLibrary(root);
    expect(groups).toEqual([]); // empty system folders produce no group
  });

  it("gives stable ids across scans", async () => {
    await put("gba", "A.gba");
    const a = (await scanLibrary(root))[0].games[0].id;
    const b = (await scanLibrary(root))[0].games[0].id;
    expect(a).toBe(b);
  });

  it("skips dotfiles and directories inside system folders", async () => {
    await put("gba", ".DS_Store");
    await mkdir(join(root, "gba", "subdir"), { recursive: true });
    await put("gba", "real.gba");
    const groups = await scanLibrary(root);
    expect(groups[0].games.map(g => g.title)).toEqual(["real"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx vitest run src/library/scanner.test.ts`
Expected: FAIL — cannot resolve `./scanner.js`.

- [ ] **Step 3: Write the implementation**

```ts
// api/src/library/scanner.ts
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Game, SystemGroup, SystemId } from "../types.js";

export const SYSTEM_CORES: Record<SystemId, string> = {
  psp: "ppsspp",
  ps: "swanstation",
  n64: "mupen64plus-next",
  ngc: "dolphin",
  dc: "flycast",
  snes: "snes9x",
  megadrive: "genesis_plus_gx",
  gba: "mgba",
};

const SYSTEMS = Object.keys(SYSTEM_CORES) as SystemId[];

export function cleanTitle(filename: string): string {
  const noExt = filename.replace(/\.[^.]+$/, "");
  return noExt
    .replace(/[._]+/g, " ")           // underscores/dots -> spaces
    .replace(/\s*[([][^)\]]*[)\]]/g, "") // (USA), [!], etc.
    .replace(/\s+/g, " ")
    .trim();
}

function gameId(system: string, path: string): string {
  return createHash("sha1").update(`${system}:${path}`).digest("hex").slice(0, 16);
}

export async function scanLibrary(romsDir: string): Promise<SystemGroup[]> {
  const groups: SystemGroup[] = [];
  for (const system of SYSTEMS) {
    const dir = join(romsDir, system);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // missing folder
    }
    const games: Game[] = [];
    for (const name of entries.sort()) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      const s = await stat(path);
      if (!s.isFile()) continue;
      games.push({
        id: gameId(system, path),
        system,
        title: cleanTitle(name),
        core: SYSTEM_CORES[system],
        size: s.size,
        path,
        artwork: null,
      });
    }
    if (games.length > 0) groups.push({ system, games });
  }
  return groups;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npx vitest run src/library/scanner.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/library/
git commit -m "feat(xmb-api): ROM library scanner with system->core mapping (TDD)"
```

---

### Task 3: JSON persistence (TDD)

**Files:**
- Test: `api/src/store/jsonStore.test.ts`
- Create: `api/src/store/jsonStore.ts`

**Interfaces:**
- Produces: `readJson<T>(path, fallback): Promise<T>`, `writeJsonAtomic(path, value): Promise<void>`. Used to cache the library scan (`/config/library.json`) and settings (`/config/settings.json`).

- [ ] **Step 1: Write the failing tests**

```ts
// api/src/store/jsonStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./jsonStore.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "store-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("returns fallback when file is missing", async () => {
  const v = await readJson(join(dir, "nope.json"), { a: 1 });
  expect(v).toEqual({ a: 1 });
});

it("round-trips a value", async () => {
  const p = join(dir, "x.json");
  await writeJsonAtomic(p, { hello: "world", n: 2 });
  expect(await readJson(p, null)).toEqual({ hello: "world", n: 2 });
});

it("leaves no temp files behind", async () => {
  const p = join(dir, "y.json");
  await writeJsonAtomic(p, { ok: true });
  const files = await readdir(dir);
  expect(files).toEqual(["y.json"]);
});

it("returns fallback when file holds invalid JSON", async () => {
  const p = join(dir, "bad.json");
  await writeJsonAtomic(p, { ok: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(p, "not json");
  expect(await readJson(p, { fallback: true })).toEqual({ fallback: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx vitest run src/store/jsonStore.test.ts`
Expected: FAIL — cannot resolve `./jsonStore.js`.

- [ ] **Step 3: Write the implementation**

```ts
// api/src/store/jsonStore.ts
import { readFile, writeFile, rename } from "node:fs/promises";

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path); // atomic on same filesystem
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npx vitest run src/store/jsonStore.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/store/
git commit -m "feat(xmb-api): atomic JSON store (TDD)"
```

---

### Task 4: Session state machine (TDD, mocked cluster + supervisor)

**Files:**
- Create: `api/src/session/ports.ts` (interfaces)
- Test: `api/src/session/sessionManager.test.ts`
- Create: `api/src/session/sessionManager.ts`

**Interfaces:**
- Consumes: two injected ports so no cluster is needed in tests.
  - `ClusterPort`: `scale(replicas: 0|1): Promise<void>`; `podStatus(): Promise<{ phase: "None"|"Pending"|"Running"; ready: boolean; hostIP: string | null }>`.
  - `SupervisorPort`: `status(hostIP): Promise<{ state: "idle"|"running"|"crashed"; game: {core:string;rom:string}|null }>`; `startGame(hostIP, core, rom): Promise<void>`; `stopGame(hostIP): Promise<void>`; `command(hostIP, cmd): Promise<void>`.
- Produces: `SessionManager` with `start(game)`, `command(cmd)`, `powerOff()`, `snapshot()`, and an `onChange(cb)` subscription. It owns the `SessionSnapshot` and emits on every transition. This is the core orchestration logic; Task 8 wires real adapters, Task 9 broadcasts `onChange` over WS.

- [ ] **Step 1: Write the ports file**

```ts
// api/src/session/ports.ts
export interface PodStatus {
  phase: "None" | "Pending" | "Running";
  ready: boolean;
  hostIP: string | null;
}

export interface ClusterPort {
  scale(replicas: 0 | 1): Promise<void>;
  podStatus(): Promise<PodStatus>;
}

export interface SupervisorStatus {
  state: "idle" | "running" | "crashed";
  game: { core: string; rom: string } | null;
}

export interface SupervisorPort {
  status(hostIP: string): Promise<SupervisorStatus>;
  startGame(hostIP: string, core: string, rom: string): Promise<void>;
  stopGame(hostIP: string): Promise<void>;
  command(hostIP: string, cmd: string): Promise<void>;
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// api/src/session/sessionManager.test.ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd api && npx vitest run src/session/sessionManager.test.ts`
Expected: FAIL — cannot resolve `./sessionManager.js`.

- [ ] **Step 4: Write the implementation**

```ts
// api/src/session/sessionManager.ts
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
    this.snap = { ...this.snap, ...patch, since: this.now() };
    for (const cb of this.listeners) cb(this.snapshot());
  }

  private async waitForReady(): Promise<string> {
    const deadline = this.now() + this.timeoutMs;
    while (this.now() < deadline) {
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
    try {
      // Emit a bare "starting" transition (no substate) first so subscribers
      // that project `substate ?? state` observe the state entry, then the
      // "scaling" substate only when we actually scale.
      this.set({ state: "starting", substate: undefined,
        game: { id: game.id, title: game.title, system: game.system }, error: undefined });
      const st = await this.cluster.podStatus();
      if (!(st.phase === "Running" && st.ready)) {
        this.set({ substate: "scaling" });
        await this.cluster.scale(1);
      }
      const hostIP = await this.waitForReady();
      this.set({ substate: "loading-game" });
      await this.supervisor.startGame(hostIP, game.core, game.path);
      this.set({ state: "in-game", substate: undefined });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If the pod never came up, we are effectively off; otherwise idle.
      const st = await this.cluster.podStatus().catch(() => null);
      const warm = st?.phase === "Running" && st.ready;
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
      await this.supervisor.stopGame(node);
      this.set({ state: "idle", substate: undefined, game: null });
      return;
    }
    await this.supervisor.command(node, cmd);
  }

  async powerOff(): Promise<void> {
    const node = this.snap.node;
    if (node) await this.supervisor.stopGame(node).catch(() => {});
    await this.cluster.scale(0);
    this.set({ state: "off", substate: undefined, game: null, node: null });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && npx vitest run src/session/sessionManager.test.ts`
Expected: all PASS. Run twice to check for flakiness (timers).

- [ ] **Step 6: Commit**

```bash
git add api/src/session/
git commit -m "feat(xmb-api): session state machine over cluster+supervisor ports (TDD)"
```

---

### Task 5: Real Kubernetes adapter

**Files:**
- Create: `api/src/adapters/k8sCluster.ts`
- Test: `api/src/adapters/k8sCluster.test.ts`

**Interfaces:**
- Consumes: `@kubernetes/client-node`; env `POD_NAMESPACE` (default `psp-xmb`), `GAME_DEPLOYMENT` (default `game-session`), `GAME_LABEL` (default `app=game-session`).
- Produces: `K8sCluster implements ClusterPort`. Uses in-cluster config in the pod. `scale` patches the Deployment's `/spec/replicas`; `podStatus` lists pods by label and derives phase/ready/hostIP. Unit test covers the pure derivation helper only (no live cluster).

- [ ] **Step 1: Write the failing test (pure derivation helper)**

```ts
// api/src/adapters/k8sCluster.test.ts
import { describe, it, expect } from "vitest";
import { derivePodStatus } from "./k8sCluster.js";

it("returns None when no pods", () => {
  expect(derivePodStatus([])).toEqual({ phase: "None", ready: false, hostIP: null });
});

it("returns Pending for a scheduled-but-not-ready pod", () => {
  const pods = [{ status: { phase: "Pending", hostIP: undefined,
    containerStatuses: [{ ready: false }] } }];
  expect(derivePodStatus(pods as any)).toEqual({ phase: "Pending", ready: false, hostIP: null });
});

it("returns Running+ready+hostIP for a healthy pod", () => {
  const pods = [{ status: { phase: "Running", hostIP: "10.0.2.198",
    containerStatuses: [{ ready: true }] } }];
  expect(derivePodStatus(pods as any)).toEqual({ phase: "Running", ready: true, hostIP: "10.0.2.198" });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd api && npx vitest run src/adapters/k8sCluster.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write the implementation**

```ts
// api/src/adapters/k8sCluster.ts
import * as k8s from "@kubernetes/client-node";
import type { ClusterPort, PodStatus } from "../session/ports.js";

export function derivePodStatus(pods: k8s.V1Pod[]): PodStatus {
  if (pods.length === 0) return { phase: "None", ready: false, hostIP: null };
  const p = pods[0];
  const phase = (p.status?.phase as PodStatus["phase"]) ?? "Pending";
  const ready = (p.status?.containerStatuses ?? []).every(c => c.ready);
  const hostIP = p.status?.hostIP ?? null;
  const ph: PodStatus["phase"] = phase === "Running" ? "Running" : "Pending";
  return { phase: ph, ready: ready && ph === "Running", hostIP: ready ? hostIP : (ph === "Running" ? hostIP : null) };
}

export class K8sCluster implements ClusterPort {
  private apps: k8s.AppsV1Api;
  private core: k8s.CoreV1Api;
  constructor(
    private ns = process.env.POD_NAMESPACE ?? "psp-xmb",
    private deployment = process.env.GAME_DEPLOYMENT ?? "game-session",
    private labelSelector = process.env.GAME_LABEL ?? "app=game-session",
  ) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    this.apps = kc.makeApiClient(k8s.AppsV1Api);
    this.core = kc.makeApiClient(k8s.CoreV1Api);
  }
  async scale(replicas: 0 | 1): Promise<void> {
    await this.apps.patchNamespacedDeploymentScale(
      this.deployment, this.ns,
      { spec: { replicas } },
      undefined, undefined, undefined, undefined, undefined,
      { headers: { "Content-Type": "application/merge-patch+json" } },
    );
  }
  async podStatus(): Promise<PodStatus> {
    const res = await this.core.listNamespacedPod(
      this.ns, undefined, undefined, undefined, undefined, this.labelSelector);
    return derivePodStatus(res.body.items);
  }
}
```

*Note:* `@kubernetes/client-node` v0.22 API signatures can shift; if the positional-args form above fails typecheck, adapt to the installed version's `patchNamespacedDeploymentScale`/`listNamespacedPod` signature (object-args in newer versions). Keep `derivePodStatus` unchanged — it is what the test pins.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd api && npx vitest run src/adapters/k8sCluster.test.ts && npm run typecheck`
Expected: tests PASS; typecheck passes (adjust the k8s call signature if needed per the note).

- [ ] **Step 5: Commit**

```bash
git add api/src/adapters/k8sCluster.ts api/src/adapters/k8sCluster.test.ts
git commit -m "feat(xmb-api): kubernetes cluster adapter (scale + pod status)"
```

---

### Task 6: Real supervisor + RetroArch adapter

**Files:**
- Create: `api/src/adapters/supervisorClient.ts`
- Test: `api/src/adapters/supervisorClient.test.ts`

**Interfaces:**
- Consumes: `fetch` (Node 20 global) for supervisor HTTP `:9090` with bearer `SUPERVISOR_TOKEN`; `node:dgram` for RetroArch UDP `:55355`. Command map: `pause→"PAUSE_TOGGLE"`, `save_state→"SAVE_STATE"`, `load_state→"LOAD_STATE"`, `quit→"QUIT"` (though `quit` uses the supervisor `stopGame`, not UDP, so the pod supervisor observes the exit).
- Produces: `SupervisorClient implements SupervisorPort`. Test covers the command→UDP-string mapping helper and the HTTP request shape via a stub server.

- [ ] **Step 1: Write the failing tests**

```ts
// api/src/adapters/supervisorClient.test.ts
import { describe, it, expect } from "vitest";
import { retroArchCommand } from "./supervisorClient.js";

describe("retroArchCommand", () => {
  it("maps api commands to RetroArch network commands", () => {
    expect(retroArchCommand("pause")).toBe("PAUSE_TOGGLE");
    expect(retroArchCommand("save_state")).toBe("SAVE_STATE");
    expect(retroArchCommand("load_state")).toBe("LOAD_STATE");
  });
  it("throws on unknown command", () => {
    expect(() => retroArchCommand("explode" as any)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd api && npx vitest run src/adapters/supervisorClient.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```ts
// api/src/adapters/supervisorClient.ts
import { createSocket } from "node:dgram";
import type { SupervisorPort, SupervisorStatus } from "../session/ports.js";

const CMD: Record<string, string> = {
  pause: "PAUSE_TOGGLE", save_state: "SAVE_STATE", load_state: "LOAD_STATE",
};

export function retroArchCommand(cmd: "pause" | "save_state" | "load_state"): string {
  const v = CMD[cmd];
  if (!v) throw new Error(`unknown command: ${cmd}`);
  return v;
}

export class SupervisorClient implements SupervisorPort {
  constructor(
    private token = process.env.SUPERVISOR_TOKEN ?? "",
    private httpPort = 9090,
    private udpPort = 55355,
  ) {}

  private async http(hostIP: string, method: string, body?: unknown) {
    const res = await fetch(`http://${hostIP}:${this.httpPort}/game`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`supervisor ${method} /game -> ${res.status}`);
    return res.json();
  }

  async status(hostIP: string): Promise<SupervisorStatus> {
    const res = await fetch(`http://${hostIP}:${this.httpPort}/status`, {
      headers: { "Authorization": `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`supervisor /status -> ${res.status}`);
    return res.json() as Promise<SupervisorStatus>;
  }
  async startGame(hostIP: string, core: string, rom: string): Promise<void> {
    await this.http(hostIP, "POST", { core, rom });
  }
  async stopGame(hostIP: string): Promise<void> {
    await this.http(hostIP, "DELETE");
  }
  async command(hostIP: string, cmd: string): Promise<void> {
    const msg = Buffer.from(retroArchCommand(cmd as any));
    await new Promise<void>((resolve, reject) => {
      const sock = createSocket("udp4");
      sock.send(msg, this.udpPort, hostIP, err => {
        sock.close();
        err ? reject(err) : resolve();
      });
    });
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd api && npx vitest run src/adapters/supervisorClient.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/adapters/supervisorClient.ts api/src/adapters/supervisorClient.test.ts
git commit -m "feat(xmb-api): supervisor HTTP + RetroArch UDP adapter"
```

---

### Task 7: HTTP server, auth, and routes (TDD)

**Files:**
- Create: `api/src/http/server.ts`
- Test: `api/src/http/server.test.ts`

**Interfaces:**
- Consumes: a `LibraryProvider` (`{ get(): SystemGroup[]; scan(): Promise<SystemGroup[]> }`) and a `SessionManager`-shaped object, both injected for testability; token string.
- Produces: `createApp({ library, session, token })` returning an Express app implementing the REST surface from the design. `/healthz` unauthenticated; everything else requires `Authorization: Bearer <token>`.

- [ ] **Step 1: Write the failing tests**

```ts
// api/src/http/server.test.ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "./server.js";
import type { SystemGroup } from "../types.js";

const LIB: SystemGroup[] = [
  { system: "gba", games: [
    { id: "abc", system: "gba", title: "Celeste", core: "mgba", size: 1, path: "/roms/gba/celeste.gba", artwork: null }] },
];

function fakes() {
  const session = {
    snapshot: () => ({ state: "off", game: null, node: null, since: 0 }),
    start: async (_g: any) => {},
    command: async (_c: any) => {},
    powerOff: async () => {},
  };
  const started: string[] = [];
  session.start = async (g: any) => { started.push(g.id); };
  const library = { get: () => LIB, scan: async () => LIB };
  return { session, library, started };
}

const TOKEN = "tok";
function app() { const f = fakes(); return { app: createApp({ ...f, token: TOKEN }), f }; }
const auth = { Authorization: `Bearer ${TOKEN}` };

it("healthz needs no auth", async () => {
  const { app: a } = app();
  const res = await request(a).get("/healthz");
  expect(res.status).toBe(200);
});

it("library requires auth", async () => {
  const { app: a } = app();
  expect((await request(a).get("/api/library")).status).toBe(401);
  const ok = await request(a).get("/api/library").set(auth);
  expect(ok.status).toBe(200);
  expect(ok.body[0].system).toBe("gba");
});

it("scan returns fresh catalog", async () => {
  const { app: a } = app();
  const res = await request(a).post("/api/library/scan").set(auth);
  expect(res.status).toBe(200);
  expect(res.body[0].games[0].title).toBe("Celeste");
});

it("session start resolves the game id and returns the snapshot", async () => {
  const { app: a, f } = app();
  const res = await request(a).post("/api/session/start").set(auth).send({ gameId: "abc" });
  expect(res.status).toBe(202);
  expect(f.started).toEqual(["abc"]);
});

it("session start with unknown game id is 404", async () => {
  const { app: a } = app();
  const res = await request(a).post("/api/session/start").set(auth).send({ gameId: "nope" });
  expect(res.status).toBe(404);
});

it("command validates the command name", async () => {
  const { app: a } = app();
  expect((await request(a).post("/api/session/command").set(auth).send({ command: "bogus" })).status).toBe(400);
  expect((await request(a).post("/api/session/command").set(auth).send({ command: "pause" })).status).toBe(200);
});

it("GET session returns the snapshot", async () => {
  const { app: a } = app();
  const res = await request(a).get("/api/session").set(auth);
  expect(res.body.state).toBe("off");
});

it("DELETE session powers off", async () => {
  const { app: a } = app();
  expect((await request(a).delete("/api/session").set(auth)).status).toBe(200);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd api && npx vitest run src/http/server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd api && npx vitest run src/http/server.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/http/
git commit -m "feat(xmb-api): express REST API with bearer auth (TDD)"
```

---

### Task 8: WebSocket broadcaster (TDD)

**Files:**
- Create: `api/src/http/wsBroadcaster.ts`
- Test: `api/src/http/wsBroadcaster.test.ts`

**Interfaces:**
- Consumes: an `http.Server`, a `SessionManager`-shaped object exposing `snapshot()` + `onChange(cb)`, and the token; uses `ws`.
- Produces: `attachWs(server, { session, token, path })`. On connect (token valid via `?token=` or header) it sends the current snapshot, then forwards every `onChange` to all clients. Bad/missing token → close with 1008.

- [ ] **Step 1: Write the failing tests**

```ts
// api/src/http/wsBroadcaster.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { attachWs } from "./wsBroadcaster.js";
import type { SessionSnapshot } from "../types.js";

let server: Server;
afterEach(() => new Promise<void>(r => server?.close(() => r())));

function fakeSession() {
  let cb: ((s: SessionSnapshot) => void) | null = null;
  const snap: SessionSnapshot = { state: "off", game: null, node: null, since: 0 };
  return {
    snapshot: () => snap,
    onChange: (fn: (s: SessionSnapshot) => void) => { cb = fn; return () => { cb = null; }; },
    emit: (s: SessionSnapshot) => cb?.(s),
  };
}

async function listen(): Promise<number> {
  await new Promise<void>(r => server.listen(0, r));
  return (server.address() as any).port;
}

it("rejects connections without a valid token", async () => {
  server = createServer();
  attachWs(server, { session: fakeSession(), token: "tok", path: "/api/ws" });
  const port = await listen();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=wrong`);
  const code = await new Promise<number>(res => ws.on("close", c => res(c)));
  expect(code).toBe(1008);
});

it("sends a snapshot on connect and pushes transitions", async () => {
  const session = fakeSession();
  server = createServer();
  attachWs(server, { session, token: "tok", path: "/api/ws" });
  const port = await listen();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=tok`);
  const messages: any[] = [];
  // Attach the message listener BEFORE awaiting "open": on loopback the initial
  // snapshot frame is coalesced with the 101 upgrade, so a listener attached
  // after "open" would miss it. (A real client sets onmessage synchronously too.)
  ws.on("message", d => messages.push(JSON.parse(d.toString())));
  await new Promise<void>(res => ws.on("open", () => res()));
  await new Promise(r => setTimeout(r, 20)); // receive initial snapshot
  session.emit({ state: "in-game", game: null, node: "10.0.2.198", since: 1 });
  await new Promise(r => setTimeout(r, 20));
  expect(messages[0].state).toBe("off");
  expect(messages.at(-1).state).toBe("in-game");
  ws.close();
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd api && npx vitest run src/http/wsBroadcaster.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```ts
// api/src/http/wsBroadcaster.ts
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { SessionSnapshot } from "../types.js";

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
      if (token !== deps.token) { ws.close(1008, "unauthorized"); return; }
      ws.send(JSON.stringify(deps.session.snapshot()));
      const off = deps.session.onChange(s => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(s));
      });
      ws.on("close", off);
    });
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd api && npx vitest run src/http/wsBroadcaster.test.ts`
Expected: PASS (run twice for timer stability).

- [ ] **Step 5: Commit**

```bash
git add api/src/http/wsBroadcaster.ts api/src/http/wsBroadcaster.test.ts
git commit -m "feat(xmb-api): websocket state broadcaster (TDD)"
```

---

### Task 9: Composition root (`index.ts`) + full-suite green

**Files:**
- Modify: `api/src/index.ts`
- Create: `api/src/library/libraryService.ts` (thin cache wrapper around the scanner + JSON store)

**Interfaces:**
- Produces: the wired process — scanner+store behind `LibraryProvider`, `K8sCluster` + `SupervisorClient` behind the `SessionManager`, Express app + WS on one HTTP server. Reads env: `XMB_API_TOKEN`, `SUPERVISOR_TOKEN`, `ROMS_DIR` (default `/roms`), `CONFIG_DIR` (default `/config`), `PORT` (default `8080`). No new behavior beyond wiring; not unit-tested (covered by the integration smoke test in Task 12).

- [ ] **Step 1: Write `api/src/library/libraryService.ts`**

```ts
// api/src/library/libraryService.ts
import { join } from "node:path";
import { scanLibrary } from "./scanner.js";
import { readJson, writeJsonAtomic } from "../store/jsonStore.js";
import type { SystemGroup } from "../types.js";

export class LibraryService {
  private cache: SystemGroup[] = [];
  constructor(private romsDir: string, private configDir: string) {}
  private get cacheFile() { return join(this.configDir, "library.json"); }

  async init(): Promise<void> {
    this.cache = await readJson<SystemGroup[]>(this.cacheFile, []);
    if (this.cache.length === 0) await this.scan();
  }
  get(): SystemGroup[] { return this.cache; }
  async scan(): Promise<SystemGroup[]> {
    this.cache = await scanLibrary(this.romsDir);
    await writeJsonAtomic(this.cacheFile, this.cache);
    return this.cache;
  }
}
```

- [ ] **Step 2: Write `api/src/index.ts`**

```ts
// api/src/index.ts
import { createServer } from "node:http";
import { LibraryService } from "./library/libraryService.js";
import { SessionManager } from "./session/sessionManager.js";
import { K8sCluster } from "./adapters/k8sCluster.js";
import { SupervisorClient } from "./adapters/supervisorClient.js";
import { createApp } from "./http/server.js";
import { attachWs } from "./http/wsBroadcaster.js";

async function main() {
  const token = process.env.XMB_API_TOKEN ?? "";
  const romsDir = process.env.ROMS_DIR ?? "/roms";
  const configDir = process.env.CONFIG_DIR ?? "/config";
  const port = Number(process.env.PORT ?? "8080");

  const library = new LibraryService(romsDir, configDir);
  await library.init();

  const session = new SessionManager(new K8sCluster(), new SupervisorClient());

  const app = createApp({ library, session, token });
  const server = createServer(app);
  attachWs(server, { session, token, path: "/api/ws" });

  server.listen(port, () => console.log(`[xmb-api] listening on :${port}`));
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Full suite + build**

Run: `cd api && npm test && npm run build`
Expected: all tests PASS; `dist/` compiles clean.

- [ ] **Step 4: Commit**

```bash
git add api/src/index.ts api/src/library/libraryService.ts
git commit -m "feat(xmb-api): composition root wiring cluster+supervisor+http+ws"
```

---

### Task 10: Container image

**Files:**
- Create: `api/Dockerfile`, `api/.dockerignore`

**Interfaces:**
- Produces: `docker.io/yourbr0ther/psp-xmb-api:phase2a` (linux/amd64), multi-stage (build with dev deps, run with prod deps only), non-root, listens on 8080.

- [ ] **Step 1: Write `api/.dockerignore`**

```
node_modules
dist
*.log
```

- [ ] **Step 2: Write `api/Dockerfile`**

```dockerfile
# api/Dockerfile — xmb-api (Node 20, multi-stage)
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Build for linux/amd64**

Run:
```bash
cd api && docker buildx build --platform linux/amd64 -t docker.io/yourbr0ther/psp-xmb-api:phase2a --load .
```
Expected: build completes. Verify arch: `docker inspect docker.io/yourbr0ther/psp-xmb-api:phase2a --format '{{.Architecture}}'` → `amd64`.

- [ ] **Step 4: Local sanity run** (no cluster; expects to serve /healthz and fail library init gracefully if /roms absent — so mount an empty dir)

```bash
mkdir -p /tmp/xmb-roms /tmp/xmb-config
docker run -d --name xmb-api-test -p 18081:8080 \
  -e XMB_API_TOKEN=test -e ROMS_DIR=/roms -e CONFIG_DIR=/config \
  -v /tmp/xmb-roms:/roms -v /tmp/xmb-config:/config \
  docker.io/yourbr0ther/psp-xmb-api:phase2a
sleep 3
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:18081/healthz          # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:18081/api/library       # 401
curl -s http://localhost:18081/api/library -H 'Authorization: Bearer test'         # [] (empty roms)
docker rm -f xmb-api-test
```
Expected: `200`, `401`, `[]`.

- [ ] **Step 5: Push** (controller/user handles registry auth if prompted)

```bash
docker push docker.io/yourbr0ther/psp-xmb-api:phase2a
```

- [ ] **Step 6: Commit**

```bash
git add api/Dockerfile api/.dockerignore
git commit -m "feat(xmb-api): container image (multi-stage node20)"
```

---

### Task 11: Kubernetes manifests

**Files:**
- Create: `deploy/base/xmb-api-rbac.yaml`, `deploy/base/xmb-api.yaml`, `deploy/base/xmb-api-config-pvc.yaml`
- Modify: `deploy/base/kustomization.yaml` (add the three), `deploy/base/secret.example.yaml` (add `xmb-api-token` key)

**Interfaces:**
- Consumes: image from Task 10; the ROM NFS PVC `roms` (mounted read-only); secret `psp-xmb-auth` (adds key `xmb-api-token`, reuses `supervisor-token`).
- Produces: `xmb-api` Deployment (1 replica, ClusterIP Service :8080), ServiceAccount `xmb-api` + scoped Role/RoleBinding, `xmb-api-config` PVC. Consumed by 2b's ingress.

- [ ] **Step 1: Write `deploy/base/xmb-api-rbac.yaml`**

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: xmb-api
  namespace: psp-xmb
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: xmb-api-game-session
  namespace: psp-xmb
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    resourceNames: ["game-session"]
    verbs: ["get", "list", "watch", "patch"]
  - apiGroups: ["apps"]
    resources: ["deployments/scale"]
    resourceNames: ["game-session"]
    verbs: ["get", "patch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: xmb-api-game-session
  namespace: psp-xmb
subjects:
  - kind: ServiceAccount
    name: xmb-api
    namespace: psp-xmb
roleRef:
  kind: Role
  name: xmb-api-game-session
  apiGroup: rbac.authorization.k8s.io
```
*(Note: pod `get/list/watch` cannot be restricted by resourceName in RBAC; the app filters by label. This is the tightest standard Role for pod listing.)*

- [ ] **Step 2: Write `deploy/base/xmb-api-config-pvc.yaml`**

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: xmb-api-config
  namespace: psp-xmb
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: local-path
  resources:
    requests:
      storage: 1Gi
```

- [ ] **Step 3: Write `deploy/base/xmb-api.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: xmb-api
  namespace: psp-xmb
  labels:
    app: xmb-api
spec:
  replicas: 1
  strategy:
    type: Recreate         # single RWO config PVC
  selector:
    matchLabels:
      app: xmb-api
  template:
    metadata:
      labels:
        app: xmb-api
    spec:
      serviceAccountName: xmb-api
      containers:
        - name: xmb-api
          image: docker.io/yourbr0ther/psp-xmb-api:phase2a
          imagePullPolicy: Always
          env:
            - name: PORT
              value: "8080"
            - name: ROMS_DIR
              value: /roms
            - name: CONFIG_DIR
              value: /config
            - name: POD_NAMESPACE
              value: psp-xmb
            - name: XMB_API_TOKEN
              valueFrom:
                secretKeyRef: { name: psp-xmb-auth, key: xmb-api-token }
            - name: SUPERVISOR_TOKEN
              valueFrom:
                secretKeyRef: { name: psp-xmb-auth, key: supervisor-token }
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
            initialDelaySeconds: 3
            periodSeconds: 5
          volumeMounts:
            - name: roms
              mountPath: /roms
              subPath: ROMs/roms
              readOnly: true
            - name: config
              mountPath: /config
      volumes:
        - name: roms
          persistentVolumeClaim:
            claimName: roms
        - name: config
          persistentVolumeClaim:
            claimName: xmb-api-config
---
apiVersion: v1
kind: Service
metadata:
  name: xmb-api
  namespace: psp-xmb
  labels:
    app: xmb-api
spec:
  type: ClusterIP
  selector:
    app: xmb-api
  ports:
    - name: http
      port: 8080
      targetPort: 8080
```

- [ ] **Step 4: Update kustomization + secret template**

Add to `deploy/base/kustomization.yaml` resources: `xmb-api-rbac.yaml`, `xmb-api-config-pvc.yaml`, `xmb-api.yaml`.
Add to `deploy/base/secret.example.yaml` `stringData`: `xmb-api-token: CHANGE-ME`.

- [ ] **Step 5: Add the token to the live secret, then apply**

Run:
```bash
export KUBECONFIG=~/.kube/k3s-config
kubectl -n psp-xmb patch secret psp-xmb-auth --type merge \
  -p "{\"data\":{\"xmb-api-token\":\"$(openssl rand -hex 24 | tr -d '\n' | base64)\"}}"
  # NOTE: `tr -d '\n'` is essential — openssl appends a newline, and base64ing
  # it bakes a trailing \n into the token. The server env then has 49 bytes but
  # any client strips it to 48 → length mismatch → 401 on every request.
kubectl apply -k deploy/base
kubectl -n psp-xmb rollout status deploy/xmb-api --timeout=180s
kubectl -n psp-xmb get deploy xmb-api,pvc xmb-api-config,sa xmb-api
```
Expected: xmb-api 1/1; PVC bound after pod schedules; SA present.
**Reminder:** `kubectl apply -k` resets `game-session` to `replicas: 0` (by-hand scaling design). If a game session was running, scale it back up afterward.

- [ ] **Step 6: Commit**

```bash
git add deploy/base/
git commit -m "feat(xmb-api): k8s manifests (deployment, scoped RBAC, config PVC, service)"
```

---

### Task 12: Cluster integration smoke test

**Files:**
- Create: `scripts/xmb-api-smoke.sh`

**Interfaces:**
- Consumes: the deployed `xmb-api` and the Phase 1 `game-session`.
- Produces: the Phase 2a acceptance proof — library lists real games; a start scales the pod and reaches `in-game`; power-off scales back.

- [ ] **Step 1: Write `scripts/xmb-api-smoke.sh`**

```bash
#!/usr/bin/env bash
# scripts/xmb-api-smoke.sh — Phase 2a acceptance via port-forward to xmb-api.
set -euo pipefail
NS=psp-xmb
TOKEN=$(kubectl -n "$NS" get secret psp-xmb-auth -o jsonpath='{.data.xmb-api-token}' | base64 -d)

kubectl -n "$NS" port-forward deploy/xmb-api 18080:8080 >/tmp/xmb-pf.log 2>&1 &
PF=$!; trap 'kill $PF 2>/dev/null || true' EXIT
sleep 3
BASE=http://localhost:18080
auth=(-H "Authorization: Bearer ${TOKEN}")

echo "--- library (expect real systems w/ games)"
curl -fsS "${auth[@]}" "$BASE/api/library" | \
  python3 -c 'import json,sys; d=json.load(sys.stdin); print("systems:", [(g["system"], len(g["games"])) for g in d])'

echo "--- session before (expect off)"
curl -fsS "${auth[@]}" "$BASE/api/session"; echo

GID=$(curl -fsS "${auth[@]}" "$BASE/api/library" | \
  python3 -c 'import json,sys; d=json.load(sys.stdin);
gs=[x for g in d for x in g["games"] if x["core"]=="mgba"]; print(gs[0]["id"] if gs else "")')
echo "--- starting game id=$GID (scales pod; first run pulls image)"
curl -fsS -X POST "${auth[@]}" -H 'Content-Type: application/json' \
  -d "{\"gameId\":\"$GID\"}" "$BASE/api/session/start"; echo

echo "--- polling for in-game (up to 10 min)"
for i in $(seq 1 120); do
  ST=$(curl -fsS "${auth[@]}" "$BASE/api/session" | python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])')
  echo "  state=$ST"; [ "$ST" = "in-game" ] && break; sleep 5
done
[ "$ST" = "in-game" ] || { echo "FAILED: never reached in-game"; exit 1; }

echo "--- powering off"
curl -fsS -X DELETE "${auth[@]}" "$BASE/api/session"; echo
echo "SMOKE PASSED."
```

- [ ] **Step 2: Run it**

Run: `bash scripts/xmb-api-smoke.sh`
Expected: library prints systems with game counts (gba should have a game — Celeste is there from Phase 1); session goes off → in-game; power-off returns off. Debug via `kubectl -n psp-xmb logs deploy/xmb-api`.

- [ ] **Step 3: Commit and tag**

```bash
git add scripts/xmb-api-smoke.sh
git commit -m "feat(xmb-api): phase 2a integration smoke test"
git tag phase2a-xmb-api
```

---

## Done criteria

- All unit suites green (`cd api && npm test`), image built + pushed, manifests applied, `xmb-api` 1/1 Ready.
- `scripts/xmb-api-smoke.sh` passes: real library listed, a game reaches `in-game` via the API (scaling the pod itself), power-off returns to `off`.
- Then: final whole-branch review → merge to master → Phase 2b (the visual XMB UI) is the next design.
