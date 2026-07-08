// web/src/xmb/Crossbar.test.tsx
//
// Wiring smoke test for the crossbar shell (not pixels). Renders the whole <App>
// against a fake library (mocked fetch) with the token pre-seeded, then asserts:
//   1. the Game column lists the library's systems, in SYSTEM_ORDER; and
//   2. an ArrowDown keydown moves the focused item to the next system.
//
// jsdom has no WebSocket, so useSession short-circuits; we still stub a no-op
// WebSocket to be safe against environments that define one.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../App.js";
import type { SystemGroup } from "../api/types.js";

// snes precedes gba in SYSTEM_ORDER, so the ordered list is [snes, gba].
const LIBRARY: SystemGroup[] = [
  {
    system: "gba",
    games: [
      { id: "g1", system: "gba", title: "Metroid Fusion", core: "mgba", size: 1, path: "/roms/gba/mf", artwork: null },
    ],
  },
  {
    system: "snes",
    games: [
      { id: "s1", system: "snes", title: "Super Metroid", core: "snes9x", size: 1, path: "/roms/snes/sm", artwork: null },
      { id: "s2", system: "snes", title: "Chrono Trigger", core: "snes9x", size: 1, path: "/roms/snes/ct", artwork: null },
    ],
  },
];

class NoopWebSocket {
  onopen: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  close() {}
}

function focusedItemText(): string | null {
  return document.querySelector('[data-item][aria-current="true"] .item__title')
    ?.textContent ?? null;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("xmb.token", "1234");
  vi.stubGlobal("WebSocket", NoopWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => LIBRARY,
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("lists the library systems in the Game column", async () => {
  render(<App />);
  // Game is the default focused category; systems render in SYSTEM_ORDER.
  expect(await screen.findByText("Super NES")).toBeTruthy();
  expect(screen.getByText("Game Boy Advance")).toBeTruthy();
  // First system (snes) is focused initially.
  expect(focusedItemText()).toBe("Super NES");
});

it("moves the focused system down on ArrowDown", async () => {
  render(<App />);
  await screen.findByText("Super NES");
  expect(focusedItemText()).toBe("Super NES");

  fireEvent.keyDown(window, { key: "ArrowDown" });

  await waitFor(() => expect(focusedItemText()).toBe("Game Boy Advance"));
});
