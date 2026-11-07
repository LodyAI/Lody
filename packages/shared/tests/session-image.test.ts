import { describe, expect, it } from 'vitest';

import { parseSessionImageThumbnailOptions } from '../src/session-image';

describe('session-image thumbnail path', () => {
  it('clamps untrusted thumbnail query options the same way the builder does', () => {
    expect(
      parseSessionImageThumbnailOptions(
        new URLSearchParams({ width: 'nope', height: '100000', fit: 'squish', quality: '0' })
      )
    ).toEqual({ width: 512, height: 4096, fit: 'scale-down', quality: 1 });

    // Absent height keeps the aspect ratio; a blank one falls back to the width.
    expect(parseSessionImageThumbnailOptions(new URLSearchParams({ width: '180' }))).toEqual({
      width: 180,
      height: undefined,
      fit: 'scale-down',
      quality: 85,
    });
    expect(
      parseSessionImageThumbnailOptions(new URLSearchParams({ width: '180', height: '' }))
    ).toEqual({ width: 180, height: 180, fit: 'scale-down', quality: 85 });
  });
});
