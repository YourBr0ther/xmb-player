// web/src/game/HomeMenu.tsx
//
// The Home (pause) menu — a web-rendered overlay on top of the live gameplay
// video, not Selkies chrome. It reuses the crossbar's visual language (the 2px
// icy-cyan focus rail with its glow, thin uppercase-tracked type, 180ms eases)
// so the pause screen reads as the same console, dimmed and held.
//
// Items: Resume / Save State / Load State / Quit Game. Navigable by keyboard
// (↑ ↓ Enter Esc) and clickable. Save/Load stay in-game and flash a brief line
// of feedback; Quit fires the command and hands control back to the parent.
//
// Keyboard ownership: while this menu is mounted it captures keydown at the
// document in the capture phase and stops propagation for the keys it handles,
// so the underlying <Stream>'s Escape handler stays quiet until the menu closes.

import { useCallback, useEffect, useRef, useState } from "react";
import type { XmbClient } from "../api/client.js";
import type { GameInfo } from "./GameView.js";

type Action = "resume" | "save" | "load" | "quit";

interface MenuItem {
  action: Action;
  label: string;
}

const ITEMS: MenuItem[] = [
  { action: "resume", label: "Resume" },
  { action: "save", label: "Save State" },
  { action: "load", label: "Load State" },
  { action: "quit", label: "Quit Game" },
];

const FLASH_MS = 1600;

export interface HomeMenuProps {
  client: XmbClient;
  game: GameInfo;
  /** Close the menu and return to the running game. */
  onResume: () => void;
  /** Called once a Quit has been issued to the session. */
  onQuit: () => void;
}

export function HomeMenu({ client, game, onResume, onQuit }: HomeMenuProps) {
  const [index, setIndex] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFlash = useCallback((text: string) => {
    setFlash(text);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  // Fire a session command and report the outcome as a flash line.
  const runCommand = useCallback(
    (cmd: string, ok: string, fail: string) => {
      if (busy) return;
      setBusy(true);
      client
        .command(cmd)
        .then(() => showFlash(ok))
        .catch(() => showFlash(fail))
        .finally(() => setBusy(false));
    },
    [busy, client, showFlash],
  );

  const activate = useCallback(
    (action: Action) => {
      switch (action) {
        case "resume":
          onResume();
          return;
        case "save":
          runCommand("save_state", "State saved.", "Save failed.");
          return;
        case "load":
          runCommand("load_state", "State loaded.", "Load failed.");
          return;
        case "quit":
          // Fire-and-forget: the session goes idle over the WS, which routes us
          // back to the crossbar. onQuit lets the parent leave the surface now.
          client.command("quit").catch(() => {});
          onQuit();
          return;
      }
    },
    [client, onQuit, onResume, runCommand],
  );

  // Own the keyboard while mounted. Capture phase + stopPropagation keeps the
  // underlying Stream's Escape handler from also firing (see GameView notes).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setIndex((i) => (i - 1 + ITEMS.length) % ITEMS.length);
          return;
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setIndex((i) => (i + 1) % ITEMS.length);
          return;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          activate(ITEMS[index].action);
          return;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onResume();
          return;
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [activate, index, onResume]);

  // Move real focus with the selection so the focus ring and screen readers
  // track it, without letting focus fall onto the video underneath.
  useEffect(() => {
    buttonsRef.current[index]?.focus();
  }, [index]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  return (
    <div className="home" role="dialog" aria-modal="true" aria-label="Home menu">
      <div className="home__panel">
        <p className="home__eyebrow">Paused</p>
        <h2 className="home__title">{game.title}</h2>

        <ul className="home__menu">
          {ITEMS.map((item, i) => (
            <li key={item.action}>
              <button
                type="button"
                ref={(el) => {
                  buttonsRef.current[i] = el;
                }}
                className={`home__item${i === index ? " is-focused" : ""}`}
                aria-current={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => activate(item.action)}
              >
                <span className="home__item-label">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>

        <p className="home__flash" role="status" aria-live="polite">
          {flash ?? ""}
        </p>

        <p className="home__hint">
          <kbd>↑↓</kbd> Move <kbd>Enter</kbd> Select <kbd>Esc</kbd> Resume
        </p>
      </div>
    </div>
  );
}

export default HomeMenu;
