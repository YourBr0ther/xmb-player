// web/src/xmb/systems.ts
//
// Fixed display order + human labels for the console systems. The Game category
// lists systems in this order (filtered to those actually present in the loaded
// library); GameColumn renders the labels.

import type { SystemId } from "../api/types.js";

export const SYSTEM_ORDER: SystemId[] = [
  "psp",
  "ps",
  "n64",
  "ngc",
  "dc",
  "snes",
  "megadrive",
  "gba",
];

export const SYSTEM_LABELS: Record<SystemId, string> = {
  psp: "PlayStation Portable",
  ps: "PlayStation",
  n64: "Nintendo 64",
  ngc: "GameCube",
  dc: "Dreamcast",
  snes: "Super NES",
  megadrive: "Mega Drive",
  gba: "Game Boy Advance",
};
