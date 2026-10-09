import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Identity } from '@loro-dev/roost';
import { fromApplicationJson } from '@loro-dev/roost/lody-history';
import { createRoostHistoryReader } from '@lody/shared/session-data';
import { createRoostReadPort } from '../src/session/roost-history-port';

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
