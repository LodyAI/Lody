import { afterEach, describe, expect, it } from 'vitest';
import { exportDevice, generateDevice } from '../src/platform/device';
import {
  isRecordingEntropy,
  recordingEntropy,
  replayEntropy,
  type EntropyFill,
} from '../src/entropy';
import {
  cleanupLab,
  drainUntil,
  labClient,
  launchLab,
  permitUntil,
  snapshotDevices,
} from '../src/fixtures';
import { firstReplayDivergence, type ReplayMaterial } from '../src/replay';
import { LabRuntime } from '../src/runtime';

afterEach(() => cleanupLab());

async function casOnce(input?: {
  devices?: Record<string, string>;
  extras?: { extra: string; other: string };
  entropy?: readonly EntropyFill[];
}): Promise<{
  material: ReplayMaterial;
  devices: Record<string, string>;
  extras: { extra: string; other: string };
  entropy: EntropyFill[];
  winner: Uint8Array;
}> {
  const runtime = new LabRuntime({ mode: 'manual' });
  const host = await launchLab();
  const recorded = input?.entropy ? replayEntropy(input.entropy) : recordingEntropy();
  const fills = isRecordingEntropy(recorded) ? recorded.fills : [...input!.entropy!];
  const alice = await labClient({
    host,
    account: 'alice',
    runtime,
    entropy: recorded,
    device: input?.devices?.alice,
  });
  const twin = await labClient({
    host,
    account: 'twin',
    runtime,
    entropy: recorded,
    device: input?.devices?.alice,
  });
  await alice.createSpace();
  twin.device = alice.device;
  await twin.reauth();
  await twin.adoptGenesis(alice.genesisHex!);
  const extra = input?.extras?.extra
    ? await (await import('../src/platform/device')).importDevice(input.extras.extra)
    : await generateDevice();
  const other = input?.extras?.other
    ? await (await import('../src/platform/device')).importDevice(input.extras.other)
    : await generateDevice();
  runtime.pause('twin');
  const aliceSubmit = alice.admitDevice(extra, 'personal', false);
  const twinSubmit = twin.admitDevice(other, 'personal', false);
  const casRequest =
    (actor: string) => (event: { actor: string; operation: string; phase: string }) =>
      event.actor === actor && event.operation === 'submit' && event.phase === 'request-queued';
  const aliceCas = await permitUntil(runtime, casRequest('alice'));
  runtime.pause('alice');
  runtime.resumeActor('twin');
  const twinCas = await permitUntil(runtime, casRequest('twin'));
  runtime.pause('twin');
  runtime.resumeActor('alice');
  runtime.permit(aliceCas.eventId);
  const aliceResult = await drainUntil(runtime, aliceSubmit);
  runtime.resumeActor('twin');
  runtime.permit(twinCas.eventId);
  const twinResult = await drainUntil(runtime, twinSubmit);
  expect(aliceResult.status).toBe('committed');
  expect(twinResult.status).toBe('conflict');
  const devices = await snapshotDevices({ alice });
  return {
    material: {
      events: runtime.events(),
      frames: runtime.frames,
      entropy: fills,
    },
    devices,
    extras: { extra: await exportDevice(extra), other: await exportDevice(other) },
    entropy: fills,
    winner: (await drainUntil(runtime, alice.readLedger())).head,
  };
}

async function lostAckOnce(input?: {
  devices?: Record<string, string>;
  extra?: string;
  entropy?: readonly EntropyFill[];
}): Promise<{
  material: ReplayMaterial;
  devices: Record<string, string>;
  extra: string;
  entropy: EntropyFill[];
  status: string;
}> {
  const runtime = new LabRuntime({ mode: 'auto' });
  const host = await launchLab();
  const recorded = input?.entropy ? replayEntropy(input.entropy) : recordingEntropy();
  const alice = await labClient({
    host,
    account: 'alice',
    runtime,
    entropy: recorded,
    device: input?.devices?.alice,
  });
  await alice.createSpace();
  const extra = input?.extra
    ? await (await import('../src/platform/device')).importDevice(input.extra)
    : await generateDevice();
  host.setFailpoint('drop-control-ack');
  let status = 'unknown';
  try {
    status = (await alice.admitDevice(extra, 'personal', false)).status;
  } catch {
    host.setFailpoint('none');
    status = (await alice.resume()).status;
  }
  host.setFailpoint('none');
  const entropy = isRecordingEntropy(recorded) ? recorded.fills : [...input!.entropy!];
  return {
    material: { events: runtime.events(), frames: runtime.frames, entropy },
    devices: await snapshotDevices({ alice }),
    extra: await exportDevice(extra),
    entropy,
    status,
  };
}

describe('P2 protocol-byte replay', () => {
  it('replays CAS in three fresh directories with the same bytes and catches a mutated schedule', async () => {
    const first = await casOnce();
    const second = await casOnce({
      devices: first.devices,
      extras: first.extras,
      entropy: first.entropy,
    });
    const third = await casOnce({
      devices: first.devices,
      extras: first.extras,
      entropy: first.entropy,
    });
    expect(firstReplayDivergence(first.material, second.material)).toBeNull();
    expect(firstReplayDivergence(first.material, third.material)).toBeNull();
    expect(second.winner).toEqual(first.winner);
    const mutated = {
      ...second.material,
      events: second.material.events.map((event, index) =>
        index === 0 ? { ...event, actor: 'intruder' } : event
      ),
    };
    expect(firstReplayDivergence(first.material, mutated)?.field).toBe('actor');
  });

  it('replays lost ACK resume in three fresh directories', async () => {
    const first = await lostAckOnce();
    expect(first.status).toBe('committed');
    const second = await lostAckOnce({
      extra: first.extra,
      devices: first.devices,
      entropy: first.entropy,
    });
    const third = await lostAckOnce({
      extra: first.extra,
      devices: first.devices,
      entropy: first.entropy,
    });
    expect(firstReplayDivergence(first.material, second.material)).toBeNull();
    expect(firstReplayDivergence(first.material, third.material)).toBeNull();
    const mutated =
      second.material.frames.length > 0
        ? {
            ...second.material,
            frames: second.material.frames.map((frame, index) =>
              index === 0 ? { ...frame, requestHex: `${frame.requestHex}00` } : frame
            ),
          }
        : {
            ...second.material,
            entropy: second.material.entropy.map((fill, index) =>
              index === 0 ? { ...fill, bytes: new Uint8Array(fill.bytes.length) } : fill
            ),
          };
    expect(firstReplayDivergence(first.material, mutated)?.field).toMatch(
      /frame\.request|entropy\.bytes/
    );
  });

  it('replays ciphertext mutation in three fresh directories and locates a mutated needle', async () => {
    const runs: Array<{
      mutated: boolean;
      rejected: boolean;
      genesis: string | null;
      material: ReplayMaterial;
    }> = [];
    let devices: Record<string, string> | undefined;
    let entropy: EntropyFill[] | undefined;
    let needle: Uint8Array | undefined;
    for (let i = 0; i < 3; i++) {
      const runtime = new LabRuntime({ mode: 'auto' });
      const host = await launchLab();
      const recorded = entropy ? replayEntropy(entropy) : recordingEntropy();
      const alice = await labClient({
        host,
        account: 'alice',
        runtime,
        entropy: recorded,
        device: devices?.alice,
      });
      await alice.createSpace();
      if (!entropy && isRecordingEntropy(recorded)) entropy = recorded.fills;
      if (!devices) devices = await snapshotDevices({ alice });
      if (!needle) needle = alice.genesis!.subarray(0, 16);
      const dataDir = host.dataDir;
      const dbPath = host.riverrunDbPath;
      await host.close();
      const { mutateSqliteBytes } = await import('../src/attacks');
      const mutated = mutateSqliteBytes(dbPath, needle);
      const restarted = await launchLab(dataDir);
      const alice2 = await labClient({
        host: restarted,
        account: 'alice',
        runtime: new LabRuntime({ mode: 'auto' }),
        entropy: replayEntropy(entropy!),
        device: devices.alice,
        clientDir: alice.clientDir,
      });
      let rejected = false;
      try {
        await alice2.readLedger();
      } catch {
        rejected = true;
      }
      runs.push({
        mutated,
        rejected,
        genesis: alice.genesisHex,
        material: {
          events: runtime.events(),
          frames: runtime.frames,
          entropy: entropy!,
        },
      });
    }
    expect(runs.every((run) => run.genesis === runs[0]!.genesis)).toBe(true);
    expect(firstReplayDivergence(runs[0]!.material, runs[1]!.material)).toBeNull();
    expect(firstReplayDivergence(runs[0]!.material, runs[2]!.material)).toBeNull();
    const mutatedEvents = {
      ...runs[0]!.material,
      entropy: runs[0]!.material.entropy.map((fill, index) =>
        index === 0 ? { ...fill, bytes: new Uint8Array(fill.bytes.length) } : fill
      ),
    };
    expect(firstReplayDivergence(runs[0]!.material, mutatedEvents)?.field).toBe('entropy.bytes');
  });
});
