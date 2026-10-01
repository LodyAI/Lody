import http from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createSimulatorGateway } from './gateway';
import { LocalPreviewProxyManager } from '@/preview/local-preview-proxy';
import type { SessionId } from '@lody/shared';
import type { SimulatorHostControl } from './host-controls';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  setDebug: () => {},
  child: () => logger,
  close: () => {},
};
async function setup(
  handler?: http.RequestListener,
  hostControl: (control: SimulatorHostControl) => Promise<void> = async () => {}
) {
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith('/orientation?value=portrait')) {
      res.end('{"ok":true}');
    } else if (handler) handler(req, res);
    else res.writeHead(404).end();
  });
  const upstream = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('bind');
  cleanups.push(async () => {
    for (const client of upstream.clients) client.terminate();
    upstream.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  let active = true,
    renewals = 0;
  const gateway = await createSimulatorGateway({
    operationId: 'operation',
    udid: '5519CB11-71C9-46D9-AEFF-73C96F1104E0',
    port: address.port,
    active: () => active,
    renew: () => renewals++,
    hostControl,
  });
  cleanups.push(gateway.close);
  const proxy = new LocalPreviewProxyManager({ logger });
  const endpoint = await proxy.acquire({
    sessionId: 's' as SessionId,
    target: { protocol: 'http', host: '127.0.0.1', port: gateway.port, path: gateway.path },
    visualAnnotation: false,
  });
  cleanups.push(() => proxy.closeAll('test'));
  const url = new URL(endpoint.viewerUrl);
  const stream = new URL('stream', url);
  const control = new URL('control', url);
  control.search = url.search;
  stream.protocol = 'ws:';
  stream.search = url.search;
  return {
    upstream,
    gateway,
    url,
    stream,
    control,
    renewals: () => renewals,
    revoke: () => {
      active = false;
    },
  };
}
describe('simulator media boundary', () => {
  it('serializes host controls and fences their completion after ownership is revoked', async () => {
    let began: () => void = () => {};
    let complete: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const f = await setup(undefined, async () => {
      began();
      await finished;
    });
    const request = (requestId: string) =>
      fetch(f.control, {
        method: 'POST',
        headers: { Origin: f.url.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: 'operation',
          requestId,
          control: { kind: 'text', text: 'synthetic' },
        }),
      });
    const pending = request('first');
    try {
      await started;
      expect(await (await request('second')).json()).toEqual({ success: false, error: 'busy' });
      f.revoke();
      complete();
      expect(await (await pending).json()).toEqual({ success: false, error: 'unavailable' });
      expect(f.renewals()).toBe(0);
    } finally {
      complete();
      await pending;
    }
  });

  it('authenticates private controls, binds the device and deduplicates completed request IDs', async () => {
    const received: Array<{ path?: string; body: unknown }> = [];
    const f = await setup((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        received.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      })();
    });
    const request = {
      operationId: 'operation',
      requestId: 'one',
      control: { kind: 'button', button: 'home' },
    };
    const send = (body: unknown, url = f.control, origin = f.url.origin) =>
      fetch(url, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const anonymous = new URL(f.control);
    anonymous.search = '';
    expect((await send(request, anonymous)).status).toBe(403);
    expect((await send(request, f.control, 'https://untrusted.example')).status).toBe(404);
    expect((await send({ ...request, operationId: 'other' })).status).toBe(400);
    expect(
      (await send({ ...request, control: { kind: 'install', path: '/tmp/test.app' } })).status
    ).toBe(400);
    expect(received).toEqual([]);
    expect(await (await send(request)).json()).toEqual({ success: true, rotation: 0 });
    expect(await (await send(request)).json()).toEqual({ success: true, rotation: 0 });
    expect(received).toEqual([
      {
        path: '/simulators/5519CB11-71C9-46D9-AEFF-73C96F1104E0/input',
        body: { type: 'button', button: 'home', duration: 0 },
      },
    ]);
    expect(
      await (await send({ ...request, control: { kind: 'button', button: 'lock' } })).json()
    ).toEqual({ success: false, error: 'failed' });
    expect(f.renewals()).toBe(1);
    f.revoke();
    expect((await send({ ...request, requestId: 'two' })).status).toBe(410);
    expect(received).toHaveLength(1);
  });

  it('serves fixed unannotated content behind capability auth and exposes no Baguette API', async () => {
    const { url, gateway } = await setup();
    const direct = `http://127.0.0.1:${gateway.port}${gateway.path}`;
    expect((await fetch(direct, { headers: { Origin: 'https://untrusted.example' } })).status).toBe(
      404
    );
    expect((await fetch(`http://127.0.0.1:${gateway.port}/`)).status).toBe(404);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('lody:ios-simulator:init');
    expect(html).not.toContain('data-lody');
    const denied = new URL(url);
    denied.search = '';
    expect((await fetch(denied)).status).toBe(403);
    const forbidden = new URL(url);
    forbidden.pathname = '/simulators';
    expect((await fetch(forbidden)).status).toBe(404);
  });
  it('forwards only validated touches to the bound device, never counts video as activity', async () => {
    const f = await setup();
    const incoming = once(f.upstream, 'connection');
    const client = new WebSocket(f.stream);
    cleanups.push(async () => {
      client.terminate();
    });
    await once(client, 'open');
    const [native, request] = (await incoming) as [WebSocket, http.IncomingMessage];
    expect(request.url).toContain('/simulators/5519CB11-71C9-46D9-AEFF-73C96F1104E0/stream?');
    const painted = once(client, 'message');
    native.send(Buffer.from([1, 2, 3]));
    expect((await painted)[0]).toEqual(Buffer.from([1, 2, 3]));
    expect(f.renewals()).toBe(0);
    const input = once(native, 'message');
    client.send(JSON.stringify({ type: 'touch1-down', x: 10, y: 20, width: 100, height: 200 }));
    expect(JSON.parse(String((await input)[0]))).toMatchObject({ type: 'touch1-down', x: 10 });
    expect(f.renewals()).toBe(1);
    const released = once(native, 'message');
    const closed = once(client, 'close');
    client.send(JSON.stringify({ type: 'install', path: '/tmp/evil.app' }));
    await closed;
    expect(JSON.parse(String((await released)[0]))).toMatchObject({
      type: 'touch1-up',
      x: 10,
      y: 20,
    });
  });
  it('forwards bottom-edge gestures and preserves their edge during disconnect cleanup', async () => {
    const f = await setup();
    const incoming = once(f.upstream, 'connection');
    const client = new WebSocket(f.stream);
    cleanups.push(async () => {
      client.terminate();
    });
    await once(client, 'open');
    const [native] = (await incoming) as [WebSocket];
    for (const input of [
      { type: 'touch1-down', x: 50, y: 196, width: 100, height: 200, edge: 'bottom' },
      { type: 'touch1-move', x: 50, y: 100, width: 100, height: 200, edge: 'bottom' },
      { type: 'touch1-up', x: 50, y: 80, width: 100, height: 200, edge: 'bottom' },
      { type: 'touch1-down', x: 50, y: 196, width: 100, height: 200, edge: 'bottom' },
    ]) {
      const forwarded = once(native, 'message');
      client.send(JSON.stringify(input));
      expect(JSON.parse(String((await forwarded)[0]))).toEqual(input);
    }
    const released = once(native, 'message');
    client.close();
    expect(JSON.parse(String((await released)[0]))).toEqual({
      type: 'touch1-up',
      x: 50,
      y: 196,
      width: 100,
      height: 200,
      edge: 'bottom',
    });
  });
  it.each(['outside-band', 'change-edge'])('rejects invalid edge input: %s', async (scenario) => {
    const f = await setup();
    const incoming = once(f.upstream, 'connection');
    const client = new WebSocket(f.stream);
    cleanups.push(async () => {
      client.terminate();
    });
    await once(client, 'open');
    const [native] = (await incoming) as [WebSocket];
    if (scenario === 'change-edge') {
      const down = once(native, 'message');
      client.send(
        JSON.stringify({
          type: 'touch1-down',
          x: 50,
          y: 196,
          width: 100,
          height: 200,
          edge: 'bottom',
        })
      );
      await down;
    }
    const closed = once(client, 'close');
    client.send(
      JSON.stringify(
        scenario === 'outside-band'
          ? { type: 'touch1-down', x: 50, y: 100, width: 100, height: 200, edge: 'bottom' }
          : { type: 'touch1-move', x: 50, y: 100, width: 100, height: 200 }
      )
    );
    await closed;
    expect(f.renewals()).toBe(scenario === 'change-edge' ? 1 : 0);
  });
  it('revocation rejects frames and tears down the stream', async () => {
    const f = await setup();
    const incoming = once(f.upstream, 'connection');
    const client = new WebSocket(f.stream);
    cleanups.push(async () => {
      client.terminate();
    });
    await once(client, 'open');
    const [native] = (await incoming) as [WebSocket];
    const closed = once(client, 'close');
    f.revoke();
    native.send(Buffer.from([1]));
    await closed;
    expect((await fetch(f.url)).status).toBe(410);
  });
});
