// web/src/streaming/Stream.test.tsx
//
// Shell-level smoke test: <Stream> renders a <video> and shows the "Connecting…"
// overlay before frames flow. Real WebRTC is out of scope here (Task 11 browser
// smoke); we stub the Selkies globals so loadSelkies() short-circuits and the
// hook's connect sequence runs without a live pod.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Stream } from "./Stream.js";

class StubSignalling {
  peer_id = 1;
  state = "disconnected" as const;
  connect() {}
  disconnect() {}
}

class StubInput {
  attach() {}
  detach() {}
  attach_context() {}
  detach_context() {}
  getWindowResolution(): [number, number] {
    return [1280, 720];
  }
}

class StubWebRTC {
  input = new StubInput();
  rtcPeerConfig: RTCConfiguration = {};
  forceTurn = false;
  constructor(
    public signalling: unknown,
    public element: HTMLVideoElement,
    public peerId: number,
  ) {}
  connect() {} // never fires onconnectionstatechange -> stays "Connecting…"
  reset() {}
  playStream() {}
  sendDataChannelMessage() {}
}

beforeEach(() => {
  // Stub the vendored globals so loadSelkies() resolves without injecting scripts.
  (window as unknown as Record<string, unknown>).WebRTCDemoSignalling = StubSignalling;
  (window as unknown as Record<string, unknown>).WebRTCDemo = StubWebRTC;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ iceServers: [] }) })),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).WebRTCDemoSignalling;
  delete (window as unknown as Record<string, unknown>).WebRTCDemo;
  delete (window as unknown as Record<string, unknown>).webrtc;
});

it("renders a <video> and a Connecting… overlay initially", async () => {
  const { container } = render(<Stream onHome={() => {}} />);

  const video = container.querySelector("video");
  expect(video).not.toBeNull();

  expect(screen.getByText(/Connecting/)).toBeTruthy();

  // Let the async connect sequence settle (loadSelkies + /turn fetch) so no
  // state update happens after the test ends; still "Connecting…" (stub never
  // reports connected).
  await waitFor(() => {
    expect((window as unknown as Record<string, unknown>).webrtc).toBeDefined();
  });
  expect(screen.getByText(/Connecting/)).toBeTruthy();
});

it("calls onHome when Escape is pressed", async () => {
  const onHome = vi.fn();
  render(<Stream onHome={onHome} />);
  await waitFor(() => {
    expect((window as unknown as Record<string, unknown>).webrtc).toBeDefined();
  });
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(onHome).toHaveBeenCalledTimes(1);
});
