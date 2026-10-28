import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { Clock, Deferred, Effect, Fiber } from 'effect';
import { it as effectIt } from '@effect/vitest';
import { TestClock } from 'effect/testing';
import {
  makeEncryptedStreamsRpc,
  makeEncryptedRpcListener,
} from '@lody/loro-streams-rpc/e2ee-streams';
import type { LoroStreamsJsonStreamClient } from '@lody/loro-streams-rpc';
import { encryptedRpcFixture } from '../../../../../packages/loro-streams-rpc/tests/fixtures/e2ee-native-fixture';
import { RealtimeJournal } from './realtime-journal';
import { makeEncryptedAgentExecution } from './agent-execution';
import { makeEncryptedRpcReceiver, makeEncryptedQueryReceiver } from './realtime-rpc';

const fixtures: ReturnType<typeof encryptedRpcFixture>[] = [];
afterEach(() => {
  for (const value of fixtures.splice(0)) value.close();
});
function fixture() {
  const f = encryptedRpcFixture();
  fixtures.push(f);
  let now = 1000;
  let permitted = true;
  let rejectPublish = false;
  let offers = 0;
  const published: unknown[] = [];
  const receipts = RealtimeJournal.create(join(f.directory, 'receipts.sqlite'), () => now);
  const execution = RealtimeJournal.create(join(f.directory, 'execution.sqlite'), () => now);
  const client: LoroStreamsJsonStreamClient = {
    ensureJsonStream: async () => {},
    appendJson: async (_stream, frame) => {
      if (rejectPublish) throw new Error('synthetic offline');
      published.push(frame);
      return '1';
    },
    readJsonLive: async () => {
      throw new Error('not used by receiver');
    },
  };
  const authorize = () =>
    Effect.succeed(
      permitted
        ? { _tag: 'Authorized' as const }
        : { _tag: 'Denied' as const, reason: 'synthetic revoked' }
    );
  const receiver = (journal = receipts) =>
    makeEncryptedRpcReceiver({
      workspaceId: f.workspaceId,
      genesis: Buffer.from(f.ledger.context.genesis.toBytes()).toString('hex'),
      machineId: f.machineId,
      native: f.receiver,
      journal: () => journal,
      authorize,
      isOpen: () => true,
      client,
      offer: async (input) => {
        offers++;
        return { ...f.ack, sessionId: input.sessionId, userTurnId: input.userTurnId };
      },
    });
  const gate = (journal = execution) =>
    makeEncryptedAgentExecution({
      workspaceId: f.workspaceId,
      genesis: Buffer.from(f.ledger.context.genesis.toBytes()).toString('hex'),
      targetMachineId: f.machineId,
      journal: () => journal,
      authorizeExecution: authorize,
      resolveVerifiedOriginal: (intent) =>
        Effect.gen(function* () {
          const saved = yield* f.receiver.readIncoming(intent);
          if (!saved) return undefined;
          const opened = yield* f.receiver.openDispatch(
            f.machineId,
            Buffer.from(saved.frame).toString('hex')
          );
          return {
            requesterDevice: opened.requesterDevice,
            requesterCryptoUserId: 'synthetic-owner',
            expiresAt: opened.expiresAt,
          };
        }),
    });
  return {
    ...f,
    nativeReceiver: f.receiver,
    receipts,
    execution,
    client,
    receiver,
    gate,
    published,
    now: (value: number) => {
      now = value;
    },
    permit: (value: boolean) => {
      permitted = value;
    },
    rejectPublish: (value: boolean) => {
      rejectPublish = value;
    },
    offers: () => offers,
  };
}

describe('encrypted dispatch receiver and the shared actual-start journal', () => {
  it('retains exact request/ACK originals, while the ACK starts no agent and completes no execution', async () => {
    const f = fixture();
    const original = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, f.input));
    const frame = { id: original.requestId, frame: original.frameHex };
    await Effect.runPromise(f.receiver()(frame));
    expect(f.offers()).toBe(1);
    const ack = f.published[0] as { id: string; frame: string };
    expect(
      await Effect.runPromise(f.sender.acceptResponse(f.machineId, f.input, ack.frame))
    ).toEqual(f.ack);
    expect(
      f.execution.read({
        genesis: Buffer.from(f.ledger.context.genesis.toBytes()).toString('hex'),
        workspaceId: f.workspaceId,
        targetMachineId: f.machineId,
        requestId: `agent-start:${f.input.userTurnId}`,
      })
    ).toBeNull();
    // Reopening receipt storage replays the original ACK, without a second offer.
    const reopened = new RealtimeJournal(join(f.directory, 'receipts.sqlite'), () => 1000);
    await Effect.runPromise(f.receiver(reopened)(frame));
    expect(f.offers()).toBe(1);
    expect(f.published[1]).toEqual(ack);
  });

  it('lets simultaneous durable/realtime execution paths claim the same business turn once, including after restart', async () => {
    const f = fixture();
    const original = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, f.input));
    await Effect.runPromise(f.receiver()({ id: original.requestId, frame: original.frameHex }));
    const intent = {
      workspaceId: f.workspaceId,
      sessionId: f.input.sessionId,
      userTurnId: f.input.userTurnId,
      inputConfig: f.input.inputConfig,
    };
    const gate = f.gate();
    const claims = await Effect.runPromise(
      Effect.all([gate.claim(intent), gate.claim(intent)], { concurrency: 2 })
    );
    expect(claims.map((claim) => claim.state).sort()).toEqual(['claimed', 'uncertain']);
    const reopened = new RealtimeJournal(join(f.directory, 'execution.sqlite'), () => 1000);
    expect(await Effect.runPromise(f.gate(reopened).claim(intent))).toEqual({ state: 'uncertain' });
    // A distinct new user intent stays independent of this uncertainty.
    const nextInput = { ...f.input, userTurnId: 'different-turn' };
    const next = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, nextInput));
    await Effect.runPromise(f.receiver()({ id: next.requestId, frame: next.frameHex }));
    expect(
      await Effect.runPromise(f.gate(reopened).claim({ ...intent, userTurnId: 'different-turn' }))
    ).toMatchObject({ state: 'claimed' });
  });

  it('keeps the committed ACK on failed publication and retries only those bytes', async () => {
    const f = fixture();
    const original = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, f.input));
    const frame = { id: original.requestId, frame: original.frameHex };
    f.rejectPublish(true);
    await expect(Effect.runPromise(f.receiver()(frame))).rejects.toThrow();
    expect(f.offers()).toBe(1);
    f.rejectPublish(false);
    await Effect.runPromise(f.receiver()(frame));
    const first = f.published[0];
    await Effect.runPromise(f.receiver()(frame));
    expect(f.published[1]).toEqual(first);
    expect(f.offers()).toBe(1);
  });

  it('retains an uncommitted ACK original through a local write fault without offering or sealing again', async () => {
    const f = fixture();
    const original = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, f.input));
    const frame = { id: original.requestId, frame: original.frameHex };
    const receive = f.receiver();
    let attempted: Uint8Array | undefined;
    const save = vi.spyOn(f.receipts, 'retainResponse').mockImplementationOnce((_permit, input) => {
      attempted = Uint8Array.from(input.frame);
      throw new Error('synthetic write failure');
    });
    await expect(Effect.runPromise(receive(frame))).rejects.toThrow();
    save.mockRestore();
    expect(f.published).toEqual([]);
    await Effect.runPromise(receive(frame));
    expect(f.offers()).toBe(1);
    expect(f.published).toEqual([
      { id: original.requestId, frame: Buffer.from(attempted ?? []).toString('hex') },
    ]);
  });

  it('rejects expired/revoked/bad requests and admits the next legitimate call without a workspace fence', async () => {
    const f = fixture();
    const original = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, f.input));
    const frame = { id: original.requestId, frame: original.frameHex };
    f.permit(false);
    await Effect.runPromise(f.receiver()(frame));
    expect(f.offers()).toBe(0);
    f.permit(true);
    await expect(
      Effect.runPromise(f.receiver()({ ...frame, id: 'ff'.repeat(16) }))
    ).rejects.toThrow();
    f.now(original.expiresAt);
    await Effect.runPromise(f.receiver()(frame));
    expect(f.offers()).toBe(0);
    const nextInput = {
      ...f.input,
      userTurnId: 'new-turn',
      timestamp: new Date(original.expiresAt).toISOString(),
    };
    const next = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, nextInput));
    await Effect.runPromise(f.receiver()({ id: next.requestId, frame: next.frameHex }));
    expect(f.offers()).toBe(1);
  });
});

/** Deterministic stream I/O seam with explicit append/read signals; no timer or socket. */
function memoryStreams() {
  const values = new Map<string, unknown[]>();
  const listeners = new Map<string, Set<(value: unknown) => Promise<void>>>();
  const appended = new Map<string, Deferred.Deferred<void>>();
  let failResponses = false;
  const writes: Array<{ stream: string; value: unknown }> = [];
  const signalFor = (id: string) => {
    let signal = appended.get(id);
    if (!signal) {
      signal = Deferred.makeUnsafe<void>();
      appended.set(id, signal);
    }
    return signal;
  };
  const client: LoroStreamsJsonStreamClient = {
    ensureJsonStream: async (stream) => {
      if (!values.has(stream)) values.set(stream, []);
    },
    appendJson: async (stream, value) => {
      writes.push({ stream, value });
      if (stream.includes(':res:') && failResponses) throw new Error('synthetic ACK offline');
      const rows = values.get(stream) ?? [];
      rows.push(value);
      values.set(stream, rows);
      for (const listener of listeners.get(stream) ?? []) await listener(value);
      const id = (value as { id?: string }).id;
      if (id && stream.includes(':req:')) Deferred.doneUnsafe(signalFor(id), Effect.void);
      return String(rows.length);
    },
    readJsonLive: async (stream, state, onBatch, options) => {
      const subscribers = listeners.get(stream) ?? new Set();
      listeners.set(stream, subscribers);
      const listener = async (value: unknown) => {
        await onBatch({ messages: [value], upToDate: false });
      };
      subscribers.add(listener);
      try {
        const rows = values.get(stream) ?? [];
        const pending = rows.slice(Number(state.nextOffset ?? '0'));
        if (pending.length) await onBatch({ messages: pending, upToDate: true });
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      } finally {
        subscribers.delete(listener);
      }
    },
  };
  return {
    client,
    writes,
    waitAppend: (id: string) => Deferred.await(signalFor(id)),
    failResponses: (value: boolean) => {
      failResponses = value;
    },
    activeReads: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
  };
}

effectIt.effect(
  'routes ciphertext-only Streams ACKs, falls back on timeout, then replays the exact original safely',
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const streams = memoryStreams();
      const original = yield* f.sender.prepareDispatch(f.machineId, f.input);
      streams.failResponses(true);
      const originalReceiver = makeEncryptedRpcReceiver({
        workspaceId: f.workspaceId,
        genesis: Buffer.from(f.ledger.context.genesis.toBytes()).toString('hex'),
        machineId: f.machineId,
        native: f.nativeReceiver,
        journal: () => f.receipts,
        authorize: () => Effect.succeed({ _tag: 'Authorized' }),
        isOpen: () => true,
        client: streams.client,
        offer: async () => f.ack,
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* makeEncryptedRpcListener({
            workspaceId: f.workspaceId,
            machineId: f.machineId,
            client: streams.client,
            receive: originalReceiver,
          });
          const sender = yield* makeEncryptedStreamsRpc({
            workspaceId: f.workspaceId,
            requesterDevice: original.requesterDevice,
            client: streams.client,
            acceptResponse: (prepared, input, frame) =>
              Effect.runPromise(f.sender.acceptResponse(prepared.targetMachineId, input, frame)),
          });
          const pending = yield* Effect.forkChild(sender.send(original, f.input));
          yield* streams.waitAppend(original.requestId);
          yield* TestClock.adjust(800);
          expect(yield* Fiber.join(pending)).toBeNull();
          streams.failResponses(false);
          const repeated = yield* f.sender.prepareDispatch(f.machineId, f.input);
          expect(repeated).toEqual(original);
          expect(yield* sender.send(repeated, f.input)).toEqual(f.ack);
          const requests = streams.writes.filter((write) => write.stream.includes(':req:'));
          expect(requests.map((write) => write.value)).toEqual([
            { id: original.requestId, frame: original.frameHex },
            { id: original.requestId, frame: original.frameHex },
          ]);
          expect(JSON.stringify(streams.writes)).not.toContain(f.input.inputConfig.prompt);
          expect(streams.activeReads()).toBe(2);
        })
      );
      expect(streams.activeReads()).toBe(0);
    })
);

effectIt.effect(
  'delivers a paged encrypted query through the real method client/server without a journal',
  () =>
    Effect.gen(function* () {
      const f = encryptedRpcFixture();
      fixtures.push(f);
      const clock = yield* Clock.Clock;
      const run = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.runPromise(effect.pipe(Effect.provideService(Clock.Clock, clock)));
      const streams = memoryStreams();
      const { LoroStreamsMachineRpcServer, LoroStreamsMachineRpcClient } = yield* Effect.promise(
        () => import('@lody/loro-streams-rpc')
      );
      const outcome = {
        status: 'ok' as const,
        path: 'synthetic.txt',
        digest: `sha256:${'a'.repeat(64)}`,
        text: {
          encoding: 'plain' as const,
          text: 'PRIVATE_READ_CANARY'.repeat(70000),
          rawBytes: 18 * 70000,
        },
      };
      const server = new LoroStreamsMachineRpcServer({
        workspaceId: f.workspaceId as never,
        machineId: f.machineId as never,
        logger: { warn: () => {} },
        now: () => 0,
        getMachineStatus: async () => {
          throw new Error('unused');
        },
        refreshMachineAcpCapabilities: async () => {
          throw new Error('must not launch');
        },
        resolveCodeCollabOwnerSessionId: async () => 'synthetic-session',
        openCodeCollabText: async () => outcome,
      });
      const receive = yield* makeEncryptedQueryReceiver({
        workspaceId: f.workspaceId,
        machineId: f.machineId,
        native: f.receiver,
        authorize: () => Effect.succeed({ _tag: 'Authorized' }),
        isOpen: () => true,
        client: streams.client,
        query: (input, expiresAt, signal) => server.readQuery(input, expiresAt, signal),
      });
      yield* makeEncryptedRpcListener({
        workspaceId: f.workspaceId,
        machineId: f.machineId,
        client: streams.client,
        receive,
      });
      const channel = yield* makeEncryptedStreamsRpc<
        import('@lody/shared/e2ee-rpc').E2eeQueryInput,
        import('@lody/shared/e2ee-rpc').E2eeQueryResult
      >({
        workspaceId: f.workspaceId,
        requesterDevice: Buffer.from(f.ledger.owner.raw).toString('hex'),
        client: streams.client,
        acceptResponse: (original, input, frame) =>
          run(f.sender.acceptQueryResponse(original.targetMachineId, input, frame)),
      });
      const client = new LoroStreamsMachineRpcClient({
        workspaceId: f.workspaceId,
        machineId: f.machineId,
        encryptedQuery: async (method, params) => {
          const input = {
            queryId: 'integrated-query',
            method: method as 'code-collab/open-text',
            params,
          };
          const original = await run(f.sender.prepareQuery(f.machineId, input));
          return run(channel.send(original, input, 60000));
        },
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          client.stop();
          server.stop();
        })
      );
      const read = yield* Effect.promise(() =>
        client.requestCodeCollabOpenText({
          sessionId: 'synthetic-session',
          path: 'synthetic.txt',
          timeoutMs: 60000,
        })
      );
      expect(read).toEqual(outcome);
      expect(JSON.stringify(streams.writes)).not.toContain('PRIVATE_READ_CANARY');
      const before = streams.writes.length;
      const denied = yield* Effect.promise(() =>
        client
          .requestMachineRestart({
            requesterUserId: 'synthetic',
            requestId: 'blocked',
            requestToken: 'blocked',
          })
          .then(
            () => false,
            () => true
          )
      );
      expect(denied).toBe(true);
      expect(streams.writes.length).toBe(before);
    })
);
