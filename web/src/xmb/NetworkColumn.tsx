// web/src/xmb/NetworkColumn.tsx
//
// The Network category column. Renders NETWORK_ITEMS: a live "Connection Status"
// row reflecting the session WebSocket snapshot (state, running game, node) and a
// "Power Off" row whose selection the reducer turns into a powerOff effect.

import type { SessionSnapshot } from "../api/types.js";
import { ColumnList, Row } from "./Column.js";
import { NETWORK_ITEMS } from "./navigation.js";
import type { State } from "./navigation.js";

const STATE_LABELS: Record<SessionSnapshot["state"], string> = {
  off: "Powered off",
  starting: "Starting",
  "in-game": "In game",
  idle: "Ready",
  crashed: "Stopped unexpectedly",
};

/** One-line summary of the live session for the status row's meta text. */
function statusMeta(session: SessionSnapshot | null): string {
  if (!session) return "Connecting…";
  const parts: string[] = [STATE_LABELS[session.state] ?? session.state];
  if (session.substate) parts[0] = `${parts[0]} · ${session.substate}`;
  if (session.state === "in-game" && session.game) {
    parts.push(session.game.title);
  }
  if (session.node) parts.push(`Node ${session.node}`);
  return parts.join("  ·  ");
}

export interface NetworkColumnProps {
  state: State;
  session: SessionSnapshot | null;
}

export function NetworkColumn({ state, session }: NetworkColumnProps) {
  const metas = [
    statusMeta(session),
    "End the session and release the node",
  ];
  return (
    <ColumnList focus={state.item}>
      {NETWORK_ITEMS.map((label, i) => (
        <Row key={label} title={label} meta={metas[i]} focused={i === state.item} />
      ))}
    </ColumnList>
  );
}
