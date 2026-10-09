/**
 * Epoch keys, envelopes and history against the
 * real Lab host, real Riverrun streams and real crypto. Races are driven by
 * deterministic fetch hooks (no sleeps).
 *
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupLab, labClient, launchLab } from '../src/fixtures';
import { exportDevice, generateDevice } from '../src/platform/device';
import { CONTROL_STREAM } from '../src/platform/protocol';
import { readLoro, writeLoro, type ContentClient } from '../src/platform/content-session';
import { commitEpochKey } from '@lody/e2ee-core/ledger';

afterEach(() => cleanupLab());

const nativeFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

function isStreamRequest(input: RequestInfo | URL, stream: string, method: string) {
  const request = input instanceof Request ? input : null;
  if (!request || request.method !== method) return false;
  return new URL(request.url).pathname.endsWith(`/${stream}`);
}

describe('epoch-key install racing rotation (Lab)', () => {
  it('keeps post-rotation writes unreadable to a revoked K0 holder', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    await alice.readLedger();
    await writeLoro(alice, 'epoch-zero');

    const laptopDevice = await generateDevice(); // will be revoked; legitimately holds K0
    const tabletDevice = await generateDevice(); // honest victim
    const probeDevice = await generateDevice(); // measures the refresh sequence
    for (const d of [laptopDevice, tabletDevice, probeDevice])
      expect((await alice.admitDevice(d, 'personal')).status).toBe('committed');

    // The laptop receives K0 honestly before it is revoked.
    const laptopFrame = await alice.deliverEpochKey(laptopDevice, 0);
    const laptop = await labClient({
      host,
      account: 'alice',
      device: await exportDevice(laptopDevice),
    });
    await laptop.adoptGenesis(alice.genesisHex!);
    await laptop.readLedger();
    await laptop.receiveEpochKey(alice.device, 0, laptopFrame);
    const k0 = laptop.epochKeys.get(0)!;
    expect(k0).toEqual(alice.epochKeys.get(0));

    const tabletFrame = await alice.deliverEpochKey(tabletDevice, 0);
    const probeFrame = await alice.deliverEpochKey(probeDevice, 0);
    expect((await alice.revokeDevice(laptopDevice.publicKey)).status).toBe('committed');

    // Probe: count control-stream GETs made by one receiveEpochKey.
    let counting = false;
    let controlGets = 0;
    const probe = await labClient({
      host,
      account: 'alice',
      device: await exportDevice(probeDevice),
      fetch: (input, init) => {
        if (counting && isStreamRequest(input, CONTROL_STREAM, 'GET')) controlGets++;
        return nativeFetch(input, init);
      },
    });
    await probe.adoptGenesis(alice.genesisHex!);
    await probe.readLedger();
    counting = true;
    await probe.receiveEpochKey(alice.device, 0, probeFrame);
    counting = false;
    expect(probe.epochKeys.get(0)).toEqual(k0);
    expect(controlGets).toBeGreaterThanOrEqual(1);

    // Victim: identical sequence; the Owner's (legitimate, required) rotation lands
    // right before the last control read, i.e. installEpochEnvelope's slot refresh.
    let armed = false;
    let seen = 0;
    let rotated: { status: string; epoch: number } | null = null;
    const tablet = await labClient({
      host,
      account: 'alice',
      device: await exportDevice(tabletDevice),
      fetch: async (input, init) => {
        if (armed && isStreamRequest(input, CONTROL_STREAM, 'GET') && ++seen === controlGets) {
          armed = false;
          rotated = await alice.publishEpoch();
        }
        return nativeFetch(input, init);
      },
    });
    await tablet.adoptGenesis(alice.genesisHex!);
    await tablet.readLedger();
    armed = true;
    await tablet.receiveEpochKey(alice.device, 0, tabletFrame).catch(() => undefined);
    expect(rotated).toEqual({ status: 'committed', epoch: 1 });

    // K0 never occupies the epoch-1 slot; the committed K1 still installs.
    const ledger = await tablet.readLedger();
    expect(ledger.state.epoch.number).toBe(1);
    expect(tablet.epochKeys.get(1)).not.toEqual(k0);
    await tablet.receiveEpochKey(alice.device, 1, await alice.deliverEpochKey(tabletDevice, 1));
    expect(await commitEpochKey(ledger.state.genesis, 1, tablet.epochKeys.get(1)!)).toEqual(
      ledger.state.epoch.keyCommitment
    );

    await writeLoro(tablet, 'post-rotation-secret');

    // The revoked laptop (K0 only) cannot read it, even given the ciphertext.
    const spy: ContentClient = {
      baseUrl: host.baseUrl,
      genesisHex: alice.genesisHex,
      device: laptopDevice,
      account: 'revoked-laptop',
      membershipId: null,
      epochKeys: new Map([
        [0, k0],
        [1, k0],
      ]),
      canWriteDocument: false,
      currentEpoch: () => 1,
      fetch: (input, init) => alice.fetch(input, init),
    };
    expect(await readLoro(spy).catch(() => '')).not.toContain('post-rotation-secret');
    expect(await readLoro(alice)).toContain('post-rotation-secret');
  });
});

describe('history recovery (Lab)', () => {
  it('ignores forged unsigned history rows and never overwrites an installed key', async () => {
    const {
      encodeRecord,
      sealHistoryPacket,
      commitEpochKey: commit,
    } = await import('@lody/e2ee-core/ledger');
    let tamper: Uint8Array | null = null;
    const alice = await labClient({
      host: await launchLab(),
      account: 'alice',
      fetch: async (input, init) => {
        const response = await nativeFetch(input, init);
        if (
          tamper === null ||
          !isStreamRequest(input, CONTROL_STREAM, 'GET') ||
          new URL((input as Request).url).searchParams.get('offset') !== '-1'
        )
          return response;
        // Malicious storage appends forged, UNSIGNED records to a full read.
        const body = new Uint8Array(await response.arrayBuffer());
        const out = new Uint8Array(body.length + tamper.length);
        out.set(body, 0);
        out.set(tamper, body.length);
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        return new Response(out, { status: response.status, headers });
      },
    });
    const host = { baseUrl: alice.baseUrl };
    await alice.createSpace();
    await alice.readLedger();
    // Revoked-later laptop legitimately learns K0..K2.
    const laptopDevice = await generateDevice();
    expect((await alice.admitDevice(laptopDevice, 'personal')).status).toBe('committed');
    expect((await alice.publishEpoch()).status).toBe('committed');
    expect((await alice.publishEpoch()).status).toBe('committed');
    const frame = await alice.deliverEpochKey(laptopDevice, 2);
    const laptop = await labClient({
      host,
      account: 'alice',
      device: await exportDevice(laptopDevice),
    });
    await laptop.adoptGenesis(alice.genesisHex!);
    await laptop.readLedger();
    await laptop.receiveEpochKey(alice.device, 2, frame);
    const known = await laptop.recoverEpochHistory();
    expect([...known.keys()].sort()).toEqual([0, 1, 2]);
    expect((await alice.revokeDevice(laptopDevice.publicKey)).status).toBe('committed');
    expect((await alice.publishEpoch()).status).toBe('committed');
    const realK1 = alice.epochKeys.get(1)!;
    expect(realK1).toEqual(known.get(1));

    // Attacker (server + laptop keys only) forges epoch-1/epoch-2 history rows.
    const genesis = (await alice.readLedger()).state.genesis;
    const fakeK1 = crypto.getRandomValues(new Uint8Array(32));
    const forge = (epoch: number, commitment: Uint8Array, packet: Uint8Array) =>
      encodeRecord(
        {
          type: 'ordinary',
          fields: {
            previousHash: new Uint8Array(32),
            signer: alice.device.publicKey,
            operation: { type: 'publishEpoch', epoch, commitment, previousEpochKey: packet },
          },
        },
        new Uint8Array(64)
      );
    const forged = [
      forge(
        1,
        await commit(genesis, 1, fakeK1),
        sealHistoryPacket(fakeK1, known.get(0)!, genesis, 1)
      ),
      forge(
        2,
        await commit(genesis, 2, known.get(2)!),
        sealHistoryPacket(known.get(2)!, fakeK1, genesis, 2)
      ),
    ];
    const framed = forged.flatMap((record) => {
      const prefix = new Uint8Array(4);
      new DataView(prefix.buffer).setUint32(0, record.length, false);
      return [prefix, record];
    });
    tamper = new Uint8Array(framed.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of framed) {
      tamper.set(part, at);
      at += part.length;
    }

    const recovered = await alice.recoverEpochHistory().catch(() => null);
    tamper = null;
    // Result recovery fails closed on the tampered read, or it yields the verified K1.
    if (recovered) expect(recovered.get(1)).toEqual(realK1);
    expect(alice.epochKeys.get(1)).toEqual(realK1);
    expect((await alice.recoverEpochHistory()).get(1)).toEqual(realK1);
  });
});
