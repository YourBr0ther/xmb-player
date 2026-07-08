// web/src/game/HomeMenu.test.tsx
//
// Unit test for the Home (pause) menu in isolation — no <Stream>, no WebRTC.
// Asserts the two load-bearing wirings: Quit issues client.command("quit"), and
// Resume calls the close handler. A fake client records the commands it receives.

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { HomeMenu } from "./HomeMenu.js";
import type { XmbClient } from "../api/client.js";
import type { GameInfo } from "./GameView.js";

const GAME: GameInfo = { id: "g1", system: "gba", title: "Metroid Fusion" };

function fakeClient() {
  const command = vi.fn(async () => ({
    state: "in-game" as const,
    game: GAME,
    node: null,
    since: 0,
  }));
  return { command } as unknown as XmbClient & { command: typeof command };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("Quit Game issues the quit command and signals exit", () => {
  const client = fakeClient();
  const onQuit = vi.fn();
  render(
    <HomeMenu client={client} game={GAME} onResume={() => {}} onQuit={onQuit} />,
  );

  fireEvent.click(screen.getByText("Quit Game"));

  expect(client.command).toHaveBeenCalledWith("quit");
  expect(onQuit).toHaveBeenCalledTimes(1);
});

it("Resume calls the close handler and issues no command", () => {
  const client = fakeClient();
  const onResume = vi.fn();
  render(
    <HomeMenu client={client} game={GAME} onResume={onResume} onQuit={() => {}} />,
  );

  fireEvent.click(screen.getByText("Resume"));

  expect(onResume).toHaveBeenCalledTimes(1);
  expect(client.command).not.toHaveBeenCalled();
});

it("Save State issues save_state, flashes feedback, and stays open", async () => {
  const client = fakeClient();
  const onResume = vi.fn();
  render(
    <HomeMenu client={client} game={GAME} onResume={onResume} onQuit={() => {}} />,
  );

  await act(async () => {
    fireEvent.click(screen.getByText("Save State"));
  });

  expect(client.command).toHaveBeenCalledWith("save_state");
  expect(screen.getByText("State saved.")).toBeTruthy();
  expect(onResume).not.toHaveBeenCalled();
});
