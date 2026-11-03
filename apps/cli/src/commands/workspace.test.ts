import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listWorkspaceGitHubRepositoriesForCliToken } from '@/lib/workspace';

const queryMock = vi.fn();

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    query = queryMock;
  },
}));

vi.mock('@lody/cloud-api', () => ({
  api: {
    github: {
      listWorkspaceRepositoriesForCliToken: 'github.listWorkspaceRepositoriesForCliToken',
    },
    deviceAuth: {
      listMyWorkspacesForCliToken: 'deviceAuth.listMyWorkspacesForCliToken',
    },
  },
}));

vi.mock('@/utils/const', () => ({
  LODY_AUTH_URL: 'http://convex.test',
}));

describe('workspace command helpers', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('retries GitHub repository listing without requester user id for older Convex deploys', async () => {
    queryMock
      .mockRejectedValueOnce(
        new Error('ArgumentValidationError: Object contains extra field `requesterUserId`')
      )
      .mockResolvedValueOnce({
        valid: true,
        repositories: [],
      });

    await expect(
      listWorkspaceGitHubRepositoriesForCliToken({
        token: 'cli-token',
        workspaceId: 'workspace-1',
        requesterUserId: 'current-session-user',
      })
    ).resolves.toEqual([]);

    expect(queryMock).toHaveBeenNthCalledWith(1, 'github.listWorkspaceRepositoriesForCliToken', {
      cliToken: 'cli-token',
      workspaceId: 'workspace-1',
      requesterUserId: 'current-session-user',
    });
    expect(queryMock).toHaveBeenNthCalledWith(2, 'github.listWorkspaceRepositoriesForCliToken', {
      cliToken: 'cli-token',
      workspaceId: 'workspace-1',
    });
  });

  it('rejects expired CLI tokens when listing workspace GitHub repositories', async () => {
    queryMock.mockResolvedValueOnce({
      valid: false,
      repositories: [],
    });

    await expect(
      listWorkspaceGitHubRepositoriesForCliToken({
        token: 'expired-token',
        workspaceId: 'workspace-1',
      })
    ).rejects.toThrow(/invalid or expired/i);
  });
});
