// web/src/xmb/GameColumn.tsx
//
// The Game category column. At the top level it lists the library's systems (in
// the fixed SYSTEM_ORDER); once nav state drills into a system it lists that
// system's games under a caption. Focus follows nav state: state.item selects a
// system, state.drill.game selects a game.

import type { SystemGroup } from "../api/types.js";
import { ColumnList, Row } from "./Column.js";
import { SYSTEM_LABELS } from "./systems.js";
import type { State } from "./navigation.js";

export interface GameColumnProps {
  /** Library systems already filtered + ordered by SYSTEM_ORDER. */
  systems: SystemGroup[];
  state: State;
}

export function GameColumn({ systems, state }: GameColumnProps) {
  if (state.drill) {
    const group = systems.find((g) => g.system === state.drill!.system);
    const games = group?.games ?? [];
    const caption = group ? SYSTEM_LABELS[group.system] : state.drill.system;
    return (
      <ColumnList focus={state.drill.game} caption={caption}>
        {games.map((game, i) => (
          <Row key={game.id} title={game.title} focused={i === state.drill!.game} />
        ))}
      </ColumnList>
    );
  }

  return (
    <ColumnList focus={state.item}>
      {systems.map((group, i) => (
        <Row
          key={group.system}
          title={SYSTEM_LABELS[group.system]}
          meta={`${group.games.length} ${group.games.length === 1 ? "game" : "games"}`}
          focused={i === state.item}
        />
      ))}
    </ColumnList>
  );
}
