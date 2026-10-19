import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Deferred, Effect, Exit, Fiber, Result, Scope } from 'effect';
import { StreamsClient } from '@loro-dev/streams-client';
import { Bytes } from '@lody/e2ee-core';
import { encodeCbor, type ContentScope } from '@lody/e2ee-core/protocol';
import { scopedDocumentKey, sealDocument } from '@lody/e2ee-core/protocol';
import { prepareLedgerCommand } from '@lody/e2ee-core/protocol';
import { prepareLedgerRecord, signLedgerRecord } from '@lody/e2ee-core/protocol';
import { frameLedgerRecord } from '@lody/e2ee-core/protocol';
import { commitEpochKey, sealHistoryPacket } from '@lody/e2ee-core/protocol';
import { expect, it, vi } from 'vitest';
import { makeLabAttackObserver } from '../src/platform/attack-observer';
import { makeLabContentTrace } from '../src/platform/content-trace';
import { makeLabScenarioFixture } from '../src/platform/scenario-fixture';
import { openLabExistingWorkspace } from '../src/platform/workspace-session';
import { makeLabSdkOwner } from '../src/platform/sdk-owner';
import { history } from './ledger-fixture';
const ok = Result.getOrThrow;

it('wipes owned plaintext after partial capture failure and waits native settlement before Scope destroys earlier owners', async () => {
  const f = history(),
    marker = new TextEncoder().encode('private observer copy marker'),
    cleared: Uint8Array[] = [];
  const originalFill = Uint8Array.prototype.fill;
  const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
    this: Uint8Array,
    value: number,
    start?: number,
    end?: number
  ) {
    if (value === 0 && this.length === marker.length && Buffer.compare(this, marker) === 0)
      cleared.push(this);
    return originalFill.call(this, value, start, end);
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope: ContentScope = {
            genesis: Buffer.from(f.anchor.toBytes()).toString('hex'),
            resource: 'document-A',
            epoch: 1,
            purpose: 'doc-update',
          };
          const first = { scope, frame: new Uint8Array([1]), expectedPlaintext: marker };
          const broken = {
            ...first,
            get expectedPlaintext(): Uint8Array {
              throw new Error('capture failed after first private copy');
            },
          };
          const probe = {
            key: ok(Bytes.epochKey(new Uint8Array(32).fill(81))),
            keyEpoch: 0,
            freshnessBypassed: false,
            samples: [first, broken],
          };
          const bad = yield* makeLabAttackObserver({
            genesis: f.anchor,
            ledger: () => Effect.succeed(f.view),
            backend: { read: () => Effect.succeed([]) },
          });
          expect(Result.isFailure(yield* Effect.result(bad.observe({ insider: probe })))).toBe(
            true
          );
          expect(cleared).toHaveLength(1);
          expect(cleared[0].every((byte) => byte === 0)).toBe(true);
          expect(new TextDecoder().decode(marker)).toBe('private observer copy marker');

          const child = yield* Scope.make(),
            entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          let settled = false,
            ownerClosed = false,
            closedEarly = false;
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(release, undefined).pipe(Effect.andThen(Scope.close(child, Exit.void)))
          );
          const native = yield* makeLabSdkOwner(() => ({
            close: async () => {
              ownerClosed = true;
              closedEarly = !settled;
            },
          })).pipe(Effect.provideService(Scope.Scope, child));
          const observer = yield* makeLabAttackObserver({
            genesis: f.anchor,
            ledger: () => Effect.succeed(f.view),
            backend: {
              read: () =>
                native.invoke(async () => {
                  Deferred.doneUnsafe(entered, Effect.void);
                  await Effect.runPromise(Deferred.await(release));
                  settled = true;
                  return [];
                }),
            },
          }).pipe(Effect.provideService(Scope.Scope, child));
          const pending = yield* observer
            .observe({ insider: { ...probe, samples: [first] } })
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const closing = yield* Scope.close(child, Exit.void).pipe(
            Effect.forkChild({ startImmediately: true })
          );
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          expect(closing.pollUnsafe()).toBeUndefined();
          expect(ownerClosed).toBe(false);
          expect(cleared).toHaveLength(1);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(closing);
          expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true);
          expect(settled).toBe(true);
          expect(ownerClosed).toBe(true);
          expect(closedEarly).toBe(false);
          expect(cleared).toHaveLength(2);
          expect(cleared.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
          expect(new TextDecoder().decode(marker)).toBe('private observer copy marker');
        })
      )
    );
  } finally {
    spy.mockRestore();
  }
});

it('measures real backend bytes, refused signed control/content and the actual boundary of an excluded insider retained key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-attack-observer-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'));
          const org = Buffer.from(f.genesis.toBytes()).toString('hex');
          const key0 = ok(Bytes.epochKey(new Uint8Array(32).fill(117))),
            key1 = ok(Bytes.epochKey(new Uint8Array(32).fill(91)));
          const scope = (epoch: number): ContentScope => ({
            genesis: org,
            resource: 'document-A',
            epoch,
            purpose: 'doc-update',
          });
          const privateTrace = yield* makeLabContentTrace({ maxFacts: 10, maxTextBytes: 4096 });
          const oldText = new TextEncoder().encode('synthetic old secret marker'),
            newText = new TextEncoder().encode('synthetic rotated secret marker');
          const seal = (signer: typeof f.owner, epoch: number, plaintext: Uint8Array) =>
            Effect.gen(function* () {
              const key = yield* scopedDocumentKey(scope(epoch), epoch === 0 ? key0 : key1);
              yield* privateTrace.recordContentWrite({
                genesisHex: org,
                stream: 'loro',
                deviceHex: Buffer.from(signer.publicKey.toBytes()).toString('hex'),
                epoch,
                text: new TextDecoder().decode(plaintext),
                writerMayWrite: true,
              });
              return yield* sealDocument({
                scope: scope(epoch),
                documentKey: key,
                signer,
                ledger: f.ledger,
                plaintext,
              });
            });
          const old = yield* seal(f.owner, 0, oldText),
            formerWriter = yield* seal(f.peer, 0, oldText);
          const controlSdk = new StreamsClient({
            url: `${f.server.baseUrl}/ds/${org}/control`,
            retry: { maxAttempts: 1 },
          });
          const publish = (record: Uint8Array) =>
            Effect.gen(function* () {
              const ack = yield* Effect.promise(() =>
                controlSdk.append({
                  part: {
                    contentType: 'application/octet-stream',
                    body: ok(frameLedgerRecord(record)),
                  },
                })
              );
              expect(ack.ok).toBe(true);
              f.records.push(new Uint8Array(record));
              f.view();
            });
          const revoked = yield* signLedgerRecord(
            ok(
              prepareLedgerCommand(f.view(), f.owner.publicKey, {
                _tag: 'RevokeDevice',
                target: f.peer.publicKey,
              })
            ),
            f.owner
          );
          yield* publish(revoked);
          const packet = ok(
            sealHistoryPacket({ genesis: f.genesis, epoch: 1, currentKey: key1, previousKey: key0 })
          );
          const body = ok(
            encodeCbor([
              f.point().head.toBytes(),
              f.owner.publicKey.toBytes(),
              [7, 1, ok(commitEpochKey(f.genesis, 1, key1)).toBytes(), packet],
            ])
          );
          yield* publish(yield* signLedgerRecord(ok(prepareLedgerRecord(f.view(), body)), f.owner));
          const fresh = yield* seal(f.owner, 1, newText);
          const client = yield* openLabExistingWorkspace(f.input('owner', 'create'));
          const contentSdk = new StreamsClient({
            url: `${f.server.baseUrl}/ds/${org}/attack-observer-bytes`,
            retry: { maxAttempts: 1 },
          });
          expect(
            (yield* Effect.promise(() =>
              contentSdk.create({ contentType: 'application/octet-stream' })
            )).ok
          ).toBe(true);
          for (const bytes of [old, fresh])
            expect(
              (yield* Effect.promise(() =>
                contentSdk.append({
                  part: { contentType: 'application/octet-stream', body: bytes },
                })
              )).ok
            ).toBe(true);
          // Attacker boundary gets protocol streams only: no fixture directory,
          // honest signer, plaintext trace, current key or protected-store handle.
          const backend = Object.freeze({
            read: () =>
              Effect.tryPromise({
                try: async () => {
                  const result = await contentSdk.read({ offset: '-1' });
                  if (!result.ok) throw new Error('actual-sdk-read');
                  return [new Uint8Array(result.result.payload.body)];
                },
                catch: (cause) => cause,
              }),
            appendControl: (record: Uint8Array) =>
              Effect.tryPromise({
                try: async () => {
                  const result = await controlSdk.append({
                    part: {
                      contentType: 'application/octet-stream',
                      body: ok(frameLedgerRecord(record)),
                    },
                  });
                  if (!result.ok) throw new Error('actual-sdk-append');
                  return { status: 200 };
                },
                catch: (cause) => cause,
              }),
          });
          const observer = yield* makeLabAttackObserver({
            genesis: f.genesis,
            ledger: f.ledger,
            backend,
            trace: privateTrace,
          });
          const malformed = new Uint8Array(revoked);
          malformed[malformed.length - 1] ^= 1;
          const measured = yield* observer.observe({
            control: {
              record: malformed,
              refresh: () => client.control.refresh().pipe(Effect.map((row) => row.view)),
              retained: () => client.control.current().pipe(Effect.map((row) => row.view)),
            },
            content: [
              {
                kind: 'wrong-context',
                originalScope: scope(1),
                scope: { ...scope(1), resource: 'different-resource' },
                principal: f.owner.publicKey,
                frame: fresh,
              },
              {
                kind: 'unauthorized-writer',
                scope: scope(0),
                principal: f.peer.publicKey,
                frame: formerWriter,
              },
            ],
            insider: {
              key: key0,
              keyEpoch: 0,
              freshnessBypassed: false,
              samples: [
                { scope: scope(0), frame: old, expectedPlaintext: oldText },
                { scope: scope(1), frame: fresh, expectedPlaintext: newText },
              ],
            },
          });
          expect(measured.properties).toEqual([
            { id: 'durability.committed-rotation-complete-group', verdict: 'unavailable' },
            { id: 'confidentiality.backend-plaintext', verdict: 'pass' },
            { id: 'integrity.forged-control', verdict: 'pass' },
            { id: 'integrity.wrong-context', verdict: 'pass' },
            { id: 'integrity.unauthorized-writer', verdict: 'pass' },
            { id: 'confidentiality.insider-post-exclusion', verdict: 'pass' },
          ]);
          expect(measured.report).toEqual({
            confidentiality: 'pass',
            integrity: 'pass',
            durability: 'unavailable',
          });
          expect(measured.observations).toMatchObject({
            plaintextSamples: 3,
            oldKeyOpened: 1,
            laterSamples: 1,
            laterOpened: 0,
          });
          expect(measured.fingerprint.related.ledgerRecords).toBe(4);
          expect((yield* client.control.current()).view.head.equals(f.point().head)).toBe(true);
          const wrongReasonProbes = [
            // The claimed original was already unauthorized: this does not
            // measure whether changing its resource caused the rejection.
            {
              kind: 'wrong-context',
              originalScope: scope(0),
              scope: { ...scope(0), resource: 'different-resource' },
              principal: f.peer.publicKey,
              frame: formerWriter,
            },
            // Original principal mismatch is a harness error, not context evidence.
            {
              kind: 'wrong-context',
              originalScope: scope(1),
              scope: { ...scope(1), resource: 'different-resource' },
              principal: f.peer.publicKey,
              frame: fresh,
            },
            // A nonexistent epoch fails permission lookup before a context signature test.
            {
              kind: 'wrong-context',
              originalScope: scope(1),
              scope: scope(99),
              principal: f.owner.publicKey,
              frame: fresh,
            },
            {
              kind: 'unauthorized-writer',
              scope: scope(0),
              principal: f.owner.publicKey,
              frame: formerWriter,
            },
          ] as const;
          for (const probe of wrongReasonProbes) {
            const wrongReason = yield* observer.observe({ content: [probe] });
            expect(
              wrongReason.properties.find((row) => row.id === `integrity.${probe.kind}`)?.verdict
            ).toBe('harness-error');
            expect(wrongReason.report.integrity).toBe('harness-error');
          }
          // Positive leak control against actual native backend bytes.
          expect(
            (yield* Effect.promise(() =>
              contentSdk.append({
                part: { contentType: 'application/octet-stream', body: oldText },
              })
            )).ok
          ).toBe(true);
          const leaked = yield* observer.observe();
          expect(
            leaked.properties.find((row) => row.id === 'confidentiality.backend-plaintext')?.verdict
          ).toBe('violation');
          expect(leaked.report.confidentiality).toBe('violation');
          expect(leaked.report.integrity).toBe('unavailable');
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('does not treat missing observations or a failed transport as negative evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-attack-observer-unmeasured-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'));
          const observer = yield* makeLabAttackObserver({
            genesis: f.genesis,
            ledger: f.ledger,
            backend: { read: () => Effect.fail(new Error('synthetic transport down')) },
          });
          const result = yield* observer.observe();
          expect(result.report).toEqual({
            confidentiality: 'harness-error',
            integrity: 'unavailable',
            durability: 'unavailable',
          });
          expect(
            result.properties
              .filter((row) => row.id !== 'confidentiality.backend-plaintext')
              .every((row) => row.verdict === 'unavailable')
          ).toBe(true);
          const unavailable = yield* makeLabAttackObserver({
            genesis: f.genesis,
            ledger: f.ledger,
            backend: {
              read: () => Effect.succeed([]),
              appendControl: () => Effect.fail(new Error('request never reached backend')),
            },
          });
          const transportFailure = yield* unavailable.observe({
            control: {
              record: f.records[1]!,
              refresh: f.ledger,
              retained: f.ledger,
            },
          });
          expect(
            transportFailure.properties.find((row) => row.id === 'integrity.forged-control')
          ).toEqual({
            id: 'integrity.forged-control',
            verdict: 'harness-error',
          });
          expect(transportFailure.report.integrity).toBe('harness-error');
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('retains an actual later-epoch leak even when an expected plaintext is wrong or another positive control is unmeasured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-insider-leak-control-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture')),
            org = Buffer.from(f.genesis.toBytes()).toString('hex');
          const retained = ok(Bytes.epochKey(new Uint8Array(32).fill(117))),
            plaintext = new TextEncoder().encode('synthetic actual retained-key leak');
          const scope = (epoch: number): ContentScope => ({
            genesis: org,
            resource: 'document-A',
            epoch,
            purpose: 'doc-update',
          });
          const seal = (epoch: number) =>
            Effect.gen(function* () {
              const leaf = yield* scopedDocumentKey(scope(epoch), retained);
              return yield* sealDocument({
                scope: scope(epoch),
                documentKey: leaf,
                signer: f.owner,
                ledger: f.ledger,
                plaintext,
              });
            });
          const old = yield* seal(0);
          // Explicit malicious-publisher test control: reuse retained material for
          // epoch1. The actual publisher implementation generates fresh secure bytes.
          const packet = ok(
            sealHistoryPacket({
              genesis: f.genesis,
              epoch: 1,
              currentKey: retained,
              previousKey: retained,
            })
          );
          const body = ok(
            encodeCbor([
              f.point().head.toBytes(),
              f.owner.publicKey.toBytes(),
              [7, 1, ok(commitEpochKey(f.genesis, 1, retained)).toBytes(), packet],
            ])
          );
          const record = yield* signLedgerRecord(ok(prepareLedgerRecord(f.view(), body)), f.owner);
          const sdk = new StreamsClient({
            url: `${f.server.baseUrl}/ds/${org}/control`,
            retry: { maxAttempts: 1 },
          });
          expect(
            (yield* Effect.promise(() =>
              sdk.append({
                part: {
                  contentType: 'application/octet-stream',
                  body: ok(frameLedgerRecord(record)),
                },
              })
            )).ok
          ).toBe(true);
          f.records.push(new Uint8Array(record));
          f.view();
          const newer = yield* seal(1);
          const observer = yield* makeLabAttackObserver({
            genesis: f.genesis,
            ledger: f.ledger,
            backend: { read: () => Effect.succeed([old, newer]) },
          });
          const result = yield* observer.observe({
            insider: {
              key: retained,
              keyEpoch: 0,
              freshnessBypassed: false,
              samples: [
                { scope: scope(0), frame: old, expectedPlaintext: plaintext },
                { scope: scope(0), frame: old },
                { scope: scope(1), frame: newer, expectedPlaintext: new Uint8Array([0]) },
              ],
            },
          });
          expect(result.observations).toMatchObject({
            oldKeyOpened: 1,
            laterSamples: 1,
            laterOpened: 1,
          });
          expect(
            result.properties.find((row) => row.id === 'confidentiality.insider-post-exclusion')
              ?.verdict
          ).toBe('violation');
          expect(result.report.confidentiality).toBe('violation');
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
