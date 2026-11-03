import { beforeEach, describe, expect, it, vi } from 'vitest';

const mutationMock = vi.fn();

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    mutation = mutationMock;
  },
}));

vi.mock('@lody/cloud-api', () => ({
  api: { agentFeedback: { submitFromCli: 'agentFeedback.submitFromCli' } },
}));

vi.mock('@/utils/const', () => ({
  LODY_AUTH_URL: 'https://convex.example.test',
}));

import { submitAgentFeedback } from './feedback';

describe('agent feedback client', () => {
  beforeEach(() => {
    mutationMock.mockReset();
    mutationMock.mockResolvedValue({ ok: true, feedbackId: 'feedback-1' });
  });

  it('trims feedback and sends the authenticated CLI token separately', async () => {
    await expect(
      submitAgentFeedback({
        cliToken: 'secret-cli-token',
        source: 'mcp',
        feedback: '  Status errors need recovery hints.  ',
        cliVersion: '1.2.3',
      })
    ).resolves.toEqual({ ok: true, feedbackId: 'feedback-1' });

    expect(mutationMock).toHaveBeenCalledWith('agentFeedback.submitFromCli', {
      cliToken: 'secret-cli-token',
      source: 'mcp',
      feedback: 'Status errors need recovery hints.',
      systemInfo: {
        cliVersion: '1.2.3',
        platform: process.platform,
        arch: process.arch,
      },
    });
  });

  it('rejects obvious credentials before making a request', async () => {
    await expect(
      submitAgentFeedback({
        cliToken: 'token',
        source: 'mcp',
        feedback: 'The request used Bearer abcdefghijklmnopqrstuvwxyz1234',
        cliVersion: '1.2.3',
      })
    ).rejects.toThrow('appears to contain a secret');
    expect(mutationMock).not.toHaveBeenCalled();
  });
});
