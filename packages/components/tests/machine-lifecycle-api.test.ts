import { describe, expect, it } from 'vitest';
import { isCliVersionOutdated } from '../src/lib/machine-lifecycle-api';

describe('isCliVersionOutdated', () => {
  it('treats a prerelease current version as older than the matching stable latest', () => {
    expect(isCliVersionOutdated('1.2.3-beta.1', '1.2.3')).toBe(true);
    expect(isCliVersionOutdated('1.2.3', '1.2.3-beta.1')).toBe(false);
  });
});
