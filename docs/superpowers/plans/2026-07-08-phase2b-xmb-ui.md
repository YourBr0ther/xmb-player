# Phase 2b step 1: XMB UI (functional) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Use superpowers:frontend-design when building the visual components (even "plain" styling should be intentional, not default-ugly).

**Goal:** A working, custom-rendered PSP XMB web app that browses the real ROM library via `xmb-api`, launches/attaches/quits games, and embeds the WebRTC gameplay stream in its own `<video>` with a Home-menu overlay — plain styling, real function.

**Architecture:** React + TS + Vite SPA in `web/`. `xmb-api` serves the built SPA as static files and proxies the WebRTC signaling WebSocket + `/turn` to the running game-session pod (single origin). Media flows direct browser↔node. Crossbar navigation is a pure reducer (unit-tested); the streaming client reuses Selkies' signaling/webrtc/input JS driving our own `<video>`.

**Tech Stack:** React 18, TypeScript, Vite, vitest + @testing-library/react, the existing Express `xmb-api`, `http-proxy` (or `ws`-level manual proxy) for signaling, Docker multi-stage, k3s.

## Global Constraints

- New SPA lives in `web/`; it is built and bundled into the `xmb-api` image (one deployment).
- Single origin: the SPA calls `/api/*` (same host); the bearer token (the XMB PIN) is stored client-side and sent on REST + WS. No CORS.
- Image: `docker.io/yourbr0ther/psp-xmb-api:phase2b` (bump tag; keep `:phase2a` intact).
- Ingress: repoint `xmb` IngressRoute (in `k3s_setup`) from `game-session` Service → `xmb-api` Service. Refresh the restore ConfigMap. Do NOT hardcode the site domain into this repo (host lives in `k3s_setup`).
- game-session image is UNCHANGED. `xmb-api` proxies to the pod's node-IP:8080 `/webrtc/signalling` and `/turn`.
- Selkies JS is MPL-2.0: vendor the specific files with their license headers intact under `web/src/vendor/selkies/` and note provenance.
- TDD for pure logic (navigation reducer, proxy, api client). Streaming + visual components are verified by a Playwright browser smoke test, not unit tests. Frequent commits.
- Plain styling in step 1 (system font stack, flat colors, CSS transitions ok) — no wave shader, no sounds, no box art (step 2).

---

### Task 1: web/ SPA scaffold

**Files:** `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx` (placeholder), `web/src/vite-env.d.ts`, `web/.gitignore`

- [ ] **Step 1: `web/package.json`**
```json
{
  "name": "xmb-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1" },
  "devDependencies": {
    "@testing-library/react": "^16.0.1",
    "@testing-library/jest-dom": "^6.5.0",
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```
- [ ] **Step 2: `web/tsconfig.json`** (standard Vite React TS: ES2022, jsx react-jsx, strict, moduleResolution Bundler, noEmit).
- [ ] **Step 3: `web/vite.config.ts`** — React plugin; `build.outDir: "dist"`; a dev proxy so `npm run dev` talks to a running xmb-api:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true, ws: true },
    },
  },
  test: { environment: "jsdom", globals: true, setupFiles: [] },
});
```
- [ ] **Step 4:** `web/index.html`, `web/src/main.tsx` (mount `<App/>`), `web/src/App.tsx` (placeholder `<div>xmb</div>`), `web/src/vite-env.d.ts` (`/// <reference types="vite/client" />`), `web/.gitignore` (`node_modules/`, `dist/`).
- [ ] **Step 5:** `cd web && npm install && npm run typecheck && npm run build`. Expect a clean `dist/`. If registry blocked, STOP + report.
- [ ] **Step 6:** Commit `git add web/ && git commit -m "feat(web): vite react SPA scaffold"` (+ Co-Authored-By trailer). Verify `node_modules/`/`dist/` not staged.

---

### Task 2: types + API client (TDD)

**Files:** Create `web/src/api/types.ts`, `web/src/api/client.ts`; Test `web/src/api/client.test.ts`

**Interfaces:** mirror the `xmb-api` contract. `types.ts`: `Game`, `SystemGroup`, `SessionSnapshot` (copy shapes from `api/src/types.ts`). `client.ts`: `createClient(token, base="")` → `{ getLibrary(), scan(), getSession(), start(gameId), command(cmd), powerOff() }`, each `fetch`ing `/api/*` with `Authorization: Bearer <token>`, throwing on non-2xx.

- [ ] **Step 1: failing tests** (`client.test.ts`) — mock global `fetch`; assert:
  - `getLibrary()` GETs `/api/library` with the bearer header and returns parsed JSON.
  - `start("abc")` POSTs `/api/session/start` with `{gameId:"abc"}` and JSON content-type.
  - `command("quit")` POSTs `/api/session/command` `{command:"quit"}`.
  - `powerOff()` DELETEs `/api/session`.
  - a 401 response throws an error whose message includes `401`.
```ts
// web/src/api/client.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClient } from "./client.js";

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
  })) as any;
}

beforeEach(() => { vi.restoreAllMocks(); });

it("getLibrary sends bearer and returns json", async () => {
  const f = mockFetch(200, [{ system: "gba", games: [] }]);
  vi.stubGlobal("fetch", f);
  const c = createClient("tok");
  const lib = await c.getLibrary();
  expect(lib[0].system).toBe("gba");
  const [url, init] = f.mock.calls[0];
  expect(url).toBe("/api/library");
  expect(init.headers.Authorization).toBe("Bearer tok");
});

it("start posts gameId", async () => {
  const f = mockFetch(202, { state: "starting" });
  vi.stubGlobal("fetch", f);
  await createClient("tok").start("abc");
  const [url, init] = f.mock.calls[0];
  expect(url).toBe("/api/session/start");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ gameId: "abc" });
});

it("command posts the command", async () => {
  const f = mockFetch(200, { state: "idle" });
  vi.stubGlobal("fetch", f);
  await createClient("tok").command("quit");
  expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ command: "quit" });
});

it("powerOff deletes the session", async () => {
  const f = mockFetch(200, { state: "off" });
  vi.stubGlobal("fetch", f);
  await createClient("tok").powerOff();
  expect(f.mock.calls[0][0]).toBe("/api/session");
  expect(f.mock.calls[0][1].method).toBe("DELETE");
});

it("throws on 401", async () => {
  vi.stubGlobal("fetch", mockFetch(401, { error: "unauthorized" }));
  await expect(createClient("bad").getLibrary()).rejects.toThrow(/401/);
});
```
- [ ] **Step 2:** run → fail (no `client.js`).
- [ ] **Step 3:** implement `types.ts` + `client.ts` to pass. `createClient` returns the six methods; a private helper does `fetch(base+path, {method, headers:{Authorization:\`Bearer ${token}\`, ...json}, body})`, checks `res.ok` else `throw new Error(\`${path} -> ${res.status}\`)`, returns `res.json()` (or void for DELETE/command where the body is still JSON).
- [ ] **Step 4:** run → pass. Typecheck.
- [ ] **Step 5:** commit `feat(web): typed xmb-api client (TDD)`.

---

### Task 3: crossbar navigation reducer (TDD)

**Files:** Create `web/src/xmb/navigation.ts`; Test `web/src/xmb/navigation.test.ts`

**Interfaces:** pure logic. `State = { category: number; item: number; drill: null | { system: string; game: number } }`. Categories order: `["settings","game","photo","music","video","network"]` (Game is the default focus). `reduce(state, action, ctx)` where `action ∈ {left,right,up,down,enter,back}` and `ctx` gives item counts (systems per Game, games per system, items per other category). `reduce` returns `{ state, effect? }` where `effect` describes a launch/command intent (e.g. `{type:"launch", gameId}` or `{type:"powerOff"}`) for the container to execute. Keep pure — no I/O.

- [ ] **Step 1: failing tests** covering:
  - left/right wraps or clamps across the 6 categories (choose clamp; test both ends).
  - default focus is the `game` category.
  - up/down moves `item` within the current category, clamped to its count from `ctx`.
  - in Game, `enter` on a system sets `drill` to that system with `game:0`; `back` clears `drill`.
  - in Game while drilled, up/down moves within games; `enter` emits `effect {type:"launch", gameId}`.
  - in Network, `enter` on the "Power Off" item emits `effect {type:"powerOff"}`.
  - `back` while drilled returns to system list; `back` at top level is a no-op.
  (Write ~10 focused assertions. `ctx` is a small fixture: 8 systems, gba has 3 games, network has 2 items, etc.)
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement the reducer (pure switch on action; clamp with `ctx`). No React here.
- [ ] **Step 4:** run → pass. Typecheck.
- [ ] **Step 5:** commit `feat(web): crossbar navigation reducer (TDD)`.

---

### Task 4: input layer — keyboard + gamepad → actions (TDD where practical)

**Files:** Create `web/src/xmb/input.ts`; Test `web/src/xmb/input.test.ts`

**Interfaces:** `keyToAction(e: {key:string})` → `NavAction | null` (Arrow*→up/down/left/right, Enter→enter, Escape→back). `createGamepadPoller(onAction, opts)` → `{ start(), stop() }` polling `navigator.getGamepads()` and emitting debounced d-pad/button actions. Unit-test `keyToAction` fully; gamepad poller gets a light test with a fake `navigator.getGamepads` (verify a pressed d-pad-up yields one `up` action, not repeated every poll).

- [ ] Steps: failing tests → run fail → implement → pass → typecheck → commit `feat(web): keyboard + gamepad input mapping (TDD)`.

---

### Task 5: Selkies streaming JS — inspection spike

**Files:** Create `web/src/vendor/selkies/README.md` (provenance + findings); vendor the needed JS.

**This is an inspection task — its output is knowledge + vendored files, not a feature.** The exact Selkies client API isn't known a priori; determine it from the real assets.

- [ ] **Step 1:** Extract the Selkies web client from the game-session image to inspect it:
```bash
id=$(docker create docker.io/yourbr0ther/psp-xmb-game-session:phase1)
docker cp "$id:/opt/gst-web" /tmp/gst-web && docker rm "$id"
ls -R /tmp/gst-web | head -40
```
- [ ] **Step 2:** Identify the classes the Phase 1 client used (we saw `window.signalling`, `window.webrtc`, `window.input` at runtime). Find the JS modules that define them (e.g. `signalling.js`, `webrtc.js`, `input.js`, or a bundled `app.js`). Read their constructors and public methods: how signalling connects (URL, peer id), how `webrtc` attaches to a `<video>` element, how input is wired. Record the exact API surface (constructor args, the `onstatus/onsdp/onice` callbacks, the connect sequence) in `web/src/vendor/selkies/README.md`.
- [ ] **Step 3:** Decide the integration: either (a) vendor the standalone `signalling.js`/`webrtc.js`/`input.js` modules (preferred — copy into `web/src/vendor/selkies/`, keep MPL headers) and import them, or (b) if they're only available as one bundled `app.js` tightly coupled to Selkies' DOM, extract just the classes into a thin vendored module. Document which and why.
- [ ] **Step 4:** Write `web/src/streaming/README.md` (or extend the vendor README) with the concrete plan for Task 6: the exact call sequence to (1) point signalling at `/webrtc/signalling/` on our origin, (2) hand `webrtc` our `<video>` ref, (3) enable input capture on it. **No app code yet.**
- [ ] **Step 5:** Commit `chore(web): vendor + document Selkies streaming client (spike)`.

*If the Selkies client proves impractical to reuse standalone (too DOM-coupled), STOP and report — we may fall back to an iframe for step 1 and revisit. Do not spend more than the spike; report findings.*

---

### Task 6: streaming component — our `<video>` + Selkies client

**Files:** Create `web/src/streaming/Stream.tsx`, `web/src/streaming/useSelkies.ts`

**Interfaces:** `<Stream nodeReady onHome />` renders a full-bleed `<video>` and, on mount, runs the connect sequence from Task 5's findings against same-origin `/webrtc/signalling/` + `/turn`. Exposes connection status (connecting/connected/failed) for a loading indicator. Input capture (keyboard/gamepad → data channel) is enabled while focused. This task follows the spike's documented API — reference it; there is no verbatim code here because it depends on Task 5's findings.

- [ ] **Step 1:** Implement `useSelkies` hook: given the `<video>` ref, construct the vendored signalling+webrtc+input objects, wire callbacks, connect. Clean up on unmount (close peer connection, remove listeners).
- [ ] **Step 2:** Implement `Stream.tsx` using the hook; show a "Connecting…" overlay until frames flow (`video.readyState >= 3` or the webrtc "connected" callback).
- [ ] **Step 3:** Manual verification is deferred to the Task 11 browser smoke (needs the full app + a running pod). For now: `npm run build` compiles clean; the component renders a `<video>` in a jsdom smoke test (no real WebRTC).
- [ ] **Step 4:** Commit `feat(web): webrtc stream component over vendored selkies client`.

---

### Task 7: xmb-api — serve the SPA + proxy signaling/turn (TDD for proxy)

**Files:** Modify `api/src/http/server.ts` (mount static + proxy); Create `api/src/http/streamProxy.ts`; Test `api/src/http/streamProxy.test.ts`; Modify `api/src/index.ts` (pass the session's node IP resolver to the proxy).

**Interfaces:** two additions to `xmb-api`:
1. **Static SPA:** serve `web/dist` (bundled into the image at `/app/web`) at `/` with SPA fallback (`index.html` for non-`/api` routes). `/api/*` and `/healthz` unchanged and still take precedence.
2. **Signaling/turn proxy:** `attachStreamProxy(server, app, { nodeIP(): string|null, token })` — HTTP `GET /turn` and the `/webrtc/signalling*` WebSocket upgrade proxy to `http(s)://<nodeIP>:8080` (the game-session pod). If no session/nodeIP, return 503. Reuse the bearer gate (browser already authed same-origin).

- [ ] **Step 1: failing tests** for the proxy's pure parts: a `pickUpstream(nodeIP)` helper returning the base URL or throwing when null; the path predicate `isSignalingPath(p)` matching `/webrtc/signalling` (+ trailing slash) and `/turn`. (The live socket proxying is covered by the Task 11 e2e; unit-test the routing decisions.)
- [ ] **Step 2:** run → fail. **Step 3:** implement `streamProxy.ts` (use Node `http`/`ws` manual proxy or `http-proxy`; add the dep to `api/package.json` if used). Wire static serving + `attachStreamProxy` in `server.ts`/`index.ts`, sourcing `nodeIP` from the `SessionManager`'s current snapshot (`node`). **Step 4:** run → pass; full `api` suite still green; typecheck.
- [ ] **Step 5:** commit `feat(xmb-api): serve SPA + proxy webrtc signaling/turn to the session pod (TDD)`.

---

### Task 8: crossbar UI components (wired, plain styling)

**Files:** Create `web/src/xmb/Crossbar.tsx`, `web/src/xmb/GameColumn.tsx`, `web/src/xmb/NetworkColumn.tsx`, `web/src/xmb/SettingsColumn.tsx`, `web/src/xmb/StubColumn.tsx`, `web/src/xmb/xmb.css`; rewrite `web/src/App.tsx`; Create `web/src/session/useSession.ts` (WS hook).

**Use superpowers:frontend-design** — plain ≠ ugly. A restrained dark theme, a clear focus ring, legible type scale, smooth 150–200ms CSS transitions on selection. No shader/sounds.

- [ ] **Step 1:** `useSession.ts` — connect `/api/ws?token=…`, expose the live `SessionSnapshot`; reconnect on close.
- [ ] **Step 2:** `App.tsx` — auth gate (prompt for the PIN on first load, store in `localStorage`, pass token down); load `/api/library`; hold nav state via the Task 3 reducer + Task 4 input; render `<Crossbar>`.
- [ ] **Step 3:** `Crossbar.tsx` + column components — horizontal category row, vertical items, focus from nav state; Game drill-in list; Network shows live session + Power Off; Settings minimal; Photo/Music/Video stubs. Selecting a game dispatches the reducer's `launch` effect → `client.start(gameId)`.
- [ ] **Step 4:** `npm run build` clean; a light RTL test that the Game column lists systems from a fake library and that pressing Down moves focus (component test of the wiring, not pixel-perfect).
- [ ] **Step 5:** commit `feat(web): crossbar UI wired to xmb-api (plain styling)`.

---

### Task 9: in-game flow + Home menu

**Files:** Create `web/src/game/GameView.tsx`, `web/src/game/HomeMenu.tsx`; modify `App.tsx` (route crossbar ↔ in-game by session state).

- [ ] **Step 1:** When session state → `starting`, show a launching indicator driven by WS sub-states; when `in-game`, mount `<GameView>` (which renders `<Stream>`), fade the crossbar out.
- [ ] **Step 2:** `HomeMenu.tsx` overlay — opened by Esc / gamepad Home; items Resume / Save State / Load State / Quit; wired to `client.command(...)`; Quit returns to crossbar (session goes idle via WS).
- [ ] **Step 3:** `crashed` state → return to crossbar with a PSP-style error dialog ("The game could not be started."). `off` → crossbar.
- [ ] **Step 4:** build clean; component test that HomeMenu Quit calls `command("quit")`.
- [ ] **Step 5:** commit `feat(web): in-game view + Home menu (save/load/quit)`.

---

### Task 10: image + manifests + ingress repoint

**Files:** Modify `api/Dockerfile` (add web build stage); Modify `deploy/base/xmb-api.yaml` (image `:phase2b`); Modify `k3s_setup/manifests/custom-ingressroutes.yaml` (xmb route → xmb-api) + refresh ConfigMap.

- [ ] **Step 1:** `api/Dockerfile` — add a `web-build` stage (`node:20-slim`, copy `web/`, `npm ci`, `npm run build`) and copy `web/dist` into the runtime image at the static path Express serves (e.g. `/app/web`). Keep the api build stage. Verify `docker build --platform linux/amd64` locally; run the container with an empty `/roms` and confirm `GET /` returns the SPA `index.html` (200) and `/healthz` 200.
- [ ] **Step 2:** Build + push `docker.io/yourbr0ther/psp-xmb-api:phase2b`. Bump `deploy/base/xmb-api.yaml` image to `:phase2b`; `kubectl apply -k deploy/base` (remember: this resets game-session to 0 — restore if it was running); `kubectl -n psp-xmb rollout status deploy/xmb-api`.
- [ ] **Step 3:** In `k3s_setup`: change the `xmb` IngressRoute service from `game-session:8080` to `xmb-api:8080`; refresh the restore ConfigMap; `kubectl apply`. Verify `curl -sk https://$XMB_HOST/` → 302 to Authelia (unchanged), and after auth the SPA loads. Commit the k3s_setup change separately (only the two files; the repo has pre-existing dirt — stage explicitly).
- [ ] **Step 4:** commit (psp_ui) `feat: bundle SPA into xmb-api image; point ingress at xmb-api`.

---

### Task 11: end-to-end browser smoke

**Files:** Create `scripts/xmb-ui-smoke.md` (manual/Playwright checklist) or a Playwright script if the harness allows.

- [ ] **Step 1:** With `xmb-api` at `:phase2b` deployed and the ingress repointed, drive a browser (Playwright, as in Phase 1) to the direct `xmb-api` Service via port-forward (or `$XMB_HOST`): enter the PIN, confirm the crossbar loads the **real** library (systems + counts), navigate to a GBA game, launch it, and assert the stream connects (video `readyState>=3`, ICE connected) and shows gameplay. Open the Home menu, Quit, confirm return to the crossbar.
- [ ] **Step 2:** Capture a screenshot into `docs/phase2b-evidence/`. Honest reporting — if the stream doesn't connect through the proxy, debug (`kubectl logs deploy/xmb-api` for proxy errors) and report; don't claim success without frames.
- [ ] **Step 3:** commit + tag `phase2b-xmb-ui-step1`.

---

## Done criteria

- `web` unit suites green (nav reducer, input, api client); `api` suite still green incl. proxy routing.
- Image `:phase2b` built/pushed; `xmb-api` serves the SPA; ingress → xmb-api.
- Browser e2e: PIN → crossbar → real library → launch GBA game → **stream plays in our `<video>`** → Home menu → Quit → crossbar. Screenshot captured.
- Then: final whole-branch review → merge → step 2 (visual polish: wave shader, sounds, box art, eases) is the next design.
