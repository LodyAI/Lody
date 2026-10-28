import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { Deferred, Effect, Fiber } from 'effect';
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
import { makeEncryptedRpcReceiver } from './realtime-rpc';

const fixtures: ReturnType<typeof encryptedRpcFixture>[] = [];
afterEach(() => {
  for (const value of fixtures.splice(0)) value.close();
});
function fixture(options?: { guest?: boolean }) {
  const f = encryptedRpcFixture(options);
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
  const responseAttempts = new Map<string, number>();
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
      const responseId = (value as { id?: string }).id;
      if (stream.includes(':res:') && responseId) {
        const count = (responseAttempts.get(responseId) ?? 0) + 1;
        responseAttempts.set(responseId, count);
        Deferred.doneUnsafe(signalFor(`res:${responseId}:${count}`), Effect.void);
        if (failResponses) throw new Error('synthetic ACK offline');
      }
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
    waitResponse: (id: string, count: number) => Deferred.await(signalFor(`res:${id}:${count}`)),
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
  'transfers encrypted feature data and replays the retained response after publication failure without repeating the save',
  () =>
    Effect.gen(function* () {
      const { makeEncryptedFeatureReceiver } = yield* Effect.promise(() => import('./feature-rpc'));
      const f = fixture();
      const streams = memoryStreams();
      const input = {
        requestId: '55'.repeat(16),
        request: {
          workspaceId: f.workspaceId,
          machineId: f.machineId,
          method: 'code-collab/save-text' as const,
          params: {
            sessionId: f.input.sessionId,
            requestedByUserId: 'owner',
            path: 'private.ts',
            baseDigest: 'sha256:' + '11'.repeat(32),
            text: { encoding: 'plain' as const, text: 'SYNTHETIC_ENCRYPTED_SAVE', rawBytes: 24 },
          },
        },
      };
      const original = yield* f.sender.prepareFeature(input);
      const saved: string[] = [];
      let authorized = true;
      const receiveOptions = {
        workspaceId: f.workspaceId,
        genesis: Buffer.from(f.ledger.context.genesis.toBytes()).toString('hex'),
        machineId: f.machineId,
        native: f.nativeReceiver,
        journal: () => f.receipts,
        authorize: () =>
          Effect.succeed(
            authorized
              ? { _tag: 'Authorized' as const }
              : { _tag: 'Denied' as const, reason: 'revoked' }
          ),
        authorizeRead: () => Effect.die('writer test entered read lane'),
        isOpen: () => true,
        client: streams.client,
        handle: async (
          request: import('@lody/shared/local-machine-rpc').LocalMachineRpcRequest
        ) => {
          if (
            request.method !== 'code-collab/save-text' ||
            request.params.text.encoding !== 'plain'
          )
            throw new Error('unexpected request');
          saved.push(request.params.text.text);
          return { ok: false as const, error: 'synthetic saved outcome' };
        },
      };
      const envelope = { id: original.requestId, frame: original.frameHex };
      streams.failResponses(true);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const receive = yield* makeEncryptedFeatureReceiver(receiveOptions);
          yield* receive(envelope);
          yield* streams.waitResponse(original.requestId, 1);
        })
      );
      expect(saved).toEqual(['SYNTHETIC_ENCRYPTED_SAVE']);
      const first = streams.writes.filter((write) => write.stream.includes(':res:'));
      streams.failResponses(false);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const receive = yield* makeEncryptedFeatureReceiver(receiveOptions);
          yield* receive(envelope);
          yield* streams.waitResponse(original.requestId, 2);
        })
      );
      expect(saved).toEqual(['SYNTHETIC_ENCRYPTED_SAVE']);
      const replies = streams.writes.filter((write) => write.stream.includes(':res:'));
      expect(replies.slice(first.length)).toEqual(first);
      const reply = replies.at(-1)?.value as { frame: string };
      expect(yield* f.sender.acceptFeatureResponse(input, reply.frame)).toEqual({
        ok: false,
        error: 'synthetic saved outcome',
      });
      authorized = false;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const checked = yield* Deferred.make<void>();
          const receive = yield* makeEncryptedFeatureReceiver({
            ...receiveOptions,
            authorize: () =>
              Deferred.succeed(checked, undefined).pipe(
                Effect.as({ _tag: 'Denied' as const, reason: 'revoked' })
              ),
          });
          yield* receive(envelope);
          yield* Deferred.await(checked);
        })
      );
      expect(streams.writes.filter((write) => write.stream.includes(':res:'))).toEqual(replies);
      expect(JSON.stringify(streams.writes)).not.toContain('SYNTHETIC_ENCRYPTED_SAVE');
    })
);

it('connects the renderer feature facade to the CLI listener with large encrypted request and response chunks', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1000);
  const { makeEncryptedFeatureReceiver } = await import('./feature-rpc');
  const { createEncryptedDispatchLegacy } =
    await import('../../../../../packages/components/src/providers/encrypted-dispatch-legacy');
  const f = fixture();
  const streams = memoryStreams();
  const text = 'SYNTHETIC_PRIVATE_TEXT'.repeat(60_000);
  const paths = new Map<string, string>();
  const renderer = createEncryptedDispatchLegacy({
    workspaceId: f.workspaceId,
    prepare: (machine, input) => Effect.runPromise(f.sender.prepareDispatch(machine, input)),
    accept: (machine, input, frame) =>
      Effect.runPromise(f.sender.acceptResponse(machine, input, frame)),
    prepareFeature: (input) => Effect.runPromise(f.sender.prepareFeature(input)),
    acceptFeature: (input, frame) =>
      Effect.runPromise(f.sender.acceptFeatureResponse(input, frame)),
    client: async () => streams.client,
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const receive = yield* makeEncryptedFeatureReceiver({
            workspaceId: f.workspaceId,
            genesis: Buffer.from(f.ledger.context.genesis.toBytes()).toString('hex'),
            machineId: f.machineId,
            native: f.nativeReceiver,
            journal: () => f.receipts,
            authorize: () => Effect.succeed({ _tag: 'Authorized' as const }),
            authorizeRead: () => Effect.die('writer test entered read lane'),
            isOpen: () => true,
            client: streams.client,
            handle: async (request) => {
              if (
                request.method !== 'code-collab/save-text' ||
                request.params.text.encoding !== 'plain'
              )
                throw new Error('unexpected method');
              paths.set(request.params.path, request.params.text.text);
              return { ok: false, error: request.params.text.text };
            },
          });
          yield* makeEncryptedRpcListener({
            workspaceId: f.workspaceId,
            machineId: f.machineId,
            client: streams.client,
            receive: (envelope) => receive(envelope).pipe(Effect.asVoid),
          });
          const result = yield* Effect.promise(() =>
            renderer.requestFeature({
              workspaceId: f.workspaceId,
              machineId: f.machineId,
              method: 'code-collab/save-text',
              params: {
                sessionId: f.input.sessionId,
                requestedByUserId: 'owner',
                path: 'private.ts',
                baseDigest: 'sha256:' + '11'.repeat(32),
                text: { encoding: 'plain', text, rawBytes: text.length },
              },
            })
          );
          expect(result).toEqual({ ok: false, error: text });
          expect(paths.get('private.ts')).toBe(text);
          expect(JSON.stringify(streams.writes)).not.toContain('SYNTHETIC_PRIVATE_TEXT');
          yield* Effect.promise(() => renderer.close());
        })
      )
    );
    expect(streams.activeReads()).toBe(0);
  } finally {
    await renderer.close();
    vi.useRealTimers();
  }
});

it('shares the feature codec with the ordinary read adapter for a Guest, with complete large results and no execution journal', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1000);
  const { makeEncryptedFeatureReceiver } = await import('./feature-rpc');
  const { createEncryptedDispatchLegacy } =
    await import('../../../../../packages/components/src/providers/encrypted-dispatch-legacy');
  const { LoroStreamsMachineRpcClient, LoroStreamsMachineRpcServer } =
    await import('@lody/loro-streams-rpc');
  const f = fixture({ guest: true });
  const streams = memoryStreams();
  const outcome = {
    status: 'ok' as const,
    path: 'synthetic.txt',
    digest: `sha256:${'a'.repeat(64)}`,
    text: {
      encoding: 'plain' as const,
      text: 'PRIVATE_READ_CANARY'.repeat(70000),
      rawBytes: 19 * 70000,
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
    resolveCodeCollabOwnerSessionId: async () => f.input.sessionId,
    openCodeCollabText: async () => outcome,
  });
  const renderer = createEncryptedDispatchLegacy({
    workspaceId: f.workspaceId,
    prepare: (machine, input) => Effect.runPromise(f.sender.prepareDispatch(machine, input)),
    accept: (machine, input, frame) =>
      Effect.runPromise(f.sender.acceptResponse(machine, input, frame)),
    prepareFeature: (input) => Effect.runPromise(f.sender.prepareFeature(input)),
    acceptFeature: (input, frame) =>
      Effect.runPromise(f.sender.acceptFeatureResponse(input, frame)),
    client: async () => streams.client,
  });
  const client = new LoroStreamsMachineRpcClient({
    workspaceId: f.workspaceId,
    machineId: f.machineId,
    encryptedQuery: (method, params, timeoutMs) =>
      renderer.query(f.machineId, method, params, timeoutMs),
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const receive = yield* makeEncryptedFeatureReceiver({
            workspaceId: f.workspaceId,
            machineId: f.machineId,
            genesis: Buffer.from(f.ledger.context.genesis.toBytes()).toString('hex'),
            native: f.nativeReceiver,
            journal: () => {
              throw new Error('read entered execution journal');
            },
            authorize: () => Effect.succeed({ _tag: 'Denied' as const, reason: 'Guest' }),
            authorizeRead: () => Effect.succeed({ _tag: 'Authorized' as const }),
            isOpen: () => true,
            client: streams.client,
            handle: (request, context) => server.readFeatureQuery(request, context),
          });
          yield* makeEncryptedRpcListener({
            workspaceId: f.workspaceId,
            machineId: f.machineId,
            client: streams.client,
            receive: (envelope) => receive(envelope).pipe(Effect.asVoid),
          });
          expect(
            yield* Effect.promise(() =>
              renderer.requestFeature({
                workspaceId: f.workspaceId,
                machineId: f.machineId,
                method: 'code-collab/open-text',
                params: { sessionId: f.input.sessionId, path: 'synthetic.txt' },
              })
            )
          ).toEqual({ ok: true, result: outcome });
          expect(
            yield* Effect.promise(() =>
              client.requestCodeCollabOpenText({
                sessionId: f.input.sessionId,
                path: 'synthetic.txt',
                timeoutMs: 60000,
              })
            )
          ).toEqual(outcome);
          const before = streams.writes.length;
          yield* Effect.promise(async () => {
            await expect(
              renderer.requestFeature({
                workspaceId: f.workspaceId,
                machineId: f.machineId,
                method: 'code-collab/publish-index',
                params: { sessionId: f.input.sessionId },
              } as never)
            ).rejects.toThrow();
          });
          expect(streams.writes.length).toBe(before);
          expect(
            yield* Effect.promise(() =>
              client.requestCodeCollabOpenText({
                sessionId: f.input.sessionId,
                path: 'synthetic.txt',
                timeoutMs: 60000,
              })
            )
          ).toEqual(outcome);
          expect(JSON.stringify(streams.writes)).not.toContain('PRIVATE_READ_CANARY');
          yield* Effect.promise(() => renderer.close());
        })
      )
    );
    expect(streams.activeReads()).toBe(0);
  } finally {
    client.stop();
    server.stop();
    await renderer.close();
    vi.useRealTimers();
  }
});
