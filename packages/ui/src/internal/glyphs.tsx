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

/** The cross on a dialog's own close button: this goes away. */
export function CrossGlyph() {
  return <Glyph d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />;
}

/** The chevron on a menu row that opens a submenu: there is more this way. */
export function ChevronRightGlyph() {
  return <Glyph d="M6.5 4 10.5 8 6.5 12" />;
}

/** Its mirror: the way back through a pager. */
export function ChevronLeftGlyph() {
  return <Glyph d="M9.5 4 5.5 8 9.5 12" />;
}

/**
 * The pages a pager is not listing. It is three dots rather than a character,
 * so the gap between the first pages and the last is the same mark at the same
 * weight as the glyphs beside it in every font a host may be set to.
 */
export function EllipsisGlyph() {
  return (
    <svg {...stylex.props(styles.glyph)} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.15" fill="currentColor" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.15" fill="currentColor" />
    </svg>
  );
}

/**
 * The dot on the chosen row of a radio group. It is filled rather than stroked,
 * because a radio mark is a disc: at 16px a stroked ring reads as a tick that
 * has not finished drawing.
 */
export function DotGlyph() {
  return (
    <svg {...stylex.props(styles.glyph)} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="3" fill="currentColor" />
    </svg>
  );
}

/**
 * The marks a message wears. A tone draws its own rather than taking one from a
 * caller, the way a menu row draws its submenu chevron: the whole point of a
 * tone is that a person recognises what kind of message this is before reading
 * it, and a caller free to pass any glyph can put a tick on a failure.
 */
function Ringed({ d }: { d: string }) {
  return (
    <svg {...stylex.props(styles.glyph)} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.6" />
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

/** Neutral: something worth knowing, and nothing has gone wrong. */
export function InfoGlyph() {
  return <Ringed d="M8 7.2v4M8 4.8h.01" />;
}

/** It worked. */
export function SuccessGlyph() {
  return <Ringed d="M5.2 8.2 7.2 10.2 10.8 6" />;
}

/** It did not. */
export function DangerGlyph() {
  return <Ringed d="M8 4.8v4M8 11.2h.01" />;
}

/**
 * It still may. The triangle is what separates a warning from an error at a
 * glance, which two circles of different colours cannot do for a person who
 * does not see the difference between them.
 */
export function WarningGlyph() {
  return (
    <svg {...stylex.props(styles.glyph)} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.8 15 13.8H1L8 1.8Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.4v3.2M8 11.8h.01"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
