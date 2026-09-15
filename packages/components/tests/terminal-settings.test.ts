import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_FONT_SIZES,
  DEFAULT_CONVERSATION_FONT_SIZE,
  DEFAULT_TERMINAL_FONT_SIZE,
  normalizeConversationFontSize,
  normalizeTerminalFontFamily,
  normalizeTerminalFontSize,
  TERMINAL_FONT_FAMILY_MAX_LENGTH,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from '../src/atoms/settings';
import {
  buildTerminalFontLoadSpec,
  buildTerminalFontPreviewFamily,
} from '../src/components/terminal/terminal-theme';
import {
  conversationMonoFontSizeStyle,
  conversationTextFontSizeStyle,
  terminalTextFontSizeStyle,
  userTextCollapsedHeight,
} from '../src/components/ai-gui/conversation-font-size-classes';

describe('terminal appearance settings', () => {
  it('normalizes persisted font values to bounded settings', () => {
    expect(normalizeTerminalFontFamily('  Maple Mono  ')).toBe('Maple Mono');
    expect(
      normalizeTerminalFontFamily('a'.repeat(TERMINAL_FONT_FAMILY_MAX_LENGTH + 10))
    ).toHaveLength(TERMINAL_FONT_FAMILY_MAX_LENGTH);
    expect(normalizeTerminalFontFamily(null)).toBe('');
    expect(normalizeTerminalFontFamily('  Webdings  ')).toBe('');

    expect(normalizeTerminalFontSize(undefined)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(normalizeTerminalFontSize(TERMINAL_FONT_SIZE_MIN - 4)).toBe(TERMINAL_FONT_SIZE_MIN);
    expect(normalizeTerminalFontSize(TERMINAL_FONT_SIZE_MAX + 4)).toBe(TERMINAL_FONT_SIZE_MAX);
    expect(normalizeTerminalFontSize(14.7)).toBe(15);
  });

  it('quotes custom font names and retains the app fallback in previews', () => {
    expect(buildTerminalFontLoadSpec('Maple "Mono"', 15)).toBe('15px "Maple \\"Mono\\""');
    expect(buildTerminalFontPreviewFamily('Maple Mono')).toBe('"Maple Mono", var(--font-terminal)');
    expect(buildTerminalFontPreviewFamily('')).toBe('var(--font-terminal)');
  });
});

describe('conversation appearance settings', () => {
  it('offers a fixed scale and snaps every persisted value onto it', () => {
    expect([...CONVERSATION_FONT_SIZES]).toEqual([8, 12, 14, 16, 20, 24, 28, 32]);

    // Sizes a previous build could persist keep the closest step the user picked
    // instead of being clamped into a range or reset to the default.
    expect(normalizeConversationFontSize(24)).toBe(24);
    expect(normalizeConversationFontSize(14.7)).toBe(14);
    expect(normalizeConversationFontSize(13)).toBe(14); // exact tie rounds up
    expect(normalizeConversationFontSize(9)).toBe(8);
    expect(normalizeConversationFontSize(30)).toBe(32);
    expect(normalizeConversationFontSize(1)).toBe(8);
    expect(normalizeConversationFontSize(400)).toBe(32);

    expect(normalizeConversationFontSize('small')).toBe(12);
    expect(normalizeConversationFontSize('default')).toBe(DEFAULT_CONVERSATION_FONT_SIZE);
    expect(normalizeConversationFontSize('large')).toBe(16);
    expect(normalizeConversationFontSize(undefined)).toBe(DEFAULT_CONVERSATION_FONT_SIZE);
  });

  it('scales every conversation text variant from a custom size', () => {
    expect(conversationTextFontSizeStyle(24)).toEqual({ fontSize: '24px' });
    expect(conversationMonoFontSizeStyle(24)).toEqual({ fontSize: '16px' });
    expect(terminalTextFontSizeStyle(24)).toEqual({ fontSize: '20px' });
    expect(userTextCollapsedHeight(24)).toBe(274);
  });
});
