import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Identity } from '@loro-dev/roost';
import { fromApplicationJson } from '@loro-dev/roost/lody-history';

const testFile = dirname(fileURLToPath(import.meta.url));
const roostRoot = resolve(testFile, '../../../../roost');
const binaryPath = process.env.ROOST_NODE_OWNER ?? join(roostRoot, 'target/debug/roost-node-owner');
const clientModule = pathToFileURL(join(roostRoot, 'node/client.mjs')).href;
const hasLocalOwner = existsSync(binaryPath) && existsSync(fileURLToPath(clientModule));

const identity = (businessId: string, segmentId = '0') => ({
  kind: 'message' as const,
  businessId,
  segmentId,
});

const content = (text: string) =>
  fromApplicationJson({
    role: text.startsWith('user') ? 'user' : 'assistant',
    timestamp: '2026-10-03T00:00:00.000Z',
    items: [{ type: 'text', text }],
  });

describe.skipIf(!hasLocalOwner)('local Roost active branch adapter contract', () => {
  it('keeps sealed history immutable and makes branch operations CAS/idempotent', async () => {
    const [{ RoostNodeClient }, { NodeLodyHistory }] = await Promise.all([
      import(clientModule),
      import('@loro-dev/roost/lody-history'),
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'lody-roost-branch-'));
    const seed = new Uint8Array(32).fill(8);
    const ownerIdentity = Identity.fromSeed(seed);
    const owner = ownerIdentity.owner();
    const client = new RoostNodeClient({
      binaryPath,
      dbPath: join(directory, 'history.db'),
      seed,
      allowedOwners: [owner],
      clockMs: 1_700_000_000_000n,
      maxQueuedRequests: 16,
      maxQueuedBytes: 8 * 1024 * 1024,
    });

    try {
      await client.ready;
      const stream = client.stream('lody-branch');
      const history = new NodeLodyHistory(stream, owner);
      const viewId = 'conversation-branch';
      const firstIdentity = identity('user-1');
      const secondIdentity = identity('assistant-old');
      const replacementIdentity = identity('assistant-new');

      const initial = await history.readActiveBranch(viewId);
      expect(initial).toMatchObject({
        state: { viewId, revision: 0n, head: null, operationId: null },
        messages: [],
        complete: true,
      });

      const firstInput = {
        kind: 'message' as const,
        ...firstIdentity,
        parents: [],
        content: content('user-first'),
      };
      const first = await history.acceptToView({
        viewId,
        expectedRevision: 0n,
        expectedHead: null,
        operationId: 'branch-1',
        input: firstInput,
      });
      expect(first).toMatchObject({
        operationId: 'branch-1',
        created: true,
        oldHead: null,
        newHead: firstIdentity,
        revision: 1n,
      });
      await history.finish(first.turnId, 1n);

      const firstTurn = await stream.readTurn(first.turnId);
      if (firstTurn.kind !== 'found' || !firstTurn.turn.sealed) {
        throw new Error('first branch turn was not sealed');
      }
      const firstParent = { id: first.turnId, hash: firstTurn.turn.sealed };
      const secondInput = {
        kind: 'message' as const,
        ...secondIdentity,
        parents: [firstParent],
        content: content('assistant-old'),
      };
      const second = await history.acceptToView({
        viewId,
        expectedRevision: 1n,
        expectedHead: firstIdentity,
        operationId: 'branch-2',
        input: secondInput,
      });
      await history.finish(second.turnId, 1n);

      const oldTurnBeforeFork = await stream.readTurn(second.turnId);
      if (oldTurnBeforeFork.kind !== 'found' || !oldTurnBeforeFork.turn.sealed) {
        throw new Error('old branch suffix was not sealed');
      }
      const oldSeal = [...oldTurnBeforeFork.turn.sealed];
      const beforeFork = await history.readActiveBranch(viewId);
      expect(beforeFork.messages.map((row) => row.businessId)).toEqual(['user-1', 'assistant-old']);

      const replacementInput = {
        kind: 'message' as const,
        ...replacementIdentity,
        parents: [firstParent],
        content: content('assistant-new'),
      };
      const forkInput = {
        viewId,
        expectedRevision: 2n,
        expectedHead: secondIdentity,
        operationId: 'branch-fork-1',
        baseTurn: first.turnId,
        supersedes: [secondIdentity],
        input: replacementInput,
      };
      const fork = await history.forkAndActivate(forkInput);
      expect(fork).toMatchObject({
        operationId: 'branch-fork-1',
        created: true,
        oldHead: secondIdentity,
        newHead: replacementIdentity,
        revision: 3n,
      });
      await history.finish(fork.turnId, 1n);

      const afterFork = await history.readActiveBranch(viewId);
      expect(afterFork.messages.map((row) => row.businessId)).toEqual(['user-1', 'assistant-new']);

      const oldTurnAfterFork = await stream.readTurn(second.turnId);
      if (oldTurnAfterFork.kind !== 'found' || !oldTurnAfterFork.turn.sealed) {
        throw new Error('old branch suffix disappeared after fork');
      }
      expect([...oldTurnAfterFork.turn.sealed]).toEqual(oldSeal);
      expect(oldTurnAfterFork.turn.nextSeq).toBe(oldTurnBeforeFork.turn.nextSeq);

      const retry = await history.forkAndActivate(forkInput);
      expect(retry.created).toBe(false);
      expect([...retry.turnId]).toEqual([...fork.turnId]);
      expect(retry.revision).toBe(fork.revision);

      await expect(
        history.forkAndActivate({
          ...forkInput,
          input: { ...replacementInput, content: content('assistant-conflict') },
        })
      ).rejects.toMatchObject({ code: 'conflict' });

      await expect(
        history.forkAndActivate({
          ...forkInput,
          operationId: 'branch-stale',
          expectedRevision: 2n,
        })
      ).rejects.toMatchObject({ code: 'stale' });

      await client.close();
      const reopenedClient = new RoostNodeClient({
        binaryPath,
        dbPath: join(directory, 'history.db'),
        seed,
        allowedOwners: [owner],
        clockMs: 1_700_000_000_000n,
        maxQueuedRequests: 16,
        maxQueuedBytes: 8 * 1024 * 1024,
      });
      try {
        await reopenedClient.ready;
        const reopenedHistory = new NodeLodyHistory(reopenedClient.stream('lody-branch'), owner);
        const restored = await reopenedHistory.readActiveBranch(viewId);
        expect(restored.messages.map((row) => row.businessId)).toEqual(['user-1', 'assistant-new']);
        const reopenedRetry = await reopenedHistory.forkAndActivate(forkInput);
        expect(reopenedRetry.created).toBe(false);
        expect([...reopenedRetry.turnId]).toEqual([...fork.turnId]);
      } finally {
        await reopenedClient.close();
      }
    } finally {
      await client.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
