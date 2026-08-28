import { describe, expect, it } from 'vitest';
import {
  LocalProjectControlResponseSchema,
  safeParseLocalProjectControlRequest,
} from '../src/message-schemas';
import {
  isLocalProjectControlRequest,
  isLocalProjectControlResponse,
} from '../src/node/local-project-control';

const codexProvider = { cliType: 'builtin', agentType: 'codex' } as const;
const claudeProvider = { cliType: 'builtin', agentType: 'claude' } as const;

describe('local project control request schema', () => {
  it('parses add request', () => {
    const parsed = safeParseLocalProjectControlRequest(
      JSON.stringify({
        type: 'local-project/add',
        machineId: 'machine-1',
        rootPath: '/tmp/project',
      })
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).toEqual({
      type: 'local-project/add',
      machineId: 'machine-1',
      rootPath: '/tmp/project',
    });
  });

  it('parses prepare-add request', () => {
    const parsed = safeParseLocalProjectControlRequest(
      JSON.stringify({
        type: 'local-project/prepare-add',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        rootPath: '/tmp/project',
      })
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).toEqual({
      type: 'local-project/prepare-add',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      rootPath: '/tmp/project',
    });
  });

  it('parses local-project removal preflight requests and responses', () => {
    const request = {
      type: 'local-project/removal-preflight',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      localProjectId: 'project-1',
      requestedByUserId: 'user-1',
    };
    const response = {
      ok: true,
      type: 'local-project/removal-preflight',
      result: {
        clean: [{ sessionId: 'session-1', title: 'Clean', path: '/worktrees/session-1' }],
        dirty: [{ sessionId: 'session-2', title: 'Dirty', path: '/worktrees/session-2' }],
        failed: [],
      },
    };

    expect(isLocalProjectControlRequest(request)).toBe(true);
    expect(isLocalProjectControlResponse(response)).toBe(true);
    expect(LocalProjectControlResponseSchema.safeParse(response).success).toBe(true);
  });

  it('parses remote directory browse requests', () => {
    const roots = safeParseLocalProjectControlRequest(
      JSON.stringify({
        type: 'local-project/list-roots',
        machineId: 'machine-1',
      })
    );
    const browse = safeParseLocalProjectControlRequest(
      JSON.stringify({
        type: 'local-project/browse-dir',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        absolutePath: '/home/user/project',
        showHidden: true,
        limit: 100,
        cursor: '100',
      })
    );

    expect(roots.success).toBe(true);
    expect(browse.success).toBe(true);
  });

  it('parses delete request', () => {
    const parsed = safeParseLocalProjectControlRequest(
      JSON.stringify({
        type: 'local-project/delete',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        localProjectId: 'project-1',
      })
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).toEqual({
      type: 'local-project/delete',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      localProjectId: 'project-1',
    });
  });

  it('parses git-state request with workspace id', () => {
    const parsed = safeParseLocalProjectControlRequest(
      JSON.stringify({
        type: 'local-project/git-state',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        localProjectId: 'project-1',
      })
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).toEqual({
      type: 'local-project/git-state',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      localProjectId: 'project-1',
    });
  });

  it.each(['local-project/get-worktree-cleanup', 'local-project/set-worktree-cleanup'] as const)(
    'parses worktree cleanup request: %s',
    (type) => {
      const parsed = safeParseLocalProjectControlRequest(
        JSON.stringify({
          type,
          machineId: 'machine-1',
          workspaceId: 'workspace-1',
          localProjectId: 'project-1',
          requestedByUserId: 'user-1',
          ...(type === 'local-project/set-worktree-cleanup'
            ? { config: { scripts: { bash: 'rm -rf node_modules' } } }
            : {}),
        })
      );

      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        return;
      }

      expect(parsed.data.type).toBe(type);
    }
  );

  it('parses Codex provider history sync request with workspace id', () => {
    const parsed = safeParseLocalProjectControlRequest(
      JSON.stringify({
        type: 'local-project/sync-history',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        localProjectId: 'project-1',
        provider: codexProvider,
      })
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).toEqual({
      type: 'local-project/sync-history',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      localProjectId: 'project-1',
      provider: codexProvider,
    });
  });

  it('parses Codex provider history import request with selected sessions', () => {
    const parsed = safeParseLocalProjectControlRequest(
      JSON.stringify({
        type: 'local-project/import-history',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        localProjectId: 'project-1',
        provider: codexProvider,
        acpSessionIds: ['codex-1', 'codex-2'],
      })
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).toEqual({
      type: 'local-project/import-history',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      localProjectId: 'project-1',
      provider: codexProvider,
      acpSessionIds: ['codex-1', 'codex-2'],
    });
  });

  it('parses Claude provider history sync request with workspace id', () => {
    const parsed = safeParseLocalProjectControlRequest(
      JSON.stringify({
        type: 'local-project/sync-history',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        localProjectId: 'project-1',
        provider: claudeProvider,
      })
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).toEqual({
      type: 'local-project/sync-history',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      localProjectId: 'project-1',
      provider: claudeProvider,
    });
  });

  it('parses Claude provider history import request with selected sessions', () => {
    const parsed = safeParseLocalProjectControlRequest(
      JSON.stringify({
        type: 'local-project/import-history',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        localProjectId: 'project-1',
        provider: claudeProvider,
        acpSessionIds: ['claude-1', 'claude-2'],
      })
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).toEqual({
      type: 'local-project/import-history',
      machineId: 'machine-1',
      workspaceId: 'workspace-1',
      localProjectId: 'project-1',
      provider: claudeProvider,
      acpSessionIds: ['claude-1', 'claude-2'],
    });
  });

  it('rejects legacy string history provider requests', () => {
    const parsed = safeParseLocalProjectControlRequest(
      JSON.stringify({
        type: 'local-project/sync-history',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        localProjectId: 'project-1',
        provider: 'codex',
      })
    );

    expect(parsed.success).toBe(false);
  });

  it('rejects invalid request', () => {
    const parsed = safeParseLocalProjectControlRequest(
      JSON.stringify({
        type: 'local-project/add',
        rootPath: '/tmp/project',
      })
    );

    expect(parsed.success).toBe(false);
  });
});

describe('local project control response schema', () => {
  it('accepts add success response', () => {
    const result = LocalProjectControlResponseSchema.safeParse({
      ok: true,
      type: 'local-project/add',
      result: {
        localProjectId: 'project-1',
        name: 'project',
        rootPath: '/tmp/project',
        workspaceIds: ['workspace-1'],
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts prepare-add success response', () => {
    const response = {
      ok: true,
      type: 'local-project/prepare-add',
      result: {
        localProjectId: 'project-1',
        name: 'project',
        rootPath: '/tmp/project',
        alreadyRegistered: false,
      },
    } as const;

    expect(LocalProjectControlResponseSchema.safeParse(response).success).toBe(true);
    expect(isLocalProjectControlResponse(response)).toBe(true);
  });

  it('accepts list success response', () => {
    const result = LocalProjectControlResponseSchema.safeParse({
      ok: true,
      type: 'local-project/list',
      result: {
        workspaces: [
          {
            workspaceId: 'workspace-1',
            workspaceName: 'Workspace One',
            projects: [
              {
                localProjectId: 'project-1',
                name: 'project',
                rootPath: '/tmp/project',
              },
            ],
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts remote directory browse responses', () => {
    const roots = LocalProjectControlResponseSchema.safeParse({
      ok: true,
      type: 'local-project/list-roots',
      result: {
        platform: 'linux',
        pathSeparator: '/',
        homeDir: '/home/user',
      },
    });
    const browse = LocalProjectControlResponseSchema.safeParse({
      ok: true,
      type: 'local-project/browse-dir',
      result: {
        path: '/home/user',
        parentPath: '/home',
        entries: [
          {
            name: 'project',
            absolutePath: '/home/user/project',
            isSymlink: false,
            hidden: false,
            hints: { git: true },
            registeredProjectId: 'project-1',
          },
          {
            name: 'private',
            absolutePath: '/home/user/private',
            isSymlink: false,
            hidden: false,
            error: 'unreadable',
          },
        ],
        truncated: true,
        nextCursor: '2',
      },
    });

    expect(roots.success).toBe(true);
    expect(browse.success).toBe(true);
  });

  it.each(['local-project/get-worktree-cleanup', 'local-project/set-worktree-cleanup'] as const)(
    'accepts worktree cleanup success response: %s',
    (type) => {
      const result = LocalProjectControlResponseSchema.safeParse({
        ok: true,
        type,
        result: { scripts: { bash: 'rm -rf node_modules' } },
      });

      expect(result.success).toBe(true);
    }
  );

  it('accepts error response', () => {
    const result = LocalProjectControlResponseSchema.safeParse({
      ok: false,
      type: 'local-project/add',
      error: 'workspace_required',
      message: 'workspace required',
      data: {
        candidates: [],
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts git-state response with working tree summary', () => {
    const result = LocalProjectControlResponseSchema.safeParse({
      ok: true,
      type: 'local-project/git-state',
      result: {
        git: true,
        branches: ['main'],
        currentBranch: 'main',
        defaultBranch: 'main',
        githubRepoFullName: 'loro-dev/lody',
        workingTree: {
          clean: false,
          staged: true,
          unstaged: false,
          untracked: false,
          conflicted: false,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts history catalog response', () => {
    const result = LocalProjectControlResponseSchema.safeParse({
      ok: true,
      type: 'local-project/sync-history',
      result: {
        listed: 3,
        lastListedAt: 123,
        sessions: [
          {
            acpSessionId: 'codex-1',
            title: 'Codex session',
            updatedAt: '2026-05-14T05:30:00.000Z',
            status: 'available',
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts history import result response', () => {
    const result = LocalProjectControlResponseSchema.safeParse({
      ok: true,
      type: 'local-project/import-history',
      result: {
        summary: {
          listed: 2,
          imported: 1,
          refreshed: 1,
          skipped: 0,
          conflicted: 0,
          failed: 0,
          failures: [],
        },
        catalog: {
          listed: 3,
          lastListedAt: 123,
          sessions: [
            {
              acpSessionId: 'codex-1',
              title: 'Codex session',
              importedSessionId: 'session-1',
              status: 'imported',
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts Claude history catalog response', () => {
    const result = LocalProjectControlResponseSchema.safeParse({
      ok: true,
      type: 'local-project/sync-history',
      result: {
        listed: 1,
        lastListedAt: 123,
        sessions: [
          {
            acpSessionId: 'claude-1',
            title: 'Claude session',
            updatedAt: '2026-05-14T05:30:00.000Z',
            status: 'available',
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('node local project control guard', () => {
  it('accepts remote directory browse request and response', () => {
    expect(
      isLocalProjectControlRequest({
        type: 'local-project/browse-dir',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        absolutePath: '/home/user',
        limit: 100,
        cursor: '100',
      })
    ).toBe(true);

    expect(
      isLocalProjectControlResponse({
        ok: true,
        type: 'local-project/browse-dir',
        result: {
          path: '/home/user',
          parentPath: '/home',
          entries: [
            {
              name: 'project',
              absolutePath: '/home/user/project',
              isSymlink: false,
              hidden: false,
              hints: { git: true },
            },
          ],
          truncated: false,
        },
      })
    ).toBe(true);
  });

  it('accepts list-dir request and response', () => {
    expect(
      isLocalProjectControlRequest({
        type: 'local-project/list-dir',
        machineId: 'machine-1',
        workspaceId: 'workspace-1',
        localProjectId: 'project-1',
        relativePath: 'src',
        limit: 100,
      })
    ).toBe(true);

    expect(
      isLocalProjectControlResponse({
        ok: true,
        type: 'local-project/list-dir',
        result: {
          entries: [
            { name: 'index.ts', type: 'file' },
            { name: 'components', type: 'directory' },
          ],
          truncated: false,
        },
      })
    ).toBe(true);
  });

  it('accepts list-global-skills response with absolute paths', () => {
    expect(
      isLocalProjectControlResponse({
        ok: true,
        type: 'local-project/list-global-skills',
        result: {
          groups: [
            {
              scope: 'global',
              dir: '~/.codex/skills',
              skills: [
                {
                  id: '~/.codex/skills/review',
                  name: 'review',
                  relativePath: '~/.codex/skills/review/SKILL.md',
                  absolutePath: '/home/user/.codex/skills/review/SKILL.md',
                  isSymlink: false,
                },
              ],
              truncated: false,
            },
          ],
          contentFingerprint: 'fingerprint',
        },
      })
    ).toBe(true);
  });
});
