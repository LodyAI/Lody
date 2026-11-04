import { describe, expect, it } from 'vitest';
import { resolveLocalWorkspaceFilePath } from '../src/lib/session-local-file-path';

describe('resolveLocalWorkspaceFilePath', () => {
  it('preserves absolute paths only for an explicitly local target', () => {
    expect(resolveLocalWorkspaceFilePath('/workspace', '/tmp/build/Lody.zip', true)).toBe(
      '/tmp/build/Lody.zip'
    );
    expect(resolveLocalWorkspaceFilePath(null, '/tmp/build/Lody.dmg', true)).toBe(
      '/tmp/build/Lody.dmg'
    );
    expect(resolveLocalWorkspaceFilePath('/workspace', 'C:/build/Lody.zip', true)).toBe(
      'C:/build/Lody.zip'
    );
    expect(resolveLocalWorkspaceFilePath('/workspace', '../Lody.zip', true)).toBe(
      '/workspace/../Lody.zip'
    );
  });

  it('refuses a path that is not relative to the workspace', () => {
    // Absolute paths remain rejected unless the caller identifies a local target.
    expect(resolveLocalWorkspaceFilePath('/Users/dev/project', '/etc/passwd')).toBeNull();
    expect(resolveLocalWorkspaceFilePath('/Users/dev/project', '../../etc/passwd')).toBeNull();
    expect(resolveLocalWorkspaceFilePath('/Users/dev/project', 'src/../../etc/passwd')).toBeNull();
    expect(
      resolveLocalWorkspaceFilePath('/Users/dev/project', 'C:\\Windows\\notepad.exe')
    ).toBeNull();
  });

  it('never joins a home-rooted path onto the workspace root', () => {
    // Remote targets do not resolve it, exactly like an absolute path.
    expect(resolveLocalWorkspaceFilePath('/workspace', '~/a.txt', false, '/Users/dev')).toBeNull();
    // An unknown home directory leaves it unresolved rather than producing
    // `<workspace>/~/...`.
    expect(resolveLocalWorkspaceFilePath('/workspace', '~/a.txt', true)).toBeNull();
    expect(resolveLocalWorkspaceFilePath('/workspace', '~/a.txt', true, '  ')).toBeNull();
  });
});
