// web/src/streaming/loadSelkies.ts
//
// Loads the vendored Selkies client (web/src/vendor/selkies/*.js) so its
// global classes (WebRTCDemoSignalling, WebRTCDemo, Input, GamepadManager,
// Guacamole, Queue) become reachable from our React code — WITHOUT editing the
// vendored source (see web/src/vendor/selkies/README.md).
//
// WHY A REAL <script> TAG (and not a plain ESM import):
//   The vendored files are *classic* scripts that declare bare top-level
//   `class X {}` / `var Guacamole` and reference each other by bare global name
//   (webrtc.js -> `Input`/`base64ToString`, input.js -> `Guacamole`/`Queue`/
//   `GamepadManager`, signalling.js -> a runtime global `webrtc`). Under Vite's
//   ESM/strict module scope those top-level `class` bindings do NOT attach to
//   `window`, and cross-file bare references would not resolve. Running the
//   files as an ESM `import` therefore does not work.
//
//   Options the spike listed were (a) inject <script src> to the files served as
//   static assets, (b) fetch+eval, (c) `?raw` + evaluate. We use a blend of
//   (a)+(c) that is the most robust for a Vite SPA:
//
//     - `?raw` inlines each vendored file's text at build time, so we do NOT
//       depend on the .js files being separately served as static assets (they
//       ride along inside the JS bundle as strings). Task 10's image needs
//       nothing extra for them.
//     - We concatenate them, in dependency order, into ONE classic <script>
//       delivered via a Blob URL. A single classic script runs them in exactly
//       the sloppy-mode, shared-global-lexical environment they were written
//       for, so every cross-file bare reference resolves the same way it does in
//       Selkies' own index.html. This is faithful and low-risk — no eval-scope
//       or strict-mode surprises.
//     - A wrapper-owned footer (NOT part of any vendored file) assigns the two
//       classes we construct to `window`, giving us typed `window.*` handles.
//
// NOTE for Task 7 / Task 10: if a Content-Security-Policy is ever added to the
// app, it must allow `script-src blob:` (or this must switch to a nonce'd inline
// script), because the loader injects a Blob-URL <script>.

import utilSrc from "../vendor/selkies/util.js?raw";
import gamepadSrc from "../vendor/selkies/gamepad.js?raw";
import guacSrc from "../vendor/selkies/lib/guacamole-keyboard-selkies.js?raw";
import inputSrc from "../vendor/selkies/input.js?raw";
import signallingSrc from "../vendor/selkies/signalling.js?raw";
import webrtcSrc from "../vendor/selkies/webrtc.js?raw";

// ---- Typed surface of the vendored classes (see README "Exact API surface") ----

export interface SelkiesInput {
  attach(): void;
  detach(): void;
  attach_context(): void;
  detach_context(): void;
  getWindowResolution(): [number, number];
}

export interface SelkiesSignalling {
  peer_id: number;
  state: "disconnected" | "connecting" | "connected";
  onstatus?: (msg: string) => void;
  onerror?: (msg: string) => void;
  ondebug?: (msg: string) => void;
  ondisconnect?: () => void;
  connect(): void;
  disconnect(): void;
}

export interface SelkiesWebRTC {
  input: SelkiesInput;
  // A media element — <video> for the video peer, <audio> for the audio peer.
  element: HTMLMediaElement;
  rtcPeerConfig: RTCConfiguration;
  forceTurn: boolean;
  peerConnection?: RTCPeerConnection;
  onstatus?: (msg: string) => void;
  onerror?: (msg: string) => void;
  ondebug?: (msg: string) => void;
  onconnectionstatechange?: (state: string) => void;
  ondatachannelopen?: () => void;
  ondatachannelclose?: () => void;
  onplaystreamrequired?: () => void;
  connect(): void;
  reset(): void;
  playStream(): void;
  sendDataChannelMessage(msg: string): void;
}

export type SelkiesSignallingCtor = new (server: URL) => SelkiesSignalling;
export type SelkiesWebRTCCtor = new (
  signalling: SelkiesSignalling,
  element: HTMLMediaElement,
  peerId: number,
) => SelkiesWebRTC;

declare global {
  interface Window {
    WebRTCDemoSignalling?: SelkiesSignallingCtor;
    WebRTCDemo?: SelkiesWebRTCCtor;
    // signalling.js reads this bare global on WS open (README gotcha #1); we set
    // it to the video WebRTCDemo instance before connect().
    webrtc?: SelkiesWebRTC;
  }
}

export interface SelkiesGlobals {
  Signalling: SelkiesSignallingCtor;
  WebRTCDemo: SelkiesWebRTCCtor;
}

function readGlobals(): SelkiesGlobals | null {
  const Signalling = window.WebRTCDemoSignalling;
  const WebRTCDemo = window.WebRTCDemo;
  return Signalling && WebRTCDemo ? { Signalling, WebRTCDemo } : null;
}

// Dependency order (util -> gamepad -> guac -> input -> signalling -> webrtc),
// matching Selkies' own index.html load order, followed by a wrapper footer that
// publishes the two constructors we use onto window.
const SCRIPT_TEXT = [
  utilSrc,
  gamepadSrc,
  guacSrc,
  inputSrc,
  signallingSrc,
  webrtcSrc,
  "\n;window.WebRTCDemoSignalling = WebRTCDemoSignalling;",
  "\n;window.WebRTCDemo = WebRTCDemo;\n",
].join("\n");

let loadPromise: Promise<SelkiesGlobals> | null = null;

/**
 * Ensure the vendored Selkies globals are loaded exactly once. Resolves with the
 * two constructors we build the pipeline from. Idempotent across remounts.
 */
export function loadSelkies(): Promise<SelkiesGlobals> {
  // Already present (e.g. a prior mount, or stubbed in tests).
  const existing = readGlobals();
  if (existing) return Promise.resolve(existing);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<SelkiesGlobals>((resolve, reject) => {
    const blob = new Blob([SCRIPT_TEXT], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const script = document.createElement("script");
    script.dataset.selkies = "vendored";
    script.src = url;
    script.onload = () => {
      URL.revokeObjectURL(url);
      const globals = readGlobals();
      if (globals) resolve(globals);
      else reject(new Error("Selkies scripts loaded but globals are missing"));
    };
    script.onerror = () => {
      URL.revokeObjectURL(url);
      loadPromise = null; // allow a later retry
      reject(new Error("Failed to load vendored Selkies scripts"));
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}
