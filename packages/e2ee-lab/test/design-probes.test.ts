import { afterEach, describe, expect, it } from 'vitest';
import {
  canSendEpoch,
  encodeSignedRecord,
  joinRequestSigningBytes,
  sealEpochEnvelope,
  signingBytesForBody,
} from '@lody/e2ee-core/ledger';
import { createAttackLab, inspectClient } from '../src/attack-lab';
import { maliciousAppendCas } from '../src/attacks';
import { composeIntegrity, judgeClaim, judgeUnauthorizedContent } from '../src/judge';
import { readFlock, readLoro, writeFlock, writeLoro } from '../src/platform/content-session';
import { exportDevice, generateDevice, possessionProof } from '../src/platform/device';
import { fromHex, toHex } from '../src/platform/bytes';
import { CONTROL_STREAM, FLOCK_STREAM, KEYS_STREAM, LORO_STREAM } from '../src/platform/protocol';
import { cleanupLab, labClient, launchLab } from '../src/fixtures';
import { LabRuntime } from '../src/runtime';

afterEach(() => cleanupLab());

describe('effective judge composition', () => {
  it('flags forged-accepted claims only when the journal accepted bad records', () => {
    expect(judgeClaim({ kind: 'forged-accepted', unverifiedAccepted: 0 })).toBe('pass');
    expect(judgeClaim({ kind: 'forged-accepted', unverifiedAccepted: 2 })).toBe('violation');
    expect(judgeClaim({ kind: 'forged-accepted' })).toBe('harness-error');
  });

  it('reports unauthorized content as outside-model, not a silent pass', () => {
    expect(judgeUnauthorizedContent({ observed: true, acceptedUnauthorizedWriter: true })).toBe(
      'outside-model'
    );
    expect(
      composeIntegrity({
        observed: true,
        acceptedUnauthorized: false,
        unauthorizedContentAccepted: true,
      })
    ).toBe('outside-model');
  });
});

describe('design probes: binding, host cache, guest content', () => {
  it('rejects genesis responses that do not hash to the URL id', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    await bob.createSpace();
    const aliceGenesis = alice.genesisHex!;
    const bobGenesisBytes = bob.genesis!;
    // Intercept Alice's genesis GET with Bob's bytes while keeping Alice's hex.
    const orig = bob.fetch.bind(bob);
    bob.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes(`/v1/spaces/${aliceGenesis}/genesis`)) {
        return new Response(JSON.stringify({ genesis: toHex(bobGenesisBytes) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return orig(input, init);
    };
    await expect(bob.adoptGenesis(aliceGenesis)).rejects.toThrow('genesis-binding-mismatch');
  });

  it('refreshes host ledger so a Riverrun-only revoke blocks content writes', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    await alice.readLedger();
    const tablet = await generateDevice();
    expect((await alice.admitDevice(tablet, 'personal', false)).status).toBe('committed');
    await alice.deliverEpochKey(tablet, 0);
    const writer = await labClient({
      host,
      account: 'alice',
      device: await exportDevice(tablet),
    });
    await writer.adoptGenesis(alice.genesisHex!);
    await writer.readLedger();
    const frames = await writer.readKeyFrames();
    await writer.receiveEpochKey(alice.device, 0, frames[0]!);
    await writeLoro(writer, 'before-riverrun-revoke');

    const ledger = await alice.readLedger();
    const proposal = ledger.prepare(
      { type: 'revokeDevice', target: tablet.publicKey },
      alice.device.publicKey
    );
    const record = encodeSignedRecord(
      proposal.bodyBytes,
      await alice.device.sign(signingBytesForBody(proposal.bodyBytes))
    );
    const landed = await maliciousAppendCas({
      riverrunUrl: host.riverrunUrl,
      genesisHex: alice.genesisHex!,
      record,
    });
    expect(landed.ok).toBe(true);
    // Host must re-read Riverrun; sticky cache would still authorize the tablet.
    await expect(writeLoro(writer, 'after-riverrun-revoke')).rejects.toThrow();
  });

  it('detects guest-authored content landed via malicious Riverrun as outside-model', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    const bob = await labClient({ host, account: 'bob', runtime });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(join, 'guest')).status).toBe('committed');
    await bob.readLedger();
    expect(bob.canWriteDocument).toBe(false);
    await alice.deliverEpochKey(bob.device, 0);
    const keyFrames = await bob.readKeyFrames();
    await bob.receiveEpochKey(alice.device, 0, keyFrames[0]!);

    // Malicious guest client: ignore local write policy and append straight to Riverrun.
    bob.prepareWrite = async () => undefined;
    bob.canWriteDocument = true;
    const orig = bob.fetch.bind(bob);
    bob.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes(`/${LORO_STREAM}`) && init?.method === 'POST') {
        const dest = url.replace(host.baseUrl, host.riverrunUrl.replace(/\/$/, ''));
        return fetch(dest, init);
      }
      return orig(input, init);
    };
    await writeLoro(bob, 'guest-injected-pwn');
    await expect(readLoro(alice)).resolves.toContain('guest-injected-pwn');

    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'hidden-none',
      genesisHex: alice.genesisHex,
      inspectHonest: inspectClient(alice, host),
    });
    const report = await lab.finish();
    expect(report.integrity).toBe('outside-model');
    expect(report.detectability).toBe('outside-model');
  });

  it('does not let a logged-in outsider read another org’s streams', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const outsider = await labClient({ host, account: 'outsider' });
    await alice.createSpace();
    await alice.readLedger();
    await writeLoro(alice, 'member-only-ciphertext');
    for (const stream of [LORO_STREAM, CONTROL_STREAM, KEYS_STREAM]) {
      const response = await outsider.fetch(`/ds/${alice.genesisHex}/${stream}`);
      expect(response.status, stream).toBe(403);
    }
    const joins = await outsider.fetch(`/v1/spaces/${alice.genesisHex}/joins`);
    expect(joins.status).toBe(403);
    const raw = await fetch(
      `${host.riverrunUrl.replace(/\/$/, '')}/ds/${alice.genesisHex}/${LORO_STREAM}`
    );
    expect(raw.ok, 'sqlite Riverrun stays unauthenticated storage').toBe(true);
    const unauthenticatedGenesis = await fetch(
      `${host.baseUrl}/v1/spaces/${alice.genesisHex}/genesis`
    );
    expect(unauthenticatedGenesis.status).toBe(401);
    const proof = await possessionProof(outsider.account, outsider.device);
    const claimed = await outsider.fetch('/v1/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: outsider.account,
        deviceHex: toHex(outsider.device.publicKey),
        signature: toHex(proof),
        genesisHex: alice.genesisHex,
      }),
    });
    expect(claimed.status).toBe(403);
  });

  it('lets a guest read keys through the gateway and refuses guest content writes', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(join, 'guest')).status).toBe('committed');
    await bob.readLedger();
    const keys = await bob.fetch(`/ds/${alice.genesisHex}/${KEYS_STREAM}`);
    expect(keys.status).toBe(200);
    const write = await bob.fetch(`/ds/${alice.genesisHex}/${LORO_STREAM}/append-cas`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from([0, 0, 0, 1, 1]),
    });
    expect(write.status).toBe(403);
    const keysWrite = await bob.fetch(`/ds/${alice.genesisHex}/${KEYS_STREAM}/append-cas`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from([0, 0, 0, 1, 1]),
    });
    expect(keysWrite.status).toBe(403);
  });

  it('rejects an epoch envelope signed by a member who cannot distribute keys', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    const carol = await labClient({ host, account: 'carol' });
    await alice.createSpace();
    const bobJoin = await bob.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(bobJoin)).status).toBe('committed');
    const carolJoin = await carol.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(carolJoin)).status).toBe('committed');
    await bob.readLedger();
    await carol.readLedger();
    await alice.deliverEpochKey(bob.device, 0);
    const bobFrames = await bob.readKeyFrames();
    await bob.receiveEpochKey(alice.device, 0, bobFrames[0]!);
    const key = bob.epochKeys.get(0);
    if (!key) throw new Error('missing-bob-epoch');
    const ledger = await bob.readLedger();
    const bobHex = toHex(bob.device.publicKey);
    const deviceRow = ledger.state.devices.get(bobHex);
    if (!deviceRow) throw new Error('missing-bob-device');
    const fakeDevices = new Map(ledger.state.devices);
    fakeDevices.set(bobHex, { ...deviceRow, canManage: true });
    const fakeMembers = new Map(ledger.state.members);
    const memberRow = fakeMembers.get(toHex(deviceRow.membershipId));
    if (!memberRow) throw new Error('missing-bob-member');
    fakeMembers.set(toHex(deviceRow.membershipId), { ...memberRow, role: 'admin' });
    const forged = await sealEpochEnvelope({
      state: { ...ledger.state, devices: fakeDevices, members: fakeMembers },
      genesis: bob.genesis!,
      epoch: 0,
      sender: bob.device.publicKey,
      recipient: carol.device.publicKey,
      recipientEncryptionKey: carol.device.enc,
      epochKey: key,
      sign: (bytes) => bob.device.sign(bytes),
    });
    await expect(carol.receiveEpochKey(bob.device, 0, forged)).rejects.toThrow('unauthorized');
    expect(carol.epochKeys.has(0)).toBe(false);
  });

  it('refuses to seal new content under a stale epoch after rotation', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(join)).status).toBe('committed');
    await bob.readLedger();
    await alice.deliverEpochKey(bob.device, 0);
    const frames = await bob.readKeyFrames();
    await bob.receiveEpochKey(alice.device, 0, frames[0]!);
    await writeLoro(alice, 'before-rotation');
    expect((await alice.publishEpoch()).status).toBe('committed');
    await expect(writeLoro(bob, 'after-rotation-old-epoch')).rejects.toThrow(
      'missing-current-epoch-key'
    );
    expect(await readLoro(alice)).not.toContain('after-rotation-old-epoch');
  });
});

// These cases encode currently observed defects, not intended contracts.
describe('design probes: newly observed defects', () => {
  it('leaks unauthenticated Riverrun and test-only host controls', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    await writeLoro(alice, 'member-only-ciphertext');

    const ready = await fetch(`${host.baseUrl}/readyz`);
    expect(ready.status).toBe(200);
    const body = (await ready.json()) as { riverrun?: string; riverrunDbPath?: string };
    expect(body.riverrun, 'GET /readyz discloses the unauthenticated Riverrun URL').toBeTruthy();
    const raw = await fetch(
      `${String(body.riverrun).replace(/\/$/, '')}/ds/${alice.genesisHex}/${LORO_STREAM}`
    );
    expect(raw.ok, 'external attacker can bypass the gateway via /readyz').toBe(true);

    const unknown = await fetch(`${host.baseUrl}/v1/spaces/${'00'.repeat(32)}/genesis`);
    const known = await fetch(`${host.baseUrl}/v1/spaces/${alice.genesisHex}/genesis`);
    expect(unknown.status).toBe(404);
    expect(known.status, 'unauthenticated genesis GET is an existence oracle').toBe(401);

    const failpoints = await fetch(`${host.baseUrl}/v1/failpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'drop-control-ack' }),
    });
    expect(failpoints.status, 'testMode failpoints are unauthenticated').toBe(200);

    const farFuture = String(alice.credential!.issuedAt + 16 * 60 * 1000);
    const clock = await fetch(`${host.baseUrl}/healthz`, {
      headers: { 'x-e2ee-demo-now': farFuture },
    });
    expect(clock.status).toBe(200);
    const expired = await fetch(`${host.baseUrl}/ds/${alice.genesisHex}/${CONTROL_STREAM}`, {
      headers: { authorization: `Bearer ${alice.credential!.token}` },
    });
    expect(expired.status, 'unauthenticated NOW_HEADER moves the host clock').toBe(401);
  });

  it('treats a guest-to-be as a writer between admitMember and setRole', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    const membershipId = alice.random('probe-guest-membership', 16);
    const admitted = await alice.submit({
      type: 'admitMember',
      membershipId,
      request: {
        requestId: fromHex(join.requestId),
        userId: fromHex(join.userId),
        signingPublicKey: fromHex(join.signingPublicKey),
        encryptionPublicKey: fromHex(join.encryptionPublicKey),
        expiresAt: join.expiresAt,
        signature: fromHex(join.signature),
      },
    });
    expect(admitted.status).toBe('committed');
    await bob.readLedger();
    expect(bob.canWriteDocument, 'admitMember always inserts role=member').toBe(true);
    await alice.deliverEpochKey(bob.device, 0);
    const frames = await bob.readKeyFrames();
    await bob.receiveEpochKey(alice.device, 0, frames[0]!);
    await writeLoro(bob, 'guest-window-write');
    expect(await readLoro(alice)).toContain('guest-window-write');
    expect((await alice.submit({ type: 'setRole', membershipId, role: 'guest' })).status).toBe(
      'committed'
    );
    await bob.readLedger();
    expect(bob.canWriteDocument).toBe(false);
    await expect(writeLoro(bob, 'after-guest-role')).rejects.toThrow();
  });

  it('admits a join whose expiresAt is already in the past', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    await bob.adoptGenesis(alice.genesisHex!);
    bob.userId = bob.random('join-user-id', 32);
    const request = {
      requestId: bob.random('join-request-id', 16),
      userId: bob.userId,
      signingPublicKey: bob.device.publicKey,
      encryptionPublicKey: bob.device.enc,
      expiresAt: 1,
    };
    const signature = await bob.device.sign(
      joinRequestSigningBytes(fromHex(alice.genesisHex!), request)
    );
    const wire = {
      requestId: toHex(request.requestId),
      userId: toHex(request.userId),
      signingPublicKey: toHex(request.signingPublicKey),
      encryptionPublicKey: toHex(request.encryptionPublicKey),
      expiresAt: request.expiresAt,
      signature: toHex(signature),
    };
    const posted = await bob.fetch(`/v1/spaces/${alice.genesisHex}/joins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wire),
    });
    expect(posted.ok).toBe(true);
    const approved = await alice.approveJoin(wire);
    expect(approved.status, 'host extend() never preflights join expiry').toBe('committed');
    expect((await alice.readLedger()).state.devices.has(toHex(bob.device.publicKey))).toBe(true);
  });

  it('does not give the join device canSendEpoch after approveJoin(admin)', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(join, 'admin')).status).toBe('committed');
    const ledger = await bob.readLedger();
    const member = [...ledger.state.members.values()].find((row) => row.role === 'admin');
    expect(member?.role).toBe('admin');
    expect(
      canSendEpoch(ledger.state, bob.device.publicKey),
      'join device keeps canManage=false; helper looks like a working admin'
    ).toBe(false);
  });

  it('flags historical member content as unauthorized after setRole→guest', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    const bob = await labClient({ host, account: 'bob', runtime });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    const admitted = await alice.approveJoin(join);
    await bob.readLedger();
    await alice.deliverEpochKey(bob.device, 0);
    const frames = await bob.readKeyFrames();
    await bob.receiveEpochKey(alice.device, 0, frames[0]!);
    await writeLoro(bob, 'honest-while-member');
    expect(
      (await alice.submit({ type: 'setRole', membershipId: admitted.membershipId, role: 'guest' }))
        .status
    ).toBe('committed');
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'hidden-none',
      genesisHex: alice.genesisHex,
      inspectHonest: inspectClient(alice, host),
    });
    const report = await lab.finish();
    expect(report.integrity, 'judge treats demoted authors as unauthorized writers').toBe(
      'outside-model'
    );
  });

  it('misses guest-authored Flock content under malicious Riverrun', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    const bob = await labClient({ host, account: 'bob', runtime });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(join, 'guest')).status).toBe('committed');
    await bob.readLedger();
    await alice.deliverEpochKey(bob.device, 0);
    const keyFrames = await bob.readKeyFrames();
    await bob.receiveEpochKey(alice.device, 0, keyFrames[0]!);
    bob.prepareWrite = async () => undefined;
    bob.canWriteDocument = true;
    const orig = bob.fetch.bind(bob);
    bob.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes(`/${FLOCK_STREAM}`) && init?.method === 'POST') {
        const dest = url.replace(host.baseUrl, host.riverrunUrl.replace(/\/$/, ''));
        return fetch(dest, init);
      }
      return orig(input, init);
    };
    await writeFlock(bob, 'guest-flock-pwn');
    await expect(readFlock(alice)).resolves.toContain('guest-flock-pwn');
    const facts = await inspectClient(alice, host)();
    expect(facts.unauthorizedContentAccepted, 'inspectClient only scans LORO_STREAM').toBe(false);
  });

  it('lets a remaining member publish post-rotation content under epoch 0', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(join)).status).toBe('committed');
    await bob.readLedger();
    await alice.deliverEpochKey(bob.device, 0);
    const frames = await bob.readKeyFrames();
    await bob.receiveEpochKey(alice.device, 0, frames[0]!);
    expect((await alice.publishEpoch()).status).toBe('committed');
    bob.prepareWrite = async () => undefined;
    bob.ledgerEpoch = 0;
    bob.canWriteDocument = true;
    await writeLoro(bob, 'stale-epoch-after-rotation');
    expect(await readLoro(alice)).toContain('stale-epoch-after-rotation');
  });
});
