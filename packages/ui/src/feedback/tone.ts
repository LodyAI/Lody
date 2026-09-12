import { DangerGlyph, InfoGlyph, SuccessGlyph, WarningGlyph } from '../internal/glyphs';
import { feedbackSurface as surface } from './surface';

/**
 * What a message reports. Four outcomes and no more: the palette has a colour
 * for three of them, and the fourth — something worth knowing, where nothing
 * has gone wrong — is deliberately not one. `accent` is the obvious candidate
 * and the rules reserve it for live state, so a neutral message takes the
 * secondary label and lets the words do the work.
 */
export type FeedbackTone = 'neutral' | 'success' | 'warning' | 'danger';

/** The mark each tone wears, drawn by the part rather than passed to it. */
export const TONE_GLYPHS = {
  neutral: InfoGlyph,
  success: SuccessGlyph,
  warning: WarningGlyph,
  danger: DangerGlyph,
} as const;

export const TONE_MARKS = {
  neutral: undefined,
  success: surface.markSuccess,
  warning: surface.markWarning,
  danger: surface.markDanger,
} as const;

export const NOTICE_TONES = {
  neutral: surface.noticeNeutral,
  success: surface.noticeSuccess,
  warning: surface.noticeWarning,
  danger: surface.noticeDanger,
} as const;

export const TOAST_TONES = {
  neutral: undefined,
  success: surface.toastSuccess,
  warning: surface.toastWarning,
  danger: surface.toastDanger,
} as const;

/**
 * How urgently a screen reader is told. A failure or a warning interrupts what
 * is being read; a confirmation waits its turn. The two are different roles
 * rather than a prop, because a surface that had to choose would choose wrong
 * once — and `alert` on every message is the version that trains people to
 * ignore it.
 */
export function roleForTone(tone: FeedbackTone): 'alert' | 'status' {
  return tone === 'danger' || tone === 'warning' ? 'alert' : 'status';
}
