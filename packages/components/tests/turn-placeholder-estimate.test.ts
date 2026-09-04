import { describe, expect, it } from 'vitest';
import {
  estimateTurnHeightPx,
  PLACEHOLDER_BASE_HEIGHT_PX,
} from '../src/components/ai-gui/turn-placeholder-estimate';

const summary = (textChars: number, commandCount = 0) => ({
  itemCount: 3,
  textChars,
  thoughtChars: 0,
  headText: 'head',
  activity: { commandCount, editFileCount: 0, readFileCount: 0, searchCount: 0, failedCount: 0 },
  editedPaths: [],
});

describe('estimateTurnHeightPx', () => {
  it('uses a role constant with no other signal', () => {
    expect(estimateTurnHeightPx({ role: 'user' })).toBe(PLACEHOLDER_BASE_HEIGHT_PX.user);
    expect(estimateTurnHeightPx({ role: 'assistant' })).toBe(PLACEHOLDER_BASE_HEIGHT_PX.assistant);
    expect(estimateTurnHeightPx({ role: 'system' })).toBe(PLACEHOLDER_BASE_HEIGHT_PX.system);
  });

  it('grows with summary prose and counts folded activity once', () => {
    const short = estimateTurnHeightPx({ role: 'assistant', summary: summary(90) });
    const long = estimateTurnHeightPx({ role: 'assistant', summary: summary(9_000) });
    const busy = estimateTurnHeightPx({ role: 'assistant', summary: summary(90, 12) });
    const busier = estimateTurnHeightPx({ role: 'assistant', summary: summary(90, 40) });
    expect(long).toBeGreaterThan(short);
    expect(busy).toBeGreaterThan(short);
    expect(busier).toBe(busy);
    expect(long).toBeLessThanOrEqual(1_600);
  });

  it('falls back to the item count without a summary', () => {
    expect(estimateTurnHeightPx({ role: 'assistant', itemCount: 10 })).toBeGreaterThan(
      estimateTurnHeightPx({ role: 'assistant', itemCount: 1 })
    );
  });
});
