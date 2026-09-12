import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@lody/shared';
import { getSessionShareCandidates } from '../src/lib/session-share-candidates';

describe('share candidate discovery', () => {
  it('includes both descendant relations once, bounds cycles and leaves unrelated sessions out', () => {
    const sessions = [
      { id: 'root', parentSessionId: 'cycle' },
      { id: 'tab', parentSessionId: 'root' },
      { id: 'opened', openedBySessionId: 'tab' },
      { id: 'cycle', parentSessionId: 'opened', openedBySessionId: 'root' },
      { id: 'unrelated', openedBySessionId: 'missing' },
    ] as SessionMeta[];
    expect(getSessionShareCandidates('root', sessions).map((entry) => entry.id)).toEqual([
      'tab',
      'cycle',
      'opened',
    ]);
    expect(getSessionShareCandidates('tab', sessions).map((entry) => entry.id)).toEqual([
      'opened',
      'cycle',
      'root',
    ]);
  });
});
