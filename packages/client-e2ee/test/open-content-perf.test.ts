import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect, Layer, Result } from 'effect';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  Bytes,
  authenticateInstallationReport,
  hashRecordBytes,
  prepareEpochEnvelope,
  prepareLedgerCommand,
  signLedgerRecord,
  signLedgerSnapshot,
  verifyLedger,
} from '@lody/e2ee-core/protocol';
import {
  indexedDbClientStores,
  indexedDbClientInstallationStore,
  indexedDbClientKeyStores,
  indexedDbClientApprovalEvidence,
} from '@lody/e2ee-core/adapters/indexeddb';
import {
  CLIENT_KEY_PURPOSES,
  ClientCustodyWriter,
  ClientIdentityOriginals,
  ClientKeyCustody,
  EpochPublicationSource,
  EpochStagingStore,
  KeyMailbox,
  LedgerFeedSource,
  LedgerLog,
  LedgerLogError,
  WorkspaceScope,
  type ClientCustodyBinding,
  type ClientKeyPurpose,
  type ClientWrappedKey,
} from '@lody/e2ee-core/services';
import {
  PersonalHostPlatform,
  PersonalHostRemote,
  makePersonalWorkspaceRuntime,
  personalLedgerControl,
  decodePersonalRequest,
  encodePersonalInvitation,
  type PersonalPairingOffer,
} from '@lody/e2ee-client';
import { createStore, type PlatformSessionState } from '@lody/platform';
import { personalEntry } from '../src/entry';
import { personalEntryPins } from '../src/entry-pins';
import { envelopeFixture } from '../../e2ee-core/test/keys/fixture';
import { disposeEpochKey } from '../../e2ee-core/src/internal/foundation/epoch-key';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const unhex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));

const UPDATE_CONTEXT = {
  protocol: 'loro-streams-crdt-payload-protection' as const,
  version: 2 as const,
  kind: 'update_batch' as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function setupOpenContentHarness(prefix: string, workspaceId: string, pairingSeed: string) {
  const rawIdb = new IDBFactory();
  const counters = { idbOpens: 0, idbTxs: 0, custodyUnwraps: 0 };

  const instrumentedIdb = new Proxy(rawIdb, {
    get(target, prop, receiver) {
      if (prop === 'open') {
        return (...args: Parameters<IDBFactory['open']>) => {
          counters.idbOpens++;
          const req = target.open(...args);
          const origAddListener = req.addEventListener.bind(req);
          origAddListener('success', () => {
            const db = req.result;
            if (db && !(db as unknown as { __wrapped?: boolean }).__wrapped) {
              (db as unknown as { __wrapped?: boolean }).__wrapped = true;
              const origTx = db.transaction.bind(db);
              db.transaction = ((...txArgs: Parameters<IDBDatabase['transaction']>) => {
                counters.idbTxs++;
                return origTx(...txArgs);
              }) as IDBDatabase['transaction'];
            }
          });
          return req;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  vi.stubGlobal('indexedDB', instrumentedIdb);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);

  const f = envelopeFixture();
  const records: Uint8Array[] = f.records();
  const view = () =>
    Result.getOrThrow(
      verifyLedger({
        anchor: f.context.genesis,
        records,
        checkpoint: { head: hashRecordBytes(records.at(-1)!), length: records.length },
      })
    );
  const offer: PersonalPairingOffer = {
    version: 1,
    workspaceId,
    genesisHash: hex(f.context.genesis.toBytes()),
    genesisRecordHex: hex(f.genesisRecord),
    endorser: hex(f.owner.raw),
    membershipId: hex(new Uint8Array(16).fill(10)),
    pairingSessionId: pairingSeed.repeat(16),
  };

  const identityOriginals = new Map<string, Map<ClientWrappedKey['purpose'], Uint8Array>>();
  const keks = new Map<string, CryptoKey>();
  const makeCustody = (binding: ClientCustodyBinding) => {
    const k = binding.installationId;
    const originalsMap = identityOriginals.get(k) ?? new Map();
    identityOriginals.set(k, originalsMap);
    const custody: ClientKeyCustody['Service'] = {
      binding,
      status: () => Effect.succeed('available' as const),
      create: () =>
        Effect.promise(async () => {
          if (!keks.has(k)) {
            keks.set(
              k,
              await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
                'encrypt',
                'decrypt',
              ])
            );
          }
        }),
      wrap: (purpose: ClientKeyPurpose, plaintext: Uint8Array) =>
        Effect.promise(async () => {
          const kek = keks.get(k)!;
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const aad = new TextEncoder().encode(`${binding.installationId}:${purpose}`);
          const ct = new Uint8Array(
            await crypto.subtle.encrypt(
              { name: 'AES-GCM', iv, additionalData: aad },
              kek,
              new Uint8Array(plaintext)
            )
          );
          const blob = new Uint8Array(1 + 12 + ct.length);
          blob[0] = 1;
          blob.set(iv, 1);
          blob.set(ct, 13);
          if (
            CLIENT_KEY_PURPOSES.slice(0, 3).includes(purpose as ClientWrappedKey['purpose']) &&
            !originalsMap.has(purpose as ClientWrappedKey['purpose'])
          ) {
            originalsMap.set(purpose as ClientWrappedKey['purpose'], new Uint8Array(blob));
          }
          return blob;
        }),
      unwrap: (purpose: ClientKeyPurpose, blob: Uint8Array) =>
        Effect.promise(async () => {
          counters.custodyUnwraps++;
          const kek = keks.get(k)!;
          const iv = blob.subarray(1, 13);
          const ct = blob.subarray(13);
          const aad = new TextEncoder().encode(`${binding.installationId}:${purpose}`);
          return new Uint8Array(
            await crypto.subtle.decrypt(
              { name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: new Uint8Array(aad) },
              kek,
              new Uint8Array(ct)
            )
          );
        }),
      delete: () =>
        Effect.sync(() => {
          keks.delete(k);
        }),
    };
    const originals: ClientIdentityOriginals['Service'] = {
      binding,
      read: () =>
        Effect.sync(() =>
          [...originalsMap.entries()].map(([purpose, blob]) => ({
            purpose,
            blob: new Uint8Array(blob),
          }))
        ),
    };
    return Layer.mergeAll(
      Layer.succeed(ClientKeyCustody, custody),
      Layer.succeed(ClientIdentityOriginals, originals)
    );
  };

  let invitationHex = '';
  let recipientDeviceHex = '';
  const pins = personalEntryPins(`${prefix}-pins`);
  const ws = Layer.succeed(WorkspaceScope, { genesis: f.context.genesis });
  const baseIdb = {
    databaseName: `${prefix}-ledger-db`,
    accountId: 'account-A',
    workspaceId,
    mode: 'create-or-open' as const,
  };

  const makePortsLayer = (
    drainOld: (binding: ClientCustodyBinding) => Effect.Effect<void, unknown> = () => Effect.void
  ) =>
    Layer.effectContext(
      Effect.gen(function* () {
        const stores = yield* Layer.build(
          Layer.mergeAll(
            indexedDbClientStores(baseIdb),
            indexedDbClientInstallationStore({
              ...baseIdb,
              databaseName: `${prefix}-custody-db`,
            })
          ).pipe(Layer.provide(ws))
        );
        const writer: ClientCustodyWriter['Service'] = {
          scope: { accountId: 'account-A', workspaceId, genesis: f.context.genesis },
          run: (work) => work,
        };
        const platform: PersonalHostPlatform['Service'] = {
          scope: { accountId: 'account-A', workspaceId, genesis: f.context.genesis },
          protection: 'web-crypto',
          drainOld,
          custody: (binding) => makeCustody(binding),
          evidence: (binding) =>
            indexedDbClientApprovalEvidence({
              databaseName: `${prefix}-evidence-db`,
              binding,
              mode: 'create-or-open',
            }),
          control: (_binding, _cred, approval) =>
            personalLedgerControl({ approval }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeedContext(stores),
                  ws,
                  Layer.succeed(LedgerFeedSource, {
                    readAfter: (offset) =>
                      Effect.sync(() => {
                        const start = offset === '-1' ? 0 : Number(offset.split('/')[1] ?? '0');
                        return {
                          requestOffset: offset,
                          nextOffset:
                            start === records.length ? offset : `opaque/${records.length}`,
                          records: records.slice(start),
                          upToDate: true,
                        };
                      }),
                  }),
                  Layer.succeed(LedgerLog, {
                    read: () =>
                      Effect.sync(() => ({
                        records: records.slice(),
                        checkpoint: { head: view().head, length: records.length },
                      })),
                    appendCas: () => Effect.fail(new LedgerLogError({})),
                  })
                )
              )
            ),
          keys: (binding) =>
            Layer.mergeAll(
              indexedDbClientKeyStores({
                databaseName: `${prefix}-custody-db`,
                binding,
                mode: 'create-or-open',
              }),
              Layer.succeed(KeyMailbox, {
                put: () => Effect.void,
                read: () => Effect.succeed(null),
                fetch: (epoch) =>
                  Effect.gen(function* () {
                    const current = view();
                    if (
                      epoch !== 0 ||
                      !current.inspectState().devices.has(hex(binding.device.toBytes()))
                    )
                      return { items: [], next: null };
                    const frame = yield* prepareEpochEnvelope({
                      context: {
                        genesis: binding.genesis,
                        epoch: Result.getOrThrow(Bytes.epochNumber(0)),
                        sender: f.owner.publicKey,
                        recipient: binding.device,
                      },
                      key: f.secret,
                      signer: f.owner.signer,
                      ledger: () => Effect.succeed(current),
                    });
                    return { items: [{ sender: hex(f.owner.raw), frame }], next: null };
                  }).pipe(Effect.orDie),
                status: (slot) =>
                  Effect.succeed({
                    ...slot,
                    revision: 0,
                    status: 'InstallationReported' as const,
                  }),
                report: (report) =>
                  Effect.fromResult(
                    authenticateInstallationReport({
                      view: view(),
                      genesis: binding.genesis,
                      authenticatedRecipient: binding.device,
                      report,
                    })
                  ).pipe(Effect.asVoid, Effect.orDie),
                repair: () => Effect.void,
              }),
              Layer.succeed(EpochStagingStore, {
                stageGroup: () => Effect.void,
                readGroup: () => Effect.succeed(null),
                deleteGroup: () => Effect.void,
              }),
              Layer.succeed(EpochPublicationSource, {
                current: () => Effect.succeed(records[0]!),
              })
            ),
        };
        const remote: PersonalHostRemote['Service'] = {
          accountId: 'account-A',
          exchange: (req) =>
            Effect.gen(function* () {
              if (req.action === 'begin') {
                const decoded = decodePersonalRequest(req.requestHex);
                recipientDeviceHex = decoded.signingPublicKey;
                const proposal = Result.getOrThrow(
                  prepareLedgerCommand(view(), f.owner.publicKey, {
                    _tag: 'AdmitDevice',
                    kind: 'personal',
                    signingPublicKey: Result.getOrThrow(
                      Bytes.signingPublicKey(unhex(decoded.signingPublicKey))
                    ),
                    encryptionPublicKey: Result.getOrThrow(
                      Bytes.encryptionPublicKey(unhex(decoded.encryptionPublicKey))
                    ),
                    possessionSignature: Result.getOrThrow(
                      Bytes.signature(unhex(decoded.possessionSignature))
                    ),
                  })
                );
                const admitted = yield* signLedgerRecord(proposal, f.owner.signer);
                records.push(admitted);
                const latest = view();
                const snap = yield* signLedgerSnapshot({
                  signer: f.owner.signer,
                  ledger: () => Effect.succeed(latest),
                });
                invitationHex = encodePersonalInvitation({
                  workspaceId,
                  ...snap,
                  offset: `opaque/${records.length}`,
                });
                return { ...req, status: 'pending' as const };
              }
              return { ...req, status: 'approved' as const, invitationHex };
            }),
        };
        return yield* Layer.build(
          Layer.mergeAll(
            Layer.succeedContext(stores),
            Layer.succeed(ClientCustodyWriter, writer),
            Layer.succeed(PersonalHostPlatform, platform),
            Layer.succeed(PersonalHostRemote, remote)
          )
        );
      })
    );

  return {
    f,
    records,
    view,
    offer,
    pins,
    counters,
    getRecipientDeviceHex: () => recipientDeviceHex,
    makePortsLayer,
    dispose: () => {
      pins.close();
      disposeEpochKey(f.secret);
    },
  };
}

describe('openContent hot path performance & security invariants', () => {
  it('keeps hot openContent at zero IDB opens, zero custody unwraps, bounded IDB txs, and cold reopen at 4 unwraps', async () => {
    const h = setupOpenContentHarness('bench', 'ws-bench', '11');
    const sessionStore = createStore<PlatformSessionState>({
      status: 'authenticated',
      user: { id: 'account-A', name: 'Bench', email: 'bench@test.local', image: null },
    });
    const entry = personalEntry({
      run: Effect.runPromise,
      pins: h.pins,
      ports: ({ drainOld }) => h.makePortsLayer(drainOld),
      ledgerRecords: () => () => Effect.succeed([]),
    });

    try {
      const rt = entry.createRuntime({ session: sessionStore })!;
      await rt.preparePersonalJoin!(h.offer);
      await rt.claimPersonalJoin!(h.offer.workspaceId, h.offer.pairingSessionId);
      const opened = await rt.open(h.offer.workspaceId);
      await rt.refresh(h.offer.workspaceId, { keyMode: 'receive' });

      const room = { kind: 'doc' as const, docId: 'bench-doc' };
      const aad = new TextEncoder().encode('loro-streams-crdt-payload-protection/v2\0header');
      const N = 8;
      const frames: Array<{ header: Uint8Array; sealed: Uint8Array; expected: Uint8Array }> = [];
      for (let i = 0; i < N; i++) {
        const plaintext = new TextEncoder().encode(`frame-payload-${i}-content`);
        const sealed = await rt.seal(h.offer.workspaceId, {
          epoch: 0,
          room,
          context: UPDATE_CONTEXT,
          additionalData: aad,
          plaintext,
        });
        frames.push({ header: sealed.header, sealed: sealed.sealed, expected: plaintext });
      }

      await rt.openContent(h.offer.workspaceId, {
        room,
        context: UPDATE_CONTEXT,
        header: frames[0]!.header,
        additionalData: aad,
        sealed: frames[0]!.sealed,
      });

      h.counters.idbOpens = 0;
      h.counters.idbTxs = 0;
      h.counters.custodyUnwraps = 0;
      for (const fItem of frames) {
        const out = await rt.openContent(h.offer.workspaceId, {
          room,
          context: UPDATE_CONTEXT,
          header: fItem.header,
          additionalData: aad,
          sealed: fItem.sealed,
        });
        expect(out).toEqual(fItem.expected);
      }

      const hotIdbOpens = h.counters.idbOpens;
      const hotIdbTxs = h.counters.idbTxs;
      const hotUnwraps = h.counters.custodyUnwraps;

      await rt.close(h.offer.workspaceId, 'account-A', opened.readerOwner);
      const coldUnwrapsBefore = h.counters.custodyUnwraps;
      const reopened = await rt.open(h.offer.workspaceId);
      const coldUnwraps = h.counters.custodyUnwraps - coldUnwrapsBefore;
      await rt.close(h.offer.workspaceId, 'account-A', reopened.readerOwner);

      expect(hotIdbOpens).toBe(0);
      expect(hotIdbTxs).toBeLessThanOrEqual(N * 6);
      expect(hotUnwraps).toBe(0);
      expect(coldUnwraps).toBe(4);

      const pinOpensBefore = h.counters.idbOpens;
      for (let i = 0; i < 4; i++) {
        const pin = await Effect.runPromise(h.pins.read('account-A', h.offer.workspaceId));
        expect(pin?.phase).toBe('ready');
      }
      expect(h.counters.idbOpens - pinOpensBefore).toBe(0);
    } finally {
      await entry.close();
      h.dispose();
    }
  });

  it('refuses plaintext delivery and wipes buffer when recipient is concurrently revoked before delivery', async () => {
    const h = setupOpenContentHarness('revoke-race', 'ws-revoke-race', '33');
    let armPostDecryptPause = false;
    let postDecryptAccountCalls = 0;
    let enteredPostDecrypt!: () => void;
    const onEnteredPostDecrypt = new Promise<void>((resolve) => {
      enteredPostDecrypt = resolve;
    });
    let releasePostDecrypt!: () => void;
    const gatePostDecrypt = new Promise<void>((resolve) => {
      releasePostDecrypt = resolve;
    });

    try {
      const runtimeScope = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const rt = yield* makePersonalWorkspaceRuntime({
              accountId: 'account-A',
              workspaceId: h.offer.workspaceId,
              genesisHash: h.offer.genesisHash,
              ports: h.makePortsLayer(),
              retainedOffer: () => Effect.succeed(h.offer),
              account: () =>
                Effect.promise(async () => {
                  if (armPostDecryptPause) {
                    postDecryptAccountCalls++;
                    if (postDecryptAccountCalls === 2) {
                      armPostDecryptPause = false;
                      enteredPostDecrypt();
                      await gatePostDecrypt;
                    }
                  }
                  return { userId: 'account-A', source: 'network' as const };
                }),
              ledgerRecords: () => Effect.succeed([]),
              run: Effect.runPromise,
            });
            yield* Effect.promise(async () => {
              await rt.preparePersonalJoin!(h.offer);
              await rt.claimPersonalJoin!(h.offer.workspaceId, h.offer.pairingSessionId);
              await rt.open(h.offer.workspaceId);
              await rt.refresh(h.offer.workspaceId, { keyMode: 'receive' });

              const room = { kind: 'doc' as const, docId: 'revoke-race-doc' };
              const aad = new TextEncoder().encode(
                'loro-streams-crdt-payload-protection/v2\0header'
              );
              const secret = new TextEncoder().encode('confidential-frame-payload');
              const sealed = await rt.seal(h.offer.workspaceId, {
                epoch: 0,
                room,
                context: UPDATE_CONTEXT,
                additionalData: aad,
                plaintext: secret,
              });

              expect(
                await rt.openContent(h.offer.workspaceId, {
                  room,
                  context: UPDATE_CONTEXT,
                  header: sealed.header,
                  additionalData: aad,
                  sealed: sealed.sealed,
                })
              ).toEqual(secret);

              const revokeProposal = Result.getOrThrow(
                prepareLedgerCommand(h.view(), h.f.owner.publicKey, {
                  _tag: 'RevokeDevice',
                  target: Result.getOrThrow(
                    Bytes.signingPublicKey(unhex(h.getRecipientDeviceHex()))
                  ),
                })
              );
              const revokeRecord = await Effect.runPromise(
                signLedgerRecord(revokeProposal, h.f.owner.signer)
              );
              const startIndex = h.records.length;
              h.records.push(revokeRecord);
              const revokedView = h.view();

              const wipedBuffers: Uint8Array[] = [];
              const origFill = Uint8Array.prototype.fill;
              const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
                this: Uint8Array,
                value: number,
                ...rest
              ) {
                if (value === 0 && this.length === secret.length && this[0] === secret[0]) {
                  wipedBuffers.push(this);
                }
                return origFill.call(this, value, ...rest);
              });

              try {
                armPostDecryptPause = true;
                postDecryptAccountCalls = 0;
                const openPromise = rt.openContent(h.offer.workspaceId, {
                  room,
                  context: UPDATE_CONTEXT,
                  header: sealed.header,
                  additionalData: aad,
                  sealed: sealed.sealed,
                });

                await onEnteredPostDecrypt;
                await rt.ingestLedgerRecords(h.offer.workspaceId, {
                  workspaceId: h.offer.workspaceId,
                  genesisHash: h.offer.genesisHash,
                  checkpoint: {
                    length: revokedView.length,
                    headHash: hex(revokedView.head.toBytes()),
                  },
                  startIndex,
                  recordsHex: [hex(revokeRecord)],
                  position: `opaque/${revokedView.length}`,
                  nextCursor: null,
                });
                releasePostDecrypt();

                await expect(openPromise).rejects.toThrow('e2ee_device_revoked');
                expect(wipedBuffers.length).toBeGreaterThan(0);
                expect(wipedBuffers.every((buf) => buf.every((b) => b === 0))).toBe(true);
              } finally {
                fillSpy.mockRestore();
              }
            });
            return true;
          })
        )
      );
      expect(runtimeScope).toBe(true);
    } finally {
      h.dispose();
    }
  });
});
