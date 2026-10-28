import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { expect, it } from 'vitest';
import {
  scanE2eeCanaries,
  canaryFields,
  type CanaryMarkers,
  type CanarySource,
} from '../src/pure/canary';
import { makeLabScenarioFixture } from '../src/platform/scenario-fixture';
import { openLabWorkspaceSession } from '../src/platform/full-session';
import { observeLabBackendBytes } from '../src/platform/backend-observer';
const markers = (): CanaryMarkers =>
  Object.fromEntries(
    canaryFields.map((field) => [field, `CANARY-${field}-${randomBytes(24).toString('hex')}`])
  ) as CanaryMarkers;

it('requires both observed exits and detects deliberately leaked plaintext and encoded bodies', () => {
  const canaries = markers();
  expect(scanE2eeCanaries(canaries, []).missing).toEqual(['streams', 'http']);
  for (const kind of ['streams', 'http'] as const) {
    const leaked = scanE2eeCanaries(canaries, [
      { kind, id: 'deliberate-plaintext', body: new TextEncoder().encode(canaries.message) },
    ]);
    expect(leaked.ok).toBe(false);
    expect(leaked.findings).toEqual([
      { source: 'deliberate-plaintext', kind, field: 'message', encoding: 'utf8', offset: 0 },
    ]);
  }
  const encoded = scanE2eeCanaries(canaries, [
    {
      kind: 'http',
      id: 'base64-input',
      body: new TextEncoder().encode(Buffer.from(canaries.fileName).toString('base64')),
    },
  ]);
  expect(encoded.findings[0]).toMatchObject({ field: 'fileName', encoding: 'base64' });
});

it('scans actual protected Loro/Flock peer traffic and SQLite Streams entries containing all five synthetic inputs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'e2ee-canary-'));
  const canaries = markers(),
    requests: CanarySource[] = [];
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeLabScenarioFixture(join(directory, 'fixture'));
          const capture: typeof fetch = async (value, init) => {
            const request = new Request(value, init);
            if (request.body)
              requests.push({
                kind: 'http',
                id: `request-${requests.length}`,
                body: new Uint8Array(await request.clone().arrayBuffer()),
              });
            return fetch(request);
          };
          const owner = yield* openLabWorkspaceSession({
            ...fixture.input('owner', 'create'),
            fetch: capture,
          });
          const peer = yield* openLabWorkspaceSession({
            ...fixture.input('peer', 'create'),
            fetch: capture,
          });
          yield* owner.keyRound();
          yield* peer.keyRound();
          const message = JSON.stringify({
            message: canaries.message,
            title: canaries.title,
            fileName: canaries.fileName,
          });
          const configuration = JSON.stringify({
            mcpEnvironment: canaries.mcpEnvironment,
            machineConfig: canaries.machineConfig,
          });
          yield* owner.createDocument('loro');
          yield* owner.createDocument('flock');
          yield* owner.append('loro', message);
          yield* owner.append('flock', configuration);
          yield* peer.pull('loro');
          yield* peer.pull('flock');
          expect(yield* peer.text('loro')).toBe(message);
          expect(yield* peer.text('flock')).toBe(configuration);
          const storage = yield* observeLabBackendBytes({
            path: join(fixture.directory, 'riverrun.sqlite'),
            genesis: fixture.genesis,
          });
          expect(storage.metadata.models.loro.entries).toBeGreaterThan(0);
          expect(storage.metadata.models.flock.entries).toBeGreaterThan(0);
          const report = scanE2eeCanaries(canaries, [
            ...requests,
            ...storage.rows.map((row) => ({
              kind: 'streams' as const,
              id: `${row.model}-${row.kind}-${row.storageId}`,
              body: row.body,
            })),
          ]);
          expect(report.missing).toEqual([]);
          expect(report.findings).toEqual([]);
          expect(report.ok).toBe(true);
          const negative = scanE2eeCanaries(canaries, [
            ...requests,
            {
              kind: 'streams',
              id: 'deliberate-regression',
              body: new TextEncoder().encode(message),
            },
          ]);
          expect(negative.findings.some((row) => row.field === 'message')).toBe(true);
          expect(negative.ok).toBe(false);
        })
      )
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
