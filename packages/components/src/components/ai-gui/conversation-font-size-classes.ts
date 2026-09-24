import type { CSSProperties } from 'react';
import type { ConversationFontSize } from '@/atoms/settings';

/** Document root token: settings 1em, compact chrome 0.9em. */
export const UI_FONT_SIZE_CSS_VARIABLE = '--ui-font-size';

export function applyUiFontSize(root: HTMLElement, fontSize: ConversationFontSize): void {
  root.style.setProperty(UI_FONT_SIZE_CSS_VARIABLE, `${fontSize}px`);
}

// Single source of truth for the conversation font-size scale shared across the
// ai-gui renderers (view.tsx, terminal-component.tsx). markdown-renderer.tsx keeps
// its own map because it also scales heading selectors, not just body text.

/** Body text in message rows, tool content, and the terminal command prompt. */
export function conversationTextFontSizeStyle(fontSize: ConversationFontSize): CSSProperties {
  return { fontSize: `${fontSize}px` };
}

/** Dense monospace blocks (raw tool output, structured JSON) — one tier smaller. */
export function conversationMonoFontSizeStyle(fontSize: ConversationFontSize): CSSProperties {
  return { fontSize: `${Math.round(fontSize / 2 + 4)}px` };
}

/** Streaming terminal output text — one tier smaller than the prompt. */
export function terminalTextFontSizeStyle(fontSize: ConversationFontSize): CSSProperties {
  return { fontSize: `${Math.round((fontSize * 3) / 4 + 1.5)}px` };
}

/** Collapsed-height cap (px) for long user text, scaled so ~the same line count shows. */
export function userTextCollapsedHeight(fontSize: ConversationFontSize): number {
  return Math.round((fontSize / 14) * 160);
}
