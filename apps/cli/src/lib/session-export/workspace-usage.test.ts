import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const setAuthMock = vi.fn();

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    query = queryMock;
    setAuth = setAuthMock;
  },
}));

vi.mock('@lody/cloud-api', () => ({
  api: {
    usage: {
      getWorkspaceUsageSummaryBundleFromCliToken:
        'usage.getWorkspaceUsageSummaryBundleFromCliToken',
      getWorkspaceUsageTimelineFromCliToken: 'usage.getWorkspaceUsageTimelineFromCliToken',
    },
  },
}));

vi.mock('@/utils/const', () => ({
  LODY_AUTH_URL: 'http://convex.test',
}));

import { fetchWorkspaceUsageBundle } from './workspace-usage';

describe('fetchWorkspaceUsageBundle', () => {
  beforeEach(() => {
    queryMock.mockReset();
    setAuthMock.mockReset();
  });

  it('uses CLI token queries without setting convex auth', async () => {
    queryMock
      .mockResolvedValueOnce({ summary: true })
      .mockResolvedValueOnce({ range: 'day' })
      .mockResolvedValueOnce({ range: 'week' })
      .mockResolvedValueOnce({ range: 'month' })
      .mockResolvedValueOnce({ range: 'total' });

    const bundle = await fetchWorkspaceUsageBundle({
      workspaceId: 'workspace-1',
      cliToken: 'cli-token',
    });

    expect(setAuthMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      'usage.getWorkspaceUsageSummaryBundleFromCliToken',
      {
        workspaceId: 'workspace-1',
        cliToken: 'cli-token',
      }
    );
    expect(queryMock).toHaveBeenNthCalledWith(2, 'usage.getWorkspaceUsageTimelineFromCliToken', {
      workspaceId: 'workspace-1',
      cliToken: 'cli-token',
      range: 'day',
    });
    expect(queryMock).toHaveBeenNthCalledWith(5, 'usage.getWorkspaceUsageTimelineFromCliToken', {
      workspaceId: 'workspace-1',
      cliToken: 'cli-token',
      range: 'total',
    });
    expect(bundle).toEqual({
      summary: { summary: true },
      timelines: {
        day: { range: 'day' },
        week: { range: 'week' },
        month: { range: 'month' },
        total: { range: 'total' },
      },
    });
  });
});
