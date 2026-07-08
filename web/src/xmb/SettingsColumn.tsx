// web/src/xmb/SettingsColumn.tsx
//
// The Settings category column. A stub for step 1: it renders read-only rows so
// the crossbar has a real column to focus, but changing values (and any backend
// wiring) comes later. SETTINGS_ROWS is exported so App can size the category for
// the nav reducer's item-count context.

import { ColumnList, Row } from "./Column.js";
import type { State } from "./navigation.js";

export const SETTINGS_ROWS: { label: string; value: string }[] = [
  { label: "Stream bitrate", value: "8 Mbps" },
  { label: "Video codec", value: "H.264" },
];

export interface SettingsColumnProps {
  state: State;
}

export function SettingsColumn({ state }: SettingsColumnProps) {
  return (
    <ColumnList focus={state.item}>
      {SETTINGS_ROWS.map((row, i) => (
        <Row
          key={row.label}
          title={row.label}
          value={row.value}
          focused={i === state.item}
        />
      ))}
    </ColumnList>
  );
}
