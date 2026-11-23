import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Result, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import {
  sqliteLedgerFeedStore,
  sqliteLedgerPinStore,
  sqliteLocalStores,
  sqliteSubmissionJournal,
} from '@lody/e2ee-core/adapters/node-sqlite';
import {
  authenticateInstallationReport,
  hashRecordBytes,
  prepareEpochEnvelope,
  prepareLedgerCommand,
  signLedgerRecord,
  signLedgerSnapshot,
  verifyLedger,
} from '@lody/e2ee-core/protocol';
import {
  CLIENT_KEY_PURPOSES,
  ClientApprovalEvidenceStore,
  ClientCustodyWriter,
  ClientIdentityOriginals,
  ClientInstallationStore,
  ClientKeyCustody,
  ClientPairingOriginalStore,
  EpochPublicationSource,
  EpochStagingStore,
  KeyMailbox,
  LedgerFeedSource,
  LedgerLog,
  LedgerLogError,
  WorkspaceScope,
  type ClientCustodyBinding,
  type ClientInstallation,
  type ClientKeyPurpose,
  type ClientPairingKey,
  type ClientPairingOriginal,
  type ClientWrappedKey,
} from '@lody/e2ee-core/services';
import { disposeEpochKey } from '../../e2ee-core/src/internal/foundation/epoch-key';
import { envelopeFixture } from '../../e2ee-core/test/keys/fixture';
import { PersonalHostError } from '../src/errors';
import { personalLedgerControl } from '../src/ledger';
import {
  makeOwnedPersonalDeviceHost,
  PersonalCloseIncomplete,
  type PersonalHostPorts,
  type PersonalCloseOwner,
} from '../src/owned-host';
import {
  decodePersonalRequest,
  encodePersonalInvitation,
  type PersonalPairingOffer,
} from '../src/pairing';
import { PersonalHostPlatform, PersonalHostRemote, type PersonalExchange } from '../src/platform';
import { makePersonalWorkspaceRuntime } from '../src/runtime';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const unhex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));

it('failed port acquisition preserves the original failure and releases its actual resources', async () => {
  const failure = new Error('synthetic startup failure');
  const resource = { open: false };
  const ports: Layer.Layer<PersonalHostPorts, Error> = Layer.effectContext(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          resource.open = true;
        }),
        () =>
          Effect.sync(() => {
            resource.open = false;
          })
      );
      return yield* Effect.fail(failure);
    })
  );
  const result = await Effect.runPromiseExit(Effect.scoped(makeOwnedPersonalDeviceHost(ports)));
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(failure);
  expect(resource.open).toBe(false);
});

it('startup and parent-scope failure retain an unfinished resource owner past the close budget', async () => {
  const failure = new Error('synthetic startup failure');
  const resource = { open: false };
  let retained: PersonalCloseOwner | undefined;
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const ports: Layer.Layer<PersonalHostPorts, Error> = Layer.effectContext(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              resource.open = true;
            }),
            () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                resource.open = false;
              })
          );
          return yield* Effect.fail(failure);
        })
      );
      yield* Effect.gen(function* () {
        const parent = yield* Scope.make();
        const acquiring = yield* Effect.forkChild(
          Effect.exit(makeOwnedPersonalDeviceHost(ports).pipe(Scope.provide(parent)))
        );
        yield* Deferred.await(entered);
        const closing = yield* Effect.forkChild(Effect.exit(Scope.close(parent, Exit.void)));
        yield* TestClock.adjust(5000);
        const outcome = yield* Fiber.join(closing);
        expect(Exit.isFailure(outcome)).toBe(true);
        if (Exit.isSuccess(outcome)) throw new Error('parent close should report incomplete');
        const incomplete = outcome.cause.reasons.flatMap((reason) => {
          const error = Cause.isFailReason(reason)
            ? reason.error
            : Cause.isDieReason(reason)
              ? reason.defect
              : undefined;
          return error instanceof PersonalCloseIncomplete ? [error] : [];
        });
        expect(incomplete.length).toBeGreaterThan(0);
        retained = incomplete[0]!.owner;
        expect(yield* retained.settled()).toBe(false);
        expect(resource.open).toBe(true);
        yield* Fiber.interrupt(acquiring);
        yield* Deferred.succeed(release, undefined);
        yield* retained.awaitSettled();
        expect(resource.open).toBe(false);
        expect(yield* retained.settled()).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Deferred.succeed(release, undefined);
            if (retained) yield* retained.awaitSettled().pipe(Effect.orDie);
          })
        )
      );
    }).pipe(Effect.provide(TestClock.layer({ warningDelay: '1 hour' })))
  );
});

describe('makePersonalWorkspaceRuntime contentStreamsToken', () => {
  // Explicit assumption: contentStreamsToken accepts https: and loopback http: (127.0.0.1,
  // localhost, [::1]) gatewayBaseUrl values for local-stack development while rejecting
  // non-loopback plain http: URLs.
  it('accepts https: and loopback http: gatewayBaseUrl values while rejecting non-loopback http: and invalid schemes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2ee-runtime-gateway-'));
    const f = envelopeFixture();
    const accountId = 'account-1';
    const workspaceId = 'workspace-A';
    const genesisHash = hex(f.context.genesis.toBytes());
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
      genesisHash,
      genesisRecordHex: hex(f.genesisRecord),
      endorser: hex(f.owner.raw),
      membershipId: '0a'.repeat(16),
      pairingSessionId: '11'.repeat(16),
    };

    let currentInstallation: ClientInstallation | null = null;
    const retiredInstallations: ClientInstallation[] = [];
    const pairingOriginals = new Map<
      string,
      { key: ClientPairingKey; value: ClientPairingOriginal }
    >();
    const evidencePages = new Map<string, readonly Uint8Array[]>();
    let kek: CryptoKey | null = null;
    const identityOriginals = new Map<ClientWrappedKey['purpose'], Uint8Array>();
    let retainedOffer: PersonalPairingOffer | null = null;
    let invitationHex: string | undefined;
    let gatewayBaseUrl = 'https://streams.example.test';

    const pairingKeyId = (k: ClientPairingKey) =>
      JSON.stringify([
        k.accountId,
        k.workspaceId,
        hex(k.genesis.toBytes()),
        hex(k.device.toBytes()),
        k.installationId,
        k.pairingSessionId,
        k.purpose,
      ]);

    const scopeSpec = { accountId, workspaceId, genesis: f.context.genesis };
    const wsLayer = Layer.succeed(WorkspaceScope, { genesis: f.context.genesis });
    const controlStores = Layer.mergeAll(
      sqliteLedgerFeedStore({ path: join(dir, 'ledger-feed.sqlite'), mode: 'create-or-open' }),
      sqliteLedgerPinStore({ path: join(dir, 'ledger-pin.sqlite'), mode: 'create-or-open' }),
      sqliteSubmissionJournal({ path: join(dir, 'submissions.sqlite') })
    ).pipe(Layer.provide(wsLayer));
    const sqliteStores = sqliteLocalStores({ directory: dir, mode: 'create-or-open' });

    const installationLayer = Layer.succeed(ClientInstallationStore, {
      scope: scopeSpec,
      read: () => Effect.sync(() => currentInstallation),
      readRetired: (binding) =>
        Effect.sync(
          () =>
            retiredInstallations.find(
              (item) =>
                item.binding.installationId === binding.installationId &&
                item.binding.device.equals(binding.device)
            ) ?? null
        ),
      compareAndSet: (expected, next) =>
        Effect.sync(() => {
          if ((currentInstallation?.revision ?? null) !== expected) throw new Error('cas conflict');
          currentInstallation = {
            ...next,
            wrapped: next.wrapped.map((row) => ({
              purpose: row.purpose,
              blob: new Uint8Array(row.blob),
            })),
          };
        }),
      replace: (expected, next) =>
        Effect.fromResult(
          ClientInstallationStore.prepareReplacement(currentInstallation, expected, next)
        ).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              retiredInstallations.push(result.retired);
              currentInstallation = result.current;
            })
          ),
          Effect.asVoid
        ),
    });

    const writerLayer = Layer.succeed(ClientCustodyWriter, {
      scope: scopeSpec,
      run: (work) => work,
    });

    const pairingStoreLayer = Layer.succeed(ClientPairingOriginalStore, {
      load: (key) => Effect.sync(() => pairingOriginals.get(pairingKeyId(key))?.value ?? null),
      compareAndSet: (key, expectedRevision, next) =>
        Effect.sync(() => {
          const id = pairingKeyId(key);
          const existing = pairingOriginals.get(id)?.value ?? null;
          if ((existing?.revision ?? null) !== expectedRevision) throw new Error('cas conflict');
          pairingOriginals.set(id, {
            key: { ...key },
            value: {
              revision: next.revision,
              original: new Uint8Array(next.original),
              receipt: next.receipt ? new Uint8Array(next.receipt) : null,
            },
          });
        }),
      list: (binding) =>
        Effect.sync(() => ({
          entries: [...pairingOriginals.values()].filter(
            ({ key }) =>
              key.installationId === binding.installationId && key.device.equals(binding.device)
          ),
          next: null,
        })),
    });

    const custodyLayer = (binding: ClientCustodyBinding) =>
      Layer.mergeAll(
        Layer.succeed(ClientKeyCustody, {
          binding,
          status: () => Effect.sync(() => (kek ? ('available' as const) : ('missing' as const))),
          create: () =>
            Effect.promise(async () => {
              kek ??= await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
                'encrypt',
                'decrypt',
              ]);
            }),
          wrap: (purpose: ClientKeyPurpose, body: Uint8Array) =>
            Effect.promise(async () => {
              if (!kek) throw new Error('missing kek');
              const iv = crypto.getRandomValues(new Uint8Array(12));
              const aad = new TextEncoder().encode(`${binding.installationId}:${purpose}`);
              const ct = new Uint8Array(
                await crypto.subtle.encrypt(
                  { name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: new Uint8Array(aad) },
                  kek,
                  new Uint8Array(body)
                )
              );
              const blob = new Uint8Array(1 + iv.length + ct.length);
              blob[0] = 1;
              blob.set(iv, 1);
              blob.set(ct, 13);
              if (
                CLIENT_KEY_PURPOSES.slice(0, 3).includes(purpose as ClientWrappedKey['purpose']) &&
                !identityOriginals.has(purpose as ClientWrappedKey['purpose'])
              ) {
                identityOriginals.set(purpose as ClientWrappedKey['purpose'], new Uint8Array(blob));
              }
              return blob;
            }),
          unwrap: (purpose: ClientKeyPurpose, blob: Uint8Array) =>
            Effect.promise(async () => {
              if (!kek) throw new Error('missing kek');
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
              kek = null;
            }),
        }),
        Layer.succeed(ClientIdentityOriginals, {
          binding,
          read: () =>
            Effect.sync(() =>
              [...identityOriginals.entries()].map(([purpose, blob]) => ({
                purpose,
                blob: new Uint8Array(blob),
              }))
            ),
        })
      );

    const feedSourceLayer = Layer.succeed(LedgerFeedSource, {
      readAfter: (offset: string) =>
        Effect.sync(() => {
          const start = offset === '-1' ? 0 : Number(offset.split('/')[1] ?? '0');
          return {
            requestOffset: offset,
            nextOffset: start === records.length ? offset : `opaque/${records.length}`,
            records: records.slice(start),
            upToDate: true,
          };
        }),
    });

    const logLayer = Layer.succeed(LedgerLog, {
      readFrom: (_anchor, base) =>
        Effect.succeed({
          records: records.slice(base.length).map((record) => new Uint8Array(record)),
          checkpoint: { head: view().head, length: records.length },
        }),
      read: () =>
        Effect.succeed({
          records: records.map((record) => new Uint8Array(record)),
          checkpoint: { head: view().head, length: records.length },
        }),
      appendCas: () => Effect.fail(new LedgerLogError({})),
    });

    const platformLayer = Layer.succeed(PersonalHostPlatform, {
      scope: scopeSpec,
      protection: 'web-crypto',
      custody: custodyLayer,
      control: (_binding, _credential, approval) =>
        personalLedgerControl({ approval }).pipe(
          Layer.provide(Layer.mergeAll(wsLayer, feedSourceLayer, logLayer, controlStores))
        ),
      keys: (binding) =>
        Layer.mergeAll(
          sqliteStores,
          Layer.succeed(KeyMailbox, {
            status: (slot) =>
              Effect.succeed({
                ...slot,
                revision: 0,
                status: 'InstallationReported' as const,
              }),
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
                return {
                  items: [{ sender: hex(f.owner.raw), frame }],
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
              ).pipe(Effect.asVoid, Effect.orDie),
            repair: () => Effect.void,
            put: () => Effect.void,
            read: () => Effect.succeed(null),
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
      evidence: () =>
        Layer.succeed(ClientApprovalEvidenceStore, {
          load: (sessionId) => Effect.sync(() => evidencePages.get(sessionId) ?? null),
          retain: (sessionId, pages) =>
            Effect.sync(() => {
              const copy = pages.map((page) => new Uint8Array(page));
              evidencePages.set(sessionId, copy);
              return copy;
            }),
        }),
      contentToken: () =>
        Effect.sync(() => ({
          token: 'synthetic-short-lived-content',
          attachmentToken: 'synthetic-attachment-only',
          bucketId: 'protected-fixture',
          gatewayBaseUrl,
          expiresIn: 900,
          expiresAt: Date.now() + 900_000,
        })),
    });

    const remoteLayer = Layer.succeed(PersonalHostRemote, {
      accountId,
      exchange: (exchange: PersonalExchange) =>
        Effect.gen(function* () {
          if (exchange.action === 'begin' && !invitationHex) {
            const parsed = decodePersonalRequest(exchange.requestHex);
            const proposal = Result.getOrThrow(
              prepareLedgerCommand(view(), f.owner.publicKey, {
                _tag: 'AdmitDevice',
                kind: 'personal',
                signingPublicKey: Result.getOrThrow(
                  Bytes.signingPublicKey(unhex(parsed.signingPublicKey))
                ),
                encryptionPublicKey: Result.getOrThrow(
                  Bytes.encryptionPublicKey(unhex(parsed.encryptionPublicKey))
                ),
                possessionSignature: Result.getOrThrow(
                  Bytes.signature(unhex(parsed.possessionSignature))
                ),
              })
            );
            records.push(yield* signLedgerRecord(proposal, f.owner.signer));
            const signed = yield* signLedgerSnapshot({
              signer: f.owner.signer,
              ledger: () => Effect.succeed(view()),
            });
            invitationHex = encodePersonalInvitation({
              ...signed,
              workspaceId,
              offset: `opaque/${records.length}`,
            });
          }
          return {
            version: 1,
            accountId: exchange.accountId,
            workspaceId: exchange.workspaceId,
            genesisHash: exchange.genesisHash,
            pairingSessionId: exchange.pairingSessionId,
            requestHex: exchange.requestHex,
            status: invitationHex ? ('approved' as const) : ('pending' as const),
            ...(invitationHex ? { invitationHex } : {}),
          };
        }),
    });

    const ports: Layer.Layer<PersonalHostPorts, never> = Layer.mergeAll(
      platformLayer,
      remoteLayer,
      installationLayer,
      writerLayer,
      pairingStoreLayer
    );

    const scope = Effect.runSync(Scope.make());
    try {
      const runtime = await Effect.runPromise(
        makePersonalWorkspaceRuntime({
          accountId,
          workspaceId,
          genesisHash,
          ports,
          retainedOffer: () => Effect.sync(() => retainedOffer),
          account: () => Effect.succeed({ userId: accountId, source: 'network' as const }),
          ledgerRecords: () =>
            Effect.sync(() => records.map((record, position) => ({ position, record }))),
          run: (program) => Effect.runPromise(program),
          openKeyRound: { sleep: () => Effect.never },
          keyDeliveryRetry: { sleep: () => Effect.never },
        }).pipe(Scope.provide(scope))
      );

      retainedOffer = offer;
      await runtime.preparePersonalJoin!(offer);
      const claimed = await runtime.claimPersonalJoin!(workspaceId, offer.pairingSessionId);
      expect(claimed).toEqual({ ready: true, status: 'approved' });
      await runtime.open(workspaceId);
      const refreshed = await runtime.refresh(workspaceId, { keyMode: 'full' });
      expect(refreshed.hasCurrentKey).toBe(true);

      const acceptedUrls = [
        'https://streams.example.test',
        'https://streams.example.test:8443/prefix',
        'http://127.0.0.1:8788',
        'http://127.0.0.1',
        'http://localhost:8788',
        'http://localhost',
        'http://[::1]:8788',
        'http://[::1]',
      ];
      for (const candidate of acceptedUrls) {
        gatewayBaseUrl = candidate;
        const grant = await runtime.contentStreamsToken(workspaceId);
        expect(grant.gatewayBaseUrl).toBe(candidate);
      }

      const rejectedUrls = [
        'http://example.com',
        'http://192.168.1.10:8788',
        'http://10.0.0.1',
        'http://127.0.0.1.attacker.example',
        'http://localhost.attacker.example',
        'http://sub.localhost:8788',
        'http://127.0.0.2:8788',
        'http://0.0.0.0:8788',
        'ws://127.0.0.1:8788',
        'ftp://localhost/streams',
        'javascript:alert(1)',
        'not-a-url',
        '',
      ];
      for (const candidate of rejectedUrls) {
        gatewayBaseUrl = candidate;
        await expect(runtime.contentStreamsToken(workspaceId)).rejects.toMatchObject({
          _tag: 'PersonalHostError',
          code: 'invalid-input',
        } satisfies Partial<PersonalHostError>);
      }

      await runtime.close(workspaceId);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      disposeEpochKey(f.secret);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
