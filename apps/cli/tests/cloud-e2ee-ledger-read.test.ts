import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloudE2eeDeviceRevoked,
  CloudE2eeLedgerOutage,
  CloudE2eeMemberRemoved,
} from '../src/lib/cloud-e2ee-errors';
import { createCloudE2eePort } from '../src/lib/cloud-cli-port';

/** Only the network is replaced: replies pass through the real Convex SDK and the real port. */
const network = vi.hoisted(() => ({
  reply: (_url: unknown, _init: unknown): Promise<Response> =>
    Promise.reject(new Error('no reply configured')),
}));
vi.mock('@/utils/http-transport', async (original) => ({
  ...(await original<object>()),
  getCliHttpFetch: () => (url: unknown, init: unknown) => network.reply(url, init),
}));

const UDF_FAILED = 560;
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const read = (authBaseUrl = 'https://cloud.invalid') =>
  createCloudE2eePort({ authBaseUrl, logger: {} as never })
    .getHistory({ workspaceId: 'workspace', credential: 'a'.repeat(64) })
    .then(
      () => {
        throw new Error('expected the read to fail');
      },
      (cause: unknown) => cause
    );

describe('latest ledger read failures through the Convex SDK', () => {
  beforeEach(() => {
    network.reply = () => Promise.reject(new Error('no reply configured'));
  });

  it.each<[string, () => Promise<Response>]>([
    ['no reply', () => Promise.reject(new TypeError('fetch failed'))],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
    ['a bad gateway page', async () => new Response('<html>Bad gateway</html>', { status: 502 })],
    ['an empty 503', async () => new Response('', { status: 503 })],
    ['a 429', async () => new Response('Too many requests', { status: 429 })],
    [
      'a server error with no business code',
      async () => json({ status: 'error', errorMessage: '[Server Error]' }, UDF_FAILED),
    ],
  ])('treats %s as an outage', async (_name, reply) => {
    network.reply = reply;
    expect(await read()).toBeInstanceOf(CloudE2eeLedgerOutage);
  });

  it.each<[string, () => Promise<Response>]>([
    [
      'a 429 naming a refusal',
      async () => json({ code: 'e2ee_device_revoked', message: 'refused' }, 429),
    ],
    [
      'a 502 naming a refusal',
      async () => json({ code: 'e2ee_member_removed', message: 'refused' }, 502),
    ],
    ['a 403', async () => new Response('Forbidden', { status: 403 })],
    ['a 200 success with no value', async () => json({ status: 'success' }, 200)],
    ['a 200 with an unknown status', async () => json({ status: 'pending' }, 200)],
    ['a 200 that is not JSON', async () => new Response('<html></html>', { status: 200 })],
    ['a success failing the page schema', async () => json({ status: 'success', value: {} }, 200)],
    [
      'an unauthorized code',
      async () =>
        json(
          {
            status: 'error',
            errorMessage: 'refused',
            errorData: { code: 'e2ee_device_unauthorized' },
          },
          UDF_FAILED
        ),
    ],
    [
      'an unknown business code',
      async () =>
        json(
          { status: 'error', errorMessage: 'refused', errorData: { code: 'e2ee_ledger_rollback' } },
          UDF_FAILED
        ),
    ],
  ])('does not treat %s as an outage', async (_name, reply) => {
    network.reply = reply;
    expect(await read()).not.toBeInstanceOf(CloudE2eeLedgerOutage);
  });

  const readFromTruncatedResponse = async (status: number) => {
    const server = createServer((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': 1024 });
      response.write('{"status":', () => response.socket?.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      network.reply = (url, init) => fetch(url as string, init as RequestInit);
      return await read(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };

  it.each([200, 429, 502, 503])(
    'treats a socket closed after %i response headers as an outage',
    async (status) => {
      expect(await readFromTruncatedResponse(status)).toBeInstanceOf(CloudE2eeLedgerOutage);
    }
  );

  it.each([401, 403])(
    'keeps a %i refusal when the socket closes after its headers',
    async (status) => {
      expect(await readFromTruncatedResponse(status)).not.toBeInstanceOf(CloudE2eeLedgerOutage);
    }
  );

  it('keeps the removal and revocation types', async () => {
    network.reply = async () =>
      json(
        { status: 'error', errorMessage: 'refused', errorData: { code: 'e2ee_member_removed' } },
        UDF_FAILED
      );
    expect(await read()).toBeInstanceOf(CloudE2eeMemberRemoved);
    network.reply = async () =>
      json(
        { status: 'error', errorMessage: 'refused', errorData: { code: 'e2ee_device_revoked' } },
        UDF_FAILED
      );
    expect(await read()).toBeInstanceOf(CloudE2eeDeviceRevoked);
  });
});
