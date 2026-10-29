import * as stylex from '@stylexjs/stylex';

/**
 * The ONE panel treatment for framed conversation content: the plan-exit card's
 * command block, the worktree-script terminal, the permission card, and the
 * proposed plan. An expanded tool step is not a panel: it is the header-less
 * sheet in `tool-call-detail.tsx`.
 *
 * The rule is that the HEADER carries the lighter fill and the body stays on the
 * frame's own surface — never the reverse. Panels used to disagree about which
 * half got the fill (terminal filled its header, the proposed plan filled an
 * inner body panel, tool output filled a bare `pre` under an unfilled label), so
 * the same structure read as three different components stacked in one turn.
 *
 * Import these instead of re-typing the tokens; a panel that hand-rolls its own
 * fill is the drift this module exists to prevent.
 */

/** Outer frame. Carries the border, the base surface, and the clipping. */
export const CONVERSATION_PANEL_FRAME_CLASS =
  'overflow-hidden rounded-xl border border-border/60 bg-background/70 shadow-xs';

/**
 * Header band — the raised fill. `border-b` belongs here only when a body
 * follows; a collapsed panel must not paint a rule against nothing.
 *
 * THE RULE: the header is a step off the surface it sits on — LIGHTER in dark,
 * DARKER in light. Measured today at +12 / -13 (terminal +11 / -12).
 *
 * The tint is therefore an alpha of the FOREGROUND, not `bg-muted`. Vesper's
 * `--muted` resolves to the same value as `--background`, so a `bg-muted` header
 * over a `bg-background` frame measured as a zero-step band in dark — the fill
 * simply did not render and only the rule was holding the header up. A
 * foreground alpha steps the right way in both themes whatever the base is.
 *
 * That base must be the SAME surface the body sits on, or the step is against
 * the wrong thing: the terminal paints its VS Code `terminal.background` on a
 * wrapper around header AND body for exactly this reason. While that colour was
 * on the body alone, the header tinted the frame instead and measured -1 in dark
 * and +7 in light — inverted.
 *
 * Measure the COMPOSITED pixel when changing this, never the token name (see
 * `sessions/AGENTS.md` on the surface ladder).
 */
export const CONVERSATION_PANEL_HEADER_CLASS = 'bg-muted-foreground/[0.09]';

/** Header label: quiet next to the content it introduces. */
export const CONVERSATION_PANEL_TITLE_CLASS = 'font-medium';

export const conversationPanelStyles = stylex.create({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 1.5)',
    color: 'hsl(var(--foreground) / 1)',
  },
  headerRule: {
    borderBottomStyle: 'var(--tw-border-style)',
    borderBottomWidth: '1px',
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
  },
  title: {
    minWidth: 'calc(var(--spacing) * 0)',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '11px',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  body: {
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2)',
  },
});
