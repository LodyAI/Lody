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
  });

  it('uses backslashes for a Windows workspace root', () => {
    expect(resolveLocalWorkspaceFilePath('C:\\Users\\dev\\project', 'src/main.ts')).toBe(
      'C:\\Users\\dev\\project\\src\\main.ts'
    );
  });

  it('refuses a path that is not relative to the workspace', () => {
    // Nothing that could name a file outside the workspace may reach the OS.
    expect(resolveLocalWorkspaceFilePath('/Users/dev/project', '/etc/passwd')).toBeNull();
    expect(resolveLocalWorkspaceFilePath('/Users/dev/project', '../../etc/passwd')).toBeNull();
    expect(resolveLocalWorkspaceFilePath('/Users/dev/project', 'src/../../etc/passwd')).toBeNull();
    expect(
      resolveLocalWorkspaceFilePath('/Users/dev/project', 'C:\\Windows\\notepad.exe')
    ).toBeNull();
  });

  it('has no path without both a workspace root and a file', () => {
    expect(resolveLocalWorkspaceFilePath(null, 'src/main.ts')).toBeNull();
    expect(resolveLocalWorkspaceFilePath('/Users/dev/project', '  ')).toBeNull();
  });
});
