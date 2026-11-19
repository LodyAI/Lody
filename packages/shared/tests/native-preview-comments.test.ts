import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connectEngine } from '@loro-dev/loro-repo-client/node';
import {
  startNativePreviewHost,
  createNativePreviewComments,
  nativePreviewRoom,
} from '../src/node/native-repo';
import {
  observeRoom,
  deferredObservationSource,
  type ObservationEvent,
} from '../src/room-observation';
import type { SessionId } from '../src/index';
import { comment } from './fixtures/native-preview-comment';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const sid = 'session-a' as SessionId;
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'lody-native-preview-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const host = await startNativePreviewHost(dir);
  cleanup.push(() => host.close());
  const client = await connectEngine(dir, { autoReconnect: false });
  cleanup.push(() => client.close());
  const domain = createNativePreviewComments(client, 'synthetic');
  await domain.ensure();
  return { dir, host, client, domain };
}

it('shares the SDK writer, preserves independent readers and confirms release', async () => {
  const { dir, host, client, domain } = await setup();
  const attached = await startNativePreviewHost(dir);
  expect(attached.role).toBe('client');
  await attached.close();
  const update = signal<void>();
  const seen: unknown[] = [];
  const observation = domain.observe(sid, (event) => {
    seen.push(event);
    if (event.kind === 'changes') update.resolve();
  });
  await observation.ready;
  await domain.mutate(sid, { kind: 'create', comment: comment() });
  await update.promise;
  const read = await domain.read(sid, ['one']);
  expect(read.results[0]?.[0]?.value).toEqual(comment());
  expect(seen).toHaveLength(2);
  expect(await observation.release()).toMatchObject({ status: 'acknowledged' });
  expect(await observation.release()).toMatchObject({ status: 'acknowledged' });
  await domain.mutate(sid, {
    kind: 'resolve',
    commentId: 'one',
    resolvedAt: 2,
    resolvedBy: 'local:test',
  });
  expect(seen).toHaveLength(2);
  expect(host.engine?.stats().namespaces[0]?.flockSubscriptions).toBe(0);
  await client.close();
  const stillAlive = createNativePreviewComments(host.client, 'synthetic');
  expect((await stillAlive.read(sid, ['one'])).results[0]?.[0]?.value).toMatchObject({
    resolvedAt: 2,
  });
});

it('uses precise negative read conditions and rejects conflicting updates atomically', async () => {
  const { client, domain } = await setup();
  await domain.mutate(sid, { kind: 'create', comment: comment() });
  await expect(
    domain.mutate(sid, { kind: 'create', comment: { ...comment(), body: 'different' } })
  ).rejects.toThrow('id_conflict');
  await expect(
    domain.mutate(sid, { kind: 'mark-submitted', commentIds: ['one', 'missing'], submittedAt: 3 })
  ).rejects.toThrow('not_found');
  expect((await domain.read(sid, ['one'])).results[0]?.[0]?.value).toMatchObject({
    status: 'completed',
  });
  const read = await domain.read(sid, ['one']);
  await domain.mutate(sid, { kind: 'create', comment: comment('unrelated') });
  await client.flockBatchConditional(
    'synthetic',
    nativePreviewRoom,
    [{ op: 'put', key: ['comment', sid, 'one'], value: { ...comment(), body: 'conditional' } }],
    read.readSet
  );
  await expect(
    client.flockBatchConditional(
      'synthetic',
      nativePreviewRoom,
      [{ op: 'delete', key: ['comment', sid, 'one'] }],
      read.readSet
    )
  ).rejects.toThrow();
  const page = await domain.page(sid);
  expect(page.eof).toBe(true);
  expect(page.examinedRows).toBeLessThanOrEqual(128);
});

it('persists comments across a real host stop/reopen', async () => {
  const { dir, host, client, domain } = await setup();
  await domain.mutate(sid, { kind: 'create', comment: comment() });
  await client.close();
  await host.close();
  const reopened = await startNativePreviewHost(dir);
  cleanup.push(() => reopened.close());
  expect(
    (await createNativePreviewComments(reopened.client, 'synthetic').read(sid, ['one']))
      .results[0]?.[0]?.value
  ).toEqual(comment());
});

it('invalidates an observation on disconnect and never applies an old-generation patch', async () => {
  const { host, client, domain } = await setup();
  const invalid = signal<void>();
  const observed = domain.observe(sid, (event) => {
    if (event.kind === 'invalidated') invalid.resolve();
  });
  await observed.ready;
  await host.close();
  await invalid.promise;
  expect(await observed.release()).toMatchObject({ status: 'disconnected' });
  await client.close();
});

it('cancels establishment and shares/retries failed release without delivering stale rows', async () => {
  const acquired = signal<void>();
  const released = signal<void>();
  let emit!: (event: ObservationEvent<number>) => void;
  let fail = true;
  const events: ObservationEvent<number>[] = [];
  const observation = observeRoom(
    deferredObservationSource<number>(async (listener) => {
      emit = listener;
      await acquired.promise;
      return {
        ready: Promise.resolve(),
        handle: {
          async release() {
            if (fail) throw new Error('online release failure');
            await released.promise;
            return { status: 'acknowledged' as const, generation: 7 };
          },
        },
      };
    }),
    (event) => events.push(event)
  );
  const first = observation.release();
  acquired.resolve();
  await expect(first).rejects.toThrow('online release failure');
  emit({ kind: 'snapshot', entries: [1], generation: 7 });
  expect(events).toEqual([]);
  fail = false;
  const retry = observation.release();
  expect(observation.release()).toBe(retry);
  released.resolve();
  expect(await retry).toEqual({ status: 'acknowledged', generation: 7 });
});

it('attaches from another OS process without creating a second writer', async () => {
  const { dir, host, domain } = await setup();
  await domain.mutate(sid, { kind: 'create', comment: comment() });
  const source = `
    import { ensureEngineHost } from ${JSON.stringify(import.meta.resolve('@loro-dev/loro-repo-client/node'))};
    import * as addon from ${JSON.stringify(import.meta.resolve('@loro-dev/loro-repo-engine'))};
    const host = await ensureEngineHost({ addon, dataDir: process.argv[1] });
    if (host.role !== 'client') throw new Error('unexpected second writer');
    const room = { kind: 'flock', id: 'preview-comments-v1' };
    const read = await host.client.flockReadMany('synthetic', room, [{ kind: 'key', key: ['comment', 'session-a', 'one'] }]);
    await host.client.flockBatchConditional('synthetic', room, [{ op: 'put', key: ['comment', 'session-a', 'one'], value: { ...read.results[0][0].value, body: 'child process' } }], read.readSet);
    await host.close();
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', source, dir]);
  expect(host.engine?.exited).toBe(false);
  expect((await domain.read(sid, ['one'])).results[0]?.[0]?.value).toMatchObject({
    body: 'child process',
  });
});

it('replaces the invalidated generation with a fresh snapshot after host restart', async () => {
  const { dir, host, domain } = await setup();
  await domain.mutate(sid, { kind: 'create', comment: comment() });
  const reconnecting = await connectEngine(dir, { queueWhileReconnecting: false });
  cleanup.push(() => reconnecting.close());
  const invalid = signal<void>();
  const reset = signal<void>();
  let snapshots = 0;
  let resetValue: unknown;
  const observation = createNativePreviewComments(reconnecting, 'synthetic').observe(
    sid,
    (event) => {
      if (event.kind === 'invalidated') invalid.resolve();
      if (event.kind === 'snapshot' && ++snapshots > 1) {
        resetValue = event.entries[0]?.value;
        reset.resolve();
      }
    }
  );
  await observation.ready;
  await host.close();
  await invalid.promise;
  const next = await startNativePreviewHost(dir);
  cleanup.push(() => next.close());
  await reset.promise;
  expect(resetValue).toMatchObject({ id: 'one', body: 'Synthetic comment' });
  expect(await observation.release()).toMatchObject({ status: 'acknowledged' });
});
