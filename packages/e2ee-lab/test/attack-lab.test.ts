import { afterEach, describe, expect, it } from 'vitest';
import { writeLoro } from '../src/platform/content-session';
import { toHex } from '../src/platform/bytes';
import {
  createAttackLab,
  replayAttackActions,
  type AttackAction,
  type AttackLab,
} from '../src/attack-lab';
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

/** Capability-only explorer: observe, scan ciphertext, mutate, claim, finish. */
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
    const replayed = await replayAttackActions(replayLab, first.actions as AttackAction[]);
    expect(replayed.confidentiality).toBe(first.report.confidentiality);
    expect(replayed.budgetExceeded).toBe(false);
  });
});
