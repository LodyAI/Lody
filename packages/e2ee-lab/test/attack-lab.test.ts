import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { assertLiveCiphertext, writeFlock, writeLoro } from '../src/platform/content-session';
import { flockDocPath, loroDocPath } from '../src/platform/persist';
import { generateDevice } from '../src/platform/device';
import { toHex } from '../src/platform/bytes';
import {
  createAttackLab,
  harnessReplayActions,
  harnessReplayMaterial,
  inspectClient,
  replayAttackActions,
  type AttackAction,
  type AttackLab,
} from '../src/attack-lab';
import { maliciousAppendCas, riverrunNextOffset } from '../src/attacks';
import { exportDevice } from '../src/platform/device';
import {
  cleanupLab,
  drainRuntime,
  drainUntil,
  labClient,
  launchLab,
  permitUntil,
} from '../src/fixtures';
import { isRecordingEntropy, recordingEntropy, replayEntropy } from '../src/entropy';
import { LabRuntime } from '../src/runtime';

afterEach(() => cleanupLab());

const ATTACK_METHODS = [
  'actions',
  'advance',
  'advanceUntil',
  'finish',
  'intercept',
  'mutateBackend',
  'observe',
  'readBackend',
  'submitClaim',
];

/** Scripted explorer (not a P4 Agent). Observe, scan, xor, claim, finish. */
async function exploreAttackLab(lab: AttackLab) {
  const view = await lab.observe();
  const disk = await lab.readBackend({ target: 'riverrun', eventId: 'barrier' });
  const ascii = [...new TextDecoder().decode(disk).matchAll(/[ -~]{12,}/g)].map((row) => row[0]);
  const leaked = ascii.find((text) => text.startsWith('hidden-') || text.startsWith('secret-'));
  if (leaked) {
    await lab.submitClaim({ kind: 'plaintext', evidence: leaked });
  } else {
    const start = Math.min(128, Math.max(0, disk.byteLength - 16));
    const needleHex = toHex(disk.subarray(start, start + 16));
    await lab.mutateBackend({ eventId: 'barrier', kind: 'xor', needleHex, xor: 0xff });
    await lab.observe();
    await lab.submitClaim({ kind: 'plaintext', evidence: 'guess-wrong' });
  }
  const report = await lab.finish();
  return { view, report, actions: lab.actions() };
}

describe('P4 AttackLab isolation', () => {
  it('hides honest secrets and rejects client-directory targets', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    await alice.readLedger();
    const secret = `secret-${toHex(crypto.getRandomValues(new Uint8Array(8)))}`;
    await writeLoro(alice, secret);
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: secret,
      genesisHex: alice.genesisHex,
    });
    const view = await lab.observe();
    const dumped = JSON.stringify(view);
    expect(dumped).not.toContain(secret);
    expect(dumped).not.toContain(alice.clientDir);
    expect(JSON.stringify(lab)).toBe('{}');
    expect(Object.keys(lab).sort()).toEqual([...ATTACK_METHODS].sort());
    expect(Object.getOwnPropertyNames(lab).sort()).toEqual([...ATTACK_METHODS].sort());
    await expect(lab.readBackend({ target: 'riverrun', eventId: 'no-such-event' })).rejects.toThrow(
      'invalid-event'
    );
    await expect(
      lab.mutateBackend({
        eventId: 'barrier',
        kind: 'xor',
        needleHex: 'ffff',
      })
    ).resolves.toEqual({ ok: false });
    expect(JSON.stringify(lab.actions())).not.toContain(secret);
  });

  it('does not treat unsupported claims as violations', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
      expectedLength: 1,
      inspectHonest: inspectClient(alice, host),
    });
    await lab.submitClaim({ kind: 'forged-accepted' });
    await lab.submitClaim({ kind: 'cursor-overrun' });
    const report = await lab.finish();
    expect(report.integrity).toBe('pass');
    expect(report.durability).toBe('pass');
    expect(report.confidentiality).toBe('pass');
  });

  it('scores integrity from measured client ledger length', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    expect((await alice.admitDevice(await generateDevice(), 'personal', false)).status).toBe(
      'committed'
    );
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
      expectedLength: 1,
      inspectHonest: inspectClient(alice, host),
    });
    const report = await lab.finish();
    expect((await alice.readLedger()).length).toBe(2);
    expect(report.integrity).toBe('pass');
    expect(report.durability).toBe('pass');
  });

  it('flags a document rolled back behind its persisted cursor', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    await writeLoro(alice, 'v1');
    const rolledBackDoc = new Uint8Array(readFileSync(loroDocPath(alice.clientDir)));
    await writeLoro(alice, 'v2');
    // Roll the persisted document back to the older valid snapshot while the
    // cursor still claims it consumed v2.
    writeFileSync(loroDocPath(alice.clientDir), rolledBackDoc);
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
      inspectHonest: inspectClient(alice, host),
    });
    const report = await lab.finish();
    expect(report.durability).toBe('violation');
    // The same rollback must surface in the private replay digest too.
    const material = await harnessReplayMaterial(lab);
    expect(material.clients[0]?.loroDoc).not.toBeNull();
  });

  it('flags a Flock document rolled back behind its persisted cursor', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    await writeFlock(alice, 'v1', ['private', 'rollback']);
    const rolledBackDoc = new Uint8Array(readFileSync(flockDocPath(alice.clientDir)));
    await writeFlock(alice, 'v2', ['private', 'rollback']);
    writeFileSync(flockDocPath(alice.clientDir), rolledBackDoc);
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
      inspectHonest: inspectClient(alice, host),
    });
    const report = await lab.finish();
    expect(report.durability).toBe('violation');
    const material = await harnessReplayMaterial(lab);
    expect(material.clients[0]?.flockDoc).not.toBeNull();
  });

  it('does not pass when observation throws, is unmeasured, or is partial', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    const make = (inspectHonest: () => Promise<never>) =>
      createAttackLab({
        host,
        runtime,
        clientDirs: [alice.clientDir],
        expectedPlaintext: 'none',
        genesisHex: alice.genesisHex,
        inspectHonest,
      });
    const throwing = await make(async () => {
      throw new Error('probe-failed');
    }).finish();
    expect(throwing.integrity).toBe('harness-error');
    expect(throwing.durability).toBe('harness-error');
    const unmeasured = await make(async () => ({ unmeasured: true }) as never).finish();
    expect(unmeasured.integrity).toBe('harness-error');
    expect(unmeasured.durability).toBe('harness-error');
    const partial = await make(async () => ({ verifiedRecords: 1 }) as never).finish();
    expect(partial.integrity).toBe('harness-error');
    expect(partial.durability).toBe('harness-error');
  });

  it('marks a stopped host unavailable without treating xor as a plaintext leak', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    await alice.readLedger();
    await writeLoro(alice, 'hidden-not-on-disk');
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'hidden-not-on-disk',
      genesisHex: alice.genesisHex,
      inspectHonest: inspectClient(alice, host),
    });
    const disk = await lab.readBackend({ target: 'riverrun', eventId: 'barrier' });
    await lab.mutateBackend({
      eventId: 'barrier',
      kind: 'xor',
      needleHex: toHex(disk.subarray(0, 16)),
    });
    const report = await lab.finish();
    expect(report.confidentiality).toBe('pass');
    expect(report.integrity).toBe('unavailable');
    expect(report.durability).toBe('unavailable');
  });

  it('does not pass default finish integrity just because healthz is up', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
      expectedLength: 1,
    });
    await lab.observe();
    const extra = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const beforeOff = await riverrunNextOffset(host.riverrunUrl, alice.genesisHex!);
    const landed = await maliciousAppendCas({
      riverrunUrl: host.riverrunUrl,
      genesisHex: alice.genesisHex!,
      record: extra,
    });
    expect(landed.ok).toBe(true);
    const afterOff = await riverrunNextOffset(host.riverrunUrl, alice.genesisHex!);
    expect(afterOff).not.toBe(beforeOff);
    const health = await fetch(`${host.baseUrl}/healthz`);
    expect(health.ok).toBe(true);
    expect(await health.text()).toBe('ok');
    const report = await lab.finish();
    expect(report.integrity).toBe('harness-error');
    expect(report.durability).toBe('harness-error');
  });

  it('does not treat backend extra plus client reject as client integrity loss', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
      expectedLength: 1,
      inspectHonest: inspectClient(alice, host),
    });
    await lab.observe();
    const landed = await maliciousAppendCas({
      riverrunUrl: host.riverrunUrl,
      genesisHex: alice.genesisHex!,
      record: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    expect(landed.ok).toBe(true);
    const report = await lab.finish();
    expect(report.integrity).toBe('pass');
    expect(report.durability).toBe('pass');
  });
});

describe('P4 AttackLab intercept and advanceUntil', () => {
  it('reports unmet when the requested phase never appears', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
    });
    const view = await lab.advanceUntil({ phase: 'no-such-phase', maxSteps: 2 });
    expect(view.unmet).toBe(true);
    await lab.finish();
  });

  const casRequest =
    (actor: string) => (event: { actor: string; operation: string; phase: string }) =>
      event.actor === actor && event.operation === 'submit' && event.phase === 'request-queued';

  it('gates reads and result delivery, not only mutations', async () => {
    const runtime = new LabRuntime({ mode: 'manual' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    // An unauthorized read must not return before the scheduler permits it.
    const read = alice.readLedger();
    await runtime.whenRequested(1);
    const queuedRead = runtime
      .events()
      .find((event) => event.operation === 'read' && event.status === 'requested');
    expect(queuedRead).toBeDefined();
    let delivered = false;
    void read.then(() => {
      delivered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(delivered).toBe(false);
    const stop = drainRuntime(runtime);
    try {
      await read;
      const deliverEvents = runtime
        .events()
        .filter((event) => event.phase === 'deliver' && event.status === 'completed');
      expect(deliverEvents.length).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  it('drops a queued CAS through intercept without an LLM', async () => {
    const runtime = new LabRuntime({ mode: 'manual' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
    });
    const admit = alice.admitDevice(await generateDevice(), 'personal', false);
    const queued = await permitUntil(runtime, casRequest('alice'));
    await lab.intercept({ eventId: queued.eventId, kind: 'drop' });
    runtime.permit(queued.eventId);
    const result = await drainUntil(runtime, admit);
    expect(result.status).toBe('unknown');
    const report = await drainUntil(runtime, lab.finish());
    expect(report.budgetExceeded).toBe(false);
  });

  it('delays CAS acknowledgement until a second permit', async () => {
    const runtime = new LabRuntime({ mode: 'manual' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
    });
    const admit = alice.admitDevice(await generateDevice(), 'personal', false);
    const queued = await permitUntil(runtime, casRequest('alice'));
    await lab.intercept({ eventId: queued.eventId, kind: 'delay' });
    runtime.permit(queued.eventId);
    // The CAS ran, but the acknowledgement is held at the deliver boundary.
    const ack = await permitUntil(
      runtime,
      (event) => event.phase === 'deliver' && event.actor === 'alice'
    );
    let delivered = false;
    void admit.then(() => {
      delivered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(delivered).toBe(false);
    runtime.permit(ack.eventId);
    const result = await drainUntil(runtime, admit);
    expect(result.status).toBe('committed');
    await drainUntil(runtime, lab.finish());
  });

  it('duplicates a CAS request and still commits the first delivery', async () => {
    const runtime = new LabRuntime({ mode: 'manual' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
    });
    const admit = alice.admitDevice(await generateDevice(), 'personal', false);
    const queued = await permitUntil(runtime, casRequest('alice'));
    await lab.intercept({ eventId: queued.eventId, kind: 'duplicate' });
    runtime.permit(queued.eventId);
    const result = await drainUntil(runtime, admit);
    expect(result.status).toBe('committed');
    expect((await drainUntil(runtime, alice.readLedger())).length).toBe(2);
    await drainUntil(runtime, lab.finish());
  });

  it('replaces a CAS ACK without committing on the client', async () => {
    const runtime = new LabRuntime({ mode: 'manual' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
    });
    const admit = alice.admitDevice(await generateDevice(), 'personal', false);
    const queued = await permitUntil(runtime, casRequest('alice'));
    await lab.intercept({
      eventId: queued.eventId,
      kind: 'replace',
      status: 502,
      bodyHex: '7b226572726f72223a227265706c616365227d',
    });
    runtime.permit(queued.eventId);
    const first = await drainUntil(runtime, admit);
    expect(first.status).toBe('unknown');
    const resumed = alice.resume();
    const retry = await permitUntil(runtime, casRequest('alice'));
    runtime.permit(retry.eventId);
    const second = await drainUntil(runtime, resumed);
    expect(second.status).toBe('committed');
    await drainUntil(runtime, lab.finish());
  });

  it('truncates a real CAS ACK and still observes the commit by read-back', async () => {
    const runtime = new LabRuntime({ mode: 'manual' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
    });
    const extra = await generateDevice();
    const admit = alice.admitDevice(extra, 'personal', false);
    const queued = await permitUntil(runtime, casRequest('alice'));
    await lab.intercept({ eventId: queued.eventId, kind: 'truncate' });
    runtime.permit(queued.eventId);
    const status = (await drainUntil(runtime, admit)).status;
    expect(status === 'unknown' || status === 'committed').toBe(true);
    if (status === 'unknown') {
      const resumed = alice.resume();
      const retry = await permitUntil(runtime, casRequest('alice'));
      runtime.permit(retry.eventId);
      expect((await drainUntil(runtime, resumed)).status).toBe('committed');
    }
    expect(
      (await drainUntil(runtime, alice.readLedger())).state.devices.has(toHex(extra.publicKey))
    ).toBe(true);
    await drainUntil(runtime, lab.finish());
  });
});

describe('P4 recorded agent exploration', () => {
  it('runs a capability-only exploration and replays it without an LLM', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const entropy = recordingEntropy();
    const alice = await labClient({ host, account: 'alice', runtime, entropy });
    await alice.createSpace();
    await alice.readLedger();
    const secret = `hidden-${toHex(crypto.getRandomValues(new Uint8Array(8)))}`;
    await writeLoro(alice, secret);
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: secret,
      genesisHex: alice.genesisHex,
    });
    const first = await exploreAttackLab(lab);
    expect(first.report.confidentiality).toBe('pass');
    expect(first.report.budgetExceeded).toBe(false);
    expect(JSON.stringify(first.actions)).not.toContain(secret);
    expect(first.view.events.every((event) => event.actor !== undefined)).toBe(true);

    const replayRuntime = new LabRuntime({ mode: 'auto' });
    const replayHost = await launchLab();
    const replayAlice = await labClient({
      host: replayHost,
      account: 'alice',
      runtime: replayRuntime,
      entropy: replayEntropy(isRecordingEntropy(entropy) ? entropy.fills : []),
      device: await exportDevice(alice.device),
    });
    await replayAlice.createSpace();
    await replayAlice.readLedger();
    // Same private initial state reproduces the same genesis and ciphertext,
    // so a recorded backend mutation hits the same bytes again.
    expect(replayAlice.genesisHex).toBe(alice.genesisHex);
    await writeLoro(replayAlice, secret);
    const replayLab = createAttackLab({
      host: replayHost,
      runtime: replayRuntime,
      clientDirs: [replayAlice.clientDir],
      expectedPlaintext: secret,
      genesisHex: replayAlice.genesisHex,
    });
    const replayed = await replayAttackActions(
      replayLab,
      harnessReplayActions(lab) as AttackAction[]
    );
    expect(replayed.report.confidentiality).toBe(first.report.confidentiality);
    expect(replayed.report.budgetExceeded).toBe(false);
  });

  it('reports the first replay divergence instead of only comparing verdicts', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const entropy = recordingEntropy();
    const alice = await labClient({ host, account: 'alice', runtime, entropy });
    await alice.createSpace();
    await alice.readLedger();
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
    });
    await lab.observe();
    const report = await lab.finish();
    const material = await harnessReplayMaterial(lab);
    expect(material.events.length).toBeGreaterThan(0);

    const spawnReplay = async () => {
      const replayRuntime = new LabRuntime({ mode: 'auto' });
      const replayHost = await launchLab();
      const replayAlice = await labClient({
        host: replayHost,
        account: 'alice',
        runtime: replayRuntime,
        entropy: replayEntropy(entropy.fills),
        device: await exportDevice(alice.device),
      });
      await replayAlice.createSpace();
      await replayAlice.readLedger();
      return createAttackLab({
        host: replayHost,
        runtime: replayRuntime,
        clientDirs: [replayAlice.clientDir],
        expectedPlaintext: 'none',
        genesisHex: replayAlice.genesisHex,
      });
    };

    const exact = await replayAttackActions(await spawnReplay(), material.actions, {
      events: material.events,
      frames: material.frames,
      clients: material.clients,
      report,
    });
    expect(exact.divergence).toBeNull();

    const shiftedTime = material.events.map((event, index) =>
      index === 0 ? { ...event, time: event.time + 1 } : event
    );
    const timed = await replayAttackActions(await spawnReplay(), material.actions, {
      events: shiftedTime,
    });
    expect(timed.divergence?.field).toBe('time');
    expect(timed.divergence?.index).toBe(0);

    const tamperedFrames = material.frames.map((frame, index) =>
      index === 0 ? { ...frame, responseHex: '00' } : frame
    );
    const framed = await replayAttackActions(await spawnReplay(), material.actions, {
      frames: tamperedFrames,
    });
    expect(framed.divergence?.field).toBe('frame.response');

    const tamperedClients = material.clients.map((client, index) =>
      index === 0 ? { ...client, ledgerHead: '00' } : client
    );
    const clientDiff = await replayAttackActions(await spawnReplay(), material.actions, {
      clients: tamperedClients,
    });
    expect(clientDiff.divergence?.field).toBe('client.ledgerHead');

    const wrongReport = { ...report, confidentiality: 'violation' as const };
    const verdict = await replayAttackActions(await spawnReplay(), material.actions, {
      report: wrongReport,
    });
    expect(verdict.divergence?.field).toBe('verdict.confidentiality');
  });

  it('flags a replayed backend mutation that misses as a divergence', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    await alice.readLedger();
    await writeLoro(alice, `hidden-${toHex(crypto.getRandomValues(new Uint8Array(8)))}`);
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: alice.genesisHex,
    });
    const ciphertext = await assertLiveCiphertext(alice, 'loro', 'hidden-');
    const hit = await lab.mutateBackend({
      eventId: 'barrier',
      kind: 'xor',
      needleHex: toHex(ciphertext.subarray(0, 16)),
    });
    expect(hit.ok).toBe(true);
    await lab.finish();

    const replayHost = await launchLab();
    const replayAlice = await labClient({
      host: replayHost,
      account: 'alice',
      runtime: new LabRuntime({ mode: 'auto' }),
    });
    await replayAlice.createSpace();
    await replayAlice.readLedger();
    await writeLoro(replayAlice, 'different-content');
    const replayLab = createAttackLab({
      host: replayHost,
      runtime: new LabRuntime({ mode: 'auto' }),
      clientDirs: [replayAlice.clientDir],
      expectedPlaintext: 'none',
      genesisHex: replayAlice.genesisHex,
    });
    await expect(
      replayAttackActions(replayLab, harnessReplayActions(lab) as AttackAction[])
    ).rejects.toThrow('replay-divergence:mutateBackend');
  });

  it('replays harness-private plaintext evidence to the same verdict', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    await alice.readLedger();
    const secret = `claim-${toHex(crypto.getRandomValues(new Uint8Array(8)))}`;
    await writeLoro(alice, secret);
    const lab = createAttackLab({
      host,
      runtime,
      clientDirs: [alice.clientDir],
      expectedPlaintext: secret,
      genesisHex: alice.genesisHex,
      inspectHonest: inspectClient(alice, host),
    });
    await lab.submitClaim({ kind: 'plaintext', evidence: secret });
    const original = await lab.finish();
    expect(original.confidentiality).toBe('violation');
    expect(JSON.stringify(lab.actions())).not.toContain(secret);
    expect(JSON.stringify(harnessReplayActions(lab))).toContain(secret);

    const replayRuntime = new LabRuntime({ mode: 'auto' });
    const replayHost = await launchLab();
    const replayAlice = await labClient({
      host: replayHost,
      account: 'alice',
      runtime: replayRuntime,
    });
    await replayAlice.createSpace();
    await replayAlice.readLedger();
    await writeLoro(replayAlice, secret);
    const replayLab = createAttackLab({
      host: replayHost,
      runtime: replayRuntime,
      clientDirs: [replayAlice.clientDir],
      expectedPlaintext: secret,
      genesisHex: replayAlice.genesisHex,
      inspectHonest: inspectClient(replayAlice, replayHost),
    });
    const replayed = await replayAttackActions(
      replayLab,
      harnessReplayActions(lab) as AttackAction[]
    );
    expect(replayed.report.confidentiality).toBe(original.confidentiality);

    const publicHost = await launchLab();
    const publicAlice = await labClient({
      host: publicHost,
      account: 'alice',
      runtime: new LabRuntime({ mode: 'auto' }),
    });
    await publicAlice.createSpace();
    await publicAlice.readLedger();
    await writeLoro(publicAlice, secret);
    const publicLab = createAttackLab({
      host: publicHost,
      runtime: new LabRuntime({ mode: 'auto' }),
      clientDirs: [publicAlice.clientDir],
      expectedPlaintext: secret,
      genesisHex: publicAlice.genesisHex,
    });
    const publicOnly = await replayAttackActions(publicLab, lab.actions() as AttackAction[]);
    expect(publicOnly.report.confidentiality).toBe('pass');
    expect(original.confidentiality).toBe('violation');
  });
});
