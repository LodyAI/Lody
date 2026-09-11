import { describe, expect, it } from 'vitest';

import { shouldHideThinkingUnderFinishedAssistant } from '../src/lib/agent-activity-visibility';

describe('shouldHideThinkingUnderFinishedAssistant', () => {
  it('keeps the activity row when history is empty or still on the user turn', () => {
    expect(shouldHideThinkingUnderFinishedAssistant(undefined)).toBe(false);
    expect(shouldHideThinkingUnderFinishedAssistant([])).toBe(false);
    expect(shouldHideThinkingUnderFinishedAssistant([{ role: 'user', finished: undefined }])).toBe(
      false
    );
  });

  it('keeps the activity row while the last assistant turn is still open', () => {
    expect(
      shouldHideThinkingUnderFinishedAssistant([
        { role: 'user' },
        { role: 'assistant', finished: false },
      ])
    ).toBe(false);
    expect(shouldHideThinkingUnderFinishedAssistant([{ role: 'assistant' }])).toBe(false);
  });

  it('hides thinking under a finished last assistant bubble', () => {
    expect(
      shouldHideThinkingUnderFinishedAssistant([
        { role: 'user' },
        { role: 'assistant', finished: true },
      ])
    ).toBe(true);
  });

  it('shows thinking again when a later user turn is already in history', () => {
    expect(
      shouldHideThinkingUnderFinishedAssistant([
        { role: 'user' },
        { role: 'assistant', finished: true },
        { role: 'user' },
      ])
    ).toBe(false);
  });
});
