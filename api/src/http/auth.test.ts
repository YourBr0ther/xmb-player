// api/src/http/auth.test.ts
import { describe, it, expect } from "vitest";
import { tokenMatches } from "./auth.js";

describe("tokenMatches", () => {
  it("accepts an exact match", () => {
    expect(tokenMatches("s3kr1t", "s3kr1t")).toBe(true);
  });
  it("rejects a wrong token", () => {
    expect(tokenMatches("nope", "s3kr1t")).toBe(false);
  });
  it("rejects a length mismatch without throwing", () => {
    expect(tokenMatches("short", "muchlonger")).toBe(false);
  });
  it("fails closed when the configured token is empty", () => {
    expect(tokenMatches("", "")).toBe(false);
    expect(tokenMatches("anything", "")).toBe(false);
  });
});
