import type { CSSProperties } from 'react';
import { text } from '@lody/ui/tokens/scales.stylex';
import type { ConversationFontSize } from '@/atoms/settings';
import { conversation } from './conversation.tokens.stylex';

/** Document baseline shared by product text and portalled controls. */
export const UI_FONT_SIZE_CSS_VARIABLE = '--ui-font-size';

export function applyUiFontSize(root: HTMLElement, fontSize: ConversationFontSize): void {
  root.style.setProperty(UI_FONT_SIZE_CSS_VARIABLE, `${fontSize}px`);
}

/** Preserve explicit sizes in standalone previews without defining another scale. */
export function conversationTextToken(token: string, fontSize: ConversationFontSize): string {
  return `calc(${token} * (${fontSize}px / var(--ui-font-size, 14px)))`;
}

/** Body text in message rows, tool content, and the terminal command prompt. */
export function conversationTextFontSizeStyle(fontSize: ConversationFontSize): CSSProperties {
  return {
    fontSize: conversationTextToken(text.bodySize, fontSize),
    lineHeight: conversationTextToken(text.bodyLeading, fontSize),
  };
}

/** Reading prose shares the body size while its leading can be themed separately. */
export function conversationReadingFontSizeStyle(fontSize: ConversationFontSize): CSSProperties {
  return {
    fontSize: conversationTextToken(text.bodySize, fontSize),
    lineHeight: conversationTextToken(conversation.readingLeading, fontSize),
  };
}

/** Code and tool output use the same control text role, with their existing mono face. */
export function terminalTextFontSizeStyle(fontSize: ConversationFontSize): CSSProperties {
  return {
    fontSize: conversationTextToken(text.subheadlineSize, fontSize),
    lineHeight: conversationTextToken(text.subheadlineLeading, fontSize),
  };
}

const USER_TEXT_COLLAPSED_LINES = 7;

/**
 * Collapsed-height cap for long user text. It is a whole number of the user
 * text's own line boxes, so the clip edge falls between rows; a pixel cap cut
 * through a row whenever the reading leading changed.
 */
export function userTextCollapsedHeight(fontSize: ConversationFontSize): string {
  return `calc(${conversationTextToken(conversation.readingLeading, fontSize)} * ${USER_TEXT_COLLAPSED_LINES})`;
}
