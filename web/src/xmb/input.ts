// web/src/xmb/input.ts
//
// Input layer: translate keyboard events and gamepad state into NavActions.
// Pure mapping + a small stateful poller; no React, no DOM listeners here — the
// container wires keydown handlers and starts/stops the poller.

import type { NavAction } from "./navigation.js";

/** KeyboardEvent.key → NavAction. Anything unmapped yields null. */
const KEY_MAP: Record<string, NavAction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "enter",
  Escape: "back",
};

export function keyToAction(e: { key: string }): NavAction | null {
  return KEY_MAP[e.key] ?? null;
}

/**
 * Standard-gamepad button index → NavAction. Only the buttons we act on are
 * listed: the d-pad (12–15) and the primary/secondary face buttons (0/1).
 */
const BUTTON_MAP: { index: number; action: NavAction }[] = [
  { index: 12, action: "up" },
  { index: 13, action: "down" },
  { index: 14, action: "left" },
  { index: 15, action: "right" },
  { index: 0, action: "enter" }, // A / cross
  { index: 1, action: "back" }, // B / circle
];

export interface GamepadPoller {
  /** Begin polling via requestAnimationFrame (falls back to setInterval). */
  start(): void;
  /** Stop polling. */
  stop(): void;
  /**
   * Read the current gamepad state once and emit any newly-pressed actions.
   * Exposed so tests can drive polling deterministically without timers; in
   * production `start()` calls this on a schedule.
   */
  poll(): void;
}

export interface GamepadPollerOptions {
  /** Injectable gamepad source; defaults to navigator.getGamepads(). */
  getGamepads?: () => (Gamepad | null)[];
}

/**
 * Create a gamepad poller with edge debounce: each button emits its action once
 * on the transition from released→pressed. Holding it emits nothing further;
 * releasing and pressing again re-emits. We track the previous pressed-state per
 * button index so `poll()` is the only place that decides on edges.
 */
export function createGamepadPoller(
  onAction: (a: NavAction) => void,
  opts: GamepadPollerOptions = {},
): GamepadPoller {
  const getGamepads =
    opts.getGamepads ?? (() => navigator.getGamepads());

  // Previous pressed-state keyed by the button indexes we care about.
  const wasPressed = new Map<number, boolean>();
  let rafId: number | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  function poll(): void {
    const pads = getGamepads();
    // Use the first connected gamepad; ignore empty/null slots.
    const pad = pads.find((p): p is Gamepad => p != null);
    if (!pad) return;
    for (const { index, action } of BUTTON_MAP) {
      const pressed = pad.buttons[index]?.pressed ?? false;
      const prev = wasPressed.get(index) ?? false;
      if (pressed && !prev) onAction(action);
      wasPressed.set(index, pressed);
    }
  }

  function start(): void {
    if (rafId != null || intervalId != null) return;
    if (typeof requestAnimationFrame === "function") {
      const loop = () => {
        poll();
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    } else {
      intervalId = setInterval(poll, 1000 / 30);
    }
  }

  function stop(): void {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  return { start, stop, poll };
}
