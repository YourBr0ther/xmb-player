// web/src/App.tsx
//
// App shell for the XMB console.
//
//   App    — owns the bearer token (the XMB PIN) in localStorage and the auth
//            gate. Renders <Console> once a token exists.
//   Gate   — PIN entry; stores the entered value as the token.
//   Console— creates the API client, loads the library, subscribes to the live
//            session over WebSocket, holds crossbar nav State (the Task 3
//            reducer), wires keyboard + gamepad input (Task 4), and renders
//            <Crossbar>. A 401 anywhere clears the token and returns to the gate.
//
// Task 9 seam: Console is where the crossbar↔in-game switch belongs. It already
// holds the live `session` snapshot; when session.state becomes "starting" /
// "in-game" it should render the launching indicator / <GameView> instead of
// <Crossbar>, and suspend the crossbar input listeners while in-game.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import "./xmb/xmb.css";
import { createClient } from "./api/client.js";
import type { SystemGroup } from "./api/types.js";
import { Crossbar } from "./xmb/Crossbar.js";
import { SETTINGS_ROWS } from "./xmb/SettingsColumn.js";
import { SYSTEM_ORDER } from "./xmb/systems.js";
import {
  initialState,
  reduce,
  NETWORK_CATEGORY,
  CATEGORIES,
} from "./xmb/navigation.js";
import type { NavAction, NavContext, State } from "./xmb/navigation.js";
import { keyToAction, createGamepadPoller } from "./xmb/input.js";
import { useSession } from "./session/useSession.js";
import GameView from "./game/GameView.js";
import "./game/game.css";

const TOKEN_KEY = "xmb.token";
const SETTINGS_CATEGORY = CATEGORIES.indexOf("settings");

function isAuthError(err: unknown): boolean {
  return err instanceof Error && /401/.test(err.message);
}

export default function App() {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(TOKEN_KEY),
  );

  const saveToken = useCallback((value: string) => {
    localStorage.setItem(TOKEN_KEY, value);
    setToken(value);
  }, []);

  const clearToken = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }, []);

  if (!token) return <Gate onSubmit={saveToken} />;
  // `key` remounts the console on token change so stale state never leaks.
  return <Console key={token} token={token} onInvalidToken={clearToken} />;
}

function Gate({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [pin, setPin] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = pin.trim();
    if (value) onSubmit(value);
  };

  return (
    <div className="gate">
      <span className="gate__brand">PSP · XMB</span>
      <h1 className="gate__title">Enter your PIN</h1>
      <form onSubmit={submit}>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          placeholder="••••"
          aria-label="PIN"
          onChange={(e) => setPin(e.target.value)}
        />
        <button type="submit">Unlock</button>
      </form>
      <span className="gate__hint">The console remembers this on this device.</span>
    </div>
  );
}

type LoadStatus = "loading" | "ready" | "error";

function Console({
  token,
  onInvalidToken,
}: {
  token: string;
  onInvalidToken: () => void;
}) {
  const client = useMemo(() => createClient(token), [token]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [library, setLibrary] = useState<SystemGroup[]>([]);
  const [state, setState] = useState<State>(initialState);
  const session = useSession(token);
  // Optimistic leave: set when Quit is issued so we drop the (now-frozen) game
  // surface immediately instead of waiting for the WS to report idle.
  const [leaving, setLeaving] = useState(false);
  // `since` of the crash we've already acknowledged; a newer crash re-shows.
  const [ackedCrash, setAckedCrash] = useState<number | null>(null);

  // Load the library once; a 401 kicks us back to the gate.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    client
      .getLibrary()
      .then((lib) => {
        if (cancelled) return;
        setLibrary(lib);
        setStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        if (isAuthError(err)) onInvalidToken();
        else setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [client, onInvalidToken]);

  // Library systems in the fixed order, filtered to those actually present.
  const systems = useMemo(
    () =>
      SYSTEM_ORDER.map((id) => library.find((g) => g.system === id)).filter(
        (g): g is SystemGroup => g != null,
      ),
    [library],
  );

  const ctx = useMemo<NavContext>(
    () => ({
      systemsForGame: systems.map((g) => g.system),
      gamesForSystem: (system) =>
        systems.find((g) => g.system === system)?.games ?? [],
      categoryItemCount: (category) => {
        if (category === NETWORK_CATEGORY) return 2; // NETWORK_ITEMS.length
        if (category === SETTINGS_CATEGORY) return SETTINGS_ROWS.length;
        return 0; // photo / music / video stubs
      },
    }),
    [systems],
  );

  // Keep the latest state/ctx in refs so dispatch stays a stable callback and
  // runs effects exactly once (no side effects inside a setState updater, which
  // StrictMode would double-invoke).
  const stateRef = useRef(state);
  stateRef.current = state;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const dispatch = useCallback(
    (action: NavAction) => {
      const { state: next, effect } = reduce(stateRef.current, action, ctxRef.current);
      stateRef.current = next;
      setState(next);
      if (!effect) return;
      const run = effect.type === "launch"
        ? client.start(effect.gameId)
        : client.powerOff();
      run.catch((err) => {
        if (isAuthError(err)) onInvalidToken();
      });
    },
    [client, onInvalidToken],
  );

  // Route the console by live session state. The crossbar is only the "resting"
  // surface; starting / in-game / crashed take over.
  const phase = session?.state ?? null;
  const launching = phase === "starting";
  const playing = phase === "in-game" && !leaving && session?.game != null;
  const crashOpen = phase === "crashed" && session!.since !== ackedCrash;
  // While anything other than the crossbar is on screen, the crossbar must not
  // eat keys: in-game the Stream captures input, and Escape belongs to the Home
  // menu / Stream, not to the reducer's "back".
  const suspendCrossbar = launching || phase === "in-game" || crashOpen;

  // Clear the optimistic-leave flag once the session actually leaves in-game.
  useEffect(() => {
    if (phase !== "in-game") setLeaving(false);
  }, [phase]);

  // Keyboard + gamepad → dispatch. Active only while the crossbar is mounted
  // and interactive (not while launching / in-game / a crash dialog is up).
  useEffect(() => {
    if (status !== "ready" || suspendCrossbar) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const action = keyToAction(e);
      if (!action) return;
      e.preventDefault();
      dispatch(action);
    };
    window.addEventListener("keydown", onKeyDown);

    const poller = createGamepadPoller(dispatch);
    const hasGamepad =
      typeof navigator !== "undefined" && "getGamepads" in navigator;
    if (hasGamepad) poller.start();

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      poller.stop();
    };
  }, [status, suspendCrossbar, dispatch]);

  if (status === "loading") {
    return (
      <div className="center">
        <span className="center__title">Loading library…</span>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="center">
        <span className="center__title">Couldn't reach the console.</span>
        <span className="center__error">The library didn't load. Check that xmb-api is running.</span>
        <button type="button" onClick={onInvalidToken}>
          Sign out
        </button>
      </div>
    );
  }

  if (launching) {
    return <Launching title={session!.game?.title ?? null} substate={session!.substate} />;
  }

  if (playing) {
    return (
      <GameView
        client={client}
        game={session!.game!}
        onExitToCrossbar={() => setLeaving(true)}
      />
    );
  }

  return (
    <div className="xmb">
      <header className="xmb__header">
        <span className="wordmark">
          PSP <b>XMB</b>
        </span>
        <Clock />
      </header>

      <Crossbar state={state} systems={systems} session={session} />

      <footer className="xmb__hint">
        <span>
          <kbd>↑↓</kbd> Move
        </span>
        <span>
          <kbd>←→</kbd> Category
        </span>
        <span>
          <kbd>Enter</kbd> Select
        </span>
        <span>
          <kbd>Esc</kbd> Back
        </span>
      </footer>

      {crashOpen && (
        <ErrorDialog
          detail={session!.error ?? null}
          onDismiss={() => setAckedCrash(session!.since)}
        />
      )}
    </div>
  );
}

// PSP-style launching indicator. Reads the WS substate for progress wording.
const SUBSTATE_TEXT: Record<string, string> = {
  scaling: "Allocating hardware",
  pulling: "Fetching game data",
  "pod-ready": "Console ready",
  "loading-game": "Loading game",
};

function Launching({
  title,
  substate,
}: {
  title: string | null;
  substate?: string;
}) {
  const status =
    (substate && SUBSTATE_TEXT[substate]) ?? substate ?? "Loading";
  return (
    <div className="launch" role="status" aria-live="polite">
      <p className="launch__eyebrow">Now Loading</p>
      <h1 className="launch__title">{title ?? "Loading…"}</h1>
      <p className="launch__status">{status}</p>
      <span className="launch__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

// PSP-style crash dialog. A single OK dismisses it back to the crossbar.
function ErrorDialog({
  detail,
  onDismiss,
}: {
  detail: string | null;
  onDismiss: () => void;
}) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    okRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onDismiss]);

  return (
    <div className="error-dialog" role="alertdialog" aria-modal="true" aria-label="Error">
      <div className="error-dialog__panel">
        <p className="error-dialog__eyebrow">Error</p>
        <p className="error-dialog__message">
          The game could not be started. (80020148)
        </p>
        {detail && <p className="error-dialog__detail">{detail}</p>}
        <div className="error-dialog__actions">
          <button
            type="button"
            ref={okRef}
            className="error-dialog__ok"
            onClick={onDismiss}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return <span className="clock">{time}</span>;
}
