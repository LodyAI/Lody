import { describe, expect, it } from 'vitest';
import type { SessionMeta, SessionId, SessionPullRequestMeta } from '@lody/shared';

import {
  getLatestPullRequest,
  getPullRequestNumber,
  getPullRequestRepoFullName,
  getSessionGitHubState,
} from '../src/lib/session-github-state';

const createPullRequest = (
  overrides: Partial<SessionPullRequestMeta> = {}
): SessionPullRequestMeta => ({
  url: 'https://github.com/loro-dev/lody/pull/1518',
  number: 1518,
  repository: 'loro-dev/lody',
  branch: 'fix/session-header-quick-actions-active-tab',
  status: 'open',
  reportedAt: '2026-03-27T10:00:00.000Z',
  ...overrides,
});

const createSession = (overrides: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 'session-1' as SessionId,
    machineId: 'machine-1',
    userId: 'user-1',
    createdAt: '2026-03-27T09:00:00.000Z',
    cliType: 'builtin',
    agentType: 'codex',
    ...overrides,
  }) as SessionMeta;

describe('getSessionGitHubState', () => {
  it('prefers the workspace owner session for PR and dirty state', () => {
    const parentSession = createSession({
      id: 'parent-session-1' as SessionId,
      repoFullName: 'loro-dev/lody',
      workspaceDirty: true,
      pullRequests: [createPullRequest()],
    });
    const childSession = createSession({
      id: 'child-session-2' as SessionId,
      parentSessionId: 'parent-session-1' as SessionId,
      repoFullName: 'loro-dev/lody',
      workspaceDirty: false,
      pullRequests: [],
    });

    const state = getSessionGitHubState(childSession, parentSession);

    expect(state.sourceSessionId).toBe(parentSession.id);
    expect(state.repoFullName).toBe('loro-dev/lody');
    expect(state.workspaceDirty).toBe(true);
    expect(state.hasChanges).toBe(true);
    expect(state.hasExistingPr).toBe(true);
    expect(state.latestPr?.number).toBe(1518);
  });

  it('reports hasChanges from committed diff stats even when the tree is clean', () => {
    const session = createSession({
      repoFullName: 'loro-dev/lody',
      workspaceDirty: false,
      diffStats: { allChange: { add: 12, del: 3 } },
      pullRequests: [],
    });

    const state = getSessionGitHubState(session);

    expect(state.sourceSessionId).toBe(session.id);
    // Clean working tree (agent already committed) but real committed changes:
    // Create PR must stay available, so hasChanges is true while dirty is false.
    expect(state.workspaceDirty).toBe(false);
    expect(state.hasChanges).toBe(true);
    expect(state.hasExistingPr).toBe(false);
  });

  it('reports no changes when the tree is clean and diff stats are empty', () => {
    const session = createSession({
      repoFullName: 'loro-dev/lody',
      workspaceDirty: false,
      diffStats: { allChange: { add: 0, del: 0 } },
      pullRequests: [],
    });

    const state = getSessionGitHubState(session);

    expect(state.workspaceDirty).toBe(false);
    expect(state.hasChanges).toBe(false);
  });

  it('falls back to the current session when no workspace owner session is provided', () => {
    const session = createSession({
      repoFullName: 'loro-dev/lody',
      workspaceDirty: false,
      pullRequests: [
        createPullRequest({
          number: 99,
          url: 'https://github.com/loro-dev/lody/pull/99',
        }),
      ],
    });

    const state = getSessionGitHubState(session);

    expect(state.repoFullName).toBe('loro-dev/lody');
    expect(state.workspaceDirty).toBe(false);
    expect(state.hasExistingPr).toBe(true);
    expect(state.latestPr?.number).toBe(99);
  });

  it('uses append order when compact PR meta has no reportedAt field', () => {
    const latest = getLatestPullRequest(
      createSession({
        pullRequests: [
          {
            url: 'https://github.com/loro-dev/lody/pull/1',
            status: 'open',
          },
          {
            url: 'https://github.com/loro-dev/lody/pull/2',
            status: 'draft',
          },
        ],
      })
    );

    expect(latest?.url).toBe('https://github.com/loro-dev/lody/pull/2');
  });

  it('derives PR number and repository from compact URL-only metadata', () => {
    const pr = {
      url: 'https://github.com/loro-dev/lody/pull/123/files',
      status: 'open' as const,
    };

    expect(getPullRequestNumber(pr)).toBe(123);
    expect(getPullRequestRepoFullName(pr)).toBe('loro-dev/lody');
  });
});
