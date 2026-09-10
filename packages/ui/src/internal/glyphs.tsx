import * as stylex from '@stylexjs/stylex';

/**
 * The glyphs a trigger and a list row need, drawn as paths rather than taken
 * from an icon package: this package depends on React, Base UI and StyleX only.
 * Each fills the box it is given and inherits `currentColor`, so the part that
 * holds one owns both its size and its colour.
 */
const styles = stylex.create({
  glyph: { display: 'block', width: '100%', height: '100%' },
});

function Glyph({ d }: { d: string }) {
  return (
    <svg {...stylex.props(styles.glyph)} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d={d}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The chevron on a Select or Combobox trigger: this opens a list. */
export function ChevronDownGlyph() {
  return <Glyph d="M4 6.5 8 10.5 12 6.5" />;
}

/** The strip that says the list continues above the visible rows. */
export function ChevronUpGlyph() {
  return <Glyph d="M4 9.5 8 5.5 12 9.5" />;
}

/** The tick on the row that holds the value. */
export function TickGlyph() {
  return <Glyph d="M3.2 8.4 6.4 11.6 12.8 4.4" />;
}
