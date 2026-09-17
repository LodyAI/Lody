import { afterEach, describe, expect, it } from 'vitest';
import { writeLoro } from '../src/platform/content-session';
import { generateDevice } from '../src/platform/device';
import { toHex } from '../src/platform/bytes';
import {
  createAttackLab,
  harnessReplayActions,
  replayAttackActions,
  type AttackAction,
  type AttackLab,
} from '../src/attack-lab';
import { maliciousAppendCas, riverrunNextOffset, riverrunRecordCount } from '../src/attacks';
import { cleanupLab, labClient, launchLab } from '../src/fixtures';
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
      inspectHonest: async () => ({
        ledgerLength: (await alice.readLedger()).length,
        expectedLength: 1,
      }),
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
      inspectHonest: async () => ({
        ledgerLength: (await alice.readLedger()).length,
        expectedLength: 1,
      }),
    });
    const report = await lab.finish();
    expect((await alice.readLedger()).length).toBe(2);
    expect(report.integrity).toBe('violation');
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
      inspectHonest: async () => ({
        ledgerLength: (await alice.readLedger()).length,
        expectedLength: 1,
      }),
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
    expect(report.integrity).not.toBe('pass');
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
    await runtime.whenRequested(1);
    const queued = runtime.events().find((event) => event.status === 'requested');
    expect(queued).toBeDefined();
    await lab.intercept({ eventId: queued!.eventId, kind: 'drop' });
    runtime.permit(queued!.eventId);
    expect((await admit).status).toBe('unknown');
    const report = await lab.finish();
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
    await runtime.whenRequested(1);
    const queued = runtime.events().find((event) => event.status === 'requested');
    expect(queued).toBeDefined();
    await lab.intercept({ eventId: queued!.eventId, kind: 'delay' });
    runtime.permit(queued!.eventId);
    await runtime.whenRequested(1);
    const ack = runtime
      .events()
      .find((event) => event.phase === 'ack-queued' && event.status === 'requested');
    expect(ack).toBeDefined();
    runtime.permit(ack!.eventId);
    expect((await admit).status).toBe('committed');
    await lab.finish();
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
    await runtime.whenRequested(1);
    const queued = runtime.events().find((event) => event.status === 'requested');
    expect(queued).toBeDefined();
    await lab.intercept({ eventId: queued!.eventId, kind: 'duplicate' });
    runtime.permit(queued!.eventId);
    expect((await admit).status).toBe('committed');
    expect((await alice.readLedger()).length).toBe(2);
    await lab.finish();
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
    await runtime.whenRequested(1);
    const queued = runtime.events().find((event) => event.status === 'requested');
    expect(queued).toBeDefined();
    await lab.intercept({
      eventId: queued!.eventId,
      kind: 'replace',
      status: 502,
      bodyHex: '7b226572726f72223a227265706c616365227d',
    });
    runtime.permit(queued!.eventId);
    expect((await admit).status).toBe('unknown');
    const resumed = alice.resume();
    await runtime.whenRequested(1);
    const retry = runtime.events().find((event) => event.status === 'requested');
    expect(retry).toBeDefined();
    runtime.permit(retry!.eventId);
    expect((await resumed).status).toBe('committed');
    await lab.finish();
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
    await runtime.whenRequested(1);
    const queued = runtime.events().find((event) => event.status === 'requested');
    expect(queued).toBeDefined();
    await lab.intercept({ eventId: queued!.eventId, kind: 'truncate' });
    runtime.permit(queued!.eventId);
    const status = (await admit).status;
    expect(status === 'unknown' || status === 'committed').toBe(true);
    if (status === 'unknown') {
      expect((await alice.resume()).status).toBe('committed');
    }
    expect((await alice.readLedger()).state.devices.has(toHex(extra.publicKey))).toBe(true);
    await lab.finish();
  });
});

describe('P4 recorded agent exploration', () => {
  it('runs a capability-only exploration and replays it without an LLM', async () => {
    const runtime = new LabRuntime({ mode: 'auto' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
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
    });
    await replayAlice.createSpace();
    await replayAlice.readLedger();
    const replaySecret = 'hidden-replay';
    await writeLoro(replayAlice, replaySecret);
    const replayLab = createAttackLab({
      host: replayHost,
      runtime: replayRuntime,
      clientDirs: [replayAlice.clientDir],
      expectedPlaintext: replaySecret,
      genesisHex: replayAlice.genesisHex,
    });
    const replayed = await replayAttackActions(
      replayLab,
      harnessReplayActions(lab) as AttackAction[]
    );
    expect(replayed.confidentiality).toBe(first.report.confidentiality);
    expect(replayed.budgetExceeded).toBe(false);
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
      inspectHonest: async () => ({
        ledgerLength: (await alice.readLedger()).length,
        expectedLength: 1,
      }),
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
    });
    const replayed = await replayAttackActions(
      replayLab,
      harnessReplayActions(lab) as AttackAction[]
    );
    expect(replayed.confidentiality).toBe(original.confidentiality);

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
    expect(publicOnly.confidentiality).toBe('pass');
    expect(original.confidentiality).toBe('violation');
  });
});
