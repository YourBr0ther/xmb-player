// web/src/xmb/StubColumn.tsx
//
// Placeholder column for the Photo / Music / Video categories, which have no
// content in step 1. Renders an empty-state message in the interface's voice.

export interface StubColumnProps {
  label: string;
}

export function StubColumn({ label }: StubColumnProps) {
  return (
    <div className="stub">
      <span className="stub__title">No {label.toLowerCase()} yet</span>
      <span className="stub__hint">This category has nothing to show.</span>
    </div>
  );
}
