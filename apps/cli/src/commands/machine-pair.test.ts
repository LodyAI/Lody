import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  startError: undefined as Error | undefined,
  startArgs: [] as string[][],
}));

vi.mock('@/lib/cli-platform', () => ({ getCliPlatformKind: () => 'cloud' }));
vi.mock('@/lib/machine-identity', () => ({ getOrCreateMachineId: () => 'synthetic-machine' }));
vi.mock('@/utils/logger', () => ({
  getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('@/lib/cloud-cli-port', () => ({
  createCloudE2eePort: () => ({}),
  createCloudRemoteMachinePairingClaim: () => async () => ({}),
}));
vi.mock('@/lib/e2ee/remote-pairing', () => ({
  decodeRemoteMachineOffer: () => ({
    workspaceId: 'ws-1',
    deploymentUrl: 'https://deployment.invalid',
    ingressUrl: 'https://ingress.invalid',
  }),
  pairRemoteMachineLegacy: async () => ({
    reference: 'acct-1/ws-1',
    workspaceId: 'ws-1',
    machineId: 'synthetic-machine',
    summary: 'ABCD-1234',
    ready: true as const,
  }),
}));
vi.mock('./start', () => ({
  startCommand: {
    parseAsync: async (args: string[]) => {
      state.startArgs.push(args);
      if (state.startError) throw state.startError;
    },
  },
}));

describe('machine pair command', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    state.startError = undefined;
    state.startArgs = [];
    process.exitCode = undefined;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('propagates startCommand failures instead of swallowing them as pairing errors', async () => {
    state.startError = new Error('daemon_start_boom');
    const { machinePairCommand } = await import('./machine-pair');

    await expect(
      machinePairCommand.parseAsync(['--offer', 'synthetic-offer'], { from: 'user' })
    ).rejects.toThrow('daemon_start_boom');
    expect(state.startArgs).toEqual([['--paired-workspace', 'acct-1/ws-1']]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
