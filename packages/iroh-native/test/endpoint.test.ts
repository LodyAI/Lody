import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { developmentNativePath, loadError, loadIrohNative, type IrohEndpoint } from '../index.js';

// Built by `pnpm --filter @lody/iroh-native build`. Without a module the suite
// skips locally; LODY_IROH_REQUIRE=1 (CI) turns a missing or unloadable module
// into a failure instead of a silent skip.
const native = loadIrohNative(developmentNativePath());
if (process.env.LODY_IROH_REQUIRE === '1' && !native)
  throw new Error(`iroh native module unavailable: ${loadError(developmentNativePath())}`);
const opened: IrohEndpoint[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((endpoint) => endpoint.close()));
});
const open = async (accept: boolean, seed = randomBytes(32)) => {
  const endpoint = await native!.openEndpoint(seed, { relayUrls: [], accept, portmapper: false });
  opened.push(endpoint);
  return endpoint;
};

describe.skipIf(!native)('@lody/iroh-native', () => {
  it('wipes the seed and derives the EndpointId from it', async () => {
    const seed = Buffer.from(randomBytes(32));
    const endpoint = await open(false, seed);
    expect(seed.equals(Buffer.alloc(32))).toBe(true);
    expect(endpoint.endpointId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries one request and every reply between two devices', async () => {
    const listener = await open(true);
    const dialer = await open(false);
    const served = (async () => {
      const request = await listener.nextRequest();
      if (!request) throw new Error('no request');
      await request.reply(Buffer.from(`ack:${request.body.toString()}`));
      await request.reply(Buffer.from('done'));
      await request.finish();
      return request.remoteEndpointId;
    })();
    const target = { endpointId: listener.endpointId, directAddrs: listener.directAddrs() };
    expect(await dialer.hasConnection(listener.endpointId)).toBe(false);
    const call = await dialer.call(target, Buffer.from('frame'), 10_000);
    const replies: string[] = [];
    for (let reply = await call.nextReply(); reply; reply = await call.nextReply())
      replies.push(reply.toString());
    expect(replies).toEqual(['ack:frame', 'done']);
    expect(await served).toBe(dialer.endpointId);
    expect(await dialer.hasConnection(listener.endpointId)).toBe(true);
  });

  it('refuses a second live endpoint for the same device key', async () => {
    const seed = randomBytes(32);
    await open(false, Buffer.from(seed));
    await expect(open(false, Buffer.from(seed))).rejects.toThrow(/iroh_key_in_use/);
  });

  it('rejects a seed of the wrong length and still wipes it', async () => {
    const seed = Buffer.from(randomBytes(31));
    await expect(native!.openEndpoint(seed, { relayUrls: [], accept: false })).rejects.toThrow(
      /iroh_invalid_key/
    );
    expect(seed.equals(Buffer.alloc(31))).toBe(true);
  });

  it('ends nextRequest with null when the endpoint closes', async () => {
    const listener = await open(true);
    const pending = listener.nextRequest();
    await listener.close();
    expect(await pending).toBeNull();
  });
});
