import { describe, expect, it } from 'vitest';
import { isDirectLocalProject } from '../src/project';

describe('isDirectLocalProject', () => {
  it('identifies local projects using their original shared directory', () => {
    expect(isDirectLocalProject({ kind: 'local' })).toBe(true);
    expect(isDirectLocalProject({ kind: 'local', useWorktree: false })).toBe(true);
  });

  it('preserves current and legacy local worktree sessions', () => {
    expect(isDirectLocalProject({ kind: 'local', useWorktree: true })).toBe(false);
    expect(isDirectLocalProject({ kind: 'local' }, true)).toBe(false);
  });

  it('does not classify GitHub or legacy project metadata as direct local', () => {
    expect(isDirectLocalProject({ kind: 'github' })).toBe(false);
    expect(isDirectLocalProject(undefined)).toBe(false);
  });
});
