// web/src/streaming/Stream.tsx
//
// Full-bleed WebRTC stream surface. Renders our own <video>, drives the vendored
// Selkies client via useSelkies, shows a "Connecting…" overlay until frames flow,
// offers unmute / click-to-start affordances, and reports Escape to the parent so
// it can open the Home menu.

import { useEffect, useRef, useState } from "react";
import { useSelkies } from "./useSelkies.js";

export interface StreamProps {
  /** Same-origin base for `/webrtc/signalling/` + `/turn`. Defaults to current origin. */
  base?: string;
  /** Called when Escape is pressed, so the parent can open the Home menu. */
  onHome: () => void;
}

export function Stream({ base, onHome }: StreamProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // The video peer is video-only; sound arrives on a separate audio peer/element
  // that browsers won't autoplay until a user gesture. `soundOn` tracks whether
  // the user has enabled it.
  const [soundOn, setSoundOn] = useState(false);
  const { status, needsUserGesture, requestPlay } = useSelkies(videoRef, audioRef, base);

  const enableSound = () => {
    requestPlay();      // plays the <audio> element from within the click gesture
    setSoundOn(true);
  };

  // Escape opens the Home menu (parent-owned). Capture at the document so it
  // works even while the <video> has focus for input capture.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onHome();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onHome]);

  const connected = status === "connected";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        overflow: "hidden",
      }}
    >
      <video
        ref={videoRef}
        playsInline
        autoPlay
        muted
        style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
      />
      {/* Sound arrives on a separate audio peer; hidden element, played on gesture. */}
      <audio ref={audioRef} autoPlay style={{ display: "none" }} />

      {!connected && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            font: "500 1.25rem/1.4 system-ui, sans-serif",
            background: "rgba(0,0,0,0.6)",
          }}
        >
          {status === "failed" ? "Connection failed" : "Connecting…"}
        </div>
      )}

      {needsUserGesture && (
        <button
          type="button"
          onClick={requestPlay}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            cursor: "pointer",
            color: "#fff",
            font: "600 1.5rem/1.4 system-ui, sans-serif",
            background: "rgba(0,0,0,0.55)",
          }}
        >
          Click to start
        </button>
      )}

      {connected && !soundOn && (
        <button
          type="button"
          onClick={enableSound}
          style={{
            position: "absolute",
            bottom: "1rem",
            right: "1rem",
            padding: "0.5rem 0.9rem",
            border: "none",
            borderRadius: "0.4rem",
            cursor: "pointer",
            color: "#fff",
            font: "600 0.95rem/1 system-ui, sans-serif",
            background: "rgba(0,0,0,0.65)",
          }}
        >
          🔊 Enable sound
        </button>
      )}
    </div>
  );
}

export default Stream;
