import { CONVERSATION_FONT_SIZES, DEFAULT_CONVERSATION_FONT_SIZE } from '@/atoms';

export interface ConversationFontSizeChoice {
  /** Both pickers key their options by string, so the size round-trips as text. */
  value: string;
  size: number;
  label: string;
}

/**
 * One label per size, shared by the desktop and mobile settings so they cannot describe the
 * same stored size differently. `defaultLabel` is the translated word for the shipped
 * default, appended so that option reads as a recommendation rather than a bare number.
 */
export function formatConversationFontSize(size: number, defaultLabel: string): string {
  return size === DEFAULT_CONVERSATION_FONT_SIZE ? `${size} px · ${defaultLabel}` : `${size} px`;
}

/** The offered sizes, ascending, as picker options. */
export function buildConversationFontSizeChoices(
  defaultLabel: string
): ConversationFontSizeChoice[] {
  return CONVERSATION_FONT_SIZES.map((size) => ({
    value: String(size),
    size,
    label: formatConversationFontSize(size, defaultLabel),
  }));
}
