// web/src/xmb/navigation.test.ts
import { describe, it, expect } from "vitest";
import {
  reduce,
  initialState,
  CATEGORIES,
  GAME_CATEGORY,
  NETWORK_CATEGORY,
  POWER_OFF_INDEX,
  type State,
  type NavContext,
} from "./navigation.js";

// Test fixture ctx: 8 systems, gba has 3 games (others 1), settings has 3 items,
// network has 2 items, photo/music/video empty.
const systems = [
  "psp", "ps", "n64", "ngc", "dc", "snes", "megadrive", "gba",
];
const gamesBySystem: Record<string, { id: string }[]> = {
  psp: [{ id: "psp-1" }],
  gba: [{ id: "gba-1" }, { id: "gba-2" }, { id: "gba-3" }],
};
const categoryCounts: Record<number, number> = {
  0: 3, // settings
  2: 0, // photo
  3: 0, // music
  4: 0, // video
  5: 2, // network
};
const ctx: NavContext = {
  systemsForGame: systems,
  gamesForSystem: (s) => gamesBySystem[s] ?? [{ id: `${s}-1` }],
  categoryItemCount: (c) => categoryCounts[c] ?? 0,
};

const st = (over: Partial<State> = {}): State => ({
  ...initialState,
  ...over,
});

describe("navigation reduce", () => {
  it("categories are in the documented order", () => {
    expect(CATEGORIES).toEqual([
      "settings", "game", "photo", "music", "video", "network",
    ]);
    expect(CATEGORIES[GAME_CATEGORY]).toBe("game");
    expect(CATEGORIES[NETWORK_CATEGORY]).toBe("network");
  });

  it("default focus is the game category, item 0, no drill", () => {
    expect(initialState).toEqual({ category: GAME_CATEGORY, item: 0, drill: null });
  });

  it("right moves to the next category and resets item + drill", () => {
    const start = st({ category: GAME_CATEGORY, item: 4, drill: { system: "gba", game: 2 } });
    const { state, effect } = reduce(start, "right", ctx);
    expect(state).toEqual({ category: 2, item: 0, drill: null });
    expect(effect).toBeUndefined();
  });

  it("left moves to the previous category", () => {
    const { state } = reduce(st({ category: GAME_CATEGORY }), "left", ctx);
    expect(state.category).toBe(0);
  });

  it("left is clamped at the first category", () => {
    const { state } = reduce(st({ category: 0, item: 2 }), "left", ctx);
    expect(state).toEqual({ category: 0, item: 2, drill: null });
  });

  it("right is clamped at the last category", () => {
    const { state } = reduce(st({ category: NETWORK_CATEGORY, item: 1 }), "right", ctx);
    expect(state).toEqual({ category: NETWORK_CATEGORY, item: 1, drill: null });
  });

  it("down/up move item within the game system list, clamped", () => {
    const down = reduce(st({ item: 0 }), "down", ctx);
    expect(down.state.item).toBe(1);
    const upAtTop = reduce(st({ item: 0 }), "up", ctx);
    expect(upAtTop.state.item).toBe(0);
    const downAtBottom = reduce(st({ item: systems.length - 1 }), "down", ctx);
    expect(downAtBottom.state.item).toBe(systems.length - 1);
  });

  it("down is clamped to the category item count for non-game categories", () => {
    // settings (index 0) has 3 items -> max index 2
    const mid = reduce(st({ category: 0, item: 1 }), "down", ctx);
    expect(mid.state.item).toBe(2);
    const clamped = reduce(st({ category: 0, item: 2 }), "down", ctx);
    expect(clamped.state.item).toBe(2);
  });

  it("enter on a system (game, not drilled) drills in with game 0 and no effect", () => {
    // item 7 -> gba
    const { state, effect } = reduce(st({ item: 7 }), "enter", ctx);
    expect(state.drill).toEqual({ system: "gba", game: 0 });
    expect(state.item).toBe(7);
    expect(effect).toBeUndefined();
  });

  it("while drilled, down/up move within that system's games, clamped", () => {
    const drilled = st({ item: 7, drill: { system: "gba", game: 0 } });
    const d1 = reduce(drilled, "down", ctx);
    expect(d1.state.drill).toEqual({ system: "gba", game: 1 });
    const atBottom = reduce(st({ item: 7, drill: { system: "gba", game: 2 } }), "down", ctx);
    expect(atBottom.state.drill).toEqual({ system: "gba", game: 2 });
    const atTop = reduce(drilled, "up", ctx);
    expect(atTop.state.drill).toEqual({ system: "gba", game: 0 });
  });

  it("while drilled, enter emits a launch effect for the focused game", () => {
    const drilled = st({ item: 7, drill: { system: "gba", game: 1 } });
    const { state, effect } = reduce(drilled, "enter", ctx);
    expect(effect).toEqual({ type: "launch", gameId: "gba-2" });
    // state is unchanged by the launch
    expect(state).toEqual(drilled);
  });

  it("back while drilled clears the drill and keeps the system index", () => {
    const drilled = st({ item: 7, drill: { system: "gba", game: 2 } });
    const { state, effect } = reduce(drilled, "back", ctx);
    expect(state).toEqual({ category: GAME_CATEGORY, item: 7, drill: null });
    expect(effect).toBeUndefined();
  });

  it("back at the top level is a no-op", () => {
    const top = st({ category: GAME_CATEGORY, item: 3 });
    const { state, effect } = reduce(top, "back", ctx);
    expect(state).toEqual(top);
    expect(effect).toBeUndefined();
  });

  it("enter on the Power Off item in Network emits a powerOff effect", () => {
    const { state, effect } = reduce(
      st({ category: NETWORK_CATEGORY, item: POWER_OFF_INDEX }),
      "enter",
      ctx,
    );
    expect(effect).toEqual({ type: "powerOff" });
    expect(state).toEqual({ category: NETWORK_CATEGORY, item: POWER_OFF_INDEX, drill: null });
  });

  it("enter on a non-power-off Network item emits no effect", () => {
    const { effect } = reduce(st({ category: NETWORK_CATEGORY, item: 0 }), "enter", ctx);
    expect(effect).toBeUndefined();
  });
});
