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
import { runMachineIrohListener } from './iroh-listener';
import { randomBytes } from 'node:crypto';
import { developmentNativePath, loadIrohNative } from '@lody/iroh-native';

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
      machineUserId: 'synthetic-machine-account',
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

  // Built by `pnpm --filter @lody/iroh-native build`; skipped where no module exists.
  const iroh = loadIrohNative(developmentNativePath());
  it.skipIf(!iroh)(
    'serves one original over iroh and Streams with a single offer and the same verified ACK',
    async () => {
      const f = fixture();
      const original = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, f.input));
      const receive = f.receiver();
      const opened = await Effect.runPromise(Deferred.make<{ id: string; addrs: string[] }>());
      const listener = Effect.runFork(
        Effect.scoped(
          runMachineIrohListener({
            native: iroh!,
            relays: { urls: [] },
            withSeed: (open) => Effect.promise(() => open(randomBytes(32))),
            handle: (envelope, sink) =>
              receive(envelope, sink).pipe(Effect.ensuring(Effect.promise(() => sink.end()))),
            onOpen: (endpoint) =>
              Deferred.doneUnsafe(
                opened,
                Effect.succeed({ id: endpoint.endpointId, addrs: endpoint.directAddrs() })
              ),
          })
        )
      );
      const machine = await Effect.runPromise(Deferred.await(opened));
      const dialer = await iroh!.openEndpoint(randomBytes(32), { relayUrls: [], accept: false });
      try {
        const call = await dialer.call(
          { endpointId: machine.id, directAddrs: machine.addrs },
          Buffer.from(JSON.stringify({ id: original.requestId, frame: original.frameHex })),
          10_000
        );
        const replies: { id: string; frame: string }[] = [];
        for (let reply = await call.nextReply(); reply; reply = await call.nextReply())
          replies.push(JSON.parse(reply.toString('utf8')));
        expect(replies).toHaveLength(1);
        expect(replies[0]!.id).toBe(original.requestId);
        expect(
          await Effect.runPromise(f.sender.acceptResponse(f.machineId, f.input, replies[0]!.frame))
        ).toEqual(f.ack);
        // The same original over Streams replays the retained ACK without a second offer.
        await Effect.runPromise(receive({ id: original.requestId, frame: original.frameHex }));
        expect(f.offers()).toBe(1);
        expect(f.published).toEqual([replies[0]]);
        // A malformed request ends its stream without replies or an offer.
        const bad = await dialer.call(
          { endpointId: machine.id, directAddrs: machine.addrs },
          Buffer.from('not an envelope'),
          10_000
        );
        expect(await bad.nextReply()).toBeNull();
        expect(f.offers()).toBe(1);
      } finally {
        await dialer.close();
        await Effect.runPromise(Fiber.interrupt(listener));
      }
    }
  );

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

  it('rejects revoked/bad requests, admits a late delivery and the next legitimate call without a workspace fence', async () => {
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
    // Signed originals carry no deadline: three days late, it still starts once.
    const late = Date.parse(f.input.timestamp) + 3 * 24 * 60 * 60_000;
    f.now(late);
    await Effect.runPromise(f.receiver()(frame));
    expect(f.offers()).toBe(1);
    const nextInput = {
      ...f.input,
      userTurnId: 'new-turn',
      timestamp: new Date(late).toISOString(),
    };
    const next = await Effect.runPromise(f.sender.prepareDispatch(f.machineId, nextInput));
    await Effect.runPromise(f.receiver()({ id: next.requestId, frame: next.frameHex }));
    expect(f.offers()).toBe(2);
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

effectIt.effect(
  'forks for a shared member under session-scoped authority and the verified signer identity',
  () =>
    Effect.gen(function* () {
      const { makeEncryptedFeatureReceiver, makeEncryptedFeatureAuthorization } =
        yield* Effect.promise(() => import('./feature-rpc'));
      const f = fixture();
      const streams = memoryStreams();
      const spec = {
        sourceSessionId: f.input.sessionId,
        sourceTurnId: 'assistant-1',
        targetSessionId: '00000000-0000-4000-8000-0000000000f3',
        requestedByUserId: 'member-account',
      };
      const input = {
        requestId: '66'.repeat(16),
        request: {
          workspaceId: f.workspaceId,
          machineId: f.machineId,
          method: 'session/fork' as const,
          params: spec,
        },
      };
      const original = yield* f.sender.prepareFeature(input);
      const scopes: string[][] = [];
      let projectAllowed = (project: string | undefined) => project !== 'unshared';
      // The real scope authorizer, over a member grant that names no owner principal.
      const authorization = makeEncryptedFeatureAuthorization({
        authorization: {
          authorizeOwnedExecution: () => Effect.die('fork used owner-only authority'),
          authorizeRead: () => Effect.die('fork used read authority'),
          authorizeExecution: (_workspace: string, _device: string, project?: string) =>
            Effect.sync(() => {
              scopes.at(-1)?.push(project ?? '<machine>');
              return projectAllowed(project)
                ? { _tag: 'Authorized' as const }
                : { _tag: 'Denied' as const, reason: 'e2ee_machine_not_shared' };
            }),
          authorizeSessionRead: () => Effect.die('fork used session read authority'),
          authoritySignal: new AbortController().signal,
        },
        executionAuthoritySignal: () => new AbortController().signal,
        resolveSessionExecutionScope: async (sessionId) => {
          expect(sessionId).toBe(spec.sourceSessionId);
          scopes.push([]);
          return ['shared-a', 'shared-b'];
        },
      });
      const handled: unknown[] = [];
      let identity: { accountId: string; executionUserId: string } | undefined = {
        accountId: 'member-account',
        executionUserId: 'e2ee-member:aa',
      };
      const receiveOptions = {
        workspaceId: f.workspaceId,
        genesis: Buffer.from(f.ledger.context.genesis.toBytes()).toString('hex'),
        machineId: f.machineId,
        native: f.nativeReceiver,
        journal: () => f.receipts,
        authorize: () => Effect.die('fork used owner-only authority'),
        authorizeRead: () => Effect.die('fork used read authority'),
        authorizeSessionExecution: authorization.authorizeSessionExecution,
        requesterIdentity: () => Effect.sync(() => identity),
        isOpen: () => true,
        client: streams.client,
        handle: async (
          request: import('@lody/shared/local-machine-rpc').LocalMachineRpcRequest,
          context: import('./feature-rpc').EncryptedFeatureContext
        ) => {
          handled.push({ method: request.method, requester: context.requester });
          return {
            ok: true as const,
            result: {
              type: 'session/fork_response' as const,
              sourceSessionId: spec.sourceSessionId,
              targetSessionId: spec.targetSessionId,
              success: true,
              disposition: 'completed' as const,
              partial: false,
              warnings: [],
            },
          };
        },
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const receive = yield* makeEncryptedFeatureReceiver(receiveOptions);
          yield* receive({ id: original.requestId, frame: original.frameHex });
          yield* streams.waitResponse(original.requestId, 1);
        })
      );
      expect(handled).toEqual([
        {
          method: 'session/fork',
          requester: { accountId: 'member-account', executionUserId: 'e2ee-member:aa' },
        },
      ]);
      expect(scopes[0]).toEqual(['shared-a', 'shared-b']);
      const reply = streams.writes.filter((write) => write.stream.includes(':res:')).at(-1)
        ?.value as { frame: string };
      expect(yield* f.sender.acceptFeatureResponse(input, reply.frame)).toMatchObject({
        ok: true,
      });

      // One unshared project the session reaches refuses the fork before any work, and the
      // sender gets that definite answer instead of waiting out its deadline.
      projectAllowed = (project) => project !== 'shared-b';
      const unshared = { ...input, requestId: '67'.repeat(16) };
      const unsharedOriginal = yield* f.sender.prepareFeature(unshared);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const receive = yield* makeEncryptedFeatureReceiver(receiveOptions);
          yield* receive({ id: unsharedOriginal.requestId, frame: unsharedOriginal.frameHex });
          yield* streams.waitResponse(unsharedOriginal.requestId, 1);
        })
      );
      expect(handled).toHaveLength(1);
      const refusal = streams.writes.filter((write) => write.stream.includes(':res:')).at(-1)
        ?.value as { id: string; frame: string };
      expect(refusal.id).toBe(unsharedOriginal.requestId);
      expect(yield* f.sender.acceptFeatureResponse(unshared, refusal.frame)).toMatchObject({
        ok: false,
        code: 'e2ee_machine_not_shared',
      });

      // A signer without a ledger account is never attributed from the request, and it
      // gets no answer at all.
      projectAllowed = () => true;
      identity = undefined;
      const anonymous = yield* f.sender.prepareFeature({ ...input, requestId: '68'.repeat(16) });
      const before = streams.writes.length;
      const checked = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const receive = yield* makeEncryptedFeatureReceiver({
            ...receiveOptions,
            requesterIdentity: () => Deferred.succeed(checked, undefined).pipe(Effect.as(identity)),
          });
          yield* receive({ id: anonymous.requestId, frame: anonymous.frameHex });
          yield* Deferred.await(checked);
        })
      );
      expect(handled).toHaveLength(1);
      expect(
        streams.writes.slice(before).filter((write) => write.stream.includes(':res:'))
      ).toEqual([]);
    })
);

effectIt.effect(
  'joins a live encrypted write across Iroh and Streams receivers without sealing uncertainty',
  () =>
    Effect.gen(function* () {
      const { makeEncryptedFeatureReceiver } = yield* Effect.promise(() => import('./feature-rpc'));
      const f = fixture();
      const input = {
        requestId: 'd7'.repeat(16),
        request: {
          workspaceId: f.workspaceId,
          machineId: f.machineId,
          method: 'sorbet/credentials-logout' as const,
          params: { configId: 'config', providerId: 'provider' },
        },
      };
      const original = yield* f.sender.prepareFeature(input);
      const streams = memoryStreams();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fallbackAdmitted = yield* Deferred.make<void>();
      const irohdone = yield* Deferred.make<void>();
      const irohreplies: Uint8Array[] = [];
      let executions = 0;
      const options = {
        workspaceId: f.workspaceId,
        genesis: Buffer.from(f.ledger.context.genesis.toBytes()).toString('hex'),
        machineId: f.machineId,
        native: f.nativeReceiver,
        journal: () => f.receipts,
        authorize: () => Effect.succeed({ _tag: 'Authorized' as const }),
        authorizeRead: () => Effect.die('write used read authority'),
        isOpen: () => true,
        handle: async () => {
          executions++;
          Deferred.doneUnsafe(started, Effect.void);
          await Effect.runPromise(Deferred.await(release));
          return { ok: true as const, result: { type: 'sorbet/credentials-logout' as const } };
        },
      };
      let receives = 0;
      const receiveRecord = f.receipts.receive.bind(f.receipts);
      vi.spyOn(f.receipts, 'receive').mockImplementation((request) => {
        const record = receiveRecord(request);
        if (++receives === 2) Deferred.doneUnsafe(fallbackAdmitted, Effect.void);
        return record;
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const iroh = yield* makeEncryptedFeatureReceiver(options);
          const fallback = yield* makeEncryptedFeatureReceiver({
            ...options,
            client: streams.client,
          });
          const envelope = { id: original.requestId, frame: original.frameHex };
          yield* iroh(envelope, {
            deliver: async (_id, frame) => {
              irohreplies.push(frame);
            },
            end: async () => {
              Deferred.doneUnsafe(irohdone, Effect.void);
            },
          });
          yield* Deferred.await(started);
          yield* fallback(envelope);
          yield* Deferred.await(fallbackAdmitted);
          // The slow real write may now finish, after fallback admission observed its claim.
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(irohdone);
          yield* streams.waitResponse(original.requestId, 1);
        })
      );
      expect(executions).toBe(1);
      expect(irohreplies).toHaveLength(1);
      const streamReply = streams.writes.find((write) => write.stream.includes(':res:'))?.value as {
        frame: string;
      };
      expect(
        yield* f.sender.acceptFeatureResponse(
          input,
          Buffer.from(irohreplies[0] ?? []).toString('hex')
        )
      ).toEqual({ ok: true, result: { type: 'sorbet/credentials-logout' } });
      expect(yield* f.sender.acceptFeatureResponse(input, streamReply.frame)).toEqual({
        ok: true,
        result: { type: 'sorbet/credentials-logout' },
      });
      expect(streamReply.frame).toBe(Buffer.from(irohreplies[0] ?? []).toString('hex'));
    })
);

effectIt.effect(
  'returns an encrypted uncertain error for a write claimed before restart without replay',
  () =>
    Effect.gen(function* () {
      const { makeEncryptedFeatureReceiver } = yield* Effect.promise(() => import('./feature-rpc'));
      const f = fixture();
      const input = {
        requestId: 'c7'.repeat(16),
        request: {
          workspaceId: f.workspaceId,
          machineId: f.machineId,
          method: 'sorbet/credentials-logout' as const,
          params: { configId: 'config', providerId: 'provider' },
        },
      };
      const original = yield* f.sender.prepareFeature(input);
      const opened = yield* f.nativeReceiver.openFeature(f.machineId, original.frameHex);
      if (!opened) throw new Error('synthetic feature did not open');
      const request = {
        genesis: Buffer.from(f.ledger.context.genesis.toBytes()).toString('hex'),
        workspaceId: f.workspaceId,
        targetMachineId: f.machineId,
        requestId: opened.requestId,
        requester: opened.requesterDevice,
        expiresAt: opened.expiresAt,
        frame: Uint8Array.from(opened.frame),
      };
      f.receipts.receive(request);
      expect(f.receipts.claim(request).state).toBe('claimed');
      const journal = new RealtimeJournal(join(f.directory, 'receipts.sqlite'), () => 1000);
      const streams = memoryStreams();
      for (let retry = 1; retry <= 2; retry++) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const receive = yield* makeEncryptedFeatureReceiver({
              workspaceId: f.workspaceId,
              genesis: request.genesis,
              machineId: f.machineId,
              native: f.nativeReceiver,
              journal: () => journal,
              authorize: () => Effect.succeed({ _tag: 'Authorized' as const }),
              authorizeRead: () => Effect.die('write must not borrow read authority'),
              isOpen: () => true,
              client: streams.client,
              handle: async () => {
                throw new Error('uncertain write was replayed');
              },
            });
            yield* receive({ id: original.requestId, frame: original.frameHex });
            yield* streams.waitResponse(original.requestId, retry);
          })
        );
        const replies = streams.writes.filter((write) => write.stream.includes(':res:'));
        const reply = replies[retry - 1]?.value as { frame: string };
        expect(yield* f.sender.acceptFeatureResponse(input, reply.frame)).toEqual({
          ok: false,
          code: 'e2ee_outcome_uncertain',
          error:
            'Previous execution of this request was interrupted before completion and will not be replayed automatically.',
        });
        expect(journal.read(request)?.state).toBe('uncertain');
      }
    })
);

for (const method of ['sorbet/credentials-list', 'sorbet/credentials-logout'] as const) {
  effectIt.effect(
    `journals encrypted ${method} and replays the outcome without another execution`,
    () =>
      Effect.gen(function* () {
        const { makeEncryptedFeatureReceiver } = yield* Effect.promise(
          () => import('./feature-rpc')
        );
        const f = fixture();
        const streams = memoryStreams();
        const input = {
          requestId: (method === 'sorbet/credentials-list' ? 'a1' : 'a2').repeat(16),
          request: {
            workspaceId: f.workspaceId,
            machineId: f.machineId,
            ...(method === 'sorbet/credentials-list'
              ? { method, params: { configId: 'config' } }
              : { method, params: { configId: 'config', providerId: 'provider' } }),
          },
        };
        const original = yield* f.sender.prepareFeature(input);
        const calls: string[] = [];
        const signers: string[] = [];
        let authorized = false;
        let revokeDuringExecution = false;
        const checked = yield* Deferred.make<void>();
        let checkCount = 0;
        const receiveOptions = {
          workspaceId: f.workspaceId,
          genesis: Buffer.from(f.ledger.context.genesis.toBytes()).toString('hex'),
          machineId: f.machineId,
          native: f.nativeReceiver,
          journal: () => f.receipts,
          authorize: () =>
            Effect.gen(function* () {
              checkCount++;
              if (!authorized) yield* Deferred.succeed(checked, undefined);
              return authorized
                ? { _tag: 'Authorized' as const }
                : { _tag: 'Denied' as const, reason: 'e2ee_machine_not_owned' as const };
            }),
          authorizeRead: () => Effect.die('credentials must not use read authority'),
          isOpen: () => true,
          client: streams.client,
          handle: async (
            request: import('@lody/shared/local-machine-rpc').LocalMachineRpcRequest,
            context: import('./feature-rpc').EncryptedFeatureContext
          ) => {
            calls.push(request.method);
            signers.push(context.requesterDevice);
            if (revokeDuringExecution) authorized = false;
            return { ok: false as const, error: 'synthetic outcome' };
          },
        };
        const envelope = { id: original.requestId, frame: original.frameHex };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const receive = yield* makeEncryptedFeatureReceiver(receiveOptions);
            yield* receive(envelope);
            yield* Deferred.await(checked);
          })
        );
        expect(calls).toEqual([]);
        expect(streams.writes.filter((write) => write.stream.includes(':res:'))).toEqual([]);
        authorized = true;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const receive = yield* makeEncryptedFeatureReceiver(receiveOptions);
            yield* receive(envelope);
            yield* streams.waitResponse(original.requestId, 1);
          })
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const receive = yield* makeEncryptedFeatureReceiver(receiveOptions);
            yield* receive(envelope);
            yield* streams.waitResponse(original.requestId, 2);
          })
        );
        expect(calls).toEqual([method]);
        expect(signers).toEqual([original.requesterDevice]);
        const replies = streams.writes.filter((write) => write.stream.includes(':res:'));
        expect(replies[1]).toEqual(replies[0]);
        const reply = replies[0]?.value as { frame: string };
        expect(yield* f.sender.acceptFeatureResponse(input, reply.frame)).toEqual({
          ok: false,
          error: 'synthetic outcome',
        });
        const changed = {
          ...input,
          requestId: (method === 'sorbet/credentials-list' ? 'b1' : 'b2').repeat(16),
        };
        const changedOriginal = yield* f.sender.prepareFeature(changed);
        const before = checkCount;
        const revoked = yield* Deferred.make<void>();
        revokeDuringExecution = true;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const receive = yield* makeEncryptedFeatureReceiver({
              ...receiveOptions,
              authorize: () =>
                Effect.gen(function* () {
                  checkCount++;
                  if (checkCount === before + 2) yield* Deferred.succeed(revoked, undefined);
                  return authorized
                    ? { _tag: 'Authorized' as const }
                    : { _tag: 'Denied' as const, reason: 'e2ee_machine_not_owned' as const };
                }),
            });
            yield* receive({ id: changedOriginal.requestId, frame: changedOriginal.frameHex });
            yield* Deferred.await(revoked);
          })
        );
        expect(calls).toEqual([method, method]);
        expect(streams.writes.filter((write) => write.stream.includes(':res:'))).toEqual(replies);
      })
  );
}

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

it('protects interaction progress from another workspace member and binds both directions to the signed identity', async () => {
  const { createRpcSecretRecipient, encryptRpcSecret } = await import('@lody/loro-streams-rpc');
  const { e2eeAcpInteractionInputContext, e2eeAcpInteractionResponseContext } =
    await import('@lody/shared/e2ee-rpc');
  const { E2eeAcpInteractionResultSchema } = await import('@lody/shared/local-machine-rpc');
  const initiator = await createRpcSecretRecipient();
  const other = await createRpcSecretRecipient();
  const identity = {
    workspaceId: 'workspace',
    machineId: 'machine',
    requesterDevice: 'a'.repeat(64),
    interactionRequestId: 'b'.repeat(32),
    requestId: 'c'.repeat(32),
  };
  const progress = JSON.stringify({
    authorizationUrl: 'https://example.invalid/private',
    userCode: 'SYNTHETIC-CODE',
  });
  const responseContext = e2eeAcpInteractionResponseContext(identity);
  const envelope = await encryptRpcSecret(initiator.publicKey, progress, responseContext);
  expect(await initiator.decrypt(envelope, responseContext)).toBe(progress);
  await expect(other.decrypt(envelope, responseContext)).rejects.toThrow();
  await expect(
    initiator.decrypt(
      envelope,
      e2eeAcpInteractionResponseContext({ ...identity, requesterDevice: 'd'.repeat(64) })
    )
  ).rejects.toThrow();
  const result = {
    type: 'machine/acp-interaction',
    interactionRequestId: identity.interactionRequestId,
    state: 'running',
    responseEnvelope: envelope,
  };
  expect(E2eeAcpInteractionResultSchema.safeParse(result).success).toBe(true);
  expect(E2eeAcpInteractionResultSchema.safeParse({ ...result, progress }).success).toBe(false);
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC-CODE');
  const target = await createRpcSecretRecipient();
  const inputContext = e2eeAcpInteractionInputContext({
    ...identity,
    interactionId: 'interaction',
  });
  const input = await encryptRpcSecret(target.publicKey, 'SYNTHETIC-INPUT', inputContext);
  expect(await target.decrypt(input, inputContext)).toBe('SYNTHETIC-INPUT');
  await expect(
    target.decrypt(input, e2eeAcpInteractionInputContext({ ...identity, interactionId: 'other' }))
  ).rejects.toThrow();
});
