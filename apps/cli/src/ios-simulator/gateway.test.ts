import { description, frame } from './h264.test-fixtures';
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
  hostControl: (control: SimulatorHostControl) => Promise<void> = async () => {},
  remote = false
) {
  let initializations = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith('/orientation?value=portrait')) {
      initializations++;
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
    remote,
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
    proxy,
    initializations: () => initializations,
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
  it('joins an unfinished signaling request when stopping the gateway', async () => {
    const f = await setup();
    const origin = `http://127.0.0.1:${f.gateway.port}`;
    const request = http.request(new URL(`${f.gateway.remotePath}rtc`, origin), {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        expect: '100-continue',
        'content-length': '100',
      },
    });
    const closed = new Promise<void>((resolve) => {
      request.on('error', () => {});
      request.once('close', resolve);
    });
    const continued = once(request, 'continue');
    request.flushHeaders();
    await continued;
    // The server accepted the headers, but this client never completes its body.
    cleanups.splice(cleanups.indexOf(f.gateway.close), 1);
    await f.gateway.close();
    await closed;
    expect(request.destroyed).toBe(true);
  });

  it('serves local and remote routes with independent media budgets and one control baseline', async () => {
    const f = await setup();
    const remoteEndpoint = await f.proxy.acquire({
      sessionId: 'remote-viewer' as SessionId,
      target: {
        protocol: 'http',
        host: '127.0.0.1',
        port: f.gateway.port,
        path: f.gateway.remotePath,
      },
      visualAnnotation: false,
    });
    const remoteUrl = new URL(remoteEndpoint.viewerUrl);
    expect((await fetch(remoteUrl)).status).toBe(200);
    const denied = new URL(remoteUrl);
    denied.search = '';
    expect((await fetch(denied)).status).toBe(403);
    const streamUrl = new URL('stream', remoteUrl);
    streamUrl.protocol = 'ws:';
    streamUrl.search = remoteUrl.search;
    const peers: WebSocket[] = [];
    for (const [url, bitrate] of [
      [f.stream, 4_000_000],
      [streamUrl, 600_000],
    ] as const) {
      url.searchParams.set('codec', 'h264');
      const configured = new Promise<unknown>((resolve) => {
        f.upstream.once('connection', (native) => {
          native.once('message', (data) => resolve(JSON.parse(String(data))));
        });
      });
      const client = new WebSocket(url);
      peers.push(client);
      cleanups.push(async () => {
        client.terminate();
      });
      await once(client, 'open');
      expect(await configured).toEqual({ type: 'set_bitrate', bps: bitrate });
    }
    expect(peers.map((peer) => peer.readyState)).toEqual([WebSocket.OPEN, WebSocket.OPEN]);
    expect(f.initializations()).toBe(1);
    // Closing one route's media connection leaves the other route connected.
    const closed = once(peers[1]!, 'close');
    peers[1]!.close();
    await closed;
    expect(peers[0]!.readyState).toBe(WebSocket.OPEN);
    expect(f.renewals()).toBe(0);
  });

  it('derives native scale from the bounded viewport and denies forged receiver credit', async () => {
    const f = await setup(undefined, undefined, true);
    const incoming = once(f.upstream, 'connection');
    const client = new WebSocket(f.stream);
    cleanups.push(async () => {
      client.terminate();
    });
    await once(client, 'open');
    const [native] = (await incoming) as [WebSocket];
    const configured = once(native, 'message');
    const painted = once(client, 'message');
    client.send(JSON.stringify({ type: 'stream-config', width: 300, height: 650, dpr: 1 }));
    native.send(Buffer.from([255, 216, 255, 192, 0, 11, 8, 9, 252, 4, 155, 1, 1, 17, 0]));
    expect(JSON.parse(String((await configured)[0]))).toEqual({ type: 'set_scale', scale: 4 });
    const packet = (await painted)[0] as Buffer;
    expect(packet.readUInt32BE(4)).toBe(1);
    const closed = once(client, 'close');
    client.send(JSON.stringify({ type: 'frame-ack', sequence: 2 }));
    await closed;
    expect(f.renewals()).toBe(0);
  });

  it('serves only bounded DeviceKit resources behind the existing private preview capability', async () => {
    const requests: string[] = [];
    const png = Buffer.alloc(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    png.write('IHDR', 12);
    png.writeUInt32BE(440, 16);
    png.writeUInt32BE(900, 20);
    const g = await setup((req, res) => {
      requests.push(req.url ?? '');
      if (req.url?.endsWith('/definition.json'))
        res.end(
          JSON.stringify({
            screen: {
              viewport: { width: 440, height: 900 },
              rect: { x: 20, y: 20, width: 400, height: 860 },
              clipRadius: 40,
              buttonMargins: { left: 0, right: 0, top: 0, bottom: 0 },
            },
            buttons: [],
          })
        );
      else if (req.url?.endsWith('/bezel.png')) res.end(png);
      else res.writeHead(404).end();
    });
    const asset = new URL('exterior.json', g.url);
    asset.search = g.url.search;
    const unauthorized = new URL(asset);
    unauthorized.search = '';
    expect((await fetch(unauthorized)).ok).toBe(false);
    const response = await fetch(asset);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ width: 440, height: 900, buttons: [] });
    const image = new URL('bezel.png', asset);
    image.search = asset.search;
    expect(Buffer.from(await (await fetch(image)).arrayBuffer())).toEqual(png);
    const arbitrary = new URL('definition.json', asset);
    arbitrary.search = asset.search;
    expect((await fetch(arbitrary)).status).toBe(404);
    expect(requests).toEqual([
      '/simulators/5519CB11-71C9-46D9-AEFF-73C96F1104E0/definition.json',
      '/simulators/5519CB11-71C9-46D9-AEFF-73C96F1104E0/bezel.png',
    ]);
    expect(g.renewals()).toBe(0);
    g.revoke();
    expect((await fetch(image)).status).toBe(410);
  });
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
    const received: SimulatorHostControl[] = [];
    const f = await setup(undefined, async (control) => {
      received.push(control);
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
    expect(received).toEqual([{ kind: 'button', button: 'home' }]);
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
    client.send(JSON.stringify({ type: 'stream-config', width: 400, height: 800, dpr: 1 }));
    const [native, request] = (await incoming) as [WebSocket, http.IncomingMessage];
    expect(request.url).toContain('/simulators/5519CB11-71C9-46D9-AEFF-73C96F1104E0/stream?');
    const painted = once(client, 'message');
    native.send(Buffer.from([1, 2, 3]));
    const packet = (await painted)[0] as Buffer;
    expect(packet.readUInt32BE(0)).toBe(0x4c4f4459);
    expect(packet.readUInt32BE(4)).toBe(1);
    expect(packet.subarray(8)).toEqual(Buffer.from([1, 2, 3]));
    client.send(JSON.stringify({ type: 'frame-ack', sequence: 1 }));
    expect(f.renewals()).toBe(0);
    const input = once(native, 'message');
    client.send(JSON.stringify({ type: 'touch1-down', x: 10, y: 20, width: 100, height: 200 }));
    expect(JSON.parse(String((await input)[0]))).toEqual({
      type: 'touch1-down',
      x: 10,
      y: 20,
      width: 100,
      height: 200,
    });
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
  it.each(['disconnect', 'invalid-coordinate', 'changed-finger-count'] as const)(
    'forwards paired touches and releases both on %s',
    async (reason) => {
      const f = await setup();
      const incoming = once(f.upstream, 'connection');
      const client = new WebSocket(f.stream);
      cleanups.push(async () => {
        client.terminate();
      });
      await once(client, 'open');
      const [native] = await incoming;
      const point = { x1: 10, y1: 20, x2: 80, y2: 150, width: 100, height: 200 };
      for (const type of ['touch2-down', 'touch2-move']) {
        const received = once(native, 'message');
        client.send(JSON.stringify({ ...point, type }));
        expect(JSON.parse(String((await received)[0]))).toEqual({ ...point, type });
      }
      expect(f.renewals()).toBe(2);
      const released = once(native, 'message');
      const closed = once(client, 'close');
      if (reason === 'disconnect') client.close();
      else
        client.send(
          JSON.stringify(
            reason === 'invalid-coordinate'
              ? { ...point, type: 'touch2-move', x2: 101 }
              : { type: 'touch1-move', x: 10, y: 20, width: 100, height: 200 }
          )
        );
      expect(JSON.parse(String((await released)[0]))).toEqual({ ...point, type: 'touch2-up' });
      await closed;
    }
  );
  it('forwards bottom-edge gestures and preserves their edge during disconnect cleanup', async () => {
    const f = await setup();
    const incoming = once(f.upstream, 'connection');
    const client = new WebSocket(f.stream);
    cleanups.push(async () => {
      client.terminate();
    });
    await once(client, 'open');
    client.send(JSON.stringify({ type: 'stream-config', width: 400, height: 800, dpr: 1 }));
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
    client.send(JSON.stringify({ type: 'stream-config', width: 400, height: 800, dpr: 1 }));
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
    client.send(JSON.stringify({ type: 'stream-config', width: 400, height: 800, dpr: 1 }));
    const [native] = (await incoming) as [WebSocket];
    const closed = once(client, 'close');
    f.revoke();
    native.send(Buffer.from([1]));
    await closed;
    expect((await fetch(f.url)).status).toBe(410);
  });
});

describe('H.264 gateway negotiation', () => {
  it('selects only the fixed AVCC route, forwards bounded video, and recovers without renewing the lease', async () => {
    const f = await setup(undefined, undefined, true);
    f.stream.searchParams.set('codec', 'h264');
    const incoming = once(f.upstream, 'connection');
    const client = new WebSocket(f.stream);
    cleanups.push(async () => {
      client.terminate();
    });
    const packets: Buffer[] = [];
    let painted: () => void = () => {};
    client.on('message', (data, binary) => {
      if (binary) {
        packets.push(Buffer.from(data as Buffer));
        painted();
      }
    });
    await once(client, 'open');
    const [native, request] = (await incoming) as [WebSocket, http.IncomingMessage];
    expect(request.url).toMatch(/format=avcc&version=1$/);
    const received = new Promise<void>((resolve) => {
      painted = resolve;
    });
    client.send(JSON.stringify({ type: 'stream-config', width: 300, height: 650, dpr: 1 }));
    native.send(Buffer.concat([Buffer.from([1]), description]));
    native.send(frame(0));
    await received;
    expect(packets[0]?.readUInt32BE(0)).toBe(0x4c415643);
    expect(packets[0]?.[8]).toBe(2);
    const idr = new Promise<void>((resolve) => {
      native.on('message', (data) => {
        if (JSON.parse(String(data)).type === 'force_idr') resolve();
      });
    });
    client.send(JSON.stringify({ type: 'frame-ack', sequence: 1 }));
    client.send(JSON.stringify({ type: 'keyframe-request' }));
    await idr;
    expect(f.renewals()).toBe(0);
    const closed = once(client, 'close');
    client.send(JSON.stringify({ type: 'frame-ack', sequence: 100 }));
    await closed;
  });
});
