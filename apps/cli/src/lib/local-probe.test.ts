import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createLocalProbeRequestHandler } from './local-probe';

vi.hoisted(() => {
  Object.assign(globalThis, { __LODY_E2E_DAEMON_LOSS__: true });
  process.env.LODY_E2E = '1';
});

const key = '42'.repeat(32);
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
