import { describe, expect, it } from 'vitest';

import { resolveOpenFolderInFileManagerLabel } from '../src/lib/session-file-actions';

const t = (_key: string, fallback: string) => fallback;

describe('resolveOpenFolderInFileManagerLabel', () => {
  it('names Finder on macOS and File Explorer on Windows', () => {
    expect(resolveOpenFolderInFileManagerLabel('darwin', t)).toBe('Open in Finder');
    expect(resolveOpenFolderInFileManagerLabel('win32', t)).toBe('Open in File Explorer');
    expect(resolveOpenFolderInFileManagerLabel('linux', t)).toBe('Open in file manager');
    expect(resolveOpenFolderInFileManagerLabel('unknown', t)).toBe('Open in file manager');
  });
});
