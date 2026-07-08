# Vendored Selkies streaming client (Task 5 spike)

> **Status: reuse-standalone is FEASIBLE.** The Selkies web client ships as
> separate, lightly-DOM-coupled global-class scripts (`signalling.js`,
> `webrtc.js`, `input.js`) — not a single minified bundle. They can be reused in
> our React app with a thin adapter and **one documented workaround** (a global
> `window.webrtc` reference in the signalling code path). The iframe fallback is
> **not** needed. Details and the exact Task 6 call sequence are below.

## Provenance

- **Source:** `/opt/gst-web` extracted from our game-session image
  `docker.io/yourbr0ther/psp-xmb-game-session:phase1`
  (`docker create` + `docker cp`, see the plan's Task 5 Step 1).
- **Upstream project:** [selkies-project/selkies-gstreamer](https://github.com/selkies-project/selkies-gstreamer)
  `gst-web` client. Asset build timestamp in the image: `ts=1723709107`
  (2024-08-15); PWA cache name `selkies-webrtc-pwa`. The image's Selkies is the
  v1.6.x line (referred to as v1.6.2 in the plan; the assets themselves are not
  version-stamped beyond the `ts=` query string, so treat "1.6.2" as the image's
  Selkies release, not a string embedded in these files).
- **Extracted verbatim.** No edits were made to the vendored `.js` files in this
  spike. Any adaptation (ESM exports, the `window.webrtc` workaround) happens in
  Task 6's own code, not here — the vendored files stay pristine so they remain
  auditable against upstream.

## License

- `signalling.js`, `webrtc.js`, `input.js`, `gamepad.js` — **MPL-2.0**
  (headers intact; each also carries an Apache-2.0 attribution to "Copyright 2019
  Google LLC" for incorporated work). Keep these headers on any copy/derivative.
- `util.js` — **has no license header in upstream.** It is part of the same
  MPL-2.0 Selkies `gst-web` tree; it was copied verbatim (header-less) rather
  than fabricating one. Treat it as MPL-2.0 by association.
- `lib/guacamole-keyboard-selkies.js` — **Apache-2.0** (Apache Guacamole, header
  intact). This is a third-party dependency of `input.js`'s keyboard handling; a
  local customization is noted at the top of the file ("Customized Line 839").

## File inventory (the standalone dependency closure)

| File | Global(s) it defines | Depends on (globals) |
|------|----------------------|----------------------|
| `signalling.js` | `WebRTCDemoSignalling` | `WebSocket`, `RTCSessionDescription`, `RTCIceCandidate`; **`webrtc`** (reads `webrtc.input.getWindowResolution()` on WS open — see Gotchas) |
| `webrtc.js` | `WebRTCDemo` | `Input` (from `input.js`), `base64ToString` (from `util.js`), `RTCPeerConnection` |
| `input.js` | `Input` | `Queue` (util.js), `Guacamole.Keyboard` (lib), `GamepadManager` (gamepad.js); `addListener`/`removeListeners` are defined in-file |
| `gamepad.js` | `GamepadManager` | — |
| `util.js` | `Queue`, `stringToBase64`, `base64ToString` | — |
| `lib/guacamole-keyboard-selkies.js` | `Guacamole` (namespace) | — |

Everything is **classic global-class scripts** — there are **no ES `import`/
`export` statements**. In Selkies they load in dependency order via `<script>`
tags in `index.html`:
`webrtc-adapter → gamepad.js → input.js → util.js → signalling.js → webrtc.js → app.js`.
(`app.js` is Selkies' Vue application wiring — we do **not** vendor it; Task 6
reimplements that wiring in React. `webrtc-adapter` is an optional shim; modern
Chromium/Firefox do not require it.)

## Exact API surface (real signatures, read from source)

### `WebRTCDemoSignalling` (`signalling.js`)
```js
new WebRTCDemoSignalling(server /* URL object */)
```
- **Constructor arg:** a `URL` object of the signalling WebSocket endpoint.
  Selkies builds it as
  `new URL(protocol + window.location.host + "/" + app.appName + "/signalling/")`
  where `protocol` is `"ws://"`/`"wss://"` and `app.appName` defaults to
  `"webrtc"`. Net effect (and what Phase 1 observed): **`.../webrtc/signalling/`
  with a trailing slash**.
- **Public props:** `.peer_id` (default **`1`** — the video *consumer*), `.state`
  (`'disconnected'|'connecting'|'connected'`), `.retry_count`.
- **Callbacks (assign functions):** `onstatus(msg)`, `onerror(msg)`,
  `ondebug(msg)`, `onsdp(RTCSessionDescription)`, `onice(RTCIceCandidate)`,
  `ondisconnect()`.
- **Methods:** `connect()` (opens the WS; on `open` it sends
  `HELLO <peer_id> <base64(meta)>` where meta = `{res, scale}`), `disconnect()`,
  `sendICE(ice)`, `sendSDP(sdp)`.
- **Protocol:** server messages are `HELLO`, `ERROR*`, or JSON `{sdp}` / `{ice}`.

### `WebRTCDemo` (`webrtc.js`)
```js
new WebRTCDemo(signalling, element /* <video> */, peer_id)
```
- **Constructor args:** a `WebRTCDemoSignalling` instance, the **`<video>`
  element** to attach the stream to, and the consumer `peer_id`
  (**`1` = video**, **`3` = audio** in Selkies' dual-peer setup).
- **In the constructor it:** binds `signalling.onsdp`/`signalling.onice` to its own
  handlers, and **auto-creates `this.input = new Input(element, sendFn)`** where
  `sendFn` pushes strings down the data channel. So **you do not construct `Input`
  yourself** — reach it via `webrtc.input`.
- **Key prop:** `.rtcPeerConfig` — the `RTCConfiguration` (defaults to a Google
  STUN-only config). **Overwrite this with the JSON from `/turn` before
  `connect()`.** Also `.forceTurn` (bool), `.peerConnection`, `.element`.
- **Callbacks:** `onstatus`, `ondebug`, `onerror`,
  `onconnectionstatechange(state)` (`"connected"|"disconnected"|"failed"|"closed"`),
  `ondatachannelopen()`, `ondatachannelclose()`, `onplaystreamrequired()` (fires
  when autoplay is blocked — must call `playStream()` after a user gesture),
  plus `onclipboardcontent`, `oncursorchange`, `onsystemaction`, `ongpustats`,
  `onsystemstats`, `onlatencymeasurement`.
- **Methods:** `connect()` (creates the `RTCPeerConnection` from `rtcPeerConfig`,
  wires `ontrack`/`onicecandidate`/`ondatachannel`/`onconnectionstatechange`,
  copies `peer_id` onto the signalling instance, then calls
  `signalling.connect()`), `reset()`, `playStream()`, `sendDataChannelMessage(str)`,
  `getConnectionStats()` → Promise.
- **Media attach is automatic:** on `ontrack` it sets
  `element.srcObject = event.streams[0]` and calls `playStream()`. Video **and**
  audio tracks both go onto whatever element that `WebRTCDemo` owns.

### `Input` (`input.js`) — reached via `webrtc.input`
```js
new Input(element /* <video> */, send /* (str)=>void */)   // Selkies calls this for you
```
- **Callbacks:** `onmenuhotkey()` (Ctrl+Shift+M), `onfullscreenhotkey`
  (default = `enterFullscreen`), `onresizeend()`, `ongamepadconnected(id)`,
  `ongamepaddisconnected()`.
- **Methods:** `attach()` (window/document/element listeners for mouse, wheel,
  touch, resize, gamepad, **and constructs `Guacamole.Keyboard(window)`** —
  requires the guac lib global), `detach()`, `attach_context()`/`detach_context()`
  (the keyboard/mouse subset), `getWindowResolution()` → `[w,h]`,
  `getCursorScaleFactor()`, `enterFullscreen()`, `requestKeyboardLock()`.
- **Wire encoding it sends over the data channel:** `kd,<keysym>`/`ku,<keysym>`
  (keys), `m`/`m2,<x>,<y>,<mask>,<scroll>` (mouse), `js,...` (gamepad),
  `kr` (reset stuck keys), `p,0|1` (pointer visibility), `r,<WxH>` (resize).

### `GamepadManager` (`gamepad.js`) / `util.js` helpers
- `new GamepadManager(gamepad, onButton, onAxis)` — used internally by `Input`.
- `util.js`: `Queue` class, `stringToBase64`, `base64ToString`.

## Coupling assessment (why standalone reuse works)

The classes are **almost** self-contained. The only DOM/global couplings:
1. **`signalling.js` line ~180** (`_onServerOpen`) hard-references a **global
   `webrtc`**: `var currRes = webrtc.input.getWindowResolution();`. This is on the
   hot path (fires on every WS open). **Workaround (no file edit):** assign
   `window.webrtc = <video WebRTCDemo instance>` before calling
   `signalling.connect()`. Both the video and audio signalling instances read the
   same global, so pointing it at the video instance satisfies both.
2. **`webrtc.js` `capture_setup()`** uses `document.getElementById("capture")` —
   but only in the `fun()`/`capture()` debug helpers, **never on the connect
   path**. Safe to ignore.
3. **`input.js`** attaches a fullscreen listener to `element.parentElement` and
   reads `document.body.offsetWidth`. React always gives the `<video>` a parent,
   so this is fine.

None of these bind to Selkies' Vue app or specific `index.html` ids on the
connect path. That is why reuse is practical.

### How to load classic scripts inside Vite/React (Task 6 concern)
These files have no `export`. Two workable options for Task 6 (pick one there):
- **(A) Import for side-effect + read globals.** Append a tiny local
  `?raw`-eval or a `web/src/vendor/selkies/index.ts` shim that `import`s each file
  as a side-effect module and re-exports `window.WebRTCDemoSignalling` etc. Because
  Vite/ESM runs modules in strict mode where top-level `class X {}` does **not**
  become a global, the cleanest is option B.
- **(B) Add a one-line ESM footer per file in a build step / thin wrapper** that
  does `export { WebRTCDemoSignalling }` etc., or load them via a `<script>` tag
  injected at runtime (`import selkiesUrl from './signalling.js?url'`). Whichever
  Task 6 chooses, keep the vendored source pristine and do the adaptation in a
  wrapper module so the license-bearing files stay verbatim.

---

## Concrete integration plan for Task 6

Goal: our React `<Stream>` renders a full-bleed `<video>` and connects to the
game-session pod through **same-origin** `xmb-api` proxy paths (`/webrtc/signalling/`
and `/turn`), reusing these vendored classes.

**Call sequence (in `useSelkies.ts`, given a `videoRef`):**

1. **Build the signalling URL on our origin (mind the trailing slash):**
   ```js
   const proto = location.protocol === "http:" ? "ws://" : "wss://";
   const sigUrl = new URL(`${proto}${location.host}/webrtc/signalling/`); // trailing slash REQUIRED
   const signalling = new WebRTCDemoSignalling(sigUrl);
   ```
   (Do **not** point at `:8080` — xmb-api proxies it same-origin; see Gotchas.)

2. **Construct the video WebRTCDemo with our `<video>` and consumer peer_id 1:**
   ```js
   const webrtc = new WebRTCDemo(signalling, videoRef.current, 1);
   window.webrtc = webrtc; // satisfies signalling.js's global ref (workaround #1)
   ```
   `webrtc.input` now exists automatically.

3. **(If audio is wanted) construct the audio peer** — separate signalling +
   WebRTCDemo on peer_id **3**, attached to a hidden `<audio>` element:
   ```js
   const audioSig = new WebRTCDemoSignalling(new URL(sigUrl));
   const audioWebrtc = new WebRTCDemo(audioSig, audioRef.current, 3);
   ```
   Audio can be deferred for the first Task 6 milestone (video-first); it is a
   clean add-on, not a dependency of video.

4. **Wire the callbacks** you need for UI status:
   ```js
   webrtc.onconnectionstatechange = (state) => { /* 'connected' → hide overlay */ };
   webrtc.onplaystreamrequired = () => { /* show a "click to start" button; on click call webrtc.playStream() */ };
   webrtc.ondatachannelopen = () => { webrtc.input.attach(); }; // enable input once channel is open
   webrtc.ondatachannelclose = () => { webrtc.input.detach(); };
   signalling.onstatus = ...; signalling.onerror = ...;
   ```

5. **Fetch `/turn`, set it as the RTCConfiguration, then connect** (order matters
   — `rtcPeerConfig` must be set *before* `connect()`, which reads it when it
   builds the `RTCPeerConnection`):
   ```js
   const config = await fetch("/turn").then(r => r.json()); // same-origin, proxied by xmb-api
   webrtc.rtcPeerConfig = config;
   webrtc.connect();          // creates RTCPeerConnection, then signalling.connect()
   // audioWebrtc.rtcPeerConfig = config; audioWebrtc.connect();  // if audio enabled
   ```
   On success: signalling sends `HELLO 1 …`, the pod answers with an SDP **offer**,
   `WebRTCDemo._onSDP` creates the answer, ICE flows both ways, `ontrack` sets
   `video.srcObject` and calls `playStream()`. Consider the stream "live" when
   `onconnectionstatechange('connected')` fires or `video.readyState >= 3`.

6. **Input capture:** it is enabled in step 4 (`webrtc.input.attach()` on
   data-channel open). `attach()` needs the `Guacamole` global from
   `lib/guacamole-keyboard-selkies.js`, so that file must be loaded/imported before
   `attach()` runs. To gate input to focus, call `webrtc.input.detach_context()` on
   blur and `attach_context()` on focus (Selkies does exactly this).

7. **Cleanup on unmount:** `webrtc.input.detach()`,
   `signalling.disconnect()` (and the audio pair), null `video.srcObject`, and
   `delete window.webrtc`.

## Gotchas (carry into Task 6 **and** the xmb-api proxy in Task 7)

- **Trailing slash is mandatory.** The endpoint is `/webrtc/signalling/` **with**
  the trailing slash. Phase 1 confirmed the pod's nginx only matches the
  slash-terminated path; the xmb-api proxy must preserve it (do not normalize
  `/webrtc/signalling/` → `/webrtc/signalling`).
- **WebSocket upgrade must be HTTP/1.1.** The Phase 1 nginx fix required
  `proxy_http_version 1.1` + `Upgrade`/`Connection` headers for the signalling
  WS. Our xmb-api proxy (Task 7) must replicate this: forward the `Upgrade`
  handshake over HTTP/1.1 to `http://<nodeIP>:8080`, keep the path
  (`/webrtc/signalling/`) verbatim, and proxy `GET /turn` too.
- **`/turn` is same-origin.** Selkies fetches `/turn` (no host), so xmb-api must
  serve/proxy `/turn` on our origin returning the pod's `RTCConfiguration` JSON
  (`{ iceServers, iceTransportPolicy, ... }`).
- **Two peer connections.** Video = consumer **peer_id 1**, audio = consumer
  **peer_id 3** (producers are 0/2 on the pod). They are independent WS + RTC
  pairs sharing the same `/webrtc/signalling/` endpoint. Video-only is a valid
  first target.
- **Autoplay policy.** `playStream()` may reject without a prior user gesture;
  handle `onplaystreamrequired` with a click-to-start affordance (or mute the
  video element to allow muted autoplay).
- **Global `window.webrtc`.** Required by `signalling.js` (workaround #1 above).
  Set it before `connect()`; clear it on unmount to avoid leaks across remounts.
- **Guacamole load order.** `input.attach()`/`attach_context()` construct
  `new Guacamole.Keyboard(window)`; ensure `lib/guacamole-keyboard-selkies.js` is
  evaluated first.
- **Vite/ESM strict mode.** Top-level `class` in these files won't auto-attach to
  `window` under ESM. Load them so the classes become reachable (script-tag
  injection or a wrapper that assigns to `window`) — see "How to load classic
  scripts" above.
