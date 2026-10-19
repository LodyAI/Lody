import Database from 'better-sqlite3';
import { KeyDistributor } from '@lody/e2ee-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Effect, Layer, Result } from 'effect';
import { expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import { E2eeWorkspace, WorkspacePlatform } from '@lody/e2ee-core';
import { type WorkspaceRecoveryInput } from '@lody/e2ee-core';
import { createRecoveryVault, openRecoveryVault } from '@lody/e2ee-core/internal';
import { decodeRecord } from '@lody/e2ee-core/protocol';
import { makeSqliteProtectedEpochKeys } from '@lody/e2ee-core/internal';
import { makeLabRecoveryVaultStore } from '../src/platform/recovery-vault-sqlite';
import { makeLabScenarioFixture } from '../src/platform/scenario-fixture';
import { openLabWorkspaceSession, makeLabWorkspacePlatform } from '../src/platform/full-session';
import { openLabExistingWorkspace } from '../src/platform/workspace-session';
import { makeLabHttpIdentity } from '../src/platform/http-identity';
import { makeLabMailboxRemote } from '../src/platform/key-mailbox';
import { generateDevice } from '../src/platform/device';
import { labSyntheticProtector } from '../src/platform/synthetic-protection';
const ok = Result.getOrThrow;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
it('uses the public facade to set up/test a real R via HTTP, then restores into independent C after closing the old owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-workspace-vault-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'));
          const body = ok(decodeRecord(f.records[0]!)).body;
          if (body.type !== 'genesis') throw new Error('actual-genesis');
          const membershipId = body.membershipId;
          const storage = yield* makeLabRecoveryVaultStore({
            path: join(root, 'vault.sqlite'),
            mode: 'create',
          });
          const created = yield* createRecoveryVault({
            locator: 'https://synthetic.invalid/vault',
            ...storage,
          });
          const trust = {
            source: 'independently witnessed actual original genesis',
            genesisRecord: new Uint8Array(f.records[0]!),
            head: hex(f.point().head.toBytes()),
            length: f.point().length,
          };
          let delivery: KeyDistributor['Service'] | undefined;
          const fetchCurrentEnvelope: WorkspaceRecoveryInput['fetchCurrentEnvelope'] = (
            recipient,
            epoch,
            identity
          ) =>
            Effect.scoped(
              Effect.gen(function* () {
                const native = yield* makeLabHttpIdentity({
                  baseUrl: f.host.baseUrl,
                  genesis: f.genesis,
                });
                const auth = yield* native.authenticate(identity);
                const mailbox = yield* makeLabMailboxRemote({ url: auth.url, fetch: auth.fetch });
                let page = yield* mailbox.fetch(epoch, null, 100);
                if (page.items.length === 0) {
                  if (!delivery) throw new Error('no-original-publisher');
                  yield* delivery.reconcileCurrentEpoch(100);
                  yield* delivery.resumePendingDeliveries(100);
                  page = yield* mailbox.fetch(epoch, null, 100);
                }
                const row = page.items[0];
                if (!row) throw new Error('actual-R-envelope-required');
                expect(recipient.equals(identity.publicKey)).toBe(true);
                return {
                  sender: ok(
                    Bytes.signingPublicKey(new Uint8Array(Buffer.from(row.sender, 'hex')))
                  ),
                  frame: row.frame,
                };
              })
            );
          const template = f.input('owner', 'create');
          const owner = yield* openLabWorkspaceSession({
            ...template,
            documents: template.documents.filter((row) => row.model !== 'flock'),
            recoveryConfiguration: ({ distribution }) => {
              delivery = distribution;
              return Effect.succeed({
                vault: created.vault,
                local: storage.local,
                membershipId,
                trust,
                fetchCurrentEnvelope,
              });
            },
          });
          yield* owner.createDocument('loro');
          yield* owner.append('loro', 'history recovered through R');
          expect(yield* owner.recovery.status()).toMatchObject({
            paired: false,
            envelopeAvailable: false,
            recoverable: false,
          });
          expect(
            yield* Effect.result(owner.recovery.skip({ confirmedRecoveryLoss: false }))
          ).toMatchObject({ _tag: 'Failure', failure: { code: 'invalid-input' } });
          expect(yield* owner.recovery.status()).toMatchObject({ skipped: false });
          expect(yield* owner.recovery.skip({ confirmedRecoveryLoss: true })).toMatchObject({
            skipped: true,
            paired: false,
            recoverable: false,
          });
          expect(
            yield* Effect.result(owner.recovery.replace({ requestId: '', compromised: false }))
          ).toMatchObject({ _tag: 'Failure', failure: { code: 'invalid-input' } });
          expect(yield* owner.recovery.setup()).toMatchObject({
            outcome: 'Committed',
            status: { paired: true, envelopeAvailable: true, recoverable: true, skipped: false },
          });
          expect(yield* owner.recovery.test()).toMatchObject({
            paired: true,
            envelopeAvailable: true,
            recoverable: true,
            testedEpoch: 0,
          });
          const afterSetup = f.view(),
            recoveryRows = [...afterSetup.inspectState().devices].filter(
              ([, device]) => device.kind === 'recovery'
            );
          expect(recoveryRows).toHaveLength(1);
          const recoveryPublic = ok(
            Bytes.signingPublicKey(new Uint8Array(Buffer.from(recoveryRows[0]![0], 'hex')))
          );
          yield* owner.close();
          delivery = undefined;
          const fresh = yield* generateDevice(),
            base = f.input('peer', 'create'),
            file = (name: string) => join(root, `fresh-${name}.sqlite`);
          const cInput = {
            ...base,
            signer: fresh,
            path: file('feed'),
            journalPath: file('journal'),
            keys: {
              ...base.keys,
              path: file('receive'),
              pair: fresh.encryption,
              keyStore: { ...base.keys.keyStore, path: file('keys'), mode: 'create' as const },
              repairStore: { path: file('repair'), mode: 'create' as const },
              sendStore: { path: file('send'), mode: 'create' as const },
              outboxStore: { path: file('outbox'), mode: 'create' as const },
            },
            documents: base.documents
              .filter((row) => row.model !== 'flock')
              .map((row) => ({ ...row, path: file('loro') })),
          };
          const adapter = yield* makeLabWorkspacePlatform(cInput),
            context = yield* Layer.build(adapter.layer),
            platform = Context.get(context, WorkspacePlatform);
          let temporaryInstalled:
            | Effect.Success<ReturnType<typeof makeSqliteProtectedEpochKeys>>
            | undefined;
          const restored = yield* E2eeWorkspace.restoreFromRecovery({
            personal: { ...fresh, encryptionPublicKey: fresh.enc },
          }).pipe(
            Effect.provide(
              WorkspacePlatform.layer({
                ...platform,
                prepareRecovery: () =>
                  Effect.gen(function* () {
                    const vault = yield* openRecoveryVault({
                      recoveryFile: created.recoveryFile,
                      ...storage,
                    });
                    const installed = yield* makeSqliteProtectedEpochKeys({
                      path: join(root, 'temporary-R-keys.sqlite'),
                      mode: 'create',
                      genesis: f.genesis,
                      recipient: recoveryPublic,
                      ledger: f.ledger,
                      protector: labSyntheticProtector,
                    });
                    temporaryInstalled = installed;
                    return {
                      workflow: {
                        vault,
                        local: storage.local,
                        genesis: f.genesis,
                        membershipId,
                        personalSigner: fresh,
                        ledger: f.ledger,
                        installed,
                        trust,
                        fetchCurrentEnvelope,
                        submitOriginal: () =>
                          Effect.fail(new Error('setup unavailable on temporary R restore owner')),
                      },
                      submitOriginalAsRecovery: (record, identity) =>
                        Effect.scoped(
                          Effect.gen(function* () {
                            const r = yield* openLabExistingWorkspace({
                              baseUrl: f.host.baseUrl,
                              genesis: f.genesis,
                              signer: identity,
                              path: join(root, 'temporary-R-feed.sqlite'),
                              journalPath: join(root, 'temporary-R-journal.sqlite'),
                              mode: 'create',
                              checkpoint: () => Effect.sync(f.point),
                              budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
                            });
                            const result = yield* r.control.executeOriginal(record);
                            yield* r.control.acknowledge(result);
                            return result;
                          })
                        ),
                      acquirePersonal: () => platform.acquire('create'),
                    };
                  }),
              })
            )
          );
          expect(restored.outcome).toBe('Committed');
          if (!restored.workspace) throw new Error('actual-restored-workspace');
          expect(restored.workspace.signer.publicKey.equals(fresh.publicKey)).toBe(true);
          const closedTemporary = yield* Effect.result(temporaryInstalled!.read(0));
          expect(Result.isFailure(closedTemporary)).toBe(true);
          if (Result.isFailure(closedTemporary))
            expect(closedTemporary.failure).toMatchObject({
              _tag: 'InstalledKeyError',
              reason: 'closed',
            });
          const personal = yield* adapter.adapt(restored.workspace);
          yield* personal.pull('loro');
          expect(yield* personal.text('loro')).toBe('history recovered through R');
          const actual = f.view().inspectState().devices.get(hex(fresh.publicKey.toBytes()));
          expect(actual?.kind).toBe('personal');
          expect(actual?.membershipId.equals(membershipId)).toBe(true);
          const sql = new Database(cInput.keys.keyStore.path, { readonly: true });
          try {
            expect(sql.prepare('SELECT epoch FROM installed_epoch_keys').all()).toEqual([
              { epoch: 0 },
            ]);
          } finally {
            sql.close();
          }
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
