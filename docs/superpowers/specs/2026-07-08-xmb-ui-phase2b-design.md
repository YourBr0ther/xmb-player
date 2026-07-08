# XMB UI (Phase 2b, step 1: functional) — Design

**Date:** 2026-07-08
**Status:** Approved
**Depends on:** Phase 1 (streaming pipeline) + Phase 2a (xmb-api backend) — both complete and deployed.

## Summary

The visible PSP XMB web console: a custom-rendered React SPA that browses the ROM
library through `xmb-api`, launches/attaches/quits games, and embeds the WebRTC
gameplay stream in its own `<video>`. Phase 2b **step 1 is functional-first** —
a working crossbar with plain styling — so you can play through the real UI early.
Step 2 (polish: wave shader, sounds, box art, PSP timing) follows.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Sequence | Functional-first: real browse + launch + stream + Home menu with plain styling; polish later |
| Stream embed | Our own `<video>`, reusing Selkies' signaling/webrtc/input JS (MPL-2.0, proven in Phase 1) — no Selkies chrome |
| Serving / origin | `xmb-api` serves the SPA static files AND proxies WebRTC signaling — single origin, no CORS, one token gate |
| Ingress | Repoint `XMB_HOST` (e.g. the Authelia-gated ingress) from the game-session Service to the `xmb-api` Service |
| Framework | React + TypeScript + Vite SPA in a new `web/` dir |

## Architecture

```
Browser (any device)
   │  HTTPS (Authelia + bearer token, single origin)
   ▼
Traefik ── xmb-api ──────────────────────────────────────────┐
             │  serves SPA (static)                          │
             │  REST /api/*  +  WS /api/ws (session state)    │
             │  WS signaling proxy  +  /turn proxy ───────────┼──► game-session pod
             │  k8s scale 0/1 (scoped RBAC)                    │     Selkies /webrtc/signalling, /turn
             └────────────────────────────────────────────────┘     (node hostIP:8080)
                                                                          │
   WebRTC media (video/audio/input) flows DIRECT browser ◄───────────────┘
   (pod hostNetwork node-IP ICE candidates; never through xmb-api)
```

Signaling is proxied for single-origin; **media flows direct** browser↔node over
WebRTC, so `xmb-api` is never in the video path. The game-session image is
unchanged — `xmb-api` proxies to the pod's existing Selkies `/webrtc/signalling`
and `/turn` at its node IP (the pod's basic auth is already disabled).

## Crossbar UI & navigation (step 1)

Horizontal category row (crossbar); the selected category's items run vertically.

- **Left/Right** between categories; **Up/Down** within items; **Enter/✕** activate;
  **Esc/○** back out.
- **Keyboard first** (arrows/Enter/Esc) + **Gamepad API** polled and mapped to the
  same actions. Configurable ✕/○ convention deferred to step 2 (fixed default now).
- Navigation is a **pure reducer** (focused category / item / drill-level), which is
  what gets unit-tested.

Categories:
- **Game** — vertical list of the 8 systems (gba, snes, ps, n64, psp, ngc, dc,
  megadrive); Enter/right **drills into** that system's games; Esc/left backs out;
  selecting a game launches it. (Box-art grid is step 2; step 1 is a titled list.)
- **Network** — session status (running game, node), **Power Off** (scale to 0),
  and an Attach affordance when a session is live. Driven by the `xmb-api`
  WebSocket, so state updates on all devices at once.
- **Settings** — minimal in step 1 (a couple real toggles wired to `settings.json`,
  e.g. stream bitrate); fuller controls in step 2.
- **Photo / Music / Video** — present but stubbed ("No content").

The app loads `/api/library` on start and subscribes to `/api/ws` for live session
state (`off → starting → in-game → crashed`).

## In-game streaming & Home menu

1. Select a game → `POST /api/session/start {gameId}`. UI shows a **launching**
   state driven by WS sub-states (`scaling → pulling → pod-ready → loading-game`)
   so a first-run image pull doesn't look frozen.
2. On **in-game**, the SPA opens WebRTC: fetch `/turn`, connect the signaling WS
   (both proxied same-origin), Selkies `webrtc.js` negotiates, our full-bleed
   `<video>` fades in.
3. **Input** — keyboard + gamepad forwarded via Selkies' `input.js` data channel
   (reaches RetroArch as a real gamepad/keyboard); the `<video>` is the focus target.

**Home menu** (Esc, or a gamepad Home/Select combo) overlays a web-rendered menu on
the video — no Selkies chrome:
- **Resume** — dismiss.
- **Save State / Load State** — `POST /api/session/command {save_state|load_state}`.
- **Quit Game** — `POST /api/session/command {quit}` → fade to crossbar; pod stays
  warm (idle) so relaunch is instant.

Esc is unambiguous by context (in-game → Home; crossbar → back). Stream drop →
WebRTC auto-reconnects while the session keeps running. Multi-device: the Network
category shows "Now Playing" with Attach; step-1 simplification is that a new attach
just opens its own viewer (strict newest-wins arbitration deferred to step 2).

## Testing

- **Crossbar navigation reducer** — exhaustive vitest unit tests (pure logic).
- **xmb-api additions** — signaling/`/turn` proxy against a fake upstream; static
  serving check. In the existing vitest suite.
- **End-to-end** — Playwright browser smoke: load app with token, browse the real
  library, launch a game, assert the stream connects (ICE connected, frames flow),
  and the Home menu quits back to the crossbar.

## Deployment

- New `web/` dir (Vite React SPA). `xmb-api`'s Dockerfile gains a stage that builds
  `web/` and bundles `dist/` into the static path Express serves — one image, one
  deployment.
- Rebuild + push `docker.io/yourbr0ther/psp-xmb-api` (now SPA + proxy).
- Repoint the `k3s_setup` `xmb` IngressRoute from the game-session Service to the
  `xmb-api` Service; refresh the restore ConfigMap.
- No game-session image change.

## Out of scope (step 1)

- Wave shader, navigation sounds, box art, PSP-timed eases (step 2 polish).
- ✕/○ convention config; strict newest-attach arbitration.
- Photo/Music/Video content; off-LAN remote play (TURN not exposed).
