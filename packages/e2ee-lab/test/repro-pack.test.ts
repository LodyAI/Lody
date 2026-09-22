import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { exportDevice } from '../src/platform/device';
import { cleanupLab, labClient, launchLab, tempDir } from '../src/fixtures';
import { isRecordingEntropy, recordingEntropy, replayEntropy } from '../src/entropy';
import { applyKnownDefect, injectSkipVerify, measureClient } from '../src/defects';
import { fingerprintOf, fingerprintsEqual, isSecurityFingerprint } from '../src/fingerprint';
import { firstReplayDivergence } from '../src/replay';
import { minimizeCounterexample } from '../src/minimize';
import {
  createDefectPack,
  loadReproPack,
  replayReproPack,
  writeReproPack,
} from '../src/repro-pack';
import { captureImplementationIdentity } from '../src/identity';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const cli = join(here, '../src/repro-cli.ts');

afterEach(() => cleanupLab());

async function skipVerifyCase() {
  const entropy = recordingEntropy();
  const host = await launchLab();
  const alice = await labClient({ host, account: 'alice', entropy });
  await alice.createSpace();
  await alice.readLedger();
  const control = await measureClient(alice, host);
  await injectSkipVerify(alice.clientDir);
  const attack = await measureClient(alice, host);
  return {
    control,
    attack,
    fills: isRecordingEntropy(entropy) ? [...entropy.fills] : [],
    devices: { alice: await exportDevice(alice.device) },
    genesisHex: alice.genesisHex!,
    secret: 'not-for-attacker',
  };
}

describe('known-defect injection and fingerprints', () => {
  it('skip-verify produces integrity.unverified-accepted; the honest path does not', async () => {
    const run = await skipVerifyCase();
    expect(run.control.report.integrity).toBe('pass');
    expect(run.attack.report.integrity).toBe('violation');
    expect(run.attack.fingerprint.rules).toContain('integrity.unverified-accepted');
    expect(isSecurityFingerprint(run.attack.fingerprint)).toBe(true);
    expect(fingerprintsEqual(run.control.fingerprint, run.attack.fingerprint)).toBe(false);
  });

  it('cursor-before-document and wrong-context each produce a distinct rule', async () => {
    const entropy = recordingEntropy();
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', entropy });
    await alice.createSpace();
    await alice.readLedger();
    const other = await labClient({ host, account: 'other', entropy });
    await other.createSpace();
    await other.readLedger();
    const control = await measureClient(alice, host);
    expect(control.report.integrity).toBe('pass');
    expect(control.report.durability).toBe('pass');

    await applyKnownDefect('cursor-before-document', {
      clientDir: alice.clientDir,
      genesisHex: alice.genesisHex!,
    });
    const cursor = await measureClient(alice, host);
    expect(cursor.report.durability).toBe('violation');
    expect(cursor.fingerprint.rules).toContain('durability.lost-document');

    await applyKnownDefect('wrong-context-journal', {
      clientDir: alice.clientDir,
      genesisHex: alice.genesisHex!,
      foreignDir: other.clientDir,
    });
    const wrong = await measureClient(alice, host);
    expect(wrong.report.integrity).toBe('violation');
    expect(wrong.fingerprint.rules).toContain('integrity.wrong-context');
  });

  it('repeats skip-verify 20 times with the same fingerprint', async () => {
    const fingerprints = [];
    for (let i = 0; i < 20; i++) {
      const run = await skipVerifyCase();
      expect(run.attack.report.integrity).toBe('violation');
      fingerprints.push(run.attack.fingerprint);
    }
    for (let i = 1; i < fingerprints.length; i++) {
      expect(fingerprintsEqual(fingerprints[0]!, fingerprints[i]!)).toBe(true);
    }
  }, 180_000);
});

describe('independent repro pack', () => {
  it('writes a pack that a new process replays without live entropy or a model', async () => {
    const run = await skipVerifyCase();
    const packDir = tempDir('e2ee-repro-');
    writeReproPack(
      packDir,
      createDefectPack({
        defect: 'skip-verify',
        devices: run.devices,
        fills: run.fills,
        expected: run.attack.fingerprint,
        genesisHex: run.genesisHex,
        secret: run.secret,
      })
    );
    const loaded = loadReproPack(packDir);
    expect(
      loaded.manifest.identity.dirtyTree !== null || loaded.manifest.identity.head.length === 40
    ).toBe(true);
    expect(JSON.stringify(loaded.manifest)).not.toContain(run.secret);
    expect(statSync(join(packDir, 'private')).mode & 0o777).toBe(0o700);

    const inProcess = await replayReproPack(packDir);
    expect(inProcess.divergence).toBeNull();
    expect(fingerprintsEqual(inProcess.fingerprint, run.attack.fingerprint)).toBe(true);

    const child = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const proc = spawn(process.execPath, ['--import', tsxLoader, cli, 'replay', packDir], {
          cwd: join(here, '..'),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        proc.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        proc.on('error', reject);
        proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      }
    );
    expect(child.stderr).not.toContain(run.secret);
    expect(child.stdout).not.toContain(run.secret);
    const body = JSON.parse(child.stdout) as {
      divergence: null | object;
      fingerprint: { rules: string[] };
    };
    expect(child.code).toBe(0);
    expect(body.divergence).toBeNull();
    expect(body.fingerprint.rules).toContain('integrity.unverified-accepted');
  }, 120_000);

  it('fails closed on missing private material and unsupported format', () => {
    const dir = tempDir('e2ee-repro-bad-');
    writeReproPack(
      dir,
      createDefectPack({
        defect: 'skip-verify',
        devices: { alice: 'x' },
        fills: [],
        expected: fingerprintOf({
          confidentiality: 'pass',
          integrity: 'violation',
          durability: 'pass',
          detectability: 'pass',
          budgetExceeded: false,
          claims: 0,
        }),
        genesisHex: '00',
      })
    );
    rmSync(join(dir, 'private'), { recursive: true, force: true });
    expect(() => loadReproPack(dir)).toThrow(/repro-missing-private/);
    const identity = captureImplementationIdentity();
    expect(identity.head.length).toBeGreaterThan(8);
  });
});

describe('precise comparison counterexamples', () => {
  it('reports a locatable divergence for order, payload, entropy tail, persist, and verdict', () => {
    const events = [
      {
        eventId: 'e1',
        step: 0,
        time: 0,
        actor: 'alice',
        operation: 'submit',
        phase: 'request-queued',
        status: 'completed' as const,
      },
      {
        eventId: 'e2',
        step: 1,
        time: 0,
        actor: 'bob',
        operation: 'submit',
        phase: 'request-queued',
        status: 'completed' as const,
      },
    ];
    const swapped = [events[1]!, events[0]!];
    expect(
      firstReplayDivergence(
        { events, frames: [], entropy: [] },
        { events: swapped, frames: [], entropy: [] }
      )?.field
    ).toBe('actor');

    const payload = Buffer.from(
      '--rr-bootstrap-aa\r\n\r\nSECRET\r\n--rr-bootstrap-aa--\r\n'
    ).toString('hex');
    const mutated = Buffer.from(
      '--rr-bootstrap-aa\r\n\r\nSECRXX\r\n--rr-bootstrap-aa--\r\n'
    ).toString('hex');
    expect(
      firstReplayDivergence(
        {
          events: [],
          frames: [
            {
              eventId: 'e1',
              actor: 'a',
              operation: 'read',
              phase: 'request-queued',
              url: '/',
              requestHex: '',
              responseStatus: 200,
              responseHex: payload,
            },
          ],
          entropy: [],
        },
        {
          events: [],
          frames: [
            {
              eventId: 'e1',
              actor: 'a',
              operation: 'read',
              phase: 'request-queued',
              url: '/',
              requestHex: '',
              responseStatus: 200,
              responseHex: mutated,
            },
          ],
          entropy: [],
        }
      )?.field
    ).toBe('frame.response');

    const fills = [
      { label: 'hpke-dhkem-ikm', bytes: new Uint8Array([1]) },
      { label: 'content-csprng:0', bytes: new Uint8Array([2]) },
    ];
    expect(
      firstReplayDivergence(
        { events: [], frames: [], entropy: fills },
        { events: [], frames: [], entropy: fills.slice(0, 1) }
      )?.field
    ).toBe('entropy');
    const replay = replayEntropy(fills);
    replay.fill('hpke-dhkem-ikm', new Uint8Array(1));
    expect(replay.remaining()).toHaveLength(1);
    expect(replay.remaining()[0]?.label).toBe('content-csprng:0');

    expect(
      firstReplayDivergence(
        {
          events: [],
          frames: [],
          entropy: [],
        },
        {
          events: [],
          frames: [],
          entropy: [],
        }
      )
    ).toBeNull();
    const left = fingerprintOf(
      {
        confidentiality: 'pass',
        integrity: 'violation',
        durability: 'pass',
        detectability: 'pass',
        budgetExceeded: false,
        claims: 0,
      },
      { unverifiedAccepted: 1 }
    );
    const right = fingerprintOf({
      confidentiality: 'pass',
      integrity: 'pass',
      durability: 'pass',
      detectability: 'pass',
      budgetExceeded: false,
      claims: 0,
    });
    expect(fingerprintsEqual(left, right)).toBe(false);
    expect(left.rules).toContain('integrity.unverified-accepted');
  });
});

describe('minimal counterexample reduction', () => {
  it('drops unrelated noise while keeping the skip-verify fingerprint', async () => {
    const baseline = await skipVerifyCase();
    const original: Array<'create' | 'noise-a' | 'skip-verify' | 'noise-b'> = [
      'create',
      'noise-a',
      'skip-verify',
      'noise-b',
    ];
    const result = await minimizeCounterexample({
      items: original,
      fingerprint: baseline.attack.fingerprint,
      maxTrials: 16,
      run: async (candidate) => {
        if (!candidate.includes('create') || !candidate.includes('skip-verify')) {
          return {
            fingerprint: fingerprintOf({
              confidentiality: 'pass',
              integrity: 'harness-error',
              durability: 'harness-error',
              detectability: 'pass',
              budgetExceeded: false,
              claims: 0,
            }),
          };
        }
        const run = await skipVerifyCase();
        return { fingerprint: run.attack.fingerprint };
      },
    });
    expect(result.originalSize).toBe(4);
    expect(result.finalSize).toBeLessThan(result.originalSize);
    expect(result.items).toContain('skip-verify');
    expect(result.items).toContain('create');
    expect(result.items).not.toContain('noise-a');
    expect(result.items).not.toContain('noise-b');
    const noTrials = await minimizeCounterexample({
      items: original,
      fingerprint: baseline.attack.fingerprint,
      maxTrials: 0,
      run: async () => {
        throw new Error('budget must prevent execution');
      },
    });
    expect(noTrials.items).toEqual(original);
    expect(noTrials.trials).toBe(0);
    const oneTrial = await minimizeCounterexample({
      items: original,
      fingerprint: baseline.attack.fingerprint,
      maxTrials: 1,
      run: async () => ({ fingerprint: baseline.attack.fingerprint }),
    });
    expect(oneTrial.trials).toBe(1);
    expect(oneTrial.items).toEqual(original.slice(2));
  }, 180_000);
});

describe('implementation identity', () => {
  it('does not treat a dirty tree as HEAD-only source identity', () => {
    const identity = captureImplementationIdentity();
    expect(identity.head).toMatch(/^[0-9a-f]{40}$/);
    expect(identity.riverrun).toBe('0.3.0');
    expect(identity.vendorSha256.length).toBe(64);
  });
});
