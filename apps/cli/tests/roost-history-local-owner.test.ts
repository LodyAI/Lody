import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Identity } from '@loro-dev/roost';
import { fromApplicationJson } from '@loro-dev/roost/lody-history';
import { createRoostHistoryReader } from '@lody/shared/session-data';
import { createRoostReadPort } from '../src/session/roost-history-port';
import { RoostNativeClient } from '@loro-dev/roost-node';
import { reportRoostHistoryFailure } from '../src/session/roost-history-diagnostics';

describe('local Roost owner adapter', () => {
  const workerClient = (workerUrl: URL) =>
    new RoostNativeClient({
      dbPath: join(tmpdir(), 'synthetic-roost-worker.db'),
      seed: new Uint8Array(32).fill(7),
      allowedOwners: [],
      maxQueuedRequests: 4,
      maxQueuedBytes: 1024 * 1024,
      workerUrl,
    });
  const workerSource = (body: string) =>
    new URL(
      `data:text/javascript,${encodeURIComponent(
        `import { parentPort } from 'node:worker_threads'; ${body}`
      )}`
    );

  it('retains the original Worker initialization exception and its cause', async () => {
    const client = workerClient(
      workerSource(
        `throw new Error('synthetic Worker startup failure', { cause: new Error('synthetic missing dependency') });`
      )
    );
    try {
      await expect(client.ready).rejects.toMatchObject({
        code: 'workerFailed',
        cause: {
          message: 'synthetic Worker startup failure',
          cause: { message: 'synthetic missing dependency' },
        },
      });
      await client.exited;
      expect(client.failure?.cause).toMatchObject({ message: 'synthetic Worker startup failure' });
      expect(Object.keys(client.failure ?? {})).not.toContain('cause');
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('keeps a real binding-load fault instead of reducing it to nativeUnavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-roost-load-fault-'));
    const workerUrl = new URL('worker.mjs', import.meta.resolve('@loro-dev/roost-node'));
    await writeFile(join(directory, 'worker.mjs'), await readFile(workerUrl));
    await writeFile(
      join(directory, 'binding.cjs'),
      `throw new Error('synthetic binding load failure', { cause: new Error('synthetic missing library') });`
    );
    const client = workerClient(pathToFileURL(join(directory, 'worker.mjs')));
    try {
      await expect(client.ready).rejects.toMatchObject({
        code: 'nativeUnavailable',
        cause: {
          message: 'synthetic binding load failure',
          cause: { message: 'synthetic missing library' },
        },
      });
    } finally {
      await client.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['throw', 'exit'] as const)(
    'preserves dispatched and queued outcomes after a Worker %s',
    async (kind) => {
      const client = workerClient(
        workerSource(`
      parentPort.postMessage({ kind: 'ready', owner: '00'.repeat(32) });
      parentPort.on('message', () => {
        ${kind === 'throw' ? "throw new Error('synthetic write failure');" : 'process.exit(23);'}
      });
    `)
      );
      try {
        await client.ready;
        const stream = client.stream('synthetic-history');
        const outcomes = await Promise.allSettled([
          stream.create([], '{}'),
          stream.latestTurnHeaders(1n),
        ]);
        const failed = outcomes.map((outcome) => {
          expect(outcome.status).toBe('rejected');
          if (outcome.status !== 'rejected') throw new Error('Worker failure was lost');
          return outcome.reason as Error;
        });
        expect(failed[0]).toMatchObject({ code: 'unknownOutcome' });
        expect(failed[1]).toMatchObject({ code: 'notDispatched' });
        const records: unknown[] = [];
        const logger = {
          error: (_label: unknown, record: unknown) => {
            records.push(record);
          },
        };
        const failure = reportRoostHistoryFailure(failed[0], { stage: 'write' }, logger);
        const queued = reportRoostHistoryFailure(failed[1], { stage: 'write' }, logger);
        expect(failure.diagnosticId).toBe(queued.diagnosticId);
        expect(failure.message).toContain('diagnostic=');
        expect(failure.message).not.toContain('synthetic write failure');
        expect(JSON.stringify(records)).toContain(
          kind === 'throw' ? 'synthetic write failure' : 'code 23'
        );
        await expect(stream.latestTurnHeaders(1n)).rejects.toMatchObject({
          code: 'closed',
          cause: { code: kind === 'throw' ? 'workerFailed' : 'workerExited' },
        });
        expect((await client.exited).code).toBe(kind === 'exit' ? 23 : 1);
      } finally {
        await client.close().catch(() => undefined);
      }
    }
  );

  it('projects physical successor segments into one logical Lody turn', async () => {
    const { NodeLodyHistory } = await import('@loro-dev/roost/lody-history');
    const directory = await mkdtemp(join(tmpdir(), 'lody-roost-local-'));
    const seed = new Uint8Array(32).fill(7);
    const identity = Identity.fromSeed(seed);
    const client = new RoostNativeClient({
      dbPath: join(directory, 'history.db'),
      seed,
      allowedOwners: [identity.owner()],
      clockMs: 1_700_000_000_000n,
      maxQueuedRequests: 16,
      maxQueuedBytes: 8 * 1024 * 1024,
    });

    try {
      await client.ready;
      const history = new NodeLodyHistory(client.stream('lody-adapter'), identity.owner());
      const accept = (businessId: string, segmentId: string, content: unknown) =>
        history.accept({
          kind: 'message' as const,
          businessId,
          segmentId,
          parents: [],
          content: fromApplicationJson(content),
        });

      await accept('user-1', '0', {
        role: 'user',
        timestamp: '2026-10-03T00:00:00.000Z',
        items: [{ type: 'text', text: 'hello' }],
      });
      await accept('assistant-1', 'primary', {
        role: 'assistant',
        timestamp: '2026-10-03T00:00:01.000Z',
        userTurnId: 'user-1',
        items: [{ type: 'text', text: 'first' }],
        finished: false,
      });
      await accept('assistant-1', 'late-output', {
        items: [{ type: 'text', text: 'late' }],
        finished: true,
      });

      const physical = await history.readProjectedMessages();
      const reader = createRoostHistoryReader(
        createRoostReadPort(history, () => ({
          initial: history.readProjectedMessages(),
          unsubscribe: () => {},
        }))
      );
      const logical = await reader.readAll();

      expect(physical).toHaveLength(3);
      expect(logical).toHaveLength(2);
      expect(logical[1]).toMatchObject({
        id: 'assistant-1',
        role: 'assistant',
        finished: true,
      });
      expect(logical[1]?.items).toEqual([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'late' },
      ]);
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
