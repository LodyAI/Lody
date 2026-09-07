/**
 * The ONE panel treatment for framed conversation content: the plan-exit card's
 * command block, terminal command/output, tool input/output, the permission
 * card, and the proposed plan.
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
export const CONVERSATION_PANEL_HEADER_CLASS =
  'flex items-center gap-2 bg-muted-foreground/[0.09] px-3 py-1.5 text-foreground';

export const CONVERSATION_PANEL_HEADER_RULE_CLASS = 'border-b border-border/60';

/** Header label: quiet next to the content it introduces. */
export const CONVERSATION_PANEL_TITLE_CLASS =
  'min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground';

/** Body padding. No fill of its own — the frame already provides the surface. */
export const CONVERSATION_PANEL_BODY_CLASS = 'px-3 py-2';
