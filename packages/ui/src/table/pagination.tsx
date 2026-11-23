import * as stylex from '@stylexjs/stylex';
import { forwardRef, useState, type ComponentProps } from 'react';
import { Button } from '../button/button';
import { Input } from '../field/input';
import { appendClassName } from '../internal/class-name';
import { ChevronLeftGlyph, ChevronRightGlyph, EllipsisGlyph } from '../internal/glyphs';
import { tableSurface as surface } from './surface';

/**
 * How the pages are offered. `numbered` lists them, which is what a person
 * wants when there are few enough to see; `compact` says where you are out of
 * how many, which is what is left when there are thousands.
 */
export type PaginationLayout = 'numbered' | 'compact';

/** The two rungs of the control ladder a pager sits on: 28 and 32. */
export type PaginationSize = 'small' | 'medium';

/**
 * Every word the pager says. They are one prop rather than five, because a
 * surface that translates one of them translates all of them; the defaults are
 * English so a board and a test can render one without a dictionary.
 */
export interface PaginationLabels {
  /** Names the navigation landmark, so a page with two pagers has two names. */
  root: string;
  previous: string;
  next: string;
  /** The name of a numbered button, which is a number on screen. */
  page: (page: number) => string;
  /** What the compact layout's position is read as, in place of "4 slash 120". */
  position: (page: number, pages: number) => string;
  /** The name of the field a person types a page into. */
  jump: string;
}

export interface PaginationProps extends Omit<
  ComponentProps<'nav'>,
  'className' | 'onChange' | 'children'
> {
  /** The page a person is on, counted from 1. */
  page: number;
  /** How many there are. Below 1 is treated as 1: there is always a page. */
  pages: number;
  onPageChange: (page: number) => void;
  layout?: PaginationLayout;
  size?: PaginationSize;
  /** How many pages are listed either side of the one you are on. */
  siblings?: number;
  /** How many are listed at each end, so the first and last stay reachable. */
  boundaries?: number;
  /**
   * The compact layout's position is a field rather than a readout, so a person
   * can go to page 4,000 of 9,000 without pressing next four thousand times.
   */
  jump?: boolean;
  labels?: Partial<PaginationLabels>;
  className?: string;
}

const DEFAULT_LABELS: PaginationLabels = {
  root: 'Pagination',
  previous: 'Previous page',
  next: 'Next page',
  page: (page) => `Page ${page}`,
  position: (page, pages) => `Page ${page} of ${pages}`,
  jump: 'Page',
};

/** Stands for the pages between two listed ones. */
const GAP = 'gap';

const ELLIPSIS_SIZES = {
  small: surface.ellipsisSmall,
  medium: surface.ellipsisMedium,
} as const;

const PAGE_SIZES = {
  small: surface.pagerPageSmall,
  medium: surface.pagerPageMedium,
} as const;

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
}

function clampPage(page: number, pages: number): number {
  const total = Math.max(1, Math.floor(pages) || 1);
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(Math.round(page), 1), total);
}

/**
 * Which pages the numbered layout lists, and where it admits it is not listing
 * them all.
 *
 * The window is a fixed width so the pager does not change size as a person
 * walks through it: the two ends, the siblings either side of the page you are
 * on, that page itself, and the two gaps. A gap is only drawn where it stands
 * for more than one page — a gap hiding a single page is wider than the page it
 * hides, and costs a person the press it would have taken.
 */
export function pageWindow(
  page: number,
  pages: number,
  siblings: number,
  boundaries: number
): (number | typeof GAP)[] {
  const total = Math.max(1, Math.floor(pages) || 1);
  const current = clampPage(page, total);
  const listed = boundaries * 2 + siblings * 2 + 3;
  if (listed >= total) return range(1, total);

  const firstSibling = Math.max(current - siblings, boundaries + 1);
  const lastSibling = Math.min(current + siblings, total - boundaries);
  const gapBefore = firstSibling > boundaries + 2;
  const gapAfter = lastSibling < total - boundaries - 1;

  // Against either end the window has no gap on that side, so the pages the gap
  // would have cost are spent listing more of them instead — which is what
  // keeps the pager one width from the first page to the last.
  if (!gapBefore && gapAfter) {
    return [
      ...range(1, boundaries + siblings * 2 + 2),
      GAP,
      ...range(total - boundaries + 1, total),
    ];
  }
  if (gapBefore && !gapAfter) {
    return [...range(1, boundaries), GAP, ...range(total - (boundaries + siblings * 2 + 1), total)];
  }
  return [
    ...range(1, boundaries),
    GAP,
    ...range(firstSibling, lastSibling),
    GAP,
    ...range(total - boundaries + 1, total),
  ];
}

/**
 * The way to the rows a list is not showing.
 *
 * It is one control rather than a kit of parts, because the part a caller would
 * otherwise assemble is the one that is easy to get wrong: which pages to list
 * when there are nine thousand of them, and where to admit that the rest are
 * missing. A surface states where it is and how many there are, and the pager
 * works out the window, draws the gaps, and disables the ends.
 *
 * It lives with the table because a pager exists when a table did not fit —
 * though nothing here needs a table above it, and the first caller in this
 * repository is a file too large to open at once.
 */
export const Pagination = forwardRef<HTMLElement, PaginationProps>(function Pagination(
  {
    page,
    pages,
    onPageChange,
    layout = 'numbered',
    size = 'medium',
    siblings = 1,
    boundaries = 1,
    jump = false,
    labels,
    className,
    ...rest
  },
  ref
) {
  const words = { ...DEFAULT_LABELS, ...labels };
  const total = Math.max(1, Math.floor(pages) || 1);
  const current = clampPage(page, total);
  const sx = stylex.props(surface.pager);
  const go = (next: number) => {
    const target = clampPage(next, total);
    if (target !== current) onPageChange(target);
  };
  return (
    <nav
      ref={ref}
      aria-label={words.root}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    >
      <Step
        direction="previous"
        label={words.previous}
        size={size}
        disabled={current <= 1}
        onClick={() => go(current - 1)}
      />
      {layout === 'numbered' ? (
        <Pages
          current={current}
          total={total}
          siblings={siblings}
          boundaries={boundaries}
          size={size}
          words={words}
          onGo={go}
        />
      ) : (
        <Position current={current} total={total} jump={jump} size={size} words={words} onGo={go} />
      )}
      <Step
        direction="next"
        label={words.next}
        size={size}
        disabled={current >= total}
        onClick={() => go(current + 1)}
      />
    </nav>
  );
});

/**
 * One step either way. It is disabled at the end rather than removed: a pager
 * whose buttons come and go moves the ones beside them under the pointer.
 */
function Step({
  direction,
  label,
  size,
  disabled,
  onClick,
}: {
  direction: 'previous' | 'next';
  label: string;
  size: PaginationSize;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size={size}
      icon
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {direction === 'previous' ? <ChevronLeftGlyph /> : <ChevronRightGlyph />}
    </Button>
  );
}

/**
 * The pages, as a list: a screen reader is told how many things are on offer
 * before it reads the first of them. The page a person is on is the one raised
 * out of the row — a secondary Button among ghosts — and it says so twice, once
 * as a fill and once as `aria-current`, because the fill reaches only the people
 * who can see it.
 */
function Pages({
  current,
  total,
  siblings,
  boundaries,
  size,
  words,
  onGo,
}: {
  current: number;
  total: number;
  siblings: number;
  boundaries: number;
  size: PaginationSize;
  words: PaginationLabels;
  onGo: (page: number) => void;
}) {
  const list = stylex.props(surface.pagerList);
  const item = stylex.props(surface.pagerItem);
  const gap = stylex.props(surface.ellipsis, ELLIPSIS_SIZES[size]);
  const glyph = stylex.props(surface.ellipsisGlyph);
  const pageButton = stylex.props(PAGE_SIZES[size]);
  const listed = pageWindow(current, total, siblings, boundaries);
  return (
    <ul className={list.className} style={list.style}>
      {listed.map((entry, index) =>
        entry === GAP ? (
          <li key={`gap-${index}`} className={item.className} style={item.style} aria-hidden="true">
            <span className={gap.className} style={gap.style}>
              <span className={glyph.className} style={glyph.style}>
                <EllipsisGlyph />
              </span>
            </span>
          </li>
        ) : (
          <li key={entry} className={item.className} style={item.style}>
            <Button
              variant={entry === current ? 'secondary' : 'ghost'}
              size={size}
              aria-label={words.page(entry)}
              aria-current={entry === current ? 'page' : undefined}
              className={pageButton.className}
              onClick={() => onGo(entry)}
            >
              {entry}
            </Button>
          </li>
        )
      )}
    </ul>
  );
}

/**
 * Where you are, when there are too many pages to list.
 *
 * The numbers on screen are read as "4 slash 120", so the sentence a screen
 * reader gets is said separately and the figures are hidden from it. When the
 * position is a field, what it commits on is Enter or leaving it, rather than
 * every keystroke: typing 4-5 through a pager that navigates as you type visits
 * page 4 on the way to page 45, and on a pager over a large file that is a page
 * fetched and thrown away.
 */
function Position({
  current,
  total,
  jump,
  size,
  words,
  onGo,
}: {
  current: number;
  total: number;
  jump: boolean;
  size: PaginationSize;
  words: PaginationLabels;
  onGo: (page: number) => void;
}) {
  const sx = stylex.props(surface.position);
  const totalSx = stylex.props(surface.positionTotal);
  const hidden = stylex.props(surface.srOnly);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const typed = Number(draft);
    setDraft(null);
    if (draft.trim() !== '' && Number.isFinite(typed)) onGo(typed);
  };
  return (
    <div className={sx.className} style={sx.style}>
      <span className={hidden.className} style={hidden.style}>
        {words.position(current, total)}
      </span>
      {jump ? (
        <Input
          size={size}
          type="number"
          inputMode="numeric"
          min={1}
          max={total}
          aria-label={words.jump}
          value={draft ?? String(current)}
          className={stylex.props(surface.jump).className}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
        />
      ) : (
        <span aria-hidden="true">{current}</span>
      )}
      <span
        aria-hidden="true"
        className={totalSx.className}
        style={totalSx.style}
      >{`/ ${total}`}</span>
    </div>
  );
}
