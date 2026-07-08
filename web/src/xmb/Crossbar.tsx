// web/src/xmb/Crossbar.tsx
//
// The crossbar surface: a horizontal ribbon of the six categories that slides so
// the active category stays pinned at a fixed anchor, plus the active category's
// vertical column beneath it. Focus is driven entirely by nav State — nothing
// here mutates it; input + the reducer live in App.
//
// Icons are a single 24px stroke set (one visual system) rather than mismatched
// glyphs. No box art / shader / sound — those are step 2.

import type { CSSProperties } from "react";
import type { SessionSnapshot, SystemGroup } from "../api/types.js";
import { CATEGORIES } from "./navigation.js";
import type { Category, State } from "./navigation.js";
import { GameColumn } from "./GameColumn.js";
import { NetworkColumn } from "./NetworkColumn.js";
import { SettingsColumn } from "./SettingsColumn.js";
import { StubColumn } from "./StubColumn.js";

const CATEGORY_LABELS: Record<Category, string> = {
  settings: "Settings",
  game: "Game",
  photo: "Photo",
  music: "Music",
  video: "Video",
  network: "Network",
};

const svg = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
};

const ICONS: Record<Category, JSX.Element> = {
  settings: (
    <svg {...svg} aria-hidden="true">
      <line x1="4" y1="7" x2="20" y2="7" />
      <circle cx="9" cy="7" r="2.1" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="15" cy="12" r="2.1" />
      <line x1="4" y1="17" x2="20" y2="17" />
      <circle cx="8" cy="17" r="2.1" />
    </svg>
  ),
  game: (
    <svg {...svg} aria-hidden="true">
      <rect x="3" y="8" width="18" height="9" rx="4.5" />
      <line x1="7.5" y1="10.7" x2="7.5" y2="14.3" />
      <line x1="5.7" y1="12.5" x2="9.3" y2="12.5" />
      <circle cx="16" cy="11.6" r="1" />
      <circle cx="18" cy="13.6" r="1" />
    </svg>
  ),
  photo: (
    <svg {...svg} aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.7" />
      <path d="M4 17l4.5-4 3 2.2L16 11l4 4.5" />
    </svg>
  ),
  music: (
    <svg {...svg} aria-hidden="true">
      <path d="M9 17.5V6l9-2v9.5" />
      <circle cx="7" cy="17.5" r="2" />
      <circle cx="16" cy="15.5" r="2" />
    </svg>
  ),
  video: (
    <svg {...svg} aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M10 9l5 3-5 3z" />
    </svg>
  ),
  network: (
    <svg {...svg} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <path d="M12 3c2.6 2.3 4 5.4 4 9s-1.4 6.7-4 9c-2.6-2.3-4-5.4-4-9s1.4-6.7 4-9z" />
    </svg>
  ),
};

/** Icons dim with distance from the active category for depth. */
function catOpacity(index: number, active: number): number {
  if (index === active) return 1;
  return Math.max(0.28, 0.82 - Math.abs(index - active) * 0.17);
}

export interface CrossbarProps {
  state: State;
  /** Library systems ordered + filtered for the Game category. */
  systems: SystemGroup[];
  session: SessionSnapshot | null;
}

export function Crossbar({ state, systems, session }: CrossbarProps) {
  const active = CATEGORIES[state.category];

  let column: JSX.Element;
  switch (active) {
    case "game":
      column = <GameColumn systems={systems} state={state} />;
      break;
    case "network":
      column = <NetworkColumn state={state} session={session} />;
      break;
    case "settings":
      column = <SettingsColumn state={state} />;
      break;
    default:
      column = <StubColumn label={CATEGORY_LABELS[active]} />;
  }

  return (
    <>
      <div className="xmb__bar" />
      <nav
        className="ribbon"
        aria-label="Categories"
        style={{ "--active": state.category } as CSSProperties}
      >
        <div className="ribbon__track">
          {CATEGORIES.map((category, i) => {
            const isActive = i === state.category;
            return (
              <div
                key={category}
                className={isActive ? "cat is-active" : "cat"}
                style={{ opacity: catOpacity(i, state.category) }}
                aria-current={isActive ? "true" : undefined}
              >
                <span className="cat__icon">{ICONS[category]}</span>
                <span className="cat__label">{CATEGORY_LABELS[category]}</span>
              </div>
            );
          })}
        </div>
      </nav>
      {column}
    </>
  );
}
