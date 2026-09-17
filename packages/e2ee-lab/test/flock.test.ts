import { afterEach, describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { bindLoroPeer, readFlock, writeFlock, writeLoro } from '../src/platform/content-session';
import { cleanupLab, labClient, launchLab } from '../src/fixtures';
import { maliciousAppendCas } from '../src/attacks';
import { FLOCK_STREAM } from '../src/platform/protocol';
import type { Entropy } from '@lody/e2ee-core';

afterEach(() => cleanupLab());

describe('lab Flock and Loro content', () => {
  it('writes encrypted Flock and Loro values that round-trip', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    await alice.readLedger();
    await writeLoro(alice, 'loro-lab');
    await writeFlock(alice, 'flock-lab');
    expect(await readFlock(alice)).toContain('flock-lab');
  });

  it('binds Loro peer ids from session entropy', async () => {
    const host = await launchLab();
    const entropy: Entropy = {
      fill(label, bytes) {
        if (label.endsWith('loro-peer-id')) bytes.fill(0x11);
        else crypto.getRandomValues(bytes);
        return bytes;
      },
    };
    const alice = await labClient({ host, account: 'alice', entropy });
    const doc = bindLoroPeer(new LoroDoc(), alice);
    expect(doc.peerId).toBe(0x1111111111111111n);
    doc.free();
  });

  it('does not import Loro ciphertext as Flock plaintext', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    await alice.readLedger();
    await writeLoro(alice, 'cross-secret');
    await writeFlock(alice, 'flock-ok');
    const loro = await alice.fetch(`/ds/${alice.genesisHex}/${'loro'}`);
    const loroBytes = new Uint8Array(await loro.arrayBuffer());
    await maliciousAppendCas({
      riverrunUrl: host.riverrunUrl,
      genesisHex: alice.genesisHex!,
      record: loroBytes,
      expectedOffset: '-1',
      stream: FLOCK_STREAM,
    });
    let flock = '';
    try {
      flock = await readFlock(alice);
    } catch {
      flock = '';
    }
    expect(flock).not.toContain('cross-secret');
  });
});
