// api/src/http/streamProxy.test.ts
import { describe, it, expect } from "vitest";
import { isSignalingPath, isTurnPath, pickUpstream } from "./streamProxy.js";

describe("isSignalingPath", () => {
  it("matches the signalling path without a trailing slash", () => {
    expect(isSignalingPath("/webrtc/signalling")).toBe(true);
  });
  it("matches the signalling path WITH a trailing slash", () => {
    expect(isSignalingPath("/webrtc/signalling/")).toBe(true);
  });
  it("matches signalling sub-paths", () => {
    expect(isSignalingPath("/webrtc/signalling/1")).toBe(true);
    expect(isSignalingPath("/webrtc/signalling/anything/else")).toBe(true);
  });
  it("does NOT match /api/ws (belongs to the broadcaster)", () => {
    expect(isSignalingPath("/api/ws")).toBe(false);
  });
  it("does NOT match unrelated /webrtc paths", () => {
    expect(isSignalingPath("/webrtc/other")).toBe(false);
  });
  it("does NOT match a prefix impostor", () => {
    expect(isSignalingPath("/webrtc/signallingX")).toBe(false);
  });
});

describe("isTurnPath", () => {
  it("matches /turn", () => {
    expect(isTurnPath("/turn")).toBe(true);
  });
  it("does NOT match look-alikes", () => {
    expect(isTurnPath("/turnip")).toBe(false);
    expect(isTurnPath("/turn/")).toBe(false);
  });
});

describe("pickUpstream", () => {
  it("returns the node's http base url on port 8080", () => {
    expect(pickUpstream("10.0.0.5")).toBe("http://10.0.0.5:8080");
  });
  it("THROWS when nodeIP is null", () => {
    expect(() => pickUpstream(null)).toThrow();
  });
});
