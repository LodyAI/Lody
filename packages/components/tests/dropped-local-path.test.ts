// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { getDroppedFileLocalPath, toPathMentionInsertion } from '../src/lib/dropped-local-path';

type BridgeWindow = typeof window & {
  __LODY_ELECTRON__?: true;
  electron?: { webUtils?: { getPathForFile?: (file: File) => string } };
};

afterEach(() => {
  const w = window as BridgeWindow;
  delete w.__LODY_ELECTRON__;
  delete w.electron;
});

describe('toPathMentionInsertion', () => {
  it('keeps the dropped path absolute and drops the trailing slash', () => {
    expect(toPathMentionInsertion('/Users/dev/lody/packages/components/', 'dir')).toEqual({
      path: '/Users/dev/lody/packages/components',
      kind: 'dir',
    });
  });

  it('keeps a bare filesystem root', () => {
    expect(toPathMentionInsertion('/', 'dir')).toEqual({ path: '/', kind: 'dir' });
  });

  it('normalizes Windows separators', () => {
    expect(toPathMentionInsertion('C:\\Users\\dev\\lody\\src\\ui\\', 'dir')).toEqual({
      path: 'C:/Users/dev/lody/src/ui',
      kind: 'dir',
    });
  });
});

describe('getDroppedFileLocalPath', () => {
  const file = new File([], 'src');

  it('is null outside the desktop shell', () => {
    (window as BridgeWindow).electron = { webUtils: { getPathForFile: () => '/x/src' } };
    expect(getDroppedFileLocalPath(file)).toBeNull();
  });

  it('is null on a preload without the path bridge', () => {
    (window as BridgeWindow).__LODY_ELECTRON__ = true;
    (window as BridgeWindow).electron = {};
    expect(getDroppedFileLocalPath(file)).toBeNull();
  });

  it('reads the path from the preload bridge', () => {
    (window as BridgeWindow).__LODY_ELECTRON__ = true;
    (window as BridgeWindow).electron = {
      webUtils: { getPathForFile: (dropped) => (dropped === file ? '/Users/dev/lody/src' : '') },
    };
    expect(getDroppedFileLocalPath(file)).toBe('/Users/dev/lody/src');
    expect(getDroppedFileLocalPath(new File([], 'other'))).toBeNull();
  });
});
