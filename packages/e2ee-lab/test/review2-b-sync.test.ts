// Review round 2 (R2-B): ledger/client sync and local persistence under a malicious
// or faulty Riverrun, executed against the real Lab host and sqlite Riverrun.
// Tests assert the secure/Spec behaviour; a failing test is a finding.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { StreamsClient } from '@loro-dev/streams-client';
import {
  encodeSignedRecord,
  possessionSigningBytes,
  signingBytesForBody,
} from '@lody/e2ee-core/ledger';
import { SqliteLedgerStore } from '@lody/e2ee-core/ledger-node';
import { cleanupLab, labClient, launchLab } from '../src/fixtures';
import { maliciousAppendCas, riverrunNextOffset } from '../src/attacks';
import { exportDevice, generateDevice, type DemoDevice } from '../src/platform/device';
import { fromHex, toHex } from '../src/platform/bytes';
import { CONTROL_STREAM } from '../src/platform/protocol';
import type { HonestClient } from '../src/actors';

afterEach(() => cleanupLab());

type Client = HonestClient;

async function journal(client: Client) {
  const store = new SqliteLedgerStore(join(client.clientDir, 'ledger.sqlite'), {
    createFile: false,
    initializeSchema: false,
  });
  return Effect.runPromise(store.exclusive((tx) => tx.load));
}

function rr(url: string) {
  return url.replace(/\/$/, '');
}

function unframe(body: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let at = 0;
  while (at < body.length) {
    const n = view.getUint32(at, false);
    out.push(body.slice(at + 4, at + 4 + n));
    at += 4 + n;
  }
  return out;
}

async function riverrunRecords(riverrunUrl: string, genesisHex: string, stream = CONTROL_STREAM) {
  const response = await fetch(`${rr(riverrunUrl)}/ds/${genesisHex}/${stream}?offset=-1`);
  return unframe(new Uint8Array(await response.arrayBuffer()));
}

async function signAdmit(signer: Client, target: DemoDevice) {
  const ledger = await signer.readLedger();
  const actor = ledger.state.devices.get(toHex(signer.device.publicKey))!;
  const proposal = ledger.prepare(
    {
      type: 'admitDevice',
      kind: 'personal',
      signingPublicKey: target.publicKey,
      encryptionPublicKey: target.enc,
      possessionSignature: await target.sign(
        possessionSigningBytes({
          genesis: fromHex(signer.genesisHex!),
          targetMembershipId: actor.membershipId,
          signingPublicKey: target.publicKey,
          encryptionPublicKey: target.enc,
          kind: 'personal',
        })
      ),
    },
    signer.device.publicKey
  );
  return encodeSignedRecord(
    proposal.bodyBytes,
    await signer.device.sign(signingBytesForBody(proposal.bodyBytes))
  );
}

/** Owner Alice plus a second personal device (same account) that also manages. */
async function aliceWithTablet() {
  const host = await launchLab();
  const alice = await labClient({ host, account: 'alice' });
  await alice.createSpace();
  const tabletKeys = await generateDevice();
  expect((await alice.admitDevice(tabletKeys, 'personal')).status).toBe('committed');
  const tablet = await labClient({
    host,
    account: 'alice',
    device: await exportDevice(tabletKeys),
  });
  await tablet.adoptGenesis(alice.genesisHex!);
  await tablet.readLedger();
  return { host, alice, tablet };
}

/** Malicious server: control reads come straight from Riverrun, not the verifying gateway. */
function directControlReads(client: Client, riverrunUrl: string, stream = CONTROL_STREAM) {
  const orig = client.fetch.bind(client);
  client.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method === 'GET' && url.includes(`/${CONTROL_STREAM}?`)) {
      const u = new URL(url);
      const g = u.pathname.split('/')[2];
      return fetch(`${rr(riverrunUrl)}/ds/${g}/${stream}${u.search}`);
    }
    return orig(input, init);
  };
}

describe('R2-B replayed control record at a later Riverrun offset', () => {
  it('honest client rejects a duplicated committed record instead of skipping it', async () => {
    const { host, alice } = await aliceWithTablet();
    const before = await journal(alice);
    const committed = before!.records[1]!;
    // Malicious Riverrun re-appends the already-committed admitDevice bytes.
    const landed = await maliciousAppendCas({
      riverrunUrl: host.riverrunUrl,
      genesisHex: alice.genesisHex!,
      record: committed,
    });
    expect(landed.ok).toBe(true);
    // The honest gateway's strict verifyLedger refuses the stream (SAFE, host side).
    await expect(alice.admitDevice(await generateDevice(), 'personal')).rejects.toThrow();
    await expect(alice.readLedger()).rejects.toThrow();
    // Malicious server: it also serves reads (bypass the gateway's strict re-verify).
    directControlReads(alice, host.riverrunUrl);
    // Client side: AGENTS "duplicate known hashes fail closed without cursor advance";
    // Spec §6.2.5: a broken history must not be reported as up to date.
    await expect(alice.readLedger()).rejects.toThrow();
    expect((await journal(alice))!.offset).toBe(before!.offset);
  });
});

describe('R2-B per-client fork and rollback', () => {
  it('SAFE: independent comparison reveals a same-length fork; forked device keeps exact pending', async () => {
    const { host, alice, tablet } = await aliceWithTablet();
    const g = alice.genesisHex!;
    const prefix = await riverrunRecords(host.riverrunUrl, g);
    // Build a forked control stream: same prefix, then a different valid record.
    const forkName = 'control-fork';
    const created = await new StreamsClient({
      url: `${rr(host.riverrunUrl)}/ds/${g}/${forkName}`,
      retry: { maxAttempts: 0 },
    }).create({ contentType: 'application/octet-stream' });
    expect(created.ok).toBe(true);
    for (const record of prefix) {
      expect(
        (
          await maliciousAppendCas({
            riverrunUrl: host.riverrunUrl,
            genesisHex: g,
            record,
            stream: forkName,
          })
        ).ok
      ).toBe(true);
    }
    const forkRecord = await signAdmit(alice, await generateDevice());
    expect(
      (
        await maliciousAppendCas({
          riverrunUrl: host.riverrunUrl,
          genesisHex: g,
          record: forkRecord,
          stream: forkName,
        })
      ).ok
    ).toBe(true);
    // Real stream: Alice commits a different record at the same position.
    expect((await alice.admitDevice(await generateDevice(), 'personal')).status).toBe('committed');

    // Tablet's control reads are served from the fork (per-client view).
    const orig = tablet.fetch.bind(tablet);
    tablet.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method === 'GET' && url.includes(`/ds/${g}/${CONTROL_STREAM}?`)) {
        const q = url.slice(url.indexOf('?'));
        return fetch(`${rr(host.riverrunUrl)}/ds/${g}/${forkName}${q}`);
      }
      return orig(input, init);
    };
    const tabletView = await tablet.readLedger();
    const aliceView = await alice.readLedger();
    expect(tabletView.length).toBe(aliceView.length);
    expect(toHex(tabletView.head)).not.toBe(toHex(aliceView.head));
    const compared = await alice.compareIndependent(await tablet.exportNote());
    expect(compared.kind).toBe('conflict');

    // Forked device submits: honest host rejects (wrong parent); status stays unknown,
    // exact pending bytes persist and resume retries them without re-signing.
    const status = await tablet.admitDevice(await generateDevice(), 'personal');
    expect(status.status).toBe('unknown');
    const pending = (await journal(tablet))!.pending!;
    expect(pending).not.toBeNull();
    const resumed = await tablet.resume();
    expect(resumed.status).toBe('unknown');
    expect(toHex((await journal(tablet))!.pending!)).toBe(toHex(pending));
    const real = await riverrunRecords(host.riverrunUrl, g);
    expect(real.some((r) => toHex(r) === toHex(pending))).toBe(false);
  });

  async function rollbackSetup() {
    const { host, alice, tablet } = await aliceWithTablet();
    const g = alice.genesisHex!;
    const older = await riverrunRecords(host.riverrunUrl, g);
    const forkName = 'control-old';
    await new StreamsClient({
      url: `${rr(host.riverrunUrl)}/ds/${g}/${forkName}`,
      retry: { maxAttempts: 0 },
    }).create({ contentType: 'application/octet-stream' });
    for (const record of older)
      await maliciousAppendCas({
        riverrunUrl: host.riverrunUrl,
        genesisHex: g,
        record,
        stream: forkName,
      });
    expect((await alice.admitDevice(await generateDevice(), 'personal')).status).toBe('committed');
    const seen = await tablet.readLedger();
    const offset = (await journal(tablet))!.offset;
    const orig = tablet.fetch.bind(tablet);
    tablet.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method === 'GET' && url.includes(`/ds/${g}/${CONTROL_STREAM}?`)) {
        // Rollback: every read is answered with the old, shorter stream from its start.
        return fetch(`${rr(host.riverrunUrl)}/ds/${g}/${forkName}?offset=-1`);
      }
      return orig(input, init);
    };
    const outcome = await tablet.readLedger().then(
      (l) => ({ ok: true as const, length: l.length, head: toHex(l.head) }),
      (e: unknown) => ({ ok: false as const, error: String(e) })
    );
    return { tablet, seen, offset, outcome };
  }

  it('SAFE: a rolled-back (older) stream never regresses the verified local view', async () => {
    const { tablet, seen, outcome } = await rollbackSetup();
    if (outcome.ok) {
      expect(outcome.length).toBe(seen.length);
      expect(outcome.head).toBe(toHex(seen.head));
    }
    expect((await journal(tablet))!.records).toHaveLength(seen.length);
  });

  it('refuses a rollback page instead of rewinding the persisted cursor', async () => {
    const { tablet, offset, outcome } = await rollbackSetup();
    // Old known records replayed at the client's cursor are invalid data (Spec §6.2.5);
    // the cursor (future CAS expected offset) must not move to the server's older tail.
    expect(outcome.ok).toBe(false);
    expect((await journal(tablet))!.offset).toBe(offset);
  });
});

/** Rewrites control GET responses. `mutate` receives the real body and headers. */
function hookControlReads(
  client: Client,
  mutate: (
    body: Uint8Array,
    offset: string,
    next: string,
    upToDate: boolean
  ) => Response | undefined
) {
  const orig = client.fetch.bind(client);
  client.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method !== 'GET' || !url.includes(`/${CONTROL_STREAM}?`)) return orig(input, init);
    const offset = new URL(url).searchParams.get('offset') ?? '-1';
    const response = await orig(input, init);
    if (!response.ok) return response;
    const body = new Uint8Array(await response.arrayBuffer());
    const next = response.headers.get('Stream-Next-Offset')!;
    const upToDate = response.headers.get('Stream-Up-To-Date') === 'true';
    return (
      mutate(body, offset, next, upToDate) ??
      new Response(body.byteLength === 0 ? null : body, {
        status: response.status,
        headers: response.headers,
      })
    );
  };
}

function page(body: Uint8Array, next: string, upToDate: boolean) {
  return new Response(body.byteLength === 0 ? null : new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Stream-Next-Offset': next,
      'Stream-Up-To-Date': String(upToDate),
    },
  });
}

describe('R2-B split / truncated / junk frames', () => {
  it('SAFE: a frame split across HTTP pages is checkpointed only at the real boundary', async () => {
    const { host, alice } = await aliceWithTablet();
    await alice.admitDevice(await generateDevice(), 'personal');
    const reader = await labClient({
      host,
      account: 'alice',
      device: await exportDevice(alice.device),
    });
    await reader.adoptGenesis(alice.genesisHex!);
    const rest = new Map<string, { body: Uint8Array; next: string; upToDate: boolean }>();
    const seenOffsets: string[] = [];
    const orig = reader.fetch.bind(reader);
    reader.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method === 'GET' && url.includes(`/${CONTROL_STREAM}?`)) {
        const offset = new URL(url).searchParams.get('offset') ?? '-1';
        seenOffsets.push(offset);
        const held = rest.get(offset);
        if (held) return page(held.body, held.next, held.upToDate);
      }
      const response = await orig(input, init);
      if (method !== 'GET' || !url.includes(`/${CONTROL_STREAM}?`) || !response.ok) return response;
      const offset = new URL(url).searchParams.get('offset') ?? '-1';
      const body = new Uint8Array(await response.arrayBuffer());
      const next = response.headers.get('Stream-Next-Offset')!;
      const upToDate = response.headers.get('Stream-Up-To-Date') === 'true';
      if (body.length < 10) return page(body, next, upToDate);
      // Split mid-frame (inside the first length prefix + a few bytes).
      const cut = 6;
      const fake = `split-${offset}`;
      rest.set(fake, { body: body.slice(cut), next, upToDate });
      return page(body.slice(0, cut), fake, false);
    };
    const ledger = await reader.readLedger();
    expect(ledger.length).toBe((await alice.readLedger()).length);
    expect(seenOffsets.some((o) => o.startsWith('split-'))).toBe(true);
    const tail = await riverrunNextOffset(host.riverrunUrl, alice.genesisHex!);
    expect((await journal(reader))!.offset).toBe(tail);
  });

  for (const [name, mutate] of [
    ['truncated final frame marked up-to-date', (b: Uint8Array) => b.slice(0, b.length - 3)],
    [
      'trailing partial length prefix marked up-to-date',
      (b: Uint8Array) => {
        const out = new Uint8Array(b.length + 6);
        out.set(b);
        out.set([0, 0, 0, 9, 1, 2], b.length);
        return out;
      },
    ],
    [
      'complete junk frame after valid records',
      (b: Uint8Array) => {
        const out = new Uint8Array(b.length + 8);
        out.set(b);
        out.set([0, 0, 0, 4, 0xde, 0xad, 0xbe, 0xef], b.length);
        return out;
      },
    ],
  ] as const) {
    it(`SAFE: ${name} fails closed without cursor advance`, async () => {
      const { alice } = await aliceWithTablet();
      await alice.admitDevice(await generateDevice(), 'personal');
      const reader = await labClient({
        host: { baseUrl: alice.baseUrl },
        account: 'alice',
        device: await exportDevice(alice.device),
      });
      await reader.adoptGenesis(alice.genesisHex!);
      const known = (await reader.readLedger()).length;
      const offset = (await journal(reader))!.offset;
      await alice.admitDevice(await generateDevice(), 'personal');
      hookControlReads(reader, (body, _offset, next, upToDate) =>
        body.length > 0 ? page(mutate(body), next, upToDate) : undefined
      );
      await expect(reader.readLedger()).rejects.toThrow();
      const stored = (await journal(reader))!;
      expect(stored.offset).toBe(offset);
      expect(stored.records).toHaveLength(known);
    });
  }
});

describe('R2-B lost / false ACK and restart', () => {
  it('SAFE: false control ACK stays unknown; a restarted process resumes the exact bytes', async () => {
    const { host, alice } = await aliceWithTablet();
    const orig = alice.fetch.bind(alice);
    let forge = true;
    alice.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (forge && init?.method === 'POST' && url.includes(`/${CONTROL_STREAM}/append-cas`)) {
        return new Response(null, { status: 204, headers: { 'Stream-Next-Offset': 'forged' } });
      }
      return orig(input, init);
    };
    const target = await generateDevice();
    expect((await alice.admitDevice(target, 'personal')).status).toBe('unknown');
    const pending = (await journal(alice))!.pending!;
    expect(pending).not.toBeNull();
    forge = false;
    // A different command must not overwrite or re-sign the pending bytes.
    await expect(alice.admitDevice(await generateDevice(), 'personal')).rejects.toThrow();
    const deviceJson = await exportDevice(alice.device);
    const g = alice.genesisHex!;
    const dir = alice.clientDir;
    await alice.close();
    const restarted = await labClient({
      host,
      account: 'alice',
      device: deviceJson,
      clientDir: dir,
    });
    await restarted.adoptGenesis(g);
    expect((await restarted.resume()).status).toBe('committed');
    const real = await riverrunRecords(host.riverrunUrl, g);
    expect(toHex(real[real.length - 1]!)).toBe(toHex(pending));
    expect((await journal(restarted))!.pending).toBeNull();
  });

  it('SAFE: lost ACK (host drops the response after commit) is observed by read-back', async () => {
    const { host, alice } = await aliceWithTablet();
    host.setFailpoint('drop-control-ack');
    const outcome = await alice.admitDevice(await generateDevice(), 'personal');
    host.setFailpoint('none');
    expect(outcome.status).toBe('committed');
    const count = (await riverrunRecords(host.riverrunUrl, alice.genesisHex!)).length;
    expect((await alice.readLedger()).length).toBe(count + 1);
  });
});

describe('R2-B replayed epoch envelope after rotation', () => {
  it('SAFE: an old-epoch envelope cannot be installed into the rotated epoch slot', async () => {
    const { alice, tablet } = await aliceWithTablet();
    const f0 = await alice.deliverEpochKey(tablet.device, 0);
    expect((await alice.publishEpoch()).status).toBe('committed');
    await tablet.readLedger();
    expect(tablet.currentEpoch()).toBe(1);
    await expect(tablet.receiveEpochKey(alice.device, 1, f0)).rejects.toBeDefined();
    await expect(tablet.receiveEpochKey(alice.device, 0, f0)).rejects.toBeDefined();
    expect(tablet.epochKeys.has(1)).toBe(false);
    const keyring = JSON.parse(readFileSync(join(tablet.clientDir, 'epochs.json'), 'utf8'));
    expect(keyring).toEqual([]);
  });
});

describe('R2-B corrupt or foreign local files fail closed', () => {
  it('SAFE: corrupt journal is not reinitialized', async () => {
    const { alice } = await aliceWithTablet();
    const path = join(alice.clientDir, 'ledger.sqlite');
    const junk = new Uint8Array(4096).fill(0x41);
    writeFileSync(path, junk);
    await alice.reauth();
    await expect(alice.readLedger()).rejects.toThrow();
    expect(new Uint8Array(readFileSync(path))).toEqual(junk);
  });

  it('SAFE: a foreign Org journal is refused and left untouched', async () => {
    const { host, alice } = await aliceWithTablet();
    const other = await labClient({ host, account: 'mallory' });
    await other.createSpace();
    await other.readLedger();
    const path = join(alice.clientDir, 'ledger.sqlite');
    copyFileSync(join(other.clientDir, 'ledger.sqlite'), path);
    const before = readFileSync(path);
    await alice.reauth();
    await expect(alice.readLedger()).rejects.toThrow();
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('SAFE: corrupt key outbox and keyring are not reinitialized', async () => {
    const { alice, tablet } = await aliceWithTablet();
    await alice.deliverEpochKey(tablet.device, 0);
    const outbox = join(alice.clientDir, 'key-outbox.sqlite');
    writeFileSync(outbox, new Uint8Array(4096).fill(0x42));
    const other = await generateDevice();
    expect((await alice.admitDevice(other, 'personal')).status).toBe('committed');
    await expect(alice.deliverEpochKey(other, 0)).rejects.toBeDefined();
    expect(new Uint8Array(readFileSync(outbox)).every((b) => b === 0x42)).toBe(true);

    const keyring = join(tablet.clientDir, 'epochs.json');
    writeFileSync(keyring, 'not json');
    const frames = await tablet.readKeyFrames();
    await expect(tablet.receiveEpochKey(alice.device, 0, frames[0]!)).rejects.toBeDefined();
    expect(readFileSync(keyring, 'utf8')).toBe('not json');
  });
});
