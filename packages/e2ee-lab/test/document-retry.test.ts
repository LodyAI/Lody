import { Effect, Result, Exit } from 'effect';
import { expect, it } from 'vitest';
import { join } from 'node:path';
import { Bytes } from '@lody/e2ee-core';
import { signGenesisRecord } from '@lody/e2ee-core/protocol';
import { hashRecordBytes, verifyLedger } from '@lody/e2ee-core/protocol';
import { makeLabLoroSession } from '../src/platform/content-session';
import { fixture } from './ledger-fixture';
import { makeLabDocumentSession } from '../src/platform/document-session';
import { LoroDoc } from 'loro-crdt';
import { createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';

const ok = Result.getOrThrow;
it('retries failed uploads with their original ciphertext without stopping or resealing', async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const key = new Uint8Array(32).fill(81);
          const genesis = yield* signGenesisRecord({
            userId: ok(Bytes.userId(new Uint8Array(32).fill(82))),
            membershipId: f.membership,
            encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(83))),
            initialKey: ok(Bytes.epochKey(key)),
            signer: f.owner,
          });
          const view = ok(
            verifyLedger({
              anchor: genesis.genesis,
              records: [genesis.record],
              checkpoint: { head: hashRecordBytes(genesis.record), length: 1 },
            })
          );
          let fault: 'network' | '502' | undefined;
          const sent: Uint8Array[] = [];
          let signCalls = 0;
          const session = yield* makeLabLoroSession({
            path: join(f.dir, 'upload-retry.sqlite'),
            mode: 'create',
            genesis: genesis.genesis,
            resource: 'retry-upload',
            streamUrl: `${f.server.baseUrl}/ds/synthetic/retry-upload`,
            writeEpoch: 'current',
            signer: {
              publicKey: f.owner.publicKey,
              sign: (bytes) => {
                signCalls++;
                return f.owner.sign(bytes);
              },
            },
            ledger: () => Effect.succeed(view),
            readEpochKey: () => Effect.sync(() => ok(Bytes.epochKey(key))),
            fetch: async (url, init) => {
              if (init?.method === 'POST' && init.body) {
                sent.push(new Uint8Array(await new Response(init.body).arrayBuffer()));
                if (fault === 'network') throw new TypeError('synthetic lost connection');
                if (fault === '502')
                  return new Response('synthetic gateway failure', { status: 502 });
              }
              return fetch(url, init);
            },
          });
          yield* session.create();
          for (const injected of ['network', '502'] as const) {
            yield* session.editOffline(` ${injected}`);
            sent.length = 0;
            fault = injected;
            const failed = yield* Effect.result(session.flushOffline());
            expect(Result.isFailure(failed)).toBe(true);
            expect(yield* session.status()).toBe('active');
            expect(sent.length).toBeGreaterThan(0);
            const original = new Uint8Array(sent[0]!);
            const signedBeforeRetry = signCalls;
            fault = undefined;
            yield* session.flushOffline();
            expect(yield* session.status()).toBe('active');
            expect(signCalls).toBe(signedBeforeRetry);
            for (const body of sent) expect(body).toEqual(original);
          }
          let failAllocation = false;
          let released = false;
          const handoff = yield* makeLabDocumentSession(
            {
              path: join(f.dir, 'handoff.sqlite'),
              mode: 'create',
              genesis: genesis.genesis,
              resource: 'handoff',
              model: 'loro',
              streamUrl: `${f.server.baseUrl}/ds/synthetic/handoff`,
              writeEpoch: 'current',
              signer: f.owner,
              ledger: () => Effect.succeed(view),
              readEpochKey: () => Effect.sync(() => ok(Bytes.epochKey(key))),
              fetch,
            },
            () => {
              if (failAllocation) throw new Error('synthetic native allocation failure');
              const native = new LoroDoc();
              return {
                adapter: () => createLoroDocAdapter(native),
                exportSnapshot: () => native.export({ mode: 'snapshot' }),
                importSnapshot: (bytes) => {
                  native.import(bytes);
                },
                importUpdate: (bytes) => {
                  native.import(bytes);
                },
                append: (text) => {
                  const value = native.getText('text');
                  value.insert(value.length, text);
                  native.commit();
                  return undefined;
                },
                text: () => native.getText('text').toString(),
                release: () => {
                  released = true;
                  native.free();
                },
              };
            }
          );
          yield* handoff.editOffline('retained native owner');
          failAllocation = true;
          expect(Exit.isFailure(yield* Effect.exit(handoff.recoverFromFullHistory()))).toBe(true);
          expect(released).toBe(false);
          expect(yield* handoff.status()).toBe('active');
          expect(yield* handoff.text()).toBe('retained native owner');
        })
      )
    );
  } finally {
    await f.close();
  }
});

it('rejected uploads retain exact ciphertext across owner restart', async () => {
  const f = await fixture();
  try {
    const key = new Uint8Array(32).fill(81);
    const genesis = await Effect.runPromise(
      signGenesisRecord({
        userId: ok(Bytes.userId(new Uint8Array(32).fill(82))),
        membershipId: f.membership,
        encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(83))),
        initialKey: ok(Bytes.epochKey(key)),
        signer: f.owner,
      })
    );
    const view = ok(
      verifyLedger({
        anchor: genesis.genesis,
        records: [genesis.record],
        checkpoint: { head: hashRecordBytes(genesis.record), length: 1 },
      })
    );
    let fail = true;
    const sent: Uint8Array[] = [];
    const config = {
      path: join(f.dir, 'restart-retry.sqlite'),
      genesis: genesis.genesis,
      resource: 'restart',
      streamUrl: `${f.server.baseUrl}/ds/synthetic/restart`,
      writeEpoch: 'current' as const,
      signer: f.owner,
      ledger: () => Effect.succeed(view),
      readEpochKey: () => Effect.sync(() => ok(Bytes.epochKey(key))),
      fetch: async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST' && init.body) {
          sent.push(new Uint8Array(await new Response(init.body).arrayBuffer()));
          if (fail) throw new TypeError('synthetic dropped upload');
        }
        return fetch(url, init);
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const doc = yield* makeLabLoroSession({ ...config, mode: 'create' });
          yield* doc.create();
          yield* doc.editOffline('retained edit');
          expect(Result.isFailure(yield* Effect.result(doc.flushOffline()))).toBe(true);
          expect(yield* doc.status()).toBe('active');
        })
      )
    );
    expect(sent.length).toBeGreaterThan(0);
    const original = sent[0];
    sent.length = 0;
    fail = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const doc = yield* makeLabLoroSession({ ...config, mode: 'open' });
          yield* doc.flushOffline();
          expect(yield* doc.text()).toContain('retained edit');
        })
      )
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]).toEqual(original);
  } finally {
    await f.close();
  }
});
