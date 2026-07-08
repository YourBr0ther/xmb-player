# PSP XMB Web Console — Design

**Date:** 2026-07-07
**Status:** Approved

## Summary

A self-hosted "virtual PSP" running on an existing k3s cluster (Linux server, RTX 3080 Ti). The user browses a pixel-faithful, custom-built PSP XMB interface as a web app in any browser. Selecting a game launches RetroArch in a GPU-backed session pod; gameplay video streams into the same page via WebRTC (Selkies-GStreamer, NVENC). Single user, single session, attachable from multiple devices — like carrying one console between rooms.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| XMB interface | Custom web replica (not RetroArch's XMB driver) — extensible for non-game features later |
| Streaming | Browser-native WebRTC via Selkies-GStreamer; lowest-latency embedded experience, no client installs |
| Host | Existing k3s cluster on Linux, NVIDIA RTX 3080 Ti (NVENC hardware encode) |
| Systems (v1) | PSP (ppsspp), PS1 (swanstation), N64 (mupen64plus-next), GameCube (dolphin), Dreamcast (flycast), SNES (snes9x), Genesis (genesis_plus_gx), GBA (mgba) |
| Sessions | Single session, single user, multi-device attach/detach (newest attach wins) |
| Deployment | k3s from the start (kustomize manifests, Traefik ingress, NVIDIA device plugin + runtime class) |
| Rejected alternatives | neko RetroArch image (weak gamepad, CPU encode default); Wolf/Sunshine + web Moonlight client (immature browser clients) |

## Architecture

```
Browser (any device)
   │  HTTPS
   ▼
Traefik Ingress ──────────────────────────────┐
   │                                          │
   ▼                                          ▼
┌─────────────────┐  REST/WS   ┌──────────────────────────┐
│  xmb-web        │◄──────────►│  xmb-api                 │
│  (static SPA:   │            │  (Node/TS service)       │
│  PSP XMB UI)    │            │  - library scan/metadata │
└─────────────────┘            │  - session lifecycle     │
                               │  - WebRTC signaling proxy│
                               │  - RetroArch ctl (UDP)   │
                               └───────┬──────────────────┘
                                       │ k8s API (scale 0/1, patch game)
                                       ▼
                          ┌────────────────────────────┐
                          │  game-session pod (GPU)    │
                          │  Xorg headless (3080 Ti)   │
                          │  RetroArch + cores         │
                          │  Selkies-GStreamer         │
                          │  (NVENC → WebRTC)          │
                          └────────────────────────────┘

PVCs (local-path/hostPath): /roms /saves /states /artwork /config
Optional: coturn pod for off-LAN play (present in manifests, off by default)
```

All components live in a `psp-xmb` namespace. Flow: XMB browsing is a pure web app (instant, no streaming). Launching a game → `xmb-api` writes core+ROM into the game-session Deployment and scales it to 1 (or commands the warm pod's supervisor to swap games). The page opens a WebRTC connection through the signaling proxy and gameplay fades in. The session pod is independent of any browser tab: close the desktop tab, reattach from a tablet, game keeps running.

## Component: xmb-web (React + TypeScript + Vite SPA)

Custom-rendered XMB — no UI component library for the crossbar/wave/icons.

- **Wave background:** WebGL fragment shader recreating the PSP ribbon. Wave color follows month (like real PSP), manual override in Settings.
- **Motion & sound:** PSP-style timing — snappy 150–200ms eases; short synthesized navigation tick/confirm sounds matching the originals' character.
- **Assets:** Sony's icons/fonts/sounds are copyrighted — all assets are recreations: monoline SVG icons in the same visual language; an open geometric font close to PSP's SST (candidates: Jost, Zen Kaku Gothic); original synthesized sounds.
- **Crossbar categories (v1):**
  - **Settings** — stream quality (bitrate/resolution), video filter, controller mapping, theme (wave color), confirm-button convention.
  - **Game** — sub-grouped by system; each game shows box art, title, PSP-style info panel (play time, last played). Select → launch/attach.
  - **Photo / Music / Video** — present but stubbed ("no content"); future extension points.
  - **Network** — session status (running game, stream stats: bitrate/latency), attach/detach, "Power → end session" styled like the PSP power menu.
- **Input:** keyboard (arrows/Enter/Esc) and browser Gamepad API for XMB navigation; same inputs forward into the game while streaming. Default ✕=confirm ○=back (Japanese convention), configurable.
- **In-game:** page swaps to fullscreen `<video>` (WebRTC stream). Home button (Esc / gamepad Home) overlays a web-rendered menu: Resume / Save State / Load State / Quit Game — executed via xmb-api's RetroArch control channel.
- **Auth UX:** first visit asks for the PIN PSP-style; stored in browser, sent as bearer token on all API/WS calls.

## Component: game-session pod

One container image (`game-session`), Ubuntu 22.04 base, NVIDIA runtime.

1. **Xorg headless** on the 3080 Ti (virtual display, no monitor), 1920×1080 X screen.
2. **RetroArch** + the eight cores, fullscreen, its own menu disabled/hidden — RetroArch is an invisible runtime; the web XMB is the only visible interface.
3. **Selkies-GStreamer:** X screen capture → `nvh264enc` (NVENC) → WebRTC. Target 1080p60, ~20 Mbps LAN default, adjustable from Settings. Input path: browser → WebRTC data channel → keyboard via X, gamepad via virtual uinput controller (RetroArch sees a real gamepad).
4. **Supervisor** (entrypoint + tiny HTTP endpoint): starts X and Selkies once; launches/replaces the RetroArch process per game on command from xmb-api. Game switch = RetroArch process restart (~2 s), not pod restart. Pod stays warm between games; scale-to-zero only on explicit "Power off" or idle timeout (default 30 min, no game and no viewer).

**RetroArch control:** built-in network command interface (UDP, in-pod): `SAVE_STATE`, `LOAD_STATE`, `PAUSE_TOGGLE`, `QUIT`. Powers the in-game Home menu.

**GPU scheduling:** pod requests `nvidia.com/gpu: 1`, `runtimeClassName: nvidia` (NVIDIA device plugin required on the cluster — verify/install during Phase 1). Emulation and NVENC share the GPU; encode uses the dedicated NVENC block.

**WebRTC path:** LAN — near-direct browser↔pod (host network or NodePort for media ports). Remote play — optional coturn relay, off by default.

## Component: xmb-api (Node/TypeScript)

- **Library:** scans `/roms` on startup and on demand; folder = system (`/roms/psp/*.iso`, `/roms/snes/*.sfc`, …). Per game: title (cleaned filename), system, size, CRC. Box art fetched from libretro-thumbnails (free, name-matched) into `/artwork`; misses fall back to a generic PSP-style disc icon; manually placed art in `/artwork` wins.
- **Session API:** `POST /session/start {gameId}`, `POST /session/command {save_state|load_state|pause|quit}`, `DELETE /session`, `GET /session` → off / starting / in-game / idle. Implementation: k8s API via in-cluster ServiceAccount (RBAC scoped to the game-session Deployment only) for scale 0↔1; supervisor HTTP + RetroArch UDP for in-pod actions.
- **State push:** session state broadcast to all connected browsers over WebSocket (launch on desktop → tablet shows "Now Playing" instantly).
- **Signaling proxy:** proxies the WebRTC signaling WebSocket between browser and Selkies — single origin, no CORS, token gate covers everything.
- **Auth:** one shared PIN in a k8s Secret; bearer token on every API/WS call. No user accounts.
- **Persistence:** metadata + settings in JSON files on `/config` (single user, few hundred games — no database needed).

## Repo layout

```
psp_ui/
├── web/            # React XMB SPA
├── api/            # xmb-api (Node/TS)
├── session/        # game-session Dockerfile, supervisor, retroarch config
├── deploy/         # kustomize manifests: namespace, deployments, services,
│                   #   ingress, PVCs, RBAC, secret template, optional coturn
└── docs/superpowers/specs/
```

Images pushed to GHCR (free, k3s pulls directly with an imagePullSecret). If the cluster turns out to have a local registry already, we use that instead — a one-line kustomize change.

## Error handling

| Failure | Behavior |
|---|---|
| Session pod can't schedule (GPU busy/missing) | API reports; XMB shows PSP-style error dialog ("The game could not be started. (80020148)") |
| Stream drops (network blip) | Web app auto-reconnects WebRTC; session untouched, game keeps running |
| RetroArch crashes (bad ROM) | Supervisor detects exit, reports "crashed"; XMB returns to crossbar with error dialog |
| Two devices attach | Newest attach wins video+input; other device shows "session attached elsewhere" |

## Testing

- **api:** unit tests for library scanner and session state machine (mocked k8s client).
- **web:** component tests for crossbar navigation logic.
- **End-to-end:** scripted smoke test — start session with a freely distributable homebrew test ROM, assert WebRTC connects and frames flow.

## Build phases

1. **Pipeline proof** — session image + manifests; launch a game via `curl`, verify streaming in a bare test page. De-risks the hard parts first.
2. **XMB core** — crossbar UI, library browsing, launch/attach/quit through the real interface.
3. **Console feel** — wave shader polish, sounds, box art scraping, in-game Home menu, save states, Settings.
4. **Extras** — idle timeout, coturn remote play; Photo/Music/Video activated whenever desired.

## Out of scope (v1)

- Multi-user / concurrent sessions
- Netplay / multiplayer
- Photo/Music/Video content (stubs only)
- Mobile touch controls (browser gamepad/keyboard only)
