import { describe, expect, it } from 'vitest';
import { feedbackCommand } from './feedback';

describe('resolveFeedbackText', () => {
  it('preserves option-like tokens after positional feedback begins', () => {
    expect(
      feedbackCommand.parseOptions([
        'The',
        '--wait',
        'flag',
        'and',
        '--json',
        'output',
        'are',
        'confusing',
      ]).operands
    ).toEqual(['The', '--wait', 'flag', 'and', '--json', 'output', 'are', 'confusing']);
  });
});
