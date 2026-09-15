import { describe, expect, it } from 'vitest';
import { machineFlockKeys, serializeMachineFlockKey, type SessionId } from '@lody/shared';

import {
  resolveMachineDotlodyPath,
  resolveSessionWorkspacePath,
} from '../src/lib/session-workspace-path';

describe('session workspace path resolver', () => {
  it('prefers machine Flock dotlody path over local home fallback', () => {
    const row = {
      key: machineFlockKeys.dotlodyPath(),
      value: '/Users/remote/.lody',
    } as const;

    expect(
      resolveMachineDotlodyPath(
        {
          [serializeMachineFlockKey(row.key)]: row,
        },
        '/Users/local'
      )
    ).toBe('/Users/remote/.lody');
    expect(resolveMachineDotlodyPath({}, '/Users/local')).toBe('/Users/local/.lody');
  });

  it('derives worktree paths from dotlody path and repo identity', () => {
    expect(
      resolveSessionWorkspacePath({
        sessionId: 'session123' as SessionId,
        isWorktree: true,
        dotlodyPath: '/Users/alice/.lody',
        repoFullName: 'example/project',
      })
    ).toBe('/Users/alice/.lody/repos/github---example---project/worktrees/session123');
  });

  it('derives non-worktree paths without per-session machine meta entries', () => {
    expect(
      resolveSessionWorkspacePath({
        sessionId: 'session123' as SessionId,
        isWorktree: false,
        dotlodyPath: '/Users/alice/.lody',
        localProjectRootPath: '/Users/alice/Code/lody',
      })
    ).toBe('/Users/alice/Code/lody');

    expect(
      resolveSessionWorkspacePath({
        sessionId: 'session123' as SessionId,
        isWorktree: false,
        dotlodyPath: '/Users/alice/.lody',
      })
    ).toBe('/Users/alice/.lody/chats/session123');
  });

  it('spells a Windows machine its own way, so it matches the paths the daemon creates', () => {
    expect(
      resolveSessionWorkspacePath({
        sessionId: 'session123' as SessionId,
        isWorktree: true,
        dotlodyPath: 'C:\\Users\\alice\\.lody',
        repoFullName: 'example/project',
      })
    ).toBe('C:\\Users\\alice\\.lody\\repos\\github---example---project\\worktrees\\session123');

    expect(
      resolveSessionWorkspacePath({
        sessionId: 'session123' as SessionId,
        isWorktree: false,
        dotlodyPath: 'C:\\Users\\alice\\.lody',
      })
    ).toBe('C:\\Users\\alice\\.lody\\chats\\session123');

    // The home-dir fallback applies when the machine has not published its row yet.
    expect(resolveMachineDotlodyPath({}, 'C:\\Users\\alice')).toBe('C:\\Users\\alice\\.lody');
  });

  it('keeps legacy workspacePaths as a compatibility fallback', () => {
    expect(
      resolveSessionWorkspacePath({
        sessionId: 'session123' as SessionId,
        isWorktree: true,
        legacyWorkspacePath: '/legacy/workspace',
      })
    ).toBe('/legacy/workspace');
  });

  it('uses the owner session id for child tab workspaces', () => {
    expect(
      resolveSessionWorkspacePath({
        sessionId: 'child-session' as SessionId,
        ownerSessionId: 'parent-session' as SessionId,
        isWorktree: false,
        dotlodyPath: '/Users/alice/.lody',
      })
    ).toBe('/Users/alice/.lody/chats/parent-session');
  });
});
