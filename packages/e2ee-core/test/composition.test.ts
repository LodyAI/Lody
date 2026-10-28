import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context, Effect, Layer, Result } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
  E2eeWorkflows,
  E2eeWorkspace,
  InstalledEpochKeys,
  KeyDistributor,
  KeyReceiver,
  WorkspacePlatform,
  WorkspaceKeyRoundFailure,
  runWorkspaceKeyRound,
} from '@lody/e2ee-core';
import {
  BackendError,
  CandidateProtector,
  DeviceIdentity,
  EpochPublicationSource,
  EpochStagingStore,
  KeyProtector,
  KeyMailbox,
  LedgerLog,
  LedgerLogError,
  LedgerSync,
  LedgerViewSource,
  WorkspaceScope,
  type DeviceSigner,
} from '@lody/e2ee-core/services';
import {
  makeSqliteKeyMailbox,
  referenceKeyMailbox,
  sqliteLocalStores,
} from '@lody/e2ee-core/adapters/node-sqlite';
import { envelopeFixture, recipientPair } from './keys/fixture';
import { synthetic } from './keys/protection-fixture';

const okMailbox = (
  host: Effect.Success<ReturnType<typeof makeSqliteKeyMailbox>>,
  device: DeviceSigner['publicKey']
) => Result.getOrThrow(host.bind(device));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const unavailable = (service: string) => () =>
  Effect.fail(new BackendError({ service, reason: 'unavailable' }));

describe('E2eeWorkflows composition', () => {
  it('distributes the current key from one device to another through the real Layers', async () => {
    const f = envelopeFixture(),
      dir = mkdtempSync(path.join(tmpdir(), 'e2ee-composition-')),
      phonePair = await recipientPair(),
      native = synthetic();
    dirs.push(dir);
    const device = (name: string, signer: DeviceSigner, encryptionKeyPair: CryptoKeyPair) => {
      const directory = path.join(dir, name);
      mkdirSync(directory);
      return (host: Effect.Success<ReturnType<typeof makeSqliteKeyMailbox>>) =>
        E2eeWorkflows.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              sqliteLocalStores({ directory, mode: 'create-or-open' }),
              referenceKeyMailbox(host, signer.publicKey),
              Layer.succeed(LedgerViewSource, LedgerViewSource.of({ current: f.ledger })),
              Layer.succeed(
                LedgerLog,
                LedgerLog.of({
                  read: () => Effect.fail(new LedgerLogError()),
                  appendCas: () => Effect.fail(new LedgerLogError()),
                })
              ),
              Layer.succeed(
                EpochStagingStore,
                EpochStagingStore.of({
                  stageGroup: unavailable('EpochStagingStore'),
                  readGroup: unavailable('EpochStagingStore'),
                  deleteGroup: unavailable('EpochStagingStore'),
                })
              ),
              Layer.succeed(
                EpochPublicationSource,
                EpochPublicationSource.of({ current: () => Effect.succeed(f.genesisRecord) })
              ),
              KeyProtector.layerFromPromises(native.protector),
              CandidateProtector.layerFromPromises(native.protector)
            )
          ),
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(WorkspaceScope, { genesis: f.context.genesis }),
              Layer.succeed(DeviceIdentity, { signer, encryptionKeyPair })
            )
          )
        );
    };
    const owner = device('owner', f.owner.signer, {} as CryptoKeyPair),
      phone = device('phone', f.phone.signer, phonePair);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
            path: path.join(dir, 'mailbox.sqlite'),
            mode: 'create',
            genesis: f.context.genesis,
            ledger: f.ledger,
          });
          // Owner: hold the genesis key, schedule and deliver an envelope to the phone.
          yield* Effect.gen(function* () {
            yield* (yield* InstalledEpochKeys).saveAndReload(0, f.secret);
            const distributor = yield* KeyDistributor;
            expect(yield* distributor.reconcileCurrentEpoch()).toEqual({
              scheduled: 1,
              blocked: [],
              next: null,
            });
            expect(yield* distributor.resumePendingDeliveries()).toMatchObject({
              processed: 1,
              blocked: [],
            });
            const delivered = yield* distributor.results();
            expect(delivered.items.map((item) => item.outcome)).toEqual(['Observed']);
          }).pipe(Effect.provide(owner(host)));
          // Phone: fetch, install and report the key.
          yield* Effect.gen(function* () {
            const receiver = yield* KeyReceiver;
            expect(yield* receiver.fetchAndInstall()).toEqual({ processed: 1, next: null });
            expect(yield* receiver.flushReports()).toMatchObject({ blocked: [] });
            const key = yield* (yield* InstalledEpochKeys).read(0);
            expect(key).toBeDefined();
          }).pipe(Effect.provide(phone(host)));
          const status = yield* Effect.fromResult(host.bind(f.owner.publicKey)).pipe(
            Effect.flatMap((bound) =>
              bound.status({
                genesis: Buffer.from(f.context.genesis.toBytes()).toString('hex'),
                epoch: 0,
                recipient: Buffer.from(f.phone.raw).toString('hex'),
              })
            )
          );
          expect(status.status).toBe('InstallationReported');
        })
      )
    );
  });

  it.each(['healthy', 'fetch', 'staged'] as const)('independent key rounds (%s)', async (mode) => {
    const receiveFails = mode !== 'healthy';
    const f = envelopeFixture(),
      dir = mkdtempSync(path.join(tmpdir(), 'e2ee-workspace-')),
      phonePair = await recipientPair(),
      native = synthetic();
    dirs.push(dir);
    let faultActive = mode === 'fetch';
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeSqliteKeyMailbox({
            path: path.join(dir, 'mailbox.sqlite'),
            mode: 'create',
            genesis: f.context.genesis,
            ledger: f.ledger,
          });
          const platform = (
            name: string,
            signer: DeviceSigner,
            encryptionKeyPair: CryptoKeyPair
          ) => {
            const directory = path.join(dir, name);
            mkdirSync(directory);
            const state = () =>
              Effect.sync(() => ({ view: f.view(), offset: 'opaque', bootstrap: false }));
            return WorkspacePlatform.layer({
              acquire: () =>
                Effect.succeed({
                  ports: Layer.mergeAll(
                    sqliteLocalStores({ directory, mode: 'create-or-open' }),
                    name === 'owner' && mode === 'fetch'
                      ? Layer.effect(
                          KeyMailbox,
                          Effect.map(KeyMailbox, (mailbox) => ({
                            ...mailbox,
                            fetch: (epoch, cursor, limit) =>
                              faultActive
                                ? Effect.fail(
                                    new BackendError({
                                      service: 'KeyMailbox',
                                      reason: 'unavailable',
                                    })
                                  )
                                : mailbox.fetch(epoch, cursor, limit),
                          }))
                        ).pipe(Layer.provide(referenceKeyMailbox(host, signer.publicKey)))
                      : referenceKeyMailbox(host, signer.publicKey),
                    Layer.succeed(LedgerSync, LedgerSync.of({ current: state, refresh: state })),
                    Layer.succeed(
                      LedgerLog,
                      LedgerLog.of({
                        read: () => Effect.fail(new LedgerLogError()),
                        appendCas: () => Effect.fail(new LedgerLogError()),
                      })
                    ),
                    Layer.succeed(
                      EpochStagingStore,
                      EpochStagingStore.of({
                        stageGroup: unavailable('EpochStagingStore'),
                        readGroup: () => Effect.succeed(null),
                        deleteGroup: unavailable('EpochStagingStore'),
                      })
                    ),
                    Layer.succeed(
                      EpochPublicationSource,
                      EpochPublicationSource.of({
                        current: () => Effect.succeed(f.genesisRecord),
                      })
                    ),
                    KeyProtector.layerFromPromises(native.protector),
                    CandidateProtector.layerFromPromises(native.protector)
                  ).pipe(
                    Layer.provideMerge(
                      Layer.mergeAll(
                        Layer.succeed(WorkspaceScope, { genesis: f.context.genesis }),
                        Layer.succeed(DeviceIdentity, { signer, encryptionKeyPair })
                      )
                    )
                  ),
                  stop: () => Effect.void,
                  documentState: () => Effect.die('no documents in this test'),
                }),
              prepareRecovery: () => Effect.die('no recovery in this test'),
            });
          };
          // Owner: hold the genesis key; one key round delivers the phone's envelope.
          yield* Effect.gen(function* () {
            const owner = yield* E2eeWorkspace.open();
            expect(yield* owner.rotationStatus()).toMatchObject({ epoch: 0, mayRotate: true });
            yield* Context.get(owner.services, InstalledEpochKeys).saveAndReload(0, f.secret);
            const cursor = '00'.repeat(32) + ':' + '00'.repeat(32);
            const attempt = yield* Effect.result(
              mode === 'staged'
                ? runWorkspaceKeyRound(
                    100,
                    { received: cursor },
                    Effect.fail(new Error('synthetic staging refusal'))
                  ).pipe(Effect.provide(owner.services))
                : owner.keyRound(100, { received: cursor })
            );
            // Observable delivery must happen even when this owner's receive page fails.
            expect(
              (yield* okMailbox(host, f.phone.publicKey).fetch(0, null, 100)).items
            ).toHaveLength(1);
            if (receiveFails) {
              expect(attempt).toMatchObject({
                _tag: 'Failure',
                failure: {
                  _tag: 'WorkspaceKeyRoundFailure',
                  receive: { _tag: 'Failure' },
                  distribution: { _tag: 'Success' },
                  cursors: {
                    received: '00'.repeat(32) + ':' + '00'.repeat(32),
                    reconciliation: null,
                    delivered: null,
                  },
                },
              });
              if (
                !Result.isFailure(attempt) ||
                !(attempt.failure instanceof WorkspaceKeyRoundFailure)
              )
                throw new Error('expected partial round');
              const original = (yield* okMailbox(host, f.phone.publicKey).fetch(0, null, 100))
                .items[0]!.frame;
              faultActive = false;
              const retried = yield* owner.keyRound(100, attempt.failure.cursors);
              expect(retried.reconciliation.scheduled).toBe(0);
              expect(
                (yield* okMailbox(host, f.phone.publicKey).fetch(0, null, 100)).items[0]!.frame
              ).toEqual(original);
            } else {
              const round = Result.getOrThrow(attempt);
              expect(round.reconciliation).toMatchObject({ scheduled: 1, blocked: [] });
              expect(round.deliveryResults.items.map((item) => item.outcome)).toEqual(['Observed']);
            }
            yield* owner.close();
          }).pipe(Effect.provide(platform('owner', f.owner.signer, {} as CryptoKeyPair)));
          // Phone: one key round fetches, installs and reports the key.
          yield* Effect.gen(function* () {
            const phone = yield* E2eeWorkspace.open();
            const round = yield* phone.keyRound();
            expect(round.received).toBe(1);
            expect(round.results.map((item) => item.outcome)).toEqual(['Reported']);
            yield* phone.close();
            expect(yield* Effect.flip(phone.rotationStatus())).toMatchObject({
              reason: 'closed',
            });
          }).pipe(Effect.provide(platform('phone', f.phone.signer, phonePair)));
        })
      )
    );
  });
});
