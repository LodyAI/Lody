import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { generateDevice } from '../src/platform/device';
import { readLoro, writeLoro } from '../src/platform/content-session';
import { recordingEntropy } from '../src/entropy';
import { loroCursorPath } from '../src/platform/persist';
import {
  cleanupLab,
  drainRuntime,
  drainUntil,
  labClient,
  launchLab,
  permitUntil,
} from '../src/fixtures';
import { LabRuntime } from '../src/runtime';

afterEach(() => cleanupLab());

describe('P2 permit runtime', () => {
  it('does not send CAS until permitted and can pause one actor', async () => {
    const runtime = new LabRuntime({ mode: 'manual' });
    const host = await launchLab();
    const entropy = recordingEntropy();
    const alice = await labClient({ host, account: 'alice', runtime, entropy });
    const twin = await labClient({
      host,
      account: 'twin',
      runtime,
      entropy,
      device: undefined,
    });
    await alice.createSpace();
    twin.device = alice.device;
    await twin.reauth();
    await twin.adoptGenesis(alice.genesisHex!);
    const extra = await generateDevice();
    const other = await generateDevice();
    runtime.pause('twin');
    const aliceSubmit = alice.admitDevice(extra, 'personal', false);
    const twinSubmit = twin.admitDevice(other, 'personal', false);
    await runtime.whenRequested(2);
    const casRequest =
      (actor: string) => (event: { actor: string; operation: string; phase: string }) =>
        event.actor === actor && event.operation === 'submit' && event.phase === 'request-queued';
    const aliceCas = await permitUntil(runtime, casRequest('alice'));
    expect(
      runtime.events().some((event) => event.actor === 'twin' && event.status === 'permitted')
    ).toBe(false);
    runtime.pause('alice');
    runtime.resumeActor('twin');
    // Twin reads the pre-alice state and queues a now-stale CAS.
    const twinCas = await permitUntil(runtime, casRequest('twin'));
    runtime.pause('twin');
    runtime.resumeActor('alice');
    runtime.permit(aliceCas.eventId);
    const aliceResult = await drainUntil(runtime, aliceSubmit);
    expect(aliceResult.status).toBe('committed');
    runtime.resumeActor('twin');
    runtime.permit(twinCas.eventId);
    const twinResult = await drainUntil(runtime, twinSubmit);
    expect(twinResult.status).toBe('conflict');
    expect((await drainUntil(runtime, alice.readLedger())).state.devices.size).toBe(2);
  });

  it('does not complete a Loro write until content POST is permitted', async () => {
    const runtime = new LabRuntime({ mode: 'manual' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    await drainUntil(runtime, alice.readLedger());
    const pending = writeLoro(alice, 'gated-content');
    await runtime.whenRequested(1);
    expect(runtime.events().some((event) => event.operation === 'content')).toBe(true);
    const stop = drainRuntime(runtime);
    try {
      await pending;
      expect(await readLoro(alice)).toContain('gated-content');
    } finally {
      stop();
    }
    const phases = runtime.events().map((event) => event.phase);
    expect(phases).toContain('request-queued');
    expect(phases).toContain('document-persisted');
    expect(phases).toContain('cursor-persisted');
    expect(phases).toContain('import');
    expect(phases).toContain('deliver');
  });

  it('keeps nested persist phases as separately permitted child events', async () => {
    const runtime = new LabRuntime({ mode: 'manual' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    const stop0 = drainRuntime(runtime);
    try {
      await alice.readLedger();
      await writeLoro(alice, 'parent-seed');
    } finally {
      stop0();
    }
    const read = readLoro(alice);
    const imported = await permitUntil(
      runtime,
      (event) => event.operation === 'content' && event.phase === 'import'
    );
    runtime.permit(imported.eventId);
    // Reads inside the import phase surface as child events needing permits.
    const nestedRead = await permitUntil(
      runtime,
      (event) => event.parent === imported.eventId && event.phase === 'request-queued'
    );
    expect(nestedRead.parent).toBe(imported.eventId);
    const stop = drainRuntime(runtime);
    try {
      await read;
      const nestedPersist = runtime
        .events()
        .filter((event) => event.phase === 'cursor-persisted' && event.parent === imported.eventId);
      expect(nestedPersist.length).toBeGreaterThan(0);
      expect(nestedPersist.every((event) => event.status === 'completed')).toBe(true);
    } finally {
      stop();
    }
    expect(existsSync(loroCursorPath(alice.clientDir))).toBe(true);
  });

  it('gates failure delivery so error timing stays controlled', async () => {
    const runtime = new LabRuntime({ mode: 'manual' });
    const host = await launchLab();
    const alice = await labClient({ host, account: 'alice', runtime });
    await alice.createSpace();
    const read = alice.readLedger();
    let settled: string | null = null;
    const outcome = read.then(
      () => 'resolved',
      (error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`
    );
    void outcome.then((value) => {
      settled = value;
    });
    const request = await permitUntil(
      runtime,
      (event) =>
        event.actor === 'alice' && event.operation === 'read' && event.phase === 'request-queued'
    );
    runtime.intercept({ eventId: request.eventId, kind: 'drop' });
    runtime.permit(request.eventId);
    // The failure is ready but not yet deliverable: a deliver event must be
    // requested and stay unpermitted while the read promise remains unsettled.
    const deliver = await permitUntil(
      runtime,
      (event) => event.actor === 'alice' && event.operation === 'read' && event.phase === 'deliver'
    );
    expect(deliver.status).toBe('requested');
    expect(settled).toBeNull();
    runtime.permit(deliver.eventId);
    // StreamsClient maps the dropped fetch to an 'unknown' stream error, but
    // the failure only reached the caller after the deliver permit.
    expect(await outcome).toBe('rejected:stream-read-unknown');
  });

  it('rejects pending gates on close instead of leaving them hanging', async () => {
    const runtime = new LabRuntime({ mode: 'manual' });
    const gated = runtime.gate('alice', 'submit', 'request-queued').then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    const requested = runtime.whenRequested(2).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    await runtime.whenRequested(1);
    runtime.close();
    expect(await gated).toBe('runtime-closed');
    expect(await requested).toBe('runtime-closed');
    await expect(runtime.gate('alice', 'submit', 'request-queued')).rejects.toThrow(
      'runtime-closed'
    );
  });
});
