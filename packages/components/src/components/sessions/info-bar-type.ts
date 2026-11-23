import * as stylex from '@stylexjs/stylex';
import { text } from '@lody/ui/tokens/scales.stylex';

/**
 * The composer info bar's type. Chips, the stage summary and the popovers they
 * open are chrome around the conversation, so they read as one tier: the
 * footnote role for everything, the body role only for prose a person authored
 * (a goal's objective). A caption step one pixel under the footnote read as noise
 * rather than hierarchy, so the bar has none.
 *
 * Both roles derive from `--ui-font-size`, which Tailwind's `text-xs` and
 * `text-xs` did not: the bar stayed at 12px while Appearance moved the rest
 * of the page. See `specs/workspace-visual-hierarchy.md`.
 *
 * A role sets size and leading only. Ink and weight stay with the caller, and an
 * element takes one role: two StyleX classes on one element have no defined order.
 */
const infoBarType = stylex.create({
  footnote: { fontSize: text.footnoteSize, lineHeight: text.footnoteLeading },
  body: { fontSize: text.bodySize, lineHeight: text.bodyLeading },
});

export const INFO_BAR_TEXT_CLASS = stylex.props(infoBarType.footnote).className;
export const INFO_BAR_PROSE_CLASS = stylex.props(infoBarType.body).className;
