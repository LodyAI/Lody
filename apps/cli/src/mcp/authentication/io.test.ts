import { afterEach, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { makeMcpAuthenticationIO } from './io';

const listeners = vi.hoisted(() => ({
  handlers: [] as Array<(request: IncomingMessage, response: ServerResponse) => void>,
  closed: new Set<number>(),
  peerUid: 1000 as number | null,
}));
vi.mock('../loopback-peer-uid', () => ({
  canReadProcNetTcp: () => true,
  lookupLoopbackPeerUid: async () => listeners.peerUid,
}));
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    createServer: (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
      const index = listeners.handlers.push(handler) - 1;
      return Object.assign(new EventEmitter(), {
        listen: (_port: number, _host: string, ready: () => void) => ready(),
        address: () => ({ port: 12345 }),
        close: (done: () => void) => {
          listeners.closed.add(index);
          done();
        },
        closeAllConnections: () => {},
      });
    },
  };
});
afterEach(() => {
  listeners.handlers.length = 0;
  listeners.closed.clear();
  listeners.peerUid = 1000;
  vi.unstubAllGlobals();
});
function message(path: string, headers: Record<string, string> = {}) {
  const completed = Promise.withResolvers<void>();
  const result = { status: 200, body: '', ended: false };
  const request = {
    method: 'GET',
    url: path,
    headers: { host: '127.0.0.1:12345', ...headers },
    socket: {
      remoteAddress: '127.0.0.1',
      remotePort: 12346,
      localAddress: '127.0.0.1',
      localPort: 12345,
    },
  } as IncomingMessage;
  const response = {
    destroyed: false,
    setHeader: () => {},
    writeHead: (status: number) => {
      result.status = status;
      return response;
    },
    end: (body?: string) => {
      result.body = body ?? '';
      result.ended = true;
      completed.resolve();
    },
  } as unknown as ServerResponse;
  return { request, response, result, completed: completed.promise };
}

it('validates callback state, consumes the code once, and closes the listener', async () => {
  const endpoint = await makeMcpAuthenticationIO().callback('expected-state');
  const handler = listeners.handlers[0];
  if (!handler) throw new Error('Missing callback listener');
  const foreign = message('/callback?code=foreign-code&state=foreign-state');
  handler(foreign.request, foreign.response);
  expect(foreign.result.status).toBe(400);
  const accepted = message(
    '/callback?code=synthetic-code&state=expected-state&iss=https%3A%2F%2Fissuer.example'
  );
  handler(accepted.request, accepted.response);
  expect(await endpoint.wait(new AbortController().signal)).toEqual({
    code: 'synthetic-code',
    iss: 'https://issuer.example',
  });
  const replay = message('/callback?code=second-code&state=expected-state');
  handler(replay.request, replay.response);
  expect(replay.result.status).toBe(400);
  expect(accepted.result.body).not.toContain('synthetic-code');
  await Promise.all([endpoint.close(), endpoint.close()]);
  expect(listeners.closed.has(0)).toBe(true);
});

it('settles a provider refusal without echoing provider error text', async () => {
  const endpoint = await makeMcpAuthenticationIO().callback('expected-state');
  const handler = listeners.handlers[0];
  if (!handler) throw new Error('Missing callback listener');
  const denial = message(
    '/callback?state=expected-state&error=access_denied&error_description=private-detail'
  );
  handler(denial.request, denial.response);
  await expect(endpoint.wait(new AbortController().signal)).rejects.toThrow('declined');
  expect(denial.result.body).not.toContain('private-detail');
  await endpoint.close();
});

it('rejects missing capabilities, browser origins and foreign Linux peers before accepting a relay request', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux', getuid: () => 1000 });
  const accepted = Promise.withResolvers<IncomingMessage>();
  const endpoint = await makeMcpAuthenticationIO().relay((job) => {
    accepted.resolve(job.request);
    job.response.end();
    return true;
  });
  const handler = listeners.handlers[0];
  if (!handler) throw new Error('Missing relay listener');
  for (const headers of [
    {},
    { authorization: `Bearer ${endpoint.capability}`, origin: 'https://foreign.example' },
    { authorization: 'Bearer wrong' },
    { authorization: `Bearer ${endpoint.capability}`, host: 'foreign.example' },
  ]) {
    const denied = message('/mcp', headers);
    handler(denied.request, denied.response);
    await denied.completed;
    expect(denied.result.status).toBe(403);
  }
  for (const uid of [null, 2000]) {
    listeners.peerUid = uid;
    const denied = message('/mcp', { authorization: `Bearer ${endpoint.capability}` });
    handler(denied.request, denied.response);
    await denied.completed;
    expect(denied.result.status).toBe(403);
  }
  listeners.peerUid = 1000;
  const own = message('/mcp', { authorization: `Bearer ${endpoint.capability}` });
  handler(own.request, own.response);
  expect(await accepted.promise).toBe(own.request);
  expect(own.result.status).toBe(200);
  await endpoint.close();
  expect(listeners.closed.has(0)).toBe(true);
});
