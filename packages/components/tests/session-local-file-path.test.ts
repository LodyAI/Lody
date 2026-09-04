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

  it('refuses a path that is not relative to the workspace', () => {
    // This is what keeps a remote session from naming a path on THIS machine
    // for the shell to open: nothing that could escape the root may resolve.
    expect(resolveLocalWorkspaceFilePath('/Users/dev/project', '/etc/passwd')).toBeNull();
    expect(resolveLocalWorkspaceFilePath('/Users/dev/project', '../../etc/passwd')).toBeNull();
    expect(resolveLocalWorkspaceFilePath('/Users/dev/project', 'src/../../etc/passwd')).toBeNull();
    expect(
      resolveLocalWorkspaceFilePath('/Users/dev/project', 'C:\\Windows\\notepad.exe')
    ).toBeNull();
  });
});
