// web/src/xmb/Column.tsx
//
// Shared primitives for the vertical item list every category column renders.
// ColumnList owns the "focused row stays on a fixed baseline while the list
// scrolls" motion (via the --focus custom property the CSS reads); Row is a
// single selectable line with an optional secondary meta line and a right-aligned
// value. Focus is driven by nav state, not DOM focus, so we mark the active row
// with aria-current for assistive tech and tests.

import type { CSSProperties, ReactNode } from "react";

export interface RowProps {
  title: string;
  meta?: ReactNode;
  value?: ReactNode;
  focused: boolean;
}

export function Row({ title, meta, value, focused }: RowProps) {
  return (
    <div
      className={focused ? "item is-focused" : "item"}
      data-item=""
      aria-current={focused ? "true" : undefined}
    >
      <span className="item__main">
        <span className="item__title">{title}</span>
        {meta != null && <span className="item__meta">{meta}</span>}
      </span>
      {value != null && <span className="item__value">{value}</span>}
    </div>
  );
}

export interface ColumnListProps {
  focus: number;
  caption?: string;
  children: ReactNode;
}

export function ColumnList({ focus, caption, children }: ColumnListProps) {
  return (
    <div className="column">
      {caption && <p className="column__caption">{caption}</p>}
      <div
        className="column__track"
        style={{ "--focus": focus } as CSSProperties}
      >
        {children}
      </div>
    </div>
  );
}
