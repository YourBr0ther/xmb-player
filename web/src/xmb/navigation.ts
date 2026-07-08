// web/src/xmb/navigation.ts
//
// Pure crossbar (XMB) navigation logic. No React, no I/O — the container owns
// state, feeds actions in, and executes any returned Effect.
//
// The reducer is context-driven: it does not know how many systems/games/items
// exist, so the caller supplies counts through `ctx` (a NavContext):
//   - systemsForGame:      the ordered list of system ids shown in the Game
//                          category's top level (item indexes into this list).
//   - gamesForSystem(sys): the ordered games for a drilled-into system
//                          (drill.game indexes into this list).
//   - categoryItemCount(c, drill): number of items in any OTHER category
//                          (settings/photo/music/video/network). Game uses the
//                          two lists above instead.
// `ctx` must be pure/side-effect free.

export const CATEGORIES = [
  "settings", "game", "photo", "music", "video", "network",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Index of the Game category (the default focus). */
export const GAME_CATEGORY = 1;
/** Index of the Network category. */
export const NETWORK_CATEGORY = 5;

/** Network column items; the caller renders these labels. */
export const NETWORK_ITEMS = ["Connection Status", "Power Off"] as const;
/** Index within NETWORK_ITEMS whose `enter` triggers power-off. */
export const POWER_OFF_INDEX = 1;

export interface Drill {
  system: string;
  game: number;
}

export interface State {
  category: number;
  item: number;
  drill: Drill | null;
}

/** Default/initial focus: the Game category, first item, not drilled in. */
export const initialState: State = {
  category: GAME_CATEGORY,
  item: 0,
  drill: null,
};

export type NavAction = "left" | "right" | "up" | "down" | "enter" | "back";

export type Effect =
  | { type: "launch"; gameId: string }
  | { type: "powerOff" };

export interface NavContext {
  categoryItemCount(category: number, drill: Drill | null): number;
  systemsForGame: string[];
  gamesForSystem(system: string): { id: string }[];
}

export interface NavResult {
  state: State;
  effect?: Effect;
}

/** Clamp an index into [0, count - 1] (never negative even when count is 0). */
function clampIndex(index: number, count: number): number {
  return Math.max(0, Math.min(index, count - 1));
}

/** Number of vertically-navigable items given the current focus context. */
function verticalCount(state: State, ctx: NavContext): number {
  if (state.category === GAME_CATEGORY) {
    if (state.drill) return ctx.gamesForSystem(state.drill.system).length;
    return ctx.systemsForGame.length;
  }
  return ctx.categoryItemCount(state.category, state.drill);
}

export function reduce(state: State, action: NavAction, ctx: NavContext): NavResult {
  switch (action) {
    case "left":
    case "right": {
      const delta = action === "left" ? -1 : 1;
      const category = clampIndex(state.category + delta, CATEGORIES.length);
      if (category === state.category) return { state };
      // Changing category resets the item cursor and any drill.
      return { state: { category, item: 0, drill: null } };
    }

    case "up":
    case "down": {
      const delta = action === "up" ? -1 : 1;
      const count = verticalCount(state, ctx);
      if (state.category === GAME_CATEGORY && state.drill) {
        const game = clampIndex(state.drill.game + delta, count);
        return { state: { ...state, drill: { ...state.drill, game } } };
      }
      const item = clampIndex(state.item + delta, count);
      return { state: { ...state, item } };
    }

    case "enter": {
      if (state.category === GAME_CATEGORY) {
        if (state.drill) {
          // Launch the focused game.
          const games = ctx.gamesForSystem(state.drill.system);
          const game = games[state.drill.game];
          if (!game) return { state };
          return { state, effect: { type: "launch", gameId: game.id } };
        }
        // Drill into the focused system.
        const system = ctx.systemsForGame[state.item];
        if (system === undefined) return { state };
        return { state: { ...state, drill: { system, game: 0 } } };
      }
      if (state.category === NETWORK_CATEGORY && state.item === POWER_OFF_INDEX) {
        return { state, effect: { type: "powerOff" } };
      }
      return { state };
    }

    case "back": {
      // Leaving a drill returns to the system list at the same system index.
      if (state.drill) return { state: { ...state, drill: null } };
      return { state };
    }
  }
}
