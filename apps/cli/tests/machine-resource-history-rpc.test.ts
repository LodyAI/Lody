import { describe, expect, it, vi } from 'vitest';
import { LocalMachineRpcRequestSchema, LocalMachineRpcResponseSchema } from '@lody/shared';
import { MachineRuntime } from '../src/lib/machine-runtime';

describe('local resource history RPC', () => {
  it('serves existing observations without starting work and rejects session-scoped access', async () => {
    const history = {
      type: 'machine/resource-history' as const,
      machineId: 'machine',
      instanceId: 'instance',
      collectedWhileObserved: true as const,
      samples: [],
    };
    const sample = vi.fn(() => {
      throw new Error('must not probe');
    });
    const runtime: MachineRuntime = Object.assign(Object.create(MachineRuntime.prototype), {
      resourceMonitor: { getHistory: () => history, sample },
    });
    const request = LocalMachineRpcRequestSchema.parse({
      method: 'machine/get-resource-history',
      machineId: 'machine',
      workspaceId: 'workspace',
      params: {},
    });
    const response = await runtime.dispatchLocalMachineRpc(request);
    expect(LocalMachineRpcResponseSchema.parse(response)).toEqual({ ok: true, result: history });
    expect(
      await runtime.dispatchLocalMachineRpc({ ...request, ownerSessionId: 'session' })
    ).toEqual({ ok: false, error: 'Machine resource history requires workspace-level access' });
    expect(sample).not.toHaveBeenCalled();
    Object.assign(runtime, { resourceMonitor: null });
    expect(await runtime.dispatchLocalMachineRpc(request)).toEqual({
      ok: false,
      error: 'Resource monitor stopped',
    });
  });
});
