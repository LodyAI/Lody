import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createLocalProbeRequestHandler } from './local-probe';
import { daemonLossObserver } from './e2ee/client-loss-observer';

vi.hoisted(() => {
  Object.assign(globalThis, { __LODY_E2E_DAEMON_LOSS__: true });
  process.env.LODY_E2E = '1';
});

const key = '42'.repeat(32);
const empty = {
  processorActive: 0,
  processorQueued: 0,
  watcherChecks: 0,
  executionTurns: 0,
  executionBookkeeping: 0,
};
const config = {
  machineId: 'machine' as never,
  cliVersion: 'test',
  logger: { debug() {} } as never,
  getRuntimeState: () => {
    throw new Error('must not query or refresh runtime state');
  },
};
const invoke = (handler: http.RequestListener, url: string, method = 'GET') => {
  const response = new EventEmitter();
  let status = 0;
  const result = new Promise<{ status: number; body: unknown }>((resolve) => {
    Object.assign(response, {
      writeHead(code: number) {
        status = code;
      },
      end(body?: string) {
        resolve({ status, body: body ? JSON.parse(body) : null });
      },
    });
  });
  handler({ url, method } as http.IncomingMessage, response as http.ServerResponse);
  return { result, response };
};

describe('read-only daemon-loss local probe', () => {
  it('requires a validated requester and returns no evidence for unknown owners/keys', async () => {
    const handler = createLocalProbeRequestHandler(config);
    expect(
      await invoke(handler, '/e2e/client-loss?workspaceId=missing&requesterDevice=' + key).result
    ).toEqual({ status: 404, body: { error: 'daemon_loss_missing' } });
    for (const suffix of [
      '',
      '&requesterDevice=secret',
      '&requesterDevice=' + key + '&token=secret',
      '&requesterDevice=' + key + '&wait=1',
      '&requesterDevice=' + key + '&afterSequence=-1',
      '&requesterDevice=' + key + '&workspaceId=duplicate',
    ]) {
      const result = await invoke(handler, '/e2e/client-loss?workspaceId=workspace' + suffix)
        .result;
      expect(result.status).toBe(400);
      expect(JSON.stringify(result)).not.toContain('secret');
    }
    expect(
      (
        await invoke(
          handler,
          '/e2e/client-loss?workspaceId=workspace&requesterDevice=' + key,
          'POST'
        ).result
      ).status
    ).toBe(404);
  });
  it('waits on actual task changes and never shuts down the surviving machine to manufacture a receipt', async () => {
    let present = true;
    let length = 10;
    let generation = 0;
    let pending = { ...empty, watcherChecks: 1 };
    daemonLossObserver.register(
      { workspaceId: 'workspace', machineId: 'machine', accountId: 'account' },
      () => ({ intakeClosed: false, pending }),
      () => ({
        membershipId: 'member',
        ownerMembershipId: 'member',
        devicePresent: present,
        memberPresent: true,
        length,
        generation,
      })
    );
    const handler = createLocalProbeRequestHandler(config);
    const url = '/e2e/client-loss?workspaceId=workspace&requesterDevice=' + key;
    const baseline = await invoke(handler, url).result;
    expect(baseline).toMatchObject({ status: 200, body: { code: null, retired: false } });
    let returned = false;
    const request = invoke(handler, url + '&afterSequence=0&wait=1');
    void request.result.then(() => {
      returned = true;
    });
    present = false;
    length++;
    generation++;
    daemonLossObserver.changed();
    await Promise.resolve();
    expect(returned).toBe(false);
    pending = { ...empty };
    daemonLossObserver.changed();
    expect(await request.result).toMatchObject({
      status: 200,
      body: {
        code: 'e2ee_device_revoked',
        retired: false,
        drained: true,
        fence: 'verified-ledger',
        pending: empty,
      },
    });
    expect(JSON.stringify(await request.result)).not.toContain(key);
  });
  it('omits the route entirely when the immutable build gate is disabled, even with runtime LODY_E2E=1', async () => {
    vi.resetModules();
    vi.stubGlobal('__LODY_E2E_DAEMON_LOSS__', false);
    try {
      const { createLocalProbeRequestHandler: disabled } = await import('./local-probe');
      expect(
        (
          await invoke(
            disabled(config),
            '/e2e/client-loss?workspaceId=workspace&requesterDevice=' + key
          ).result
        ).status
      ).toBe(404);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
