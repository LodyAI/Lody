import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Identity } from '@loro-dev/roost';
import { fromApplicationJson } from '@loro-dev/roost/lody-history';
import { createRoostHistoryReader } from '@lody/shared/session-data';
import { createRoostReadPort } from '../src/session/roost-history-port';
import { createRoostHistoryChanges } from '../src/session/roost-history-changes';

const assistantContent = (text: string, finished = false) =>
  fromApplicationJson({
    role: 'assistant',
    timestamp: '2026-10-03T00:00:01.000Z',
    items: [{ type: 'text', text }],
    finished,
  });

describe('local Roost history writes', () => {
  it('appends and seals assistant output, merges late segments, and records permission separately', async () => {
    const [{ RoostNativeClient }, { NodeLodyHistory }] = await Promise.all([
      import('@loro-dev/roost-node'),
      import('@loro-dev/roost/lody-history'),
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'lody-roost-writes-'));
    const seed = new Uint8Array(32).fill(9);
    const owner = Identity.fromSeed(seed).owner();
    const client = new RoostNativeClient({
      dbPath: join(directory, 'history.db'),
      seed,
      allowedOwners: [owner],
      clockMs: 1_700_000_000_000n,
      maxQueuedRequests: 16,
      maxQueuedBytes: 8 * 1024 * 1024,
    });

    try {
      await client.ready;
      const stream = client.stream('lody-writes');
      const history = new NodeLodyHistory(stream, owner);
      const primary = await history.accept({
        kind: 'message',
        businessId: 'assistant-1',
        segmentId: 'primary',
        parents: [],
        content: assistantContent('hello'),
      });

      await history.append(primary.turnId, 1n, [
        {
          kind: 'appendText',
          path: [{ key: 'items' }, { index: 0n }, { key: 'text' }],
          text: ' world',
        },
      ]);
      await history.finish(primary.turnId, 2n);

      const beforePermission = await stream.readTurn(primary.turnId);
      const late = await history.accept({
        kind: 'message',
        businessId: 'assistant-1',
        segmentId: 'late-output',
        parents: [],
        content: assistantContent('late', true),
      });

      const reader = createRoostHistoryReader(
        createRoostReadPort(history, () => ({
          initial: history.readProjectedMessages(),
          unsubscribe: () => {},
        }))
      );
      const projected = await reader.readAll();
      expect(projected).toHaveLength(1);
      expect(projected[0]).toMatchObject({
        id: 'assistant-1',
        role: 'assistant',
        finished: true,
      });
      expect(projected[0]?.items).toEqual([
        { type: 'text', text: 'hello world' },
        { type: 'text', text: 'late' },
      ]);

      const permission = await history.respondPermission({
        requestId: 'permission-1',
        assistantBusinessId: 'assistant-1',
        outcome: fromApplicationJson('approved'),
        parents: [],
      });
      const permissionRetry = await history.respondPermission({
        requestId: 'permission-1',
        assistantBusinessId: 'assistant-1',
        outcome: fromApplicationJson('approved'),
        parents: [],
      });
      expect(permission.created).toBe(true);
      expect(permissionRetry.created).toBe(false);
      expect([...permissionRetry.turnId]).toEqual([...permission.turnId]);

      const afterPermission = await stream.readTurn(primary.turnId);
      expect(afterPermission).toEqual(beforePermission);
      expect(late.created).toBe(true);
      const permissionTurn = await stream.readTurn(permission.turnId);
      expect(permissionTurn.kind).toBe('found');
      if (permissionTurn.kind === 'found') expect(permissionTurn.turn.sealed).not.toBeNull();
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});

it('recovers verified native change intervals and refuses a missing interval after reopen', async () => {
  const { RoostNativeClient } = await import('@loro-dev/roost-node');
  const directory = await mkdtemp(join(tmpdir(), 'lody-roost-changes-'));
  const seed = new Uint8Array(32).fill(17);
  const owner = Identity.fromSeed(seed).owner();
  const dbPath = join(directory, 'history.db');
  let client = new RoostNativeClient({
    dbPath,
    seed,
    allowedOwners: [owner],
    clockMs: 1_700_000_000_000n,
    maxQueuedRequests: 16,
    maxQueuedBytes: 8 * 1024 * 1024,
  });
  try {
    await client.ready;
    let stream = client.stream('synthetic-changes');
    let journal = createRoostHistoryChanges(
      () => stream,
      () => 'synthetic-owner'
    );
    const initial = await journal.checkpoint(0n);
    const first = await stream.create([], '{"text":"first"}');
    await journal.record(0n, 1n, { kind: 'changed', businessIds: ['logical-first'] }, true);
    await stream.edit(first.updates[0]!.turnId, 1n, [
      { kind: 'appendText', path: [{ key: 'text' }], text: ' update' },
    ]);
    await journal.record(1n, 2n, { kind: 'structure', from: 4, to: 5 }, true, [
      'logical-early-status',
    ]);
    const recovered = await journal.read(initial, 2n);
    expect(recovered).toMatchObject({
      state: 'ready',
      from: 4,
      ids: ['logical-first', 'logical-early-status'],
    });
    await client.close();
    client = new RoostNativeClient({
      dbPath,
      seed,
      allowedOwners: [owner],
      clockMs: 1_700_000_000_000n,
      maxQueuedRequests: 16,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    await client.ready;
    stream = client.stream('synthetic-changes');
    journal = createRoostHistoryChanges(
      () => stream,
      () => 'synthetic-owner'
    );
    expect(await journal.read(initial, 2n)).toEqual(recovered);
    await stream.create([], '{"text":"unrecorded"}');
    await stream.create([], '{"text":"later"}');
    await journal.record(3n, 4n, { kind: 'changed', businessIds: ['later'] }, true);
    expect(await journal.read(initial, 4n)).toMatchObject({ state: 'reset' });
    const foreign = createRoostHistoryChanges(
      () => stream,
      () => 'foreign-owner'
    );
    expect(await foreign.read(initial, 4n)).toMatchObject({ state: 'reset' });
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
