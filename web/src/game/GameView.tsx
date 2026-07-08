// web/src/game/GameView.tsx
//
// The in-game surface. Renders the full-bleed WebRTC <Stream> and, layered on
// top of it, the console-style Home (pause) menu. GameView owns the `homeOpen`
// state; everything about who listens for Escape follows from it.
//
// Escape ownership (single active handler at all times):
//   - Menu CLOSED: <Stream>'s own document-level Escape handler is live and
//     calls onHome → we open the menu. The crossbar's Escape is already
//     suspended by Console while in-game, so nothing else reacts.
//   - Menu OPEN: <HomeMenu> installs a *capture-phase* keydown listener and
//     calls stopPropagation() for the keys it owns (↑ ↓ Enter Esc). Because a
//     capture listener on `document` runs before the event descends to the
//     target — and stopPropagation() halts the trip before the bubble phase —
//     Stream's bubble-phase document handler never sees the key. So Escape
//     closes the menu and cannot simultaneously re-toggle Stream. One Escape,
//     one effect, in both directions.
//
// We never touch Stream's internals; we drive it purely through its props.

import { useState } from "react";
import { Stream } from "../streaming/Stream.js";
import { HomeMenu } from "./HomeMenu.js";
import type { XmbClient } from "../api/client.js";
import type { SessionSnapshot } from "../api/types.js";
import "./game.css";

/** The lightweight game descriptor carried on the live session snapshot. */
export type GameInfo = NonNullable<SessionSnapshot["game"]>;

export interface GameViewProps {
  client: XmbClient;
  game: GameInfo;
  /** Called after a Quit is issued so Console can leave the game surface
   *  immediately rather than waiting on the WS to report idle. */
  onExitToCrossbar: () => void;
}

export function GameView({ client, game, onExitToCrossbar }: GameViewProps) {
  const [homeOpen, setHomeOpen] = useState(false);

  return (
    <div className="gameview">
      <Stream base="" onHome={() => setHomeOpen(true)} />

      {homeOpen && (
        <HomeMenu
          client={client}
          game={game}
          onResume={() => setHomeOpen(false)}
          onQuit={onExitToCrossbar}
        />
      )}
    </div>
  );
}

export default GameView;
