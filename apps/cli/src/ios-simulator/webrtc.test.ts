import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { RTCPeerConnection } from 'werift';
import { WebSocketServer } from 'ws';
import { createSimulatorRtcPeer } from './webrtc';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

it('carries fragmented frames and input over real DTLS/SCTP, then revokes the connection', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('bind');
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = new RTCPeerConnection({
    iceServers: [],
    iceAdditionalHostAddresses: ['127.0.0.1'],
  });
  cleanup.push(() => client.close());
  const media = client.createDataChannel('media', { ordered: true });
  const control = client.createDataChannel('control', { ordered: true });
  const ready = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  let bytes = 0;
  media.onMessage.subscribe((message) => {
    if (!Buffer.isBuffer(message)) throw Error('binary expected');
    expect(message.length).toBeLessThanOrEqual(16384);
    expect(message.readUInt32BE(4)).toBe(bytes);
    const part = message.subarray(8);
    bytes += part.length;
    chunks.push(part);
    if (bytes === message.readUInt32BE(0)) complete.resolve(Buffer.concat(chunks));
  });
  control.onMessage.subscribe((message) => {
    if (typeof message === 'string' && JSON.parse(message).type === 'rtc-ready') ready.resolve();
  });
  await client.setLocalDescription(await client.createOffer());
  const abort = new AbortController();
  const closed = Promise.withResolvers<void>();
  const connected = once(wss, 'connection');
  const peer = await createSimulatorRtcPeer({
    sdp: client.localDescription?.sdp ?? '',
    iceServers: [],
    streamUrl: `ws://127.0.0.1:${address.port}/stream`,
    origin: `http://127.0.0.1:${address.port}`,
    signal: abort.signal,
    active: () => !abort.signal.aborted,
    control: async () => ({ success: false, error: 'unavailable' }),
    onClose: () => closed.resolve(),
  });
  cleanup.push(peer.close);
  await client.setRemoteDescription({ type: 'answer', sdp: peer.sdp });
  await ready.promise;
  const [upstream] = await connected;
  const input = once(upstream, 'message');
  control.send(JSON.stringify({ type: 'heartbeat' }));
  const [received] = await input;
  expect(received.toString()).toBe('{"type":"heartbeat"}');
  const frame = Buffer.alloc(200_000, 0x42);
  upstream.send(frame);
  expect(await complete.promise).toEqual(frame);
  const upstreamClosed = once(upstream, 'close');
  abort.abort();
  await closed.promise;
  await upstreamClosed;
  expect(wss.clients.size).toBe(0);
});

it.each(['tcp', 'tls'] as const)(
  'joins a cancelled pending TURN %s connection without leaking its socket',
  async (transport) => {
    // Deliberately accept but never complete TLS / answer TURN allocation. The
    // explicit first data event puts cancellation inside the pending handshake.
    const relay = createTcpServer();
    const accepted = once(relay, 'connection');
    relay.listen(0, '127.0.0.1');
    await once(relay, 'listening');
    const address = relay.address();
    if (!address || typeof address === 'string') throw Error('bind');
    cleanup.push(async () => {
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    });
    const browser = new RTCPeerConnection({ iceServers: [] });
    browser.createDataChannel('media', { ordered: true });
    browser.createDataChannel('control', { ordered: true });
    cleanup.push(() => browser.close());
    const offer = await browser.createOffer();
    const abort = new AbortController();
    const closed = Promise.withResolvers<void>();
    const peer = createSimulatorRtcPeer({
      sdp: offer.sdp,
      iceServers: [
        {
          urls: [
            `${transport === 'tls' ? 'turns' : 'turn'}:127.0.0.1:${address.port}?transport=tcp`,
          ],
          username: 'synthetic-user',
          credential: 'synthetic-password',
        },
      ],
      streamUrl: 'ws://127.0.0.1:1/unused',
      origin: 'http://127.0.0.1:1',
      signal: abort.signal,
      active: () => !abort.signal.aborted,
      control: async () => ({ success: false, error: 'unavailable' }),
      onClose: closed.resolve,
    });
    const rejected = expect(peer).rejects.toThrow('RTC cancelled');
    const [socket] = await accepted;
    cleanup.push(async () => {
      socket.destroy();
      abort.abort();
      await peer.catch(() => {});
    });
    const disconnected = once(socket, 'close');
    await once(socket, 'data');
    abort.abort();
    await closed.promise;
    await rejected;
    await disconnected;
    expect(socket.destroyed).toBe(true);
  }
);
