import { describe, expect, it } from 'vitest';
import {
  isAbsoluteFilePath,
  resolveLocalWorkspaceFilePath,
} from '../src/lib/session-local-file-path';

describe('isAbsoluteFilePath', () => {
  it('recognizes POSIX, Windows drive, and UNC paths', () => {
    expect(isAbsoluteFilePath('/tmp/build/Lody.zip')).toBe(true);
    expect(isAbsoluteFilePath('\\\\server\\share\\Lody.zip')).toBe(true);
    expect(isAbsoluteFilePath('C:/build/Lody.zip')).toBe(true);
    expect(isAbsoluteFilePath('C:\\build\\Lody.zip')).toBe(true);
    expect(isAbsoluteFilePath('  /tmp/build/Lody.zip  ')).toBe(true);
  });

  it('rejects workspace-relative and empty paths', () => {
    expect(isAbsoluteFilePath('src/main.ts')).toBe(false);
    expect(isAbsoluteFilePath('./src/main.ts')).toBe(false);
    expect(isAbsoluteFilePath('../artifacts/Lody.dmg')).toBe(false);
    expect(isAbsoluteFilePath('')).toBe(false);
    expect(isAbsoluteFilePath(null)).toBe(false);
    expect(isAbsoluteFilePath(undefined)).toBe(false);
  });
});

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

  it('expands a home-rooted path against the local home directory', () => {
    expect(
      resolveLocalWorkspaceFilePath('/workspace', '~/Code/app/SKILL.md', true, '/Users/dev')
    ).toBe('/Users/dev/Code/app/SKILL.md');
    expect(resolveLocalWorkspaceFilePath('/workspace', '~', true, '/Users/dev')).toBe('/Users/dev');
    expect(resolveLocalWorkspaceFilePath('/workspace', '~/docs', true, '/Users/dev/')).toBe(
      '/Users/dev/docs'
    );
    // The separator follows the home spelling, like the workspace root.
    expect(
      resolveLocalWorkspaceFilePath('/workspace', '~/docs/a.txt', true, 'C:\\Users\\dev')
    ).toBe('C:\\Users\\dev\\docs\\a.txt');
    expect(
      resolveLocalWorkspaceFilePath('/workspace', '~\\docs\\a.txt', true, 'C:\\Users\\dev')
    ).toBe('C:\\Users\\dev\\docs\\a.txt');
  });

  it('never joins a home-rooted path onto the workspace root', () => {
    // Remote targets do not resolve it, exactly like an absolute path.
    expect(resolveLocalWorkspaceFilePath('/workspace', '~/a.txt', false, '/Users/dev')).toBeNull();
    // An unknown home directory leaves it unresolved rather than producing
    // `<workspace>/~/...`.
    expect(resolveLocalWorkspaceFilePath('/workspace', '~/a.txt', true)).toBeNull();
    expect(resolveLocalWorkspaceFilePath('/workspace', '~/a.txt', true, '  ')).toBeNull();
  });

  it('keeps the ~user form workspace-relative', () => {
    // Other users' homes cannot be resolved, so the form keeps its existing
    // workspace-relative meaning.
    expect(resolveLocalWorkspaceFilePath('/workspace', '~dev/a.txt')).toBe('/workspace/~dev/a.txt');
  });
});
