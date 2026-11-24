import { describe, expect, it } from 'vitest';
import { resolveIcon } from './genui-catalog';

describe('resolveIcon', () => {
  it('resolves current kebab-case names directly', () => {
    expect(resolveIcon('circle-x')).toBeTruthy();
    expect(resolveIcon('check')).toBeTruthy();
  });

  it('falls back to rotated segments for dropped lucide aliases', () => {
    expect(resolveIcon('x-circle')).toBe(resolveIcon('circle-x'));
  });

  it('returns undefined for unknown names', () => {
    expect(resolveIcon('not-an-icon')).toBeUndefined();
    expect(resolveIcon('zzz')).toBeUndefined();
  });
});
