import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  platform: 'cloud' as 'cloud' | 'local',
  decodeError: undefined as Error | undefined,
  pairError: undefined as Error | undefined,
  startError: undefined as Error | undefined,
  startArgs: [] as string[][],
}));

vi.mock('@/lib/cli-platform', () => ({
  getCliPlatformKind: () => state.platform,
}));

vi.mock('@/lib/machine-identity', () => ({
  getOrCreateMachineId: () => 'synthetic-machine',
}));

vi.mock('@/utils/logger', () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

vi.mock('@/lib/cloud-cli-port', () => ({
  createCloudE2eePort: () => ({}),
  createCloudRemoteMachinePairingClaim: () => async () => ({}),
}));

vi.mock('@/lib/e2ee/remote-pairing', () => ({
  decodeRemoteMachineOffer: () => {
    if (state.decodeError) throw state.decodeError;
    return {
      workspaceId: 'ws-1',
      deploymentUrl: 'https://deployment.invalid',
      ingressUrl: 'https://ingress.invalid',
    };
  },
  pairRemoteMachineLegacy: async () => {
    if (state.pairError) throw state.pairError;
    return {
      reference: 'acct-1/ws-1',
      workspaceId: 'ws-1',
      machineId: 'synthetic-machine',
      summary: 'ABCD-1234',
      ready: true as const,
    };
  },
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
    state.platform = 'cloud';
    state.decodeError = undefined;
    state.pairError = undefined;
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

  it.each([
    ['e2ee_pairing_expired_create_new_command', /expired.*create a new/i],
    ['e2ee_pairing_cancelled_create_new_command', /cancelled.*create a new/i],
    ['e2ee_pairing_conflict_create_new_command', /conflicted.*create a new/i],
    ['e2ee_pairing_superseded_create_new_command', /superseded.*create a new/i],
    ['e2ee_pairing_invalid_command', /invalid or corrupted/i],
    ['e2ee_binding_conflict', /conflicting local encryption binding/i],
    ['e2ee_member_removed', /removed from the encrypted workspace/i],
  ] as const)(
    'maps %s to a specific actionable message without advising retry',
    async (code, pattern) => {
      state.pairError = new Error(code);
      const { machinePairCommand } = await import('./machine-pair');

      await machinePairCommand.parseAsync(['--offer', 'synthetic-offer'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(state.startArgs).toEqual([]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
      expect(message).toMatch(pattern);
      expect(message).not.toMatch(/retry the same command/i);
    }
  );
});
