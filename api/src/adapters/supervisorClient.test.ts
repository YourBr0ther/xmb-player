import { describe, it, expect } from "vitest";
import { retroArchCommand } from "./supervisorClient.js";

describe("retroArchCommand", () => {
  it("maps api commands to RetroArch network commands", () => {
    expect(retroArchCommand("pause")).toBe("PAUSE_TOGGLE");
    expect(retroArchCommand("save_state")).toBe("SAVE_STATE");
    expect(retroArchCommand("load_state")).toBe("LOAD_STATE");
  });
  it("throws on unknown command", () => {
    expect(() => retroArchCommand("explode" as any)).toThrow();
  });
});
