import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { type LoroStreamsJsonStreamClient } from '@lody/loro-streams-rpc';
import { makeEncryptedRpcListener } from '@lody/loro-streams-rpc/e2ee-streams';
import { E2eeAcpInteractionParamsSchema } from '@lody/shared/local-machine-rpc';
import { encryptedRpcFixture } from '../../../../../packages/loro-streams-rpc/tests/fixtures/e2ee-native-fixture';
import { createAcpInteraction } from '../../../../../packages/components/src/providers/acp-interaction-client';
import { createAcpInteractionCrypto } from '../../../../../packages/components/src/providers/acp-interaction-crypto';
import { createEncryptedDispatchLegacy } from '../../../../../packages/components/src/providers/encrypted-dispatch-legacy';
import { MessageHandler } from '../message-handler';
import { MachineRuntime } from '../machine-runtime';
import { makeEncryptedFeatureReceiver } from './feature-rpc';
import { RealtimeJournal } from './realtime-journal';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function streams() {
  const rows = new Map<string, unknown[]>();
  const listeners = new Map<string, Set<(value: unknown) => Promise<void>>>();
  const writes: unknown[] = [];
  const client: LoroStreamsJsonStreamClient = {
    ensureJsonStream: async () => {},
    appendJson: async (stream, value) => {
      writes.push(value);
      const entries = rows.get(stream) ?? [];
      entries.push(value);
      rows.set(stream, entries);
      for (const listener of listeners.get(stream) ?? []) await listener(value);
      return String(entries.length);
    },
    readJsonLive: async (stream, state, onBatch, options) => {
      const subscribers = listeners.get(stream) ?? new Set();
      listeners.set(stream, subscribers);
      const listener = async (value: unknown) => {
        await onBatch({ messages: [value], upToDate: false });
      };
      subscribers.add(listener);
      try {
        const pending = (rows.get(stream) ?? []).slice(Number(state.nextOffset ?? '0'));
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
  return { client, writes };
}

const url = 'https://example.invalid/SYNTHETIC_AUTH_URL';
const code = 'SYNTHETIC_USER_CODE';
const secret = 'SYNTHETIC_AUTH_INPUT';

describe('encrypted ACP interaction integration', () => {
  it('carries authentication and probe through the client, signed feature channel, journal and owner without storing plaintext', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1000);
    const f = encryptedRpcFixture({ teammate: true });
    const io = streams();
    const authority = new AbortController();
    const journal = RealtimeJournal.create(
      join(f.directory, 'interaction-receipts.sqlite'),
      () => 1000
    );
    const inputs: unknown[] = [];
    const starts: string[] = [];
    const secondStarted = deferred<void>();
    const serviceAborted = deferred<void>();
    let finish: (value: unknown) => void = () => {};
    const handler = Object.create(MessageHandler.prototype) as MessageHandler;
    Object.assign(handler, {
      encryptedAttachments: true,
      workspaceId: f.workspaceId,
      machineId: f.machineId,
      acpInteractionStopping: false,
      executionService: {
        refreshMachineAcpCapabilities: async () => {
          starts.push('probe');
          return { capabilities: ['synthetic'] };
        },
        authenticateMachineAcp: async (
          request: { action: string; authorizationCode?: string },
          options?: { signal?: AbortSignal; onProgress?: (progress: unknown) => void }
        ) => {
          if (request.action === 'cancel') {
            finish({ success: false });
            return { success: true };
          }
          if (request.action === 'submit-code') {
            inputs.push(request.authorizationCode);
            return { success: true };
          }
          starts.push('authenticate');
          if (starts.filter((kind) => kind === 'authenticate').length === 2)
            secondStarted.resolve();
          const result = new Promise<unknown>((resolve) => {
            finish = resolve;
          });
          options?.onProgress?.({ status: 'authorization', url, userCode: code });
          options?.onProgress?.({ status: 'input-required', interactionId: 'form' });
          options?.signal?.addEventListener(
            'abort',
            () => {
              serviceAborted.resolve();
              finish({ success: false });
            },
            { once: true }
          );
          return result;
        },
      },
    });
    const machine = Object.create(MachineRuntime.prototype) as MachineRuntime;
    Object.assign(machine, {
      handler,
      options: {
        handlerConfig: {
          encryptedWorkspace: true,
          workspaceId: f.workspaceId,
          machineId: f.machineId,
          userId: 'owner',
        },
      },
    });
    const renderer = createEncryptedDispatchLegacy({
      workspaceId: f.workspaceId,
      prepare: (machine, input) => Effect.runPromise(f.sender.prepareDispatch(machine, input)),
      accept: (machine, input, frame) =>
        Effect.runPromise(f.sender.acceptResponse(machine, input, frame)),
      prepareFeature: (input) => Effect.runPromise(f.sender.prepareFeature(input)),
      acceptFeature: (input, frame) =>
        Effect.runPromise(f.sender.acceptFeatureResponse(input, frame)),
      client: async () => io.client,
    });
    let sequence = 0;
    let startRequest:
      | { requestId: string; params: ReturnType<typeof E2eeAcpInteractionParamsSchema.parse> }
      | undefined;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const receive = yield* makeEncryptedFeatureReceiver({
              workspaceId: f.workspaceId,
              machineId: f.machineId,
              genesis: Buffer.from(f.ledger.context.genesis.toBytes()).toString('hex'),
              native: f.receiver,
              journal: () => journal,
              authorize: () =>
                Effect.succeed({
                  _tag: 'Authorized' as const,
                  isCurrent: () => !authority.signal.aborted,
                }),
              authoritySignal: () => authority.signal,
              authorizeRead: () => Effect.die('ACP must use execution authority'),
              isOpen: () => true,
              client: io.client,
              handle: async (request, context) => {
                if (request.method !== 'machine/acp-interaction')
                  throw new Error('unexpected method');
                return machine.handleEncryptedFeatureRpc(request, context);
              },
            });
            yield* makeEncryptedRpcListener({
              workspaceId: f.workspaceId,
              machineId: f.machineId,
              client: io.client,
              receive: (envelope) => receive(envelope).pipe(Effect.asVoid),
            });
            yield* Effect.promise(async () => {
              const crypto = await createAcpInteractionCrypto();
              const progress: unknown[] = [];
              let ready: () => void = () => {};
              const inputReady = new Promise<void>((resolve) => {
                ready = resolve;
              });
              const make = (kind: 'authenticate' | 'probe') =>
                createAcpInteraction(
                  {
                    ...crypto,
                    newRequestId: () => (++sequence).toString(16).padStart(32, '0'),
                    parseProgress: (value) => value,
                    parseResult: (_kind, value) => value,
                    transport: async ({
                      requestId,
                      expectedDevice,
                      params,
                      signal,
                      onPrepared,
                    }) => {
                      let signer = '';
                      if (params.action === 'start' && params.kind === 'authenticate')
                        startRequest = {
                          requestId,
                          params: E2eeAcpInteractionParamsSchema.parse(params),
                        };
                      const response = await renderer.requestFeature(
                        {
                          workspaceId: f.workspaceId,
                          machineId: f.machineId,
                          method: 'machine/acp-interaction',
                          params: E2eeAcpInteractionParamsSchema.parse(params),
                          timeoutMs: 10000,
                        },
                        {
                          requestId,
                          expectedDevice,
                          signal,
                          onPrepared: (device) => {
                            signer = device;
                            onPrepared?.(device);
                          },
                        }
                      );
                      if (!response.ok) throw new Error(response.error);
                      return { requesterDevice: signer, response: response.result };
                    },
                  },
                  {
                    workspaceId: f.workspaceId,
                    machineId: f.machineId,
                    configId: 'config',
                    kind,
                    timeoutMs: 10000,
                    requestTimeoutMs: 5000,
                    pollIntervalMs: 1,
                    maxPolls: 100,
                    onProgress: (value) => {
                      progress.push(value);
                      if ((value as { status?: string }).status === 'input-required') ready();
                    },
                  }
                );
              const auth = make('authenticate');
              await Promise.race([
                inputReady,
                auth.result.then(() => {
                  throw new Error('completed before input');
                }),
              ]);
              if (!startRequest) throw new Error('start was not sent');
              const replay = await renderer.requestFeature(
                {
                  workspaceId: f.workspaceId,
                  machineId: f.machineId,
                  method: 'machine/acp-interaction',
                  params: startRequest.params,
                  timeoutMs: 10000,
                },
                { requestId: startRequest.requestId }
              );
              expect(replay.ok).toBe(true);
              expect(starts).toEqual(['authenticate']);
              for (const who of ['phone', 'teammate'] as const) {
                const sender = f.native(
                  who,
                  `other-${who}`,
                  who === 'teammate' ? () => Effect.succeed(true) : undefined
                );
                const other = createEncryptedDispatchLegacy({
                  workspaceId: f.workspaceId,
                  prepare: (machine, input) =>
                    Effect.runPromise(sender.prepareDispatch(machine, input)),
                  accept: (machine, input, frame) =>
                    Effect.runPromise(sender.acceptResponse(machine, input, frame)),
                  prepareFeature: (input) => Effect.runPromise(sender.prepareFeature(input)),
                  acceptFeature: (input, frame) =>
                    Effect.runPromise(sender.acceptFeatureResponse(input, frame)),
                  client: async () => io.client,
                });
                try {
                  const attempt = other.requestFeature(
                    {
                      workspaceId: f.workspaceId,
                      machineId: f.machineId,
                      method: 'machine/acp-interaction',
                      params: { action: 'poll', interactionRequestId: auth.interactionRequestId },
                      timeoutMs: 10000,
                    },
                    { requestId: (++sequence).toString(16).padStart(32, '0') }
                  );
                  if (who === 'teammate')
                    await expect(attempt).rejects.toThrow('e2ee_machine_not_owned');
                  else
                    expect(await attempt).toEqual({
                      ok: false,
                      error: 'Encrypted ACP interaction failed.',
                    });
                } finally {
                  await other.close();
                }
              }
              await auth.submit('form', { action: 'submit-code', authorizationCode: secret });
              finish({ success: true, marker: secret });
              expect(await auth.result).toEqual({ success: true, marker: secret });
              expect(progress).toEqual([
                { status: 'authorization', url, userCode: code },
                { status: 'input-required', interactionId: 'form' },
              ]);
              expect(inputs).toEqual([secret]);
              expect(await make('probe').result).toEqual({ capabilities: ['synthetic'] });
              expect(starts).toEqual(['authenticate', 'probe']);
              const cancelled = make('authenticate');
              const cancelledResult = cancelled.result.catch((error: Error) => error.message);
              await Promise.race([
                secondStarted.promise,
                cancelledResult.then((message) => {
                  throw new Error(String(message));
                }),
              ]);
              await cancelled.cancel();
              await serviceAborted.promise;
              expect(await cancelledResult).toContain('abort');
              const persisted = Buffer.concat(
                readdirSync(f.directory)
                  .filter((name) => name.includes('.sqlite'))
                  .map((name) => readFileSync(join(f.directory, name)))
              ).toString('utf8');
              for (const sensitive of [url, code, secret]) {
                expect(JSON.stringify(io.writes)).not.toContain(sensitive);
                expect(persisted).not.toContain(sensitive);
              }
              await renderer.close();
            });
          })
        )
      );
    } finally {
      await renderer.close();
      const internals = handler as unknown as {
        acpInteractionOwner?: Promise<{ close(): Promise<void> }>;
      };
      await (await internals.acpInteractionOwner)?.close();
      f.close();
      vi.useRealTimers();
    }
  });

  it('replays a reservation across restart without activating, and fences cancellation before reservation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1000);
    const f = encryptedRpcFixture();
    const io = streams();
    const authority = new AbortController();
    const journal = RealtimeJournal.create(join(f.directory, 'reserve-journal.sqlite'), () => 1000);
    const crypto = await createAcpInteractionCrypto();
    const starts: string[] = [];
    const makeHandler = () => {
      const handler = Object.create(MessageHandler.prototype) as MessageHandler;
      Object.assign(handler, {
        encryptedAttachments: true,
        workspaceId: f.workspaceId,
        machineId: f.machineId,
        acpInteractionStopping: false,
        executionService: {
          refreshMachineAcpCapabilities: async () => {
            starts.push('probe');
            return { success: true };
          },
        },
      });
      return handler;
    };
    let handler = makeHandler();
    const machine = Object.create(MachineRuntime.prototype) as MachineRuntime;
    Object.assign(machine, {
      handler,
      options: {
        handlerConfig: {
          encryptedWorkspace: true,
          workspaceId: f.workspaceId,
          machineId: f.machineId,
          userId: 'owner',
        },
      },
    });
    const closeHandler = async (value: MessageHandler) => {
      const internals = value as unknown as {
        acpInteractionOwner?: Promise<{ close(): Promise<void> }>;
      };
      await (await internals.acpInteractionOwner)?.close();
    };
    const renderer = createEncryptedDispatchLegacy({
      workspaceId: f.workspaceId,
      prepare: (target, input) => Effect.runPromise(f.sender.prepareDispatch(target, input)),
      accept: (target, input, frame) =>
        Effect.runPromise(f.sender.acceptResponse(target, input, frame)),
      prepareFeature: (input) => Effect.runPromise(f.sender.prepareFeature(input)),
      acceptFeature: (input, frame) =>
        Effect.runPromise(f.sender.acceptFeatureResponse(input, frame)),
      client: async () => io.client,
    });
    const call = (requestId: string, params: unknown) =>
      renderer.requestFeature(
        {
          workspaceId: f.workspaceId,
          machineId: f.machineId,
          method: 'machine/acp-interaction',
          params: E2eeAcpInteractionParamsSchema.parse(params),
          timeoutMs: 10000,
        },
        { requestId }
      );
    const start = {
      action: 'start',
      kind: 'probe',
      configId: 'config',
      responseKey: crypto.responseRecipient.publicKey,
    };
    const reservedId = 'a1'.repeat(16);
    const earlyId = 'b1'.repeat(16);
    const restartEarlyId = 'e1'.repeat(16);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const receive = yield* makeEncryptedFeatureReceiver({
              workspaceId: f.workspaceId,
              machineId: f.machineId,
              genesis: Buffer.from(f.ledger.context.genesis.toBytes()).toString('hex'),
              native: f.receiver,
              journal: () => journal,
              authorize: () =>
                Effect.succeed({
                  _tag: 'Authorized' as const,
                  isCurrent: () => !authority.signal.aborted,
                }),
              authorizeRead: () => Effect.die('ACP must use execution authority'),
              authoritySignal: () => authority.signal,
              isOpen: () => true,
              client: io.client,
              handle: (request, context) => machine.handleEncryptedFeatureRpc(request, context),
            });
            yield* makeEncryptedRpcListener({
              workspaceId: f.workspaceId,
              machineId: f.machineId,
              client: io.client,
              receive: (frame) => receive(frame).pipe(Effect.asVoid),
            });
            yield* Effect.promise(async () => {
              const reserved = await call(reservedId, start);
              expect(reserved).toMatchObject({
                ok: true,
                result: { state: 'running', interactionRequestId: reservedId },
              });
              expect(starts).toEqual([]);
              const replayBefore = await call(reservedId, start);
              expect(replayBefore).toEqual(reserved);
              const otherSender = f.native('phone', 'reserve-other');
              const other = createEncryptedDispatchLegacy({
                workspaceId: f.workspaceId,
                prepare: (target, input) =>
                  Effect.runPromise(otherSender.prepareDispatch(target, input)),
                accept: (target, input, frame) =>
                  Effect.runPromise(otherSender.acceptResponse(target, input, frame)),
                prepareFeature: (input) => Effect.runPromise(otherSender.prepareFeature(input)),
                acceptFeature: (input, frame) =>
                  Effect.runPromise(otherSender.acceptFeatureResponse(input, frame)),
                client: async () => io.client,
              });
              try {
                expect(
                  await other.requestFeature(
                    {
                      workspaceId: f.workspaceId,
                      machineId: f.machineId,
                      method: 'machine/acp-interaction',
                      params: { action: 'activate', interactionRequestId: reservedId },
                      timeoutMs: 10000,
                    },
                    { requestId: 'a3'.repeat(16) }
                  )
                ).toEqual({ ok: false, error: 'Encrypted ACP interaction failed.' });
              } finally {
                await other.close();
              }
              expect(starts).toEqual([]);
              expect(
                await call('e2'.repeat(16), {
                  action: 'cancel',
                  interactionRequestId: restartEarlyId,
                })
              ).toMatchObject({ ok: true, result: { state: 'cancelled' } });
              await closeHandler(handler);
              handler = makeHandler();
              Object.assign(machine, { handler });
              // A delayed reserve after daemon restart may recreate a slot, but never starts work by itself.
              expect(await call(restartEarlyId, start)).toMatchObject({
                ok: true,
                result: { state: 'running' },
              });
              expect(starts).toEqual([]);
              const replayAfter = await call(reservedId, start);
              expect(replayAfter).toEqual(reserved);
              const activation = await call('a2'.repeat(16), {
                action: 'activate',
                interactionRequestId: reservedId,
              });
              expect(activation).toEqual({ ok: false, error: 'Encrypted ACP interaction failed.' });
              expect(starts).toEqual([]);
              const cancelled = await call('b2'.repeat(16), {
                action: 'cancel',
                interactionRequestId: earlyId,
              });
              expect(cancelled).toMatchObject({
                ok: true,
                result: { state: 'cancelled', interactionRequestId: earlyId },
              });
              const late = await call(earlyId, start);
              expect(late).toEqual({ ok: false, error: 'Encrypted ACP interaction failed.' });
              const activationAfterCancel = await call('b3'.repeat(16), {
                action: 'activate',
                interactionRequestId: earlyId,
              });
              expect(activationAfterCancel).toEqual({
                ok: false,
                error: 'Encrypted ACP interaction failed.',
              });
              const heldId = 'c1'.repeat(16);
              expect(await call(heldId, start)).toMatchObject({
                ok: true,
                result: { state: 'running' },
              });
              expect(
                await call('c2'.repeat(16), { action: 'cancel', interactionRequestId: heldId })
              ).toMatchObject({ ok: true, result: { state: 'cancelled' } });
              expect(
                await call('c3'.repeat(16), { action: 'activate', interactionRequestId: heldId })
              ).toEqual({ ok: false, error: 'Encrypted ACP interaction failed.' });
              expect(starts).toEqual([]);
              const liveId = 'd1'.repeat(16);
              expect(await call(liveId, start)).toMatchObject({
                ok: true,
                result: { state: 'running' },
              });
              expect(starts).toEqual([]);
              expect(
                await call('d2'.repeat(16), { action: 'activate', interactionRequestId: liveId })
              ).toMatchObject({ ok: true });
              expect(starts).toEqual(['probe']);
              expect(
                await call('d3'.repeat(16), { action: 'activate', interactionRequestId: liveId })
              ).toEqual({ ok: false, error: 'Encrypted ACP interaction failed.' });
              expect(starts).toEqual(['probe']);
            });
          })
        )
      );
    } finally {
      await renderer.close();
      await closeHandler(handler);
      f.close();
      vi.useRealTimers();
    }
  });
});
