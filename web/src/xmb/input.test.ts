// web/src/xmb/input.test.ts
import { describe, it, expect } from "vitest";
import { keyToAction, createGamepadPoller } from "./input.js";
import type { NavAction } from "./navigation.js";

// A minimal, mutable stand-in for the parts of a Gamepad we read. jsdom has no
// real Gamepad, so tests build these plain objects and cast at the call site.
interface FakeGamepad {
  buttons: { pressed: boolean }[];
  axes: number[];
}

/** A gamepad with 16 released buttons (index 0..15) and no axes. */
function freshGamepad(): FakeGamepad {
  return { buttons: Array.from({ length: 16 }, () => ({ pressed: false })), axes: [] };
}

describe("keyToAction", () => {
  it("maps arrow keys to directions", () => {
    expect(keyToAction({ key: "ArrowUp" })).toBe("up");
    expect(keyToAction({ key: "ArrowDown" })).toBe("down");
    expect(keyToAction({ key: "ArrowLeft" })).toBe("left");
    expect(keyToAction({ key: "ArrowRight" })).toBe("right");
  });

  it("maps Enter to enter and Escape to back", () => {
    expect(keyToAction({ key: "Enter" })).toBe("enter");
    expect(keyToAction({ key: "Escape" })).toBe("back");
  });

  it("returns null for unmapped keys", () => {
    expect(keyToAction({ key: "a" })).toBeNull();
    expect(keyToAction({ key: " " })).toBeNull();
  });
});

describe("createGamepadPoller", () => {
  it("emits a held button once, not every poll", () => {
    const pad = freshGamepad();
    const actions: NavAction[] = [];
    const poller = createGamepadPoller((a) => actions.push(a), {
      getGamepads: () => [pad as unknown as Gamepad],
    });

    pad.buttons[12].pressed = true; // d-pad up held down
    poller.poll();
    poller.poll();
    poller.poll();

    expect(actions).toEqual(["up"]);
  });

  it("re-emits after release and re-press", () => {
    const pad = freshGamepad();
    const actions: NavAction[] = [];
    const poller = createGamepadPoller((a) => actions.push(a), {
      getGamepads: () => [pad as unknown as Gamepad],
    });

    pad.buttons[12].pressed = true;
    poller.poll();
    pad.buttons[12].pressed = false;
    poller.poll();
    pad.buttons[12].pressed = true;
    poller.poll();

    expect(actions).toEqual(["up", "up"]);
  });

  it("maps d-pad directions and A/B buttons", () => {
    const pad = freshGamepad();
    const actions: NavAction[] = [];
    const poller = createGamepadPoller((a) => actions.push(a), {
      getGamepads: () => [pad as unknown as Gamepad],
    });

    pad.buttons[13].pressed = true; // down
    pad.buttons[14].pressed = true; // left
    pad.buttons[15].pressed = true; // right
    pad.buttons[0].pressed = true; // A/cross -> enter
    pad.buttons[1].pressed = true; // B/circle -> back
    poller.poll();

    expect(actions).toEqual(["down", "left", "right", "enter", "back"]);
  });

  it("ignores a null gamepad slot without emitting", () => {
    const actions: NavAction[] = [];
    const poller = createGamepadPoller((a) => actions.push(a), {
      getGamepads: () => [null],
    });

    poller.poll();

    expect(actions).toEqual([]);
  });
});
