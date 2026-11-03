import { describe, expect, it } from 'vitest';

import { applyKeyboardSelection } from '../src/components/terminal/terminal-keyboard-selection';

function select(input: Parameters<typeof applyKeyboardSelection>[0]) {
  return applyKeyboardSelection(input);
}

describe('applyKeyboardSelection', () => {
  it('ignores a stale keyboard session when the xterm selection moved', () => {
    expect(
      select({
        key: 'ArrowRight',
        cols: 80,
        lineCount: 24,
        cursor: { x: 0, y: 10 },
        anchor: { x: 5, y: 2 },
        head: { x: 8, y: 2 },
        existing: { start: { x: 10, y: 5 }, end: { x: 14, y: 5 } },
      })
    ).toEqual({
      start: { x: 10, y: 5 },
      length: 5,
      anchor: { x: 10, y: 5 },
      head: { x: 15, y: 5 },
    });
  });

  it('starts from the cursor when a cached session no longer has an xterm selection', () => {
    expect(
      select({
        key: 'ArrowRight',
        cols: 80,
        lineCount: 24,
        cursor: { x: 3, y: 7 },
        anchor: { x: 5, y: 2 },
        head: { x: 8, y: 2 },
        existing: null,
      })
    ).toEqual({
      start: { x: 3, y: 7 },
      length: 1,
      anchor: { x: 3, y: 7 },
      head: { x: 4, y: 7 },
    });
  });
});

function keyEvent(init: Partial<KeyboardEvent> & Pick<KeyboardEvent, 'key'>): KeyboardEvent {
  return {
    type: 'keydown',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...init,
  } as KeyboardEvent;
}
