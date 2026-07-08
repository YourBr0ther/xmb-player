# xmb-api (Phase 2a) — Design

**Date:** 2026-07-08
**Status:** Approved
**Depends on:** Phase 1 (pipeline proof) — complete; game-session pod streams via WebRTC/NVENC.

## Summary

`xmb-api` is the backend service for the PSP XMB web console: a Node + TypeScript
service in the `psp-xmb` namespace that scans the ROM library, orchestrates the
game-session pod's lifecycle, and broadcasts session state. Phase 2a builds
everything **except** the visual XMB UI (which is Phase 2b), so the API is
verifiable on its own with tests and a manual smoke test.

Sequencing decision: **API-first**. Build and test the backend fully before any
UI, so the hard integration (k8s scaling, supervisor bridging, state machine) is
proven before pixels.

## v1 systems

Eight systems (the design-spec set; all present in the user's NFS library), with
folder → libretro core mapping:

| Folder | System | Core |
|--------|--------|------|
| `psp` | PSP | ppsspp |
| `ps` | PlayStation 1 | swanstation |
| `n64` | Nintendo 64 | mupen64plus-next |
| `ngc` | GameCube | dolphin |
| `dc` | Dreamcast | flycast |
| `snes` | Super Nintendo | snes9x |
| `megadrive` | Genesis/Mega Drive | genesis_plus_gx |
| `gba` | Game Boy Advance | mgba |

Other folders in the library (`gb`, `gbc`, `nes`, `nds`, `3ds`, `ps2`, `switch`,
`wii`, `wiiu`, `ngage`) are ignored in v1. The container image currently ships
only `mgba` + `ppsspp`; the remaining six cores (and any required BIOS —
PS1/Dreamcast need copyrighted BIOS the user must supply) are added when launching
is wired up, tracked as its own task. **BIOS is a known dependency, not resolved
in 2a** (the scanner and mapping don't need it).

## Architecture

```
Browser (2b UI)         xmb-api (this phase)              game-session pod
    │  REST/WS      ┌──────────────────────────┐            (Phase 1)
    └──────────────►│  library scanner         │
                    │  session state machine   │  k8s API   ┌────────────────┐
                    │  WebSocket broadcaster    │──scale 0/1►│ Deployment      │
                    │  JSON persistence (/config)│           │ game-session    │
                    └──────────┬───────────────┘            └───────┬────────┘
                               │ HTTP :9090 (bearer)                │
                               │ UDP  :55355 (retroarch cmd)  node hostIP
                               └────────────────────────────────────┘
      reads /roms (NFS, read-only)          reads pod status.hostIP for node IP
```

## Scope (2a)

- **Library scan** — walk `/roms` (NFS PV, mounted read-only), the 8 system
  folders; per game emit `{id, system, title, core, size, path}`. Title cleaning
  strips extension and region/dump tags (`(USA)`, `[!]`, etc.). Unknown folders
  skipped, empty dirs tolerated. Runs at startup and on demand; cached in memory,
  persisted to `/config/library.json`.
- **Session lifecycle** — state machine scaling `game-session` 0↔1 via k8s API and
  driving the supervisor + RetroArch.
- **State broadcast** — WebSocket pushing state to all clients.
- **Persistence** — JSON on a `/config` PVC. No database.

**Deferred to 2b:** box-art scraping (metadata model includes an `artwork` field
now, but images are fetched when a UI exists to show them); in-game save/load-state
UI controls.

## API surface

All routes require the shared bearer token (one PIN in a k8s Secret); the
WebSocket carries it too.

- `GET /api/library` → catalog grouped by system, from cache.
- `POST /api/library/scan` → force re-walk, return fresh catalog.
- `GET /api/session` → `{ state, game, node, since }`.
- `POST /api/session/start` `{gameId}` → ensure pod up (scale 0→1 + wait), then
  supervisor `/game`. Returns `starting` immediately; progress via WS. Replacing a
  running game swaps via the supervisor (no pod restart).
- `POST /api/session/command` `{command: pause|save_state|load_state|quit}` →
  RetroArch UDP command in-pod (`quit` keeps the pod warm).
- `DELETE /api/session` → power off: stop game, scale Deployment to 0.
- `GET /healthz` → unauthenticated liveness.
- `WebSocket /api/ws` → snapshot on connect, then every state transition.

The stream URL is not proxied here; the browser reaches the Selkies web client
through the existing ingress. `xmb-api` reports *where* the session is and
orchestrates it.

## Session state machine

States: `off → starting → in-game`, plus `idle` and `crashed`.

- `off` — Deployment at 0 replicas, no pod.
- `starting` — scaled to 1, waiting; reports WS sub-steps
  `scaling → pulling/scheduling → pod-ready → loading-game`. First launch slow
  (image pull); warm relaunch ~2s.
- `in-game` — supervisor reports RetroArch running.
- `idle` — pod warm, no game (after `quit`).
- `crashed` — supervisor reports non-zero exit; surfaced to UI, pod stays warm.

**Reaching the pod:** supervisor is on the node host network at `hostIP:9090`
(bearer token). `xmb-api` reads the node IP from the pod's `status.hostIP` after
Ready — not hardcoded. RetroArch UDP commands go to `hostIP:55355`.

**k8s access:** dedicated ServiceAccount; Role scoped to only
`get/list/watch/patch` on the `game-session` Deployment (scale subresource) and
`get/list` on pods labeled `app=game-session`. Leaked token → blast radius of one
Deployment.

**Failure handling:** scale-up timeout (image pull stalls) → back to `off` + error
event; supervisor unreachable → retry/backoff then error; GPU slot unavailable
(pod stuck Pending) → detect Pending pod and report "no GPU available" rather than
hang.

## Persistence

`/config` PVC (local-path, ~1Gi): `library.json` (scan cache, avoids cold re-walk
on restart) and `settings.json` (stream bitrate/resolution, confirm-button
convention, theme — written now, consumed by 2b). Atomic file writes; no DB.

## Testing (TDD)

- **Library scanner** — unit tests over a fixture ROM tree: folder→system→core
  mapping, title cleaning, unknown-folder skipping, empty-dir handling.
- **Session state machine** — mocked k8s client + mocked supervisor (no cluster):
  start-from-off scales then loads; replace swaps without rescaling; `quit` keeps
  warm; power-off scales to 0; pod-Pending → "no GPU"; supervisor-500 → error.
  Heaviest coverage — this is the core logic.
- **HTTP/WS contract** — supertest-style: auth required; WS pushes snapshot on
  connect and on every transition.
- Real-cluster integration is a final manual smoke test, not CI.

## Deployment

New manifests in `deploy/base/`: `xmb-api` Deployment + ClusterIP Service;
ServiceAccount + scoped Role + RoleBinding; `/config` PVC; bearer-token Secret
(added to `psp-xmb-auth` or its own). Image built `linux/amd64`, pushed to Docker
Hub (`docker.io/yourbr0ther/psp-xmb-api`). The Authelia-gated ingress route for the
API/UI arrives in 2b when there's a browser app to serve.

## Out of scope (2a)

- The visual XMB UI (2b).
- Box-art scraping (2b).
- In-game save/load-state UI (2b).
- Systems beyond the 8; BIOS provisioning; adding the six missing cores to the
  image (tracked as a launch-enablement task when 2b needs real launches).
- Multi-user, off-LAN remote play.
