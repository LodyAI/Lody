import {
  CONVERSATION_FONT_SIZES,
  DEFAULT_CONVERSATION_FONT_SIZE,
  type ConversationFontSize,
} from '@/atoms';

const CONVERSATION_FONT_SIZE_LABEL_KEYS: Record<number, string> = {
  12: 'settings.conversationFontSize.smaller',
  13: 'settings.conversationFontSize.small',
  [DEFAULT_CONVERSATION_FONT_SIZE]: 'settings.conversationFontSize.default',
  15: 'settings.conversationFontSize.large',
  16: 'settings.conversationFontSize.larger',
};

export interface ConversationFontSizeChoice {
  /** Both pickers key their options by string, so the size round-trips as text. */
  value: string;
  size: ConversationFontSize;
  labelKey: string;
}

/**
 * One label per offered size, shared by the desktop and mobile settings so they cannot
 * describe the same stored size differently. The tiers are named, not numbered: a bare
 * pixel count says nothing about which size the app was designed around.
 */
export function buildConversationFontSizeChoices(): ConversationFontSizeChoice[] {
  return CONVERSATION_FONT_SIZES.map((size) => ({
    value: String(size),
    size,
    labelKey: CONVERSATION_FONT_SIZE_LABEL_KEYS[size] ?? 'settings.conversationFontSize.default',
  }));
}
