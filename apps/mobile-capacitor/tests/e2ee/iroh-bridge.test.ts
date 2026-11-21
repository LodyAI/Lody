import { expect, it, vi } from 'vitest';
import { irohPort, irohRelaysFromBuild, type NativeIrohBridge } from '../../src/e2ee/iroh-bridge';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => true },
  registerPlugin: () => ({}),
}));

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** Fake native plugin: records what crossed the bridge, replays queued replies. */
function fakeBridge(replies: (string | null)[]) {
  const crossed: { method: string; input: Record<string, unknown> }[] = [];
  const record = (method: string) => async (input: Record<string, unknown>) => {
    crossed.push({ method, input });
    if (method === 'open') return { handle: 'endpoint-1' };
    if (method === 'call') return { call: 'call-1' };
    if (method === 'hasConnection') return { value: true };
    if (method === 'nextReply') return { reply: replies.shift() ?? null };
    return {};
  };
  const bridge = Object.fromEntries(
    ['open', 'hasConnection', 'warm', 'call', 'nextReply', 'cancel', 'close'].map((m) => [
      m,
      record(m),
    ])
  ) as unknown as NativeIrohBridge;
  return { bridge, crossed };
}

it('reads relays only from a complete https build configuration', () => {
  expect(irohRelaysFromBuild({})).toBeUndefined();
  expect(irohRelaysFromBuild({ VITE_IROH_RELAYS: 'http://relay.example' })).toBeUndefined();
  expect(
    irohRelaysFromBuild({
      VITE_IROH_RELAYS: ' https://a.example/ , https://b.example/ ',
      VITE_IROH_RELAY_TOKEN: ' t ',
    })
  ).toEqual({ urls: ['https://a.example/', 'https://b.example/'], token: 't' });
  expect(
    irohRelaysFromBuild({
      VITE_IROH_RELAYS: 'https://a.example/',
      VITE_IROH_PROXY_URL: 'http://127.0.0.1:1087',
    })
  ).toEqual({ urls: ['https://a.example/'], proxyUrl: 'http://127.0.0.1:1087' });
  expect(
    irohRelaysFromBuild({
      VITE_IROH_RELAYS: 'https://a.example/',
      VITE_IROH_PROXY_URL: 'socks5://x',
    })
  ).toBeUndefined();
});

it('hands the seed over once and carries opaque frames both ways', async () => {
  const reply = new TextEncoder().encode('{"id":"r1","frame":"00"}');
  const { bridge, crossed } = fakeBridge([b64(reply)]);
  const seed = new Uint8Array(32).fill(7);
  const endpoint = await irohPort(bridge, { urls: ['https://a.example/'] }).open(seed);

  expect(crossed).toEqual([
    { method: 'open', input: { seed: b64(seed), relays: ['https://a.example/'] } },
  ]);
  expect(await endpoint.hasConnection('ab')).toBe(true);

  const request = new TextEncoder().encode('{"id":"r1","frame":"ff"}');
  const call = await endpoint.call('ab', request, 3000);
  expect(await call.nextReply()).toEqual(reply);
  expect(await call.nextReply()).toBeNull();
  await endpoint.close();

  const sent = crossed.find((c) => c.method === 'call')!.input;
  expect(Buffer.from(sent.request as string, 'base64')).toEqual(Buffer.from(request));
  // The seed crossed the bridge exactly once, in `open`.
  expect(crossed.filter((c) => JSON.stringify(c.input).includes(b64(seed)))).toHaveLength(1);
});

it('rejects a malformed native handle instead of routing to it', async () => {
  const { bridge } = fakeBridge([]);
  bridge.open = async () => ({ handle: '../../x' });
  await expect(
    irohPort(bridge, { urls: ['https://a.example/'] }).open(new Uint8Array(32))
  ).rejects.toThrow('iroh_reply_invalid');
});

it('reads only the existing selected path and tolerates an older plugin', async () => {
  const { bridge } = fakeBridge([]);
  const endpoint = await irohPort(bridge, { urls: ['https://a.example/'] }).open(
    new Uint8Array(32)
  );
  expect(await endpoint.connectionPath!('ab')).toBe('none');
  for (const value of ['direct', 'relay', 'none', 'untrusted-address']) {
    bridge.connectionPath = async () => ({ value });
    expect(await endpoint.connectionPath!('ab')).toBe(
      value === 'direct' || value === 'relay' ? value : 'none'
    );
  }
  await endpoint.close();
});
