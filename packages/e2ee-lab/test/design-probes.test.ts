import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canSendEpoch,
  encodeSignedRecord,
  joinRequestSigningBytes,
  openEpochEnvelope,
  sealEpochEnvelope,
  signingBytesForBody,
} from '@lody/e2ee-core/ledger';
import { createAttackLab, inspectClient } from '../src/attack-lab';
import { maliciousAppendCas } from '../src/attacks';
import { recordContentWrite } from '../src/content-trace';
import { composeIntegrity, judgeClaim, judgeUnauthorizedContent } from '../src/judge';
import { readFlock, readLoro, writeFlock, writeLoro } from '../src/platform/content-session';
import { exportDevice, generateDevice, possessionProof } from '../src/platform/device';
import { fromHex, toHex } from '../src/platform/bytes';
import { loroDocPath } from '../src/platform/persist';
import { CONTROL_STREAM, FLOCK_STREAM, KEYS_STREAM, LORO_STREAM } from '../src/platform/protocol';
import { cleanupLab, labClient, launchLab, tempDir } from '../src/fixtures';
import { LabRuntime } from '../src/runtime';

function joinRequest(wire: {
  requestId: string;
  userId: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  expiresAt: number | null;
  signature: string;
}) {
  return {
    requestId: fromHex(wire.requestId),
    userId: fromHex(wire.userId),
    signingPublicKey: fromHex(wire.signingPublicKey),
    encryptionPublicKey: fromHex(wire.encryptionPublicKey),
    expiresAt: wire.expiresAt,
    signature: fromHex(wire.signature),
  };
}

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
    // A guest holding the current key may forward it (2026-09-22): the gateway
    // admits the keys write and the recipient still checks the commitment.
    await alice.deliverEpochKey(bob.device, 0);
    const frames = await bob.readKeyFrames();
    await bob.receiveEpochKey(alice.device, 0, frames[0]!);
    const forwarded = await bob.deliverEpochKey(alice.device, 0);
    expect(
      await openEpochEnvelope({
        state: (await alice.readLedger()).state,
        genesis: fromHex(alice.genesisHex!),
        epoch: 0,
        sender: bob.device.publicKey,
        recipient: alice.device.publicKey,
        recipientKeyPair: alice.device.encryption,
        frame: forwarded,
      })
    ).toEqual(bob.epochKeys.get(0));
  });

  it('lets a member forward the current key; the recipient still rejects a wrong key', async () => {
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

    // Bob is a plain member with canManage=false. A forwarded key that is not
    // the committed key fails the commitment check and leaves Carol without a key.
    const ledger = await bob.readLedger();
    const wrongKey = await sealEpochEnvelope({
      state: ledger.state,
      genesis: ledger.state.genesis,
      epoch: 0,
      sender: bob.device.publicKey,
      recipient: carol.device.publicKey,
      recipientEncryptionKey: carol.device.enc,
      epochKey: bob.random('wrong-epoch-key', 32),
      sign: (bytes) => bob.device.sign(bytes),
    });
    await expect(carol.receiveEpochKey(bob.device, 0, wrongKey)).rejects.toMatchObject({
      _tag: 'ContextMismatch',
      context: 'epoch',
    });
    expect(carol.epochKeys.has(0)).toBe(false);

    // The real key, forwarded by Bob through the gateway, is accepted.
    const forwarded = await bob.deliverEpochKey(carol.device, 0);
    await carol.receiveEpochKey(bob.device, 0, forwarded);
    expect(carol.epochKeys.get(0)).toEqual(key);
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

describe('design probes: ordinary plane vs harness', () => {
  it('does not leak Riverrun, failpoints, or clock control on ordinary HTTP', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    await writeLoro(alice, 'member-only-ciphertext');

    const ready = await fetch(`${host.baseUrl}/readyz`);
    expect(ready.status).toBe(200);
    const body = (await ready.json()) as {
      ok?: boolean;
      riverrun?: string;
      riverrunDbPath?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.riverrun).toBeUndefined();
    expect(body.riverrunDbPath).toBeUndefined();

    const unknown = await fetch(`${host.baseUrl}/v1/spaces/${'00'.repeat(32)}/genesis`);
    const known = await fetch(`${host.baseUrl}/v1/spaces/${alice.genesisHex}/genesis`);
    expect(unknown.status).toBe(401);
    expect(known.status).toBe(401);

    const failpoints = await fetch(`${host.baseUrl}/v1/failpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'drop-control-ack' }),
    });
    expect(failpoints.status).not.toBe(200);
    const harnessDenied = await fetch(`${host.baseUrl}/v1/harness/failpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'drop-control-ack' }),
    });
    expect(harnessDenied.status).toBe(401);

    const farFuture = alice.credential!.issuedAt + 16 * 60 * 1000;
    const clock = await fetch(`${host.baseUrl}/healthz`, {
      headers: { 'x-e2ee-demo-now': String(farFuture) },
    });
    expect(clock.status).toBe(200);
    const stillFresh = await fetch(`${host.baseUrl}/ds/${alice.genesisHex}/${CONTROL_STREAM}`, {
      headers: { authorization: `Bearer ${alice.credential!.token}` },
    });
    expect(stillFresh.status).not.toBe(401);

    const harnessClock = await fetch(`${host.baseUrl}/v1/harness/clock`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${host.harnessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ now: farFuture }),
    });
    expect(harnessClock.status).toBe(200);
    const expired = await fetch(`${host.baseUrl}/ds/${alice.genesisHex}/${CONTROL_STREAM}`, {
      headers: { authorization: `Bearer ${alice.credential!.token}` },
    });
    expect(expired.status).toBe(401);

    const raw = await fetch(
      `${host.riverrunUrl.replace(/\/$/, '')}/ds/${alice.genesisHex}/${LORO_STREAM}`
    );
    expect(raw.ok, 'malicious-server handle still reaches raw Riverrun').toBe(true);
  });

  it('records that admitMember creates a member with write rights before setRole', async () => {
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
    expect(bob.canWriteDocument, 'admitMember still inserts role=member; not atomic guest').toBe(
      true
    );
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

  it('rejects host admission of a join whose expiresAt is already past', async () => {
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
    expect(approved.admitted).toBe(false);
    expect(approved.roleConfigured).toBe(false);
    expect(approved.status).not.toBe('committed');
    expect((await alice.readLedger()).state.devices.has(toHex(bob.device.publicKey))).toBe(false);
  });

  it('reports role=admin without implying the join device can manage', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    const approved = await alice.approveJoin(join, 'admin');
    expect(approved.status).toBe('committed');
    expect(approved.roleConfigured).toBe(true);
    expect(approved.deviceCanManage).toBe(false);
    const ledger = await bob.readLedger();
    const member = [...ledger.state.members.values()].find((row) => row.role === 'admin');
    expect(member?.role).toBe('admin');
    // The join device may forward keys once it holds one; here it has none yet.
    expect(canSendEpoch(ledger.state, bob.device.publicKey)).toBe(true);
    await expect(bob.deliverEpochKey(alice.device, 0)).rejects.toThrow('missing-epoch-key');
    const manager = await generateDevice();
    expect((await bob.admitDevice(manager, 'personal', true)).status).toBe('committed');
    const after = await bob.readLedger();
    expect(canSendEpoch(after.state, manager.publicKey)).toBe(true);
    const machine = await generateDevice();
    await expect(bob.admitDevice(machine, 'machine', true)).rejects.toThrow();
  });

  it('does not flag historical member content after setRole→guest', async () => {
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
    expect(report.integrity).toBe('pass');
  });

  it('flags imported guest-authored Flock content under malicious Riverrun', async () => {
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
    expect(facts.unauthorizedContentAccepted).toBe(true);
    expect(facts.contentScanIncomplete).not.toBe(true);
  });

  it('does not treat backend-only guest ciphertext as client acceptance', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(join, 'guest')).roleConfigured).toBe(true);
    await bob.readLedger();
    await alice.deliverEpochKey(bob.device, 0);
    const keyFrames = await bob.readKeyFrames();
    await bob.receiveEpochKey(alice.device, 0, keyFrames[0]!);
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
    await writeLoro(bob, 'guest-loro-backend-only');
    const facts = await inspectClient(alice, host)();
    expect(facts.unauthorizedContentAccepted).toBe(false);
  });

  it('rejects guest writes on the honest gateway', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    expect((await alice.approveJoin(join, 'guest')).roleConfigured).toBe(true);
    await bob.readLedger();
    await expect(writeLoro(bob, 'honest-guest-write')).rejects.toThrow();
  });

  it('does not report Guest/Admin complete when setRole does not commit', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    const membershipId = alice.random('join-role-fail', 16);
    expect(
      (await alice.submit({ type: 'admitMember', membershipId, request: joinRequest(join) })).status
    ).toBe('committed');
    expect((await alice.submit({ type: 'removeMember', membershipId })).status).toBe('committed');
    const approved = await alice.approveJoin(join, 'guest', { membershipId });
    expect(approved.admitted).toBe(false);
    expect(approved.roleConfigured).toBe(false);
    expect(approved.status).not.toBe('committed');
    expect(toHex(approved.membershipId)).toBe(toHex(membershipId));
    expect((await alice.readLedger()).state.devices.has(toHex(bob.device.publicKey))).toBe(false);
  });

  it('resumes a setRole after a dropped ACK', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    const membershipId = alice.random('join-role-ack', 16);
    expect(
      (await alice.submit({ type: 'admitMember', membershipId, request: joinRequest(join) })).status
    ).toBe('committed');
    const orig = alice.fetch.bind(alice);
    alice.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes(`/${CONTROL_STREAM}`) && init?.method === 'POST') {
        throw new Error('lost-setrole-response');
      }
      return orig(input, init);
    };
    const first = await alice.approveJoin(join, 'guest', { membershipId });
    alice.fetch = orig;
    expect(first.admitted).toBe(true);
    expect(first.roleConfigured).toBe(false);
    expect(first.status).toBe('unknown');
    expect(toHex(first.membershipId)).toBe(toHex(membershipId));
    host.setFailpoint('drop-control-ack');
    const dropped = await alice.approveJoin(join, 'guest', { membershipId });
    host.setFailpoint('none');
    expect(dropped.admitted).toBe(true);
    expect(dropped.roleConfigured).toBe(true);
    expect(dropped.status).toBe('committed');
    await bob.readLedger();
    expect(bob.canWriteDocument).toBe(false);
  });

  it('returns conflict when setRole loses CAS after admit', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    const membershipId = alice.random('join-role-conflict', 16);
    expect(
      (await alice.submit({ type: 'admitMember', membershipId, request: joinRequest(join) })).status
    ).toBe('committed');
    const alice2 = await labClient({
      host,
      account: 'alice',
      device: await exportDevice(alice.device),
      clientDir: tempDir('alice2-join-'),
    });
    await alice2.adoptGenesis(alice.genesisHex!);
    await alice2.readLedger();
    const orig = alice.fetch.bind(alice);
    alice.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes(`/${CONTROL_STREAM}`) && init?.method === 'POST') {
        alice.fetch = orig;
        expect((await alice2.submit({ type: 'setRole', membershipId, role: 'admin' })).status).toBe(
          'committed'
        );
        return orig(input, init);
      }
      return orig(input, init);
    };
    const approved = await alice.approveJoin(join, 'guest', { membershipId });
    alice.fetch = orig;
    expect(approved.admitted).toBe(true);
    expect(approved.roleConfigured).toBe(false);
    expect(approved.status).toBe('conflict');
    const member = (await alice.readLedger()).state.members.get(toHex(membershipId));
    expect(member?.role).toBe('admin');
  });

  it('resumes Guest role configuration after process restart', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    const join = await bob.requestJoin(alice.genesisHex!);
    const membershipId = alice.random('join-role-restart', 16);
    expect(
      (await alice.submit({ type: 'admitMember', membershipId, request: joinRequest(join) })).status
    ).toBe('committed');
    const orig = alice.fetch.bind(alice);
    alice.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes(`/${CONTROL_STREAM}`) && init?.method === 'POST') {
        throw new Error('lost-setrole-response');
      }
      return orig(input, init);
    };
    const first = await alice.approveJoin(join, 'guest', { membershipId });
    alice.fetch = orig;
    expect(first.roleConfigured).toBe(false);
    expect(first.status).toBe('unknown');
    const device = await exportDevice(alice.device);
    const clientDir = alice.clientDir;
    const genesisHex = alice.genesisHex!;
    alice.close();
    const restarted = await labClient({
      host,
      account: 'alice',
      device,
      clientDir,
    });
    await restarted.adoptGenesis(genesisHex);
    const recovered = await restarted.approveJoin(join, 'guest', { membershipId });
    expect(recovered.admitted).toBe(true);
    expect(recovered.roleConfigured).toBe(true);
    expect(recovered.status).toBe('committed');
    await bob.readLedger();
    expect(bob.canWriteDocument).toBe(false);
  });

  it('rejects an expired join at the admit boundary and still identifies a pre-expiry commit', async () => {
    const host = await launchLab();
    const now = 1_700_000_000_000;
    host.setNow(now);
    const alice = await labClient({ host, account: 'alice' });
    const bob = await labClient({ host, account: 'bob' });
    await alice.createSpace();
    await bob.adoptGenesis(alice.genesisHex!);
    bob.userId = bob.random('join-user-id-exp', 32);
    const request = {
      requestId: bob.random('join-request-id-exp', 16),
      userId: bob.userId,
      signingPublicKey: bob.device.publicKey,
      encryptionPublicKey: bob.device.enc,
      expiresAt: now + 60_000,
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
    expect(
      (
        await bob.fetch(`/v1/spaces/${alice.genesisHex}/joins`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(wire),
        })
      ).ok
    ).toBe(true);
    host.setFailpoint('drop-control-ack');
    const first = await alice.approveJoin(wire);
    host.setFailpoint('none');
    expect(first.admitted).toBe(true);
    host.setNow(request.expiresAt + 1);
    const retry = await alice.approveJoin(wire, 'member', { membershipId: first.membershipId });
    expect(retry.admitted).toBe(true);
    expect(retry.status).toBe('committed');
    expect((await alice.readLedger()).state.devices.has(toHex(bob.device.publicKey))).toBe(true);
    await expect(alice.readLedger()).resolves.toBeTruthy();

    const carol = await labClient({ host, account: 'carol' });
    await carol.adoptGenesis(alice.genesisHex!);
    const lateReq = {
      requestId: carol.random('join-request-id-crit', 16),
      userId: carol.random('join-user-id-crit', 32),
      signingPublicKey: carol.device.publicKey,
      encryptionPublicKey: carol.device.enc,
      expiresAt: now,
    };
    const lateSig = await carol.device.sign(
      joinRequestSigningBytes(fromHex(alice.genesisHex!), lateReq)
    );
    const lateWire = {
      requestId: toHex(lateReq.requestId),
      userId: toHex(lateReq.userId),
      signingPublicKey: toHex(lateReq.signingPublicKey),
      encryptionPublicKey: toHex(lateReq.encryptionPublicKey),
      expiresAt: lateReq.expiresAt,
      signature: toHex(lateSig),
    };
    await carol.fetch(`/v1/spaces/${alice.genesisHex}/joins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lateWire),
    });
    const denied = await alice.approveJoin(lateWire);
    expect(denied.admitted).toBe(false);
    expect(denied.status).not.toBe('committed');
    expect((await alice.readLedger()).state.devices.has(toHex(carol.device.publicKey))).toBe(false);
  });

  it('does not treat a later-revoked author as unauthorized history', async () => {
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
    await writeLoro(writer, 'legal-before-revoke');
    expect(await readLoro(alice)).toContain('legal-before-revoke');
    expect((await alice.revokeDevice(tablet.publicKey)).status).toBe('committed');
    const facts = await inspectClient(alice, host)();
    expect(facts.unauthorizedContentAccepted).toBe(false);
    expect(facts.contentScanIncomplete).not.toBe(true);
  });

  it('reports unmeasured when imported content cannot be decoded or attributed', async () => {
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice' });
    await alice.createSpace();
    await writeLoro(alice, 'unattributed-imported');
    recordContentWrite({
      genesisHex: alice.genesisHex!,
      stream: 'loro',
      deviceHex: toHex(alice.device.publicKey),
      epoch: 0,
      text: 'unattributed-imported',
      writerMayWrite: undefined,
    });
    const incomplete = await inspectClient(alice, host)();
    expect(incomplete.contentScanIncomplete).toBe(true);
    expect(incomplete.unauthorizedContentAccepted).toBeUndefined();

    writeFileSync(loroDocPath(alice.clientDir), Buffer.from('not-a-loro-snapshot'));
    const decoded = await inspectClient(alice, host)();
    expect(decoded.contentScanIncomplete).toBe(true);
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
