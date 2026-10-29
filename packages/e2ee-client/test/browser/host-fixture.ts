import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Scope,
  Scheduler,
  Duration,
} from 'effect';
import { importBrowserDevice, type BrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import {
  browserClientCustody,
  browserClientWriter,
} from '@lody/e2ee-core/adapters/browser-custody';
import {
  indexedDbClientStores,
  indexedDbClientInstallationStore,
  indexedDbClientKeyStores,
  indexedDbClientRpcOriginals,
  indexedDbClientApprovalEvidence,
} from '@lody/e2ee-core/adapters/indexeddb';
import {
  Bytes,
  hashRecordBytes,
  signGenesisRecord,
  verifyLedger,
  signLedgerSnapshot,
  prepareLedgerCommand,
  prepareDeviceAdmission,
  signLedgerRecord,
  prepareEpochEnvelope,
  authenticateInstallationReport,
  decodeInstallationReport,
  prepareLedgerRecord,
  encodeCbor,
  commitEpochKey,
  sealHistoryPacket,
  getCommittedEpochStagingKey,
  type EpochStagedGroup,
} from '@lody/e2ee-core/protocol';
import {
  ClientInstallationStore,
  ClientPairingOriginalStore,
  LedgerFeedStore,
  LedgerFeedSource,
  LedgerPinStore,
  LedgerLog,
  LedgerLogError,
  BackendError,
  SubmissionJournal,
  WorkspaceScope,
  KeyMailbox,
  EpochStagingStore,
  EpochPublicationSource,
} from '@lody/e2ee-core/services';
import {
  makeOwnedPersonalDeviceHost,
  PersonalCloseIncomplete,
  personalLedgerControl,
  PersonalHostPlatform,
  PersonalHostRemote,
  decodePersonalRequest,
  encodePersonalInvitation,
  type PersonalPairingOffer,
  type PersonalExchange,
  type PersonalExchangeResponse,
} from '../../src';
import { toHex, fromHex } from '../../src/bytes';
let baseContext: Context.Context<ClientInstallationStore | ClientPairingOriginalStore>;
let scope: Scope.Closeable,
  host: Effect.Success<ReturnType<typeof makeOwnedPersonalDeviceHost>>,
  session: Effect.Success<ReturnType<typeof host.open>> | undefined;
let offer: PersonalPairingOffer,
  owner: BrowserDevice,
  records: Uint8Array[],
  mode: 'create-or-open' | 'open-existing',
  events: string[] = [],
  failKeys = false,
  foreign = false;
const FIXED_NOW = 1_800_000_000_000;
let fixedClock: Clock.Clock;
let controlledClock:
  | {
      advance(ms: number): Effect.Effect<void>;
      expire(): Effect.Effect<void>;
      entered: Deferred.Deferred<void>;
    }
  | undefined;
let closeFibers: Fiber.Fiber<Exit.Exit<unknown, unknown>>[] = [];
let pendingWork: Fiber.Fiber<unknown, unknown> | undefined;
let failControl = false;
let stagedGroup: EpochStagedGroup | null = null;
let failStaging = false;
let oldSession: typeof session;
let otherSession: typeof session;
let trackNextReader = false;
let releasedReaders: { device: string; phase: string }[] = [];
let loseBegin = false,
  holdBegin = false,
  entered: Deferred.Deferred<void>,
  heldFiber: Fiber.Fiber<unknown, unknown>;
const key = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(0x71)));
const view = () =>
  Result.getOrThrow(
    verifyLedger({
      anchor: Result.getOrThrow(Bytes.genesisHash(fromHex(offer.genesisHash))),
      records,
      checkpoint: { head: hashRecordBytes(records.at(-1)!), length: records.length },
    })
  );
const retain = () => localStorage.setItem('remote-records', JSON.stringify(records.map(toHex)));
export async function boot(input: typeof mode = 'create-or-open', controlledClose = false) {
  mode = input;
  events = [];
  session = undefined;
  await Effect.runPromise(
    Effect.gen(function* () {
      scope = yield* Scope.make();
      closeFibers = [];
      releasedReaders = [];
      pendingWork = undefined;
      let controlledSleep: Clock.Clock['sleep'] | undefined;
      if (controlledClose) {
        let now = 0;
        const waiting = new Set<{ deadline: number; finish: () => void }>();
        const timerEntered = yield* Deferred.make<void>();
        controlledSleep = (duration) =>
          Effect.callback<void>((resume) => {
            const entry = {
              deadline: now + Duration.toMillis(duration),
              finish: () => resume(Effect.void),
            };
            waiting.add(entry);
            Deferred.doneUnsafe(timerEntered, Effect.void);
            if (entry.deadline <= now) {
              waiting.delete(entry);
              entry.finish();
            }
            return Effect.sync(() => {
              waiting.delete(entry);
            });
          });
        controlledClock = {
          entered: timerEntered,
          expire: () =>
            Effect.sync(() => {
              for (const entry of waiting) {
                waiting.delete(entry);
                entry.finish();
              }
            }),
          advance: (ms) =>
            Effect.sync(() => {
              now += ms;
              for (const entry of waiting)
                if (entry.deadline <= now) {
                  waiting.delete(entry);
                  entry.finish();
                }
            }),
        };
      } else controlledClock = undefined;
      fixedClock = yield* Clock.clockWith((clock) =>
        Effect.succeed({
          currentTimeMillisUnsafe: () => FIXED_NOW,
          currentTimeMillis: Effect.succeed(FIXED_NOW),
          currentTimeNanosUnsafe: () => BigInt(FIXED_NOW) * 1_000_000n,
          currentTimeNanos: Effect.succeed(BigInt(FIXED_NOW) * 1_000_000n),
          monotonicTimeNanosUnsafe: () => 0n,
          monotonicTimeNanos: Effect.succeed(0n),
          sleep: controlledSleep ?? clock.sleep.bind(clock),
        })
      );
      owner = yield* importBrowserDevice({
        signingPrivate: new Uint8Array(32).fill(10),
        encryptionPrivate: new Uint8Array(32).fill(9),
      }).pipe(Scope.provide(scope));
      const genesis = yield* signGenesisRecord({
        signer: owner,
        encryptionPublicKey: owner.enc,
        initialKey: key,
        membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10))),
        userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(8))),
      });
      offer = {
        version: 1,
        workspaceId: 'workspace-A',
        genesisHash: toHex(genesis.genesis.toBytes()),
        genesisRecordHex: toHex(genesis.record),
        membershipId: '0a'.repeat(16),
        endorser: toHex(owner.publicKey.toBytes()),
        pairingSessionId: '11'.repeat(16),
      };
      records = localStorage.getItem('remote-records')
        ? JSON.parse(localStorage.getItem('remote-records')!).map(fromHex)
        : [genesis.record];
      const ws = Layer.succeed(WorkspaceScope, { genesis: genesis.genesis });
      const options = {
        databaseName: 'personal-ledger',
        accountId: 'account',
        workspaceId: offer.workspaceId,
        mode,
      };
      const base = Layer.mergeAll(
        indexedDbClientStores(options),
        indexedDbClientInstallationStore({ ...options, databaseName: 'personal-custody' }),
        browserClientWriter({ accountId: 'account', workspaceId: offer.workspaceId })
      ).pipe(Layer.provide(ws));
      const platform = PersonalHostPlatform.of({
        scope: { accountId: 'account', workspaceId: offer.workspaceId, genesis: genesis.genesis },
        protection: 'web-crypto',
        custody: (binding, candidateRequest) =>
          browserClientCustody({
            databaseName: 'personal-custody',
            binding,
            mode,
            candidateRequest,
          }).pipe(Layer.provide(ws)),
        control: (binding, _credential, approval) =>
          Layer.effectContext(
            Effect.gen(function* () {
              if (trackNextReader) {
                trackNextReader = false;
                // Registered first, observed after the real control stores release.
                yield* Effect.addFinalizer(() =>
                  Effect.gen(function* () {
                    const current = yield* Context.get(baseContext, ClientInstallationStore)
                      .read()
                      .pipe(Effect.orDie);
                    if (current)
                      releasedReaders.push({
                        device: toHex(current.binding.device.toBytes()),
                        phase: current.phase,
                      });
                  })
                );
              }
              if (failControl) {
                failControl = false;
                return yield* Effect.fail(new Error('synthetic ledger I/O'));
              }
              const ledgerCtx = yield* Layer.build(
                indexedDbClientStores(options).pipe(Layer.provide(ws))
              );
              const business = yield* Layer.build(
                indexedDbClientStores({
                  ...options,
                  databaseName: 'personal-submission-' + binding.installationId,
                }).pipe(Layer.provide(ws))
              );
              const source = Layer.succeed(LedgerFeedSource, {
                readAfter: (offset: string) =>
                  Effect.sync(() => {
                    const start = offset === '-1' ? 0 : Number(offset.split('/')[1]);
                    return {
                      requestOffset: offset,
                      nextOffset: start === records.length ? offset : 'opaque/' + records.length,
                      records: records.slice(start),
                      upToDate: true,
                    };
                  }),
              });
              const log = Layer.succeed(LedgerLog, {
                read: () =>
                  Effect.succeed({
                    records: records.map((r) => new Uint8Array(r)),
                    checkpoint: { head: view().head, length: records.length },
                  }),
                appendCas: (_anchor, expected, record) =>
                  Effect.gen(function* () {
                    if (expected.length !== records.length || !expected.head.equals(view().head))
                      return yield* new LedgerLogError({});
                    records.push(new Uint8Array(record));
                    retain();
                    return undefined;
                  }),
              });
              const ports = Layer.mergeAll(
                ws,
                source,
                log,
                Layer.succeed(LedgerFeedStore, Context.get(ledgerCtx, LedgerFeedStore)),
                Layer.succeed(LedgerPinStore, Context.get(ledgerCtx, LedgerPinStore)),
                Layer.succeed(SubmissionJournal, Context.get(business, SubmissionJournal))
              );
              return yield* Layer.build(
                personalLedgerControl({ approval }).pipe(Layer.provide(ports))
              );
            })
          ),
        keys: (binding) => {
          if (failKeys) {
            failKeys = false;
            return Layer.effectContext(Effect.fail(new Error('synthetic key I/O')));
          }
          return Layer.mergeAll(
            indexedDbClientKeyStores({ databaseName: 'personal-custody', binding, mode }),
            Layer.succeed(KeyMailbox, {
              status: (slot) =>
                Effect.succeed({ ...slot, revision: 0, status: 'InstallationReported' }),
              fetch: (epoch) =>
                Effect.gen(function* () {
                  events.push('fetch');
                  const current = view(),
                    target = current.inspectState().devices.get(toHex(binding.device.toBytes()));
                  if (!target || epoch > 0) return { items: [], next: null };
                  const prepared = yield* prepareEpochEnvelope({
                    context: {
                      genesis: binding.genesis,
                      epoch: Result.getOrThrow(Bytes.epochNumber(epoch)),
                      sender: owner.publicKey,
                      recipient: binding.device,
                    },
                    key,
                    signer: owner,
                    ledger: () => Effect.succeed(current),
                  });
                  const frame = prepared;
                  return {
                    items: [{ sender: toHex(owner.publicKey.toBytes()), frame }],
                    next: null,
                  };
                }).pipe(Effect.orDie),
              report: (report) =>
                Effect.fromResult(
                  authenticateInstallationReport({
                    view: view(),
                    genesis: binding.genesis,
                    authenticatedRecipient: binding.device,
                    report,
                  })
                ).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      localStorage.setItem('installation-report', toHex(report));
                      events.push('installation-report');
                    })
                  ),
                  Effect.asVoid,
                  Effect.orDie
                ),
              repair: () =>
                Effect.sync(() => {
                  events.push('repair');
                }),
              put: () => Effect.void,
              read: () => Effect.succeed(null),
            }),
            Layer.succeed(EpochStagingStore, {
              stageGroup: () => Effect.void,
              readGroup: () =>
                Effect.gen(function* () {
                  if (failStaging) {
                    failStaging = false;
                    return yield* Effect.fail(
                      new BackendError({
                        service: 'EpochStagingStore',
                        reason: 'unavailable',
                      })
                    );
                  }
                  return stagedGroup;
                }),
              deleteGroup: () => Effect.void,
            }),
            Layer.succeed(EpochPublicationSource, {
              current: () => Effect.succeed(stagedGroup?.record ?? records[0]),
            })
          );
        },
        evidence: (binding) =>
          indexedDbClientApprovalEvidence({ databaseName: 'personal-custody', binding, mode }),
        rpc: (binding) =>
          indexedDbClientRpcOriginals({ databaseName: 'personal-custody', binding, mode }),
        drainOld: () => (session ? session.close() : Effect.void),
      });
      const remote = PersonalHostRemote.of({
        accountId: 'account',
        exchange: (request: PersonalExchange) =>
          Effect.gen(function* () {
            const prior = localStorage.getItem('request:' + request.pairingSessionId);
            if (prior && prior !== request.requestHex) throw new Error('changed request');
            localStorage.setItem('request:' + request.pairingSessionId, request.requestHex);
            if (loseBegin) {
              loseBegin = false;
              return yield* Effect.fail(new Error('synthetic unknown relay result'));
            }
            if (holdBegin) {
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.tryPromise({
                try: (signal) =>
                  new Promise<PersonalExchangeResponse>((_resolve, reject) => {
                    signal.addEventListener(
                      'abort',
                      () => {
                        events.push('network-aborted');
                        reject(new Error('aborted'));
                      },
                      { once: true }
                    );
                  }),
                catch: (cause) => cause,
              });
            }
            const approved =
              request.pairingSessionId === offer.pairingSessionId
                ? localStorage.getItem('invitation')
                : null;
            const history =
              request.pairingSessionId === '22'.repeat(16)
                ? localStorage.getItem('candidate-history')
                : null;
            return {
              version: 1,
              accountId: foreign ? 'foreign' : 'account',
              workspaceId: offer.workspaceId,
              genesisHash: offer.genesisHash,
              pairingSessionId: request.pairingSessionId,
              requestHex: request.requestHex,
              status:
                approved || history
                  ? 'approved'
                  : request.action === 'cancel'
                    ? 'cancelled'
                    : 'pending',
              ...(approved ? { invitationHex: approved } : {}),
              ...(history ? { history: JSON.parse(history) } : {}),
            } satisfies PersonalExchangeResponse;
          }),
      });
      const ownedPorts = Layer.effectContext(
        Effect.gen(function* () {
          const ctx = yield* Layer.build(base);
          baseContext = Context.pick(ClientInstallationStore, ClientPairingOriginalStore)(ctx);
          return ctx.pipe(
            Context.add(PersonalHostPlatform, platform),
            Context.add(PersonalHostRemote, remote)
          );
        })
      );
      host = yield* makeOwnedPersonalDeviceHost(ownedPorts).pipe(
        Scope.provide(scope),
        Effect.provideService(Clock.Clock, fixedClock)
      );
    })
  );
}
export async function invoke(action: string) {
  const invocation = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        switch (action) {
          case 'corruptInstallation':
            return yield* Effect.tryPromise({
              try: () =>
                new Promise<boolean>((resolve, reject) => {
                  const request = indexedDB.open('personal-custody');
                  request.onerror = () => reject(request.error);
                  request.onsuccess = () => {
                    const db = request.result,
                      tx = db.transaction('installation', 'readwrite'),
                      store = tx.objectStore('installation'),
                      read = store.get(0);
                    read.onsuccess = () => {
                      const row = read.result;
                      row.current.wrapped[0].blob[1] ^= 1;
                      store.put(row, 0);
                    };
                    tx.oncomplete = () => {
                      db.close();
                      resolve(true);
                    };
                    tx.onabort = () => {
                      db.close();
                      reject(tx.error);
                    };
                  };
                }),
              catch: (cause) => cause,
            });
          case 'requestOriginal': {
            const current = yield* Context.get(baseContext, ClientInstallationStore).read();
            if (!current) throw new Error('missing installation');
            const row = yield* Context.get(baseContext, ClientPairingOriginalStore).load({
              ...current.binding,
              pairingSessionId: offer.pairingSessionId,
              purpose: 'request',
            });
            return row
              ? (JSON.parse(new TextDecoder().decode(row.original)).requestHex as string)
              : null;
          }
          case 'openReader':
            trackNextReader = true;
            otherSession = yield* host.open(offer);
            return true;
          case 'releasedReaders':
            return [...releasedReaders];
          case 'otherLedger':
            return { length: (yield* otherSession!.ledger()).length };
          case 'closeOwners': {
            const owners = closeFibers.flatMap((fiber) => {
              const result = fiber.pollUnsafe();
              if (!result || Exit.isFailure(result) || Exit.isSuccess(result.value)) return [];
              const error = Cause.squash(result.value.cause);
              return error instanceof PersonalCloseIncomplete ? [error.owner] : [];
            });
            return {
              shared: owners.every((retained) => retained === owners[0]),
              settled: yield* Effect.forEach(owners, (retained) => retained.settled()),
            };
          }
          case 'currentPhase':
            return (yield* Context.get(baseContext, ClientInstallationStore).read())?.phase;
          case 'startPrepare':
            pendingWork = yield* Effect.forkIn(host.prepare(offer), scope);
            return true;
          case 'startKeyRound':
            pendingWork = yield* Effect.forkIn(session!.keyRound(), scope);
            return true;
          case 'startHostClose':
          case 'startSessionClose': {
            const close = action === 'startHostClose' ? host.close : session!.close;
            for (let index = 0; index < 2; index++)
              closeFibers.push(
                yield* Effect.forkIn(
                  Effect.exit(close()).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 32)),
                  scope,
                  { startImmediately: true }
                )
              );
            return true;
          }
          case 'waitCloseBudget':
            yield* Deferred.await(controlledClock!.entered);
            return true;
          case 'advanceCloseBudget':
            yield* controlledClock!.advance(5000);
            for (const fiber of closeFibers) yield* Fiber.join(fiber);
            return true;
          case 'expireCloseWaiters':
            if (controlledClock) yield* controlledClock.expire();
            return true;
          case 'closeOutcomes':
            return closeFibers.map((fiber) => {
              const result = fiber.pollUnsafe();
              if (!result) return { state: 'pending' };
              if (Exit.isFailure(result)) return { state: 'interrupted' };
              if (Exit.isSuccess(result.value)) return { state: 'closed' };
              const error = Cause.squash(result.value.cause);
              return {
                state: 'failed',
                code:
                  typeof error === 'object' && error !== null && 'code' in error
                    ? error.code
                    : 'unknown',
              };
            });
          case 'joinClose':
            for (const fiber of closeFibers) {
              const result = yield* Fiber.join(fiber);
              if (Exit.isFailure(result)) {
                const error = Cause.squash(result.cause);
                if (error instanceof PersonalCloseIncomplete) yield* error.owner.awaitSettled();
              }
            }
            return pendingWork ? Exit.isFailure(yield* Fiber.await(pendingWork)) : false;
          case 'closeSession':
            yield* session!.close();
            return true;
          case 'prepare':
            return yield* host.prepare(offer);
          case 'lostBegin':
            loseBegin = true;
            return yield* host.begin(offer);
          case 'startHeld':
            holdBegin = true;
            entered = yield* Deferred.make<void>();
            heldFiber = yield* Effect.forkIn(host.begin(offer), scope);
            yield* Deferred.await(entered);
            return true;
          case 'heldOutcome':
            return Exit.isFailure(yield* Fiber.await(heldFiber));
          case 'begin':
            return yield* host.begin(offer);
          case 'claim':
            return yield* host.claim(offer);
          case 'foreignClaim':
            foreign = true;
            return yield* host.claim(offer).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  foreign = false;
                })
              )
            );
          case 'approve': {
            const prepared = yield* host.prepare(offer),
              request = decodePersonalRequest(prepared.requestHex);
            const proposal = Result.getOrThrow(
              prepareLedgerCommand(view(), owner.publicKey, {
                _tag: 'AdmitDevice',
                kind: 'personal',
                signingPublicKey: Result.getOrThrow(
                  Bytes.signingPublicKey(fromHex(request.signingPublicKey))
                ),
                encryptionPublicKey: Result.getOrThrow(
                  Bytes.encryptionPublicKey(fromHex(request.encryptionPublicKey))
                ),
                possessionSignature: Result.getOrThrow(
                  Bytes.signature(fromHex(request.possessionSignature))
                ),
              })
            );
            records.push(yield* signLedgerRecord(proposal, owner));
            retain();
            const receipt = yield* signLedgerSnapshot({
              signer: owner,
              ledger: () => Effect.succeed(view()),
            });
            const invitation = encodePersonalInvitation({
              ...receipt,
              workspaceId: offer.workspaceId,
              offset: 'opaque/' + records.length,
            });
            localStorage.setItem('invitation', invitation);
            if (!localStorage.getItem('initial-invitation'))
              localStorage.setItem('initial-invitation', invitation);
            return true;
          }
          case 'open':
            if (session) yield* session.close();
            session = yield* host.open(offer);
            return true;
          case 'cancel':
            return yield* host.cancel(offer);
          case 'retryOffer':
            return yield* host.prepare({ ...offer, pairingSessionId: '22'.repeat(16) });
          case 'claimCandidate':
            return yield* host.claim({ ...offer, pairingSessionId: '22'.repeat(16) }, true);
          case 'openCandidate':
            oldSession = session;
            session = yield* host.open({ ...offer, pairingSessionId: '22'.repeat(16) }, true);
            return true;
          case 'candidateControlFailure':
            failControl = true;
            return yield* host.open({ ...offer, pairingSessionId: '22'.repeat(16) }, true);
          case 'oldOwner':
            return yield* oldSession!.ledger();
          case 'approveCandidate': {
            const p = yield* host.prepare({ ...offer, pairingSessionId: '22'.repeat(16) }, true),
              request = decodePersonalRequest(p.requestHex);
            const proposal = Result.getOrThrow(
              prepareLedgerCommand(view(), owner.publicKey, {
                _tag: 'AdmitDevice',
                kind: 'personal',
                signingPublicKey: Result.getOrThrow(
                  Bytes.signingPublicKey(fromHex(request.signingPublicKey))
                ),
                encryptionPublicKey: Result.getOrThrow(
                  Bytes.encryptionPublicKey(fromHex(request.encryptionPublicKey))
                ),
                possessionSignature: Result.getOrThrow(
                  Bytes.signature(fromHex(request.possessionSignature))
                ),
              })
            );
            records.push(yield* signLedgerRecord(proposal, owner));
            retain();
            localStorage.setItem(
              'candidate-history',
              JSON.stringify([
                {
                  workspaceId: offer.workspaceId,
                  genesisHash: offer.genesisHash,
                  checkpoint: { length: records.length, headHash: toHex(view().head.toBytes()) },
                  startIndex: 0,
                  recordsHex: records.map(toHex),
                  position: 'opaque/' + records.length,
                  nextCursor: null,
                },
              ])
            );
            return true;
          }
          case 'poisonSubmission':
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const binding = session!.binding,
                  genesis = binding.genesis;
                const proposal = Result.getOrThrow(
                  prepareLedgerCommand(view(), owner.publicKey, {
                    _tag: 'DeclareCapabilities',
                    capabilities: [1],
                  })
                );
                const original = yield* signLedgerRecord(proposal, owner);
                const context = yield* Layer.build(
                  indexedDbClientStores({
                    databaseName: 'personal-submission-' + binding.installationId,
                    accountId: binding.accountId,
                    workspaceId: binding.workspaceId,
                    mode: 'open-existing',
                  }).pipe(Layer.provide(Layer.succeed(WorkspaceScope, { genesis })))
                );
                yield* Context.get(context, SubmissionJournal).prepare(genesis, original);
                return true;
              })
            );
          case 'resumeForeign':
            return yield* session!.resume();
          case 'addMachine': {
            const machine = yield* importBrowserDevice({
              signingPrivate: new Uint8Array(32).fill(12),
              encryptionPrivate: new Uint8Array(32).fill(13),
            }).pipe(Scope.provide(scope));
            const proof = yield* prepareDeviceAdmission({
              genesis: Result.getOrThrow(Bytes.genesisHash(fromHex(offer.genesisHash))),
              membershipId: Result.getOrThrow(Bytes.membershipId(fromHex(offer.membershipId))),
              encryptionPublicKey: machine.enc,
              kind: 'machine',
              machineId: 'fixture-machine',
              signer: machine,
            });
            const proposal = Result.getOrThrow(
              prepareLedgerCommand(view(), owner.publicKey, {
                _tag: 'AdmitDevice',
                kind: 'machine',
                machineId: 'fixture-machine',
                replaces: null,
                signingPublicKey: machine.publicKey,
                encryptionPublicKey: machine.enc,
                possessionSignature: proof.possessionSignature,
              })
            );
            records.push(yield* signLedgerRecord(proposal, owner));
            retain();
            return true;
          }
          case 'rpc':
          case 'rpcChanged':
            return yield* session!.prepareDispatch('fixture-machine', {
              sessionId: 'synthetic-session',
              userTurnId: 'synthetic-turn',
              userId: 'synthetic-user',
              timestamp: new Date(FIXED_NOW).toISOString(),
              inputConfig: action === 'rpcChanged' ? { changed: true } : {},
            });
          case 'candidate':
            return yield* host.prepare({ ...offer, pairingSessionId: '22'.repeat(16) }, true);
          case 'secondCandidate':
            return yield* host.prepare({ ...offer, pairingSessionId: '33'.repeat(16) }, true);
          case 'status':
            return yield* session!.status();
          case 'wrongOffer':
            return yield* host.prepare({ ...offer, genesisHash: '77'.repeat(32) });
          case 'rotateRemote': {
            const next = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(0x72))),
              genesis = Result.getOrThrow(Bytes.genesisHash(fromHex(offer.genesisHash)));
            const body = Result.getOrThrow(
              encodeCbor([
                view().head.toBytes(),
                owner.publicKey.toBytes(),
                [
                  7,
                  1,
                  Result.getOrThrow(commitEpochKey(genesis, 1, next)).toBytes(),
                  Result.getOrThrow(
                    sealHistoryPacket({ genesis, epoch: 1, currentKey: next, previousKey: key })
                  ),
                ],
              ])
            );
            records.push(
              yield* signLedgerRecord(Result.getOrThrow(prepareLedgerRecord(view(), body)), owner)
            );
            retain();
            return true;
          }
          case 'stagingUnavailable':
            failStaging = true;
            return true;
          case 'corruptStaged':
            stagedGroup = { ...stagedGroup!, genesis: '77'.repeat(32) };
            return true;
          case 'stageCurrent': {
            const current = view(),
              epoch = current.inspectState().epoch.number,
              locator = Result.getOrThrow(getCommittedEpochStagingKey(current, epoch)),
              next = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(0x72)));
            const envelopes = [];
            for (const recipient of current.inspectState().devices.keys()) {
              const frame = yield* prepareEpochEnvelope({
                context: {
                  genesis: Result.getOrThrow(Bytes.genesisHash(fromHex(offer.genesisHash))),
                  epoch: Result.getOrThrow(Bytes.epochNumber(epoch)),
                  sender: owner.publicKey,
                  recipient: Result.getOrThrow(Bytes.signingPublicKey(fromHex(recipient))),
                },
                key: next,
                signer: owner,
                ledger: () => Effect.succeed(current),
              });
              envelopes.push({ recipient, frame });
            }
            stagedGroup = { ...locator, record: records.at(-1)!, envelopes };
            return true;
          }
          case 'ledger': {
            const current = yield* session!.ledger();
            return { length: current.length, head: toHex(current.head.toBytes()) };
          }
          case 'refresh':
            yield* session!.refresh();
            return true;
          case 'keyFailure':
            failKeys = true;
            return yield* session!.keyRound();
          case 'keyRound':
            return yield* session!.keyRound();
          case 'seal': {
            const doc = yield* session!.document('doc:1', 'loro');
            const sealed = yield* doc.seal({
              context: {
                protocol: 'loro-streams-crdt-payload-protection',
                version: 2,
                kind: 'update_batch',
              },
              plaintext: Uint8Array.of(72, 105),
              additionalData: () => new Uint8Array(),
            });
            localStorage.setItem(
              'sealed',
              JSON.stringify({ header: toHex(sealed.header), sealed: toHex(sealed.sealed) })
            );
            return true;
          }
          case 'openBody': {
            const doc = yield* session!.document('doc:1', 'loro');
            const sealed = JSON.parse(localStorage.getItem('sealed')!);
            const plaintext = yield* doc.open({
              context: {
                protocol: 'loro-streams-crdt-payload-protection',
                version: 2,
                kind: 'update_batch',
              },
              header: fromHex(sealed.header),
              sealed: fromHex(sealed.sealed),
              additionalData: new Uint8Array(),
            });
            try {
              return Array.from(plaintext);
            } finally {
              plaintext.fill(0);
            }
          }
          case 'revoke': {
            const p = yield* host.prepare(offer);
            const command = Result.getOrThrow(
              prepareLedgerCommand(view(), owner.publicKey, {
                _tag: 'RevokeDevice',
                target: Result.getOrThrow(Bytes.signingPublicKey(fromHex(p.signingPublicKey))),
              })
            );
            records.push(yield* signLedgerRecord(command, owner));
            retain();
            return true;
          }
          case 'receipt':
            return Result.getOrThrow(
              decodeInstallationReport(fromHex(localStorage.getItem('installation-report')!))
            ).context;
          case 'events':
            return [...events];
          case 'close':
            yield* host.close();
            return true;
          default:
            throw new Error('fixture action');
        }
      })
    ).pipe(Effect.provideService(Clock.Clock, fixedClock))
  );
  if (Result.isSuccess(invocation)) return { ok: true as const, value: invocation.success };
  const error = invocation.failure;
  const reason =
    typeof error === 'object' && error !== null
      ? 'reason' in error
        ? error.reason
        : 'code' in error
          ? error.code
          : 'message' in error
            ? error.message
            : 'fixture-error'
      : 'fixture-error';
  return { ok: false as const, reason };
}
export async function stop() {
  await Effect.runPromise(
    Scope.close(scope, Exit.void).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const unowned = [];
          for (const reason of cause.reasons) {
            const error = Cause.isFailReason(reason)
              ? reason.error
              : Cause.isDieReason(reason)
                ? reason.defect
                : undefined;
            if (error instanceof PersonalCloseIncomplete) yield* error.owner.awaitSettled();
            else unowned.push(reason);
          }
          if (unowned.length) return yield* Effect.failCause(Cause.fromReasons(unowned));
          return undefined;
        })
      )
    )
  );
}

export function startParentClose() {
  closeFibers.push(Effect.runFork(Effect.exit(Scope.close(scope, Exit.void))));
}
