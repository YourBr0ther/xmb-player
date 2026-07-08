// web/src/streaming/useSelkies.ts
//
// React hook that wires the vendored Selkies client (see ./loadSelkies.ts and
// web/src/vendor/selkies/README.md) to a <video> element and runs Task 5's
// documented connect sequence against same-origin `/webrtc/signalling/` + `/turn`
// (both proxied by xmb-api in Task 7).

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  loadSelkies,
  type SelkiesSignalling,
  type SelkiesWebRTC,
} from "./loadSelkies.js";

export type StreamStatus = "idle" | "connecting" | "connected" | "failed";

export interface UseSelkiesResult {
  status: StreamStatus;
  /** True when autoplay was blocked and a user gesture is needed to start playback. */
  needsUserGesture: boolean;
  /** Call from within a user gesture (e.g. a click) to (re)start playback. */
  requestPlay: () => void;
}

/** Build the signalling WebSocket URL on our origin. Trailing slash is REQUIRED. */
function signallingUrl(base: string): URL {
  const u = new URL("/webrtc/signalling/", base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u;
}

/**
 * Connect `videoRef` to the game-session stream via the vendored Selkies client.
 *
 * @param videoRef ref to the <video> element the stream attaches to.
 * @param base same-origin base URL for `/webrtc/signalling/` and `/turn`.
 *             Defaults to the current origin.
 */
export function useSelkies(
  videoRef: RefObject<HTMLVideoElement | null>,
  // Separate <audio> element for the audio peer (Selkies uses a distinct
  // audio-only WebRTC connection, consumer peer_id 3). Optional.
  audioRef?: RefObject<HTMLAudioElement | null>,
  // An empty or omitted base falls back to the current origin below.
  base: string = "",
): UseSelkiesResult {
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [needsUserGesture, setNeedsUserGesture] = useState(false);
  const webrtcRef = useRef<SelkiesWebRTC | null>(null);

  const requestPlay = () => {
    const video = videoRef.current;
    const audio = audioRef?.current;
    setNeedsUserGesture(false);
    // Retry both elements + the Selkies play path from within the user gesture.
    // Audio autoplay is almost always blocked until a gesture, so this is what
    // actually turns sound on.
    video?.play().catch(() => undefined);
    audio?.play().catch(() => undefined);
    webrtcRef.current?.playStream();
  };

  // An explicit empty base (e.g. <Stream base="">) must fall back to the
  // current origin; new URL(path, "") throws "Invalid base URL".
  const origin =
    base || (typeof window !== "undefined" ? window.location.origin : "http://localhost");

  useEffect(() => {
    let cancelled = false;
    let signalling: SelkiesSignalling | null = null;
    let webrtc: SelkiesWebRTC | null = null;
    let audioSignalling: SelkiesSignalling | null = null;
    let audioWebrtc: SelkiesWebRTC | null = null;

    async function connect() {
      const video = videoRef.current;
      if (!video) return;
      setStatus("connecting");

      let Signalling, WebRTCDemo;
      try {
        ({ Signalling, WebRTCDemo } = await loadSelkies());
      } catch {
        if (!cancelled) setStatus("failed");
        return;
      }
      if (cancelled) return;

      // 1. Signalling on our origin (video consumer = peer_id 1 by default).
      signalling = new Signalling(signallingUrl(origin));

      // 2. Video WebRTCDemo bound to our <video>; publish the global the
      //    signalling hot-path reads (README gotcha #1).
      webrtc = new WebRTCDemo(signalling, video, 1);
      webrtcRef.current = webrtc;
      window.webrtc = webrtc;

      // 3. Callbacks for UI status + input + autoplay gesture.
      webrtc.onconnectionstatechange = (state) => {
        if (cancelled) return;
        if (state === "connected") setStatus("connected");
        else if (state === "failed" || state === "closed") setStatus("failed");
      };
      webrtc.onplaystreamrequired = () => {
        // Autoplay blocked: attempt play(), surface a click-to-start affordance
        // if the browser still refuses.
        video
          .play()
          .then(() => {
            if (!cancelled) setNeedsUserGesture(false);
          })
          .catch(() => {
            if (!cancelled) setNeedsUserGesture(true);
          });
      };
      webrtc.ondatachannelopen = () => {
        // Enable keyboard/mouse/gamepad capture once the data channel is up.
        // attach() needs the Guacamole global, which loadSelkies() has loaded.
        webrtc?.input.attach();
      };
      webrtc.ondatachannelclose = () => {
        webrtc?.input.detach();
      };

      // 3b. Audio peer — a separate signalling + WebRTCDemo on consumer peer_id 3,
      //     bound to its own <audio> element. We deliberately do NOT attach its
      //     input (only the video peer handles input, else keypresses double).
      //     Its signalling reuses the global `window.webrtc` on its hot path,
      //     which is the video peer we set above.
      const audio = audioRef?.current ?? null;
      if (audio) {
        audioSignalling = new Signalling(signallingUrl(origin));
        audioWebrtc = new WebRTCDemo(audioSignalling, audio, 3);
        // Expose the audio peer for diagnostics (audio RTP stats), mirroring
        // the original Selkies client's window.audio_webrtc.
        (window as unknown as { audio_webrtc?: SelkiesWebRTC }).audio_webrtc = audioWebrtc;
        audioWebrtc.onplaystreamrequired = () => {
          // Audio autoplay is blocked until a user gesture; surface the same
          // click-to-start affordance the video path uses.
          audio.play().catch(() => {
            if (!cancelled) setNeedsUserGesture(true);
          });
        };
      }

      // 4. Fetch /turn for the RTCConfiguration; MUST be set before connect().
      try {
        const config = (await fetch(new URL("/turn", origin)).then((r) => {
          if (!r.ok) throw new Error(`/turn ${r.status}`);
          return r.json();
        })) as RTCConfiguration;
        if (cancelled) return;
        webrtc.rtcPeerConfig = config;
        if (audioWebrtc) audioWebrtc.rtcPeerConfig = config;
      } catch {
        // Fall back to the client's built-in default rtcPeerConfig (STUN-only);
        // connect may still succeed on a LAN. Do not abort the attempt.
      }
      if (cancelled) return;

      // 5. Connect (builds RTCPeerConnection from rtcPeerConfig, then signalling).
      webrtc.connect();
      audioWebrtc?.connect();
    }

    void connect();

    return () => {
      cancelled = true;
      try {
        webrtc?.input.detach();
      } catch {
        /* input may not have attached */
      }
      try {
        signalling?.disconnect();
        audioSignalling?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        webrtc?.peerConnection?.close();
        audioWebrtc?.peerConnection?.close();
      } catch {
        /* ignore */
      }
      const video = videoRef.current;
      if (video) video.srcObject = null;
      const audio = audioRef?.current;
      if (audio) audio.srcObject = null;
      if (window.webrtc === webrtc) delete window.webrtc;
      webrtcRef.current = null;
    };
    // Reconnect only if the origin base changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin]);

  return { status, needsUserGesture, requestPlay };
}
