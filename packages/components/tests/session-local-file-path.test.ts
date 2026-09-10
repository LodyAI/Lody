import { describe, expect, it } from 'vitest';
import { resolveLocalWorkspaceFilePath } from '../src/lib/session-local-file-path';

describe('resolveLocalWorkspaceFilePath', () => {
  it('joins a workspace root with a workspace-relative viewer path', () => {
    expect(resolveLocalWorkspaceFilePath('/Users/dev/.lody/worktrees/abc', 'src/app/main.ts')).toBe(
      '/Users/dev/.lody/worktrees/abc/src/app/main.ts'
    );
    expect(resolveLocalWorkspaceFilePath('/Users/dev/project/', './docs/README.md')).toBe(
      '/Users/dev/project/docs/README.md'
    );
    // The separator follows the ROOT, not the host running this code.
    expect(resolveLocalWorkspaceFilePath('C:\\Users\\dev\\project', 'src/main.ts')).toBe(
      'C:\\Users\\dev\\project\\src\\main.ts'
    );
  });

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
});
