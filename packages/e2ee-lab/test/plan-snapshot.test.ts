import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { runLabScenario } from '../src/platform/scenario-runner';
import type { LabAction } from '../src/platform/action-executor';

const good = { ok: true } as const;
const actors = [
  { id: 'owner', role: 'owner' },
  { id: 'editor', role: 'admin' },
  { id: 'reader', role: 'guest' },
] as const;
interface DocumentObservation {
  readonly text?: string;
  readonly status: string;
  readonly cursor: { readonly nextOffset: string } | null;
  readonly persisted: {
    readonly documentDigest: string;
    readonly cursorDigest: string | null;
  } | null;
}

it.each(['loro', 'flock'] as const)(
  'runs a three-role %s snapshot plan, recovers a moved snapshot with trimmed history and reopens the durable result',
  async (document) => {
    const directory = mkdtempSync(join(tmpdir(), `lab-plan-snapshot-${document}-`));
    let passed = false;
    try {
      const actions: LabAction[] = [];
      const add = (action: LabAction) => {
        actions.push(action);
        return actions.length - 1;
      };
      for (const { id: actor } of actors)
        add({ kind: 'start', actor, mode: 'create', expect: good });
      for (const { id: actor } of actors)
        add({ kind: 'call', actor, operation: 'keys', expect: good });
      add({ kind: 'call', actor: 'owner', operation: 'create', document, expect: good });
      add({
        kind: 'call',
        actor: 'owner',
        operation: 'append',
        document,
        text: 'authenticated snapshot prefix;',
        expect: good,
      });
      const upload = add({
        kind: 'call',
        actor: 'owner',
        operation: 'upload-snapshot',
        document,
        expect: good,
      });
      add({
        kind: 'call',
        actor: 'owner',
        operation: 'append',
        document,
        text: 'tail after snapshot;',
        expect: good,
      });
      // This admin has never read the document. Its first real SDK pull must
      // consume the published snapshot and the subsequently appended suffix.
      add({ kind: 'call', actor: 'editor', operation: 'pull', document, expect: good });
      const positive = add({
        kind: 'call',
        actor: 'editor',
        operation: 'observe',
        document,
        expect: { ok: true, text: 'authenticated snapshot prefix;tail after snapshot;' },
      });
      // Persist a real empty document so unchangedFrom compares actual native
      // bytes and a null cursor, rather than accepting a missing observation.
      add({ kind: 'persist', actor: 'reader', document, expect: good });
      const baseline = add({
        kind: 'call',
        actor: 'reader',
        operation: 'observe',
        document,
        expect: { ok: true, text: '' },
      });
      const movedOffset = 'attacker-moved-opaque-snapshot-position';
      add({
        kind: 'transport',
        actor: 'reader',
        expect: good,
        action: {
          kind: 'intercept',
          target: { actor: 'reader', stream: document, method: 'GET', occurrence: 0 },
          mutation: { kind: 'headers', headers: { 'stream-snapshot-offset': movedOffset } },
        },
      });
      const replayed = add({
        kind: 'call',
        actor: 'reader',
        operation: 'pull',
        document,
        expect: good,
      });
      const afterReplay = add({
        kind: 'call',
        actor: 'reader',
        operation: 'observe',
        document,
        expect: { ok: true, text: 'authenticated snapshot prefix;tail after snapshot;' },
      });
      // The first pull already retries the authentic native snapshot after the
      // damaged response and trimmed-history fallback. Explicit recovery is an
      // idempotent fresh bootstrap; it does not rewrite
      // a host retention boundary or delete the published snapshot.
      add({ kind: 'call', actor: 'reader', operation: 'recover', document, expect: good });
      const recovered = add({
        kind: 'call',
        actor: 'reader',
        operation: 'observe',
        document,
        expect: { ok: true, text: 'authenticated snapshot prefix;tail after snapshot;' },
      });
      add({ kind: 'crash', actor: 'reader', expect: good });
      add({ kind: 'start', actor: 'reader', mode: 'open', expect: good });
      const reopened = add({
        kind: 'call',
        actor: 'reader',
        operation: 'observe',
        document,
        expect: {
          ok: true,
          text: 'authenticated snapshot prefix;tail after snapshot;',
          unchangedFrom: recovered,
        },
      });
      const artifact = await Effect.runPromise(runLabScenario({ directory, actors, actions }));
      const observations = artifact.run.observations;
      expect(observations).toHaveLength(actions.length);
      expect(observations.filter((row) => row.integrity !== 'pass')).toEqual([]);
      expect(
        observations.filter(
          (row) => row.durability === 'violation' || row.durability === 'harness-error'
        )
      ).toEqual([]);
      expect(observations.filter((row) => !row.reply.ok)).toEqual([]);
      expect(observations[replayed].checks).toEqual({ ok: 'pass' });
      const value = (index: number) => observations[index].reply.value as DocumentObservation;
      expect(value(baseline)).toMatchObject({
        text: '',
        status: 'active',
        cursor: null,
        persisted: { documentDigest: expect.any(String), cursorDigest: null },
      });
      expect(value(afterReplay)).toMatchObject({ status: 'active', text: value(positive).text });
      expect(value(afterReplay).cursor?.nextOffset).toBe(value(positive).cursor?.nextOffset);
      expect(value(afterReplay).persisted?.documentDigest).not.toBe(
        value(baseline).persisted?.documentDigest
      );
      expect(value(afterReplay).persisted?.cursorDigest).toEqual(expect.any(String));
      expect(value(recovered)).toMatchObject({ status: 'active', text: value(positive).text });
      expect(value(recovered).persisted?.documentDigest).not.toBe(
        value(baseline).persisted?.documentDigest
      );
      expect(value(recovered).persisted?.cursorDigest).toEqual(expect.any(String));
      expect(value(reopened).persisted).toEqual(value(recovered).persisted);
      expect(value(reopened).cursor).toEqual(value(recovered).cursor);
      expect(observations[reopened].checks.unchangedFrom).toBe('pass');

      const events = artifact.measurements.transport.events;
      const positiveBootstrap = events.find(
        (event) =>
          event.actor === 'editor' && event.stream === document && event.path.endsWith('/bootstrap')
      );
      expect(positiveBootstrap).toMatchObject({ status: 200, source: 'native' });
      const publication = observations[upload].reply.value as { readonly snapshotOffset: string };
      expect(publication.snapshotOffset).toEqual(expect.any(String));
      expect(publication.snapshotOffset).not.toBe('-1');
      expect(positiveBootstrap?.headers['stream-snapshot-offset']).toBe(publication.snapshotOffset);
      const body = Buffer.from(positiveBootstrap!.bodyHex, 'hex');
      expect(
        body.indexOf(Buffer.from([76, 83, 67, 69, 2, 2, 0, 1, 0, 0, 4]))
      ).toBeGreaterThanOrEqual(0);
      expect(
        body.indexOf(Buffer.from([76, 83, 67, 69, 2, 1, 0, 1, 0, 0, 3]))
      ).toBeGreaterThanOrEqual(0);
      expect(positiveBootstrap!.headers['stream-next-offset']).not.toBe(
        positiveBootstrap!.headers['stream-snapshot-offset']
      );
      expect(value(positive).cursor?.nextOffset).toBe(
        positiveBootstrap!.headers['stream-next-offset']
      );
      const replay = events.find(
        (event) =>
          event.actor === 'reader' &&
          event.stream === document &&
          event.method === 'GET' &&
          event.requestOffset === '-1' &&
          !event.path.endsWith('/bootstrap')
      );
      expect(replay).toMatchObject({ status: 410, source: 'native' });
      const damaged = events.filter((event) => event.mutation === 'headers');
      expect(damaged).toHaveLength(1);
      expect(damaged[0]).toMatchObject({
        actor: 'reader',
        stream: document,
        method: 'GET',
        occurrence: 0,
        status: 200,
        source: 'native',
        headers: { 'stream-snapshot-offset': movedOffset },
      });
      expect(damaged[0].path).toMatch(/\/bootstrap$/);
      // Only the host position changed. The authentic encrypted snapshot and
      // suffix are byte-for-byte the actual native response.
      expect(damaged[0].bodyHex).toBe(damaged[0].originalBodyHex);
      const normalRetry = events.find(
        (event) =>
          event.actor === 'reader' &&
          event.stream === document &&
          event.path.endsWith('/bootstrap') &&
          event.mutation === undefined
      );
      expect(normalRetry).toMatchObject({ status: 200, source: 'native' });
      expect(normalRetry?.headers['stream-snapshot-offset']).toBe(
        positiveBootstrap!.headers['stream-snapshot-offset']
      );
      expect(value(recovered).cursor?.nextOffset).toBe(normalRetry?.headers['stream-next-offset']);
      expect(
        events.some(
          (event) =>
            event.actor === 'owner' &&
            event.stream === document &&
            event.method === 'PUT' &&
            event.path.includes('/snapshot/') &&
            event.status === 204
        )
      ).toBe(true);
      expect(observations[upload].reply.ok).toBe(true);

      // Ordinary reads retain the real native 410. Backend confidentiality is
      // measured independently from actual stored entries and snapshots; this
      // observation neither resets retention nor grants clients old history.
      expect(artifact.ciphertext.find((row) => row.stream === document)?.status).toBe(410);
      expect(
        artifact.run.properties.find((row) => row.id === 'confidentiality.backend-plaintext')
          ?.verdict
      ).toBe('pass');
      expect(artifact.measurements.backend.metadata.snapshots).toBe(1);
      expect(artifact.measurements.backend.metadata.entries).toBeGreaterThan(1);
      expect(artifact.run.verdict).toBe('pass');
      passed = true;
    } finally {
      if (passed) rmSync(directory, { recursive: true, force: true });
      else console.error(`Snapshot plan failure evidence retained at ${directory}`);
    }
  },
  0
);
