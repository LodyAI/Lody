import { describe, expect, it } from 'vitest';

import {
  latchHydrationText,
  mergeHydratedMentions,
  shouldRunHydration,
} from '../src/components/mentions/mention-hydration';

/**
 * A persisted draft does not exist on the composer's first render: the landing
 * draft lives in `atomWithStorage`, which initialises with its default and only
 * reads storage in `onMount`. So the first text a hydrator sees is `''`, and
 * the whole question is whether it commits to that.
 */
describe('when a hydrator commits to a text', () => {
  it('ignores the empty first render and latches the draft that arrives after it', () => {
    let latched = latchHydrationText('', '');
    expect(latched).toBe('');
    expect(shouldRunHydration(latched, '', false)).toBe(false);

    // The stored draft lands a tick later.
    latched = latchHydrationText(latched, 'see @src/a.ts');
    expect(latched).toBe('see @src/a.ts');
    expect(shouldRunHydration(latched, 'see @src/a.ts', false)).toBe(true);
  });

  it('waits while the text differs from the snapshot the offsets were measured against', () => {
    expect(shouldRunHydration('see @src/a.ts', 'see @src/a.ts and more', false)).toBe(false);
  });

  it('waits while the mention menu is open, which is about to commit its own range', () => {
    expect(shouldRunHydration('see @src/a.ts', 'see @src/a.ts', true)).toBe(false);
  });
});

describe('merging hydrated ranges', () => {
  const file = { start: 4, end: 11, value: 'fix-ci', kind: 'file' };

  it('rejects a range overlapping one already present, not just an identical one', () => {
    // A path and a session slug are the same shape, so `@fix-ci` can be a known
    // file to one hydrator and a known session to another, at different ends.
    // Both surviving means the renderer silently drops one and the draft stores
    // the pair.
    const session = { start: 4, end: 11, value: 'ses_1', kind: 'session' };
    expect(mergeHydratedMentions([file], [session])).toEqual([file]);
    expect(mergeHydratedMentions([file], [{ ...session, end: 13 }])).toEqual([file]);
    expect(mergeHydratedMentions([file], [{ ...session, start: 8, end: 20 }])).toEqual([file]);
  });

  it('lets what is already there win, which is what makes scanning the fallback', () => {
    const restored = { start: 4, end: 11, value: 'ses_1', kind: 'session' };
    // Restored-from-draft is present first; a scanner may only fill gaps.
    expect(mergeHydratedMentions([restored], [file])).toEqual([restored]);
  });
});
