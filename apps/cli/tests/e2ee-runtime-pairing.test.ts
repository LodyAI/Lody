import { reuseRuntimeKeyPairs } from './e2ee-runtime-key-pairs';
import { createDaemonLossRegistry } from '../src/lib/e2ee/client-loss-observer';
import { getLogger } from '../src/utils/logger';
import { type WorkspaceId } from '@lody/shared';
import { LoroDocumentManager } from '../src/lib/loro/doc';
import {
  createCliSqliteRepoStore,
  type CliSqliteRepoStore,
} from '../src/lib/loro/sqlite-repo-store';
import { CloudE2eeMemberRemoved } from '../src/lib/cloud-e2ee-errors';
import { randomUUID } from 'node:crypto';
import { resetCliE2eeIdentity } from '../src/lib/e2ee/reset-identity';
import { leaseE2eeIdentity } from '@lody/shared/node/e2ee-identity';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  Clock,
  Context,
  Effect,
  Layer,
  Result,
  Exit as TokenExit,
  Scope as TokenScope,
} from 'effect';
import { LoroDoc } from 'loro-crdt';
import {
  LoroStreamsTokenPorts,
  makeLoroStreamsTokenProvider,
  makeLoroStreamsTokenWebPorts,
} from '@lody/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  Bytes,
  commitEpochKey,
  encodeCbor,
  extendLedger,
  hashRecordBytes,
  inspectContentFrame,
  prepareDeviceAdmission,
  prepareEpochEnvelope,
  prepareJoinRequest,
  prepareLedgerCommand,
  prepareLedgerRecord,
  sealHistoryPacket,
  signGenesisRecord,
  signLedgerRecord,
  verifyDeviceCredentialBinding,
  verifyLedger,
} from '@lody/e2ee-core/protocol';
import { makeNodeE2eeCustody } from '@lody/e2ee-core/adapters/node-custody';
import { makeCliE2eeCustody } from '../src/lib/e2ee/custody';
import { makeCliE2eeRuntime } from '../src/lib/e2ee/runtime';
import { openMachinePairingJournal } from '../src/lib/e2ee/pairing-journal';
import { Lody } from '../src/lib/lody';
import { makeDesktopLocalPairing } from '../../electron/src/main/services/e2ee-local-pairing.mts';
import {
  activateAndPromoteCliE2eeWorkspaceLegacy,
  activateCliE2eeWorkspaceLegacy,
  openCliE2eePairingRuntimeLegacy,
  openCliE2eeWorkspaceLegacy,
  prepareCliE2eeMachineLegacy,
  retainCliE2eeWorkspaceBinding,
  validateCliE2eePairingIntentLegacy,
} from '../src/lib/e2ee/workspace-legacy';
import type { CloudE2eePort } from '@lody/platform';
import { KeyMailbox } from '@lody/e2ee-core/services';
import { makeSqliteKeyMailbox, referenceKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite';
import type { E2eeMailboxRequests, E2eeWorkspaceHistoryPage } from '@lody/cloud-api';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  admittedBeforeKey,
  automationOrigin,
  execute,
  hex,
  memberAccount,
  noKeyring,
  ownerAccount,
  page,
  queuedConfig,
  queuedSessionId,
  run,
  setup,
  threeDays,
  wrapper,
} from './e2ee-runtime-helpers';
import { createTestCloudPort } from './test-cloud-port';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
reuseRuntimeKeyPairs();

describe('machine E2EE local runtime', () => {
  it('refuses archival while another scoped native owner holds the identity lease', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-reset-busy-'));
    vi.stubEnv('LODY_DATA_DIR', directory);
    try {
      const root = join(
        getLodyDataDir(),
        'e2ee',
        createHash('sha256').update('account').digest('hex'),
        'workspace'
      );
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.writeFile(join(root, 'evidence'), 'original', { mode: 0o600 });
      const { Scope, Exit } = await import('effect');
      const owner = Effect.runSync(Scope.make());
      try {
        await Effect.runPromise(leaseE2eeIdentity(root).pipe(Scope.provide(owner)));
        await expect(
          execute(
            resetCliE2eeIdentity({
              accountId: 'account',
              workspaceId: 'workspace',
              resetId: randomUUID(),
              now: 0,
            })
          )
        ).rejects.toThrow();
        expect(await readFile(join(root, 'evidence'), 'utf8')).toBe('original');
      } finally {
        await Effect.runPromise(Scope.close(owner, Exit.void));
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects same-session device loss before creating any replacement original', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-partial-loss-'));
    vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
    try {
      const fixture = await execute(setup(directory));
      const accountId = 'partial-loss-account';
      const root = join(
        getLodyDataDir(),
        'e2ee',
        createHash('sha256').update(accountId).digest('hex'),
        'workspace'
      );
      const input = {
        accountId,
        machineId: 'machine',
        workspaceId: 'workspace',
        genesisHash: hex(fixture.genesis.toBytes()),
        genesisRecordHex: hex(fixture.genesisRecord),
        membershipId: '0a'.repeat(16),
        frontendSigningPublicKey: fixture.sender,
        keyring: noKeyring,
      };
      const material = await prepareCliE2eeMachineLegacy({
        ...input,
        pairingSessionId: '01'.repeat(16),
      });
      const credentialPath = join(
        root,
        'custody',
        `device-credential-${input.genesisHash}-${material.signingPublicKey}.sealed`
      );
      const credential = await readFile(credentialPath);
      const devicePath = join(root, 'custody', `${input.genesisHash}.machine.device`);
      await rm(devicePath);
      await expect(
        prepareCliE2eeMachineLegacy({ ...input, pairingSessionId: '01'.repeat(16) })
      ).rejects.toThrow();
      await expect(readFile(devicePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(credentialPath)).toEqual(credential);
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['feed', 'origin'] as const)(
    'keeps accepted ledger progress when auxiliary %s compaction storage fails',
    async (fault) => {
      const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-compaction-'));
      const warnings: unknown[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
        warnings.push(args);
      });
      try {
        const fixture = await execute(setup(directory, 71));
        const openRuntime = Effect.gen(function* () {
          const custody = yield* makeCliE2eeCustody({
            directory: join(directory, 'machine'),
            keyring: noKeyring,
          });
          const device = yield* custody.openDevice(fixture.genesis);
          return yield* makeCliE2eeRuntime({
            directory: join(directory, 'runtime'),
            workspaceId: 'workspace',
            custody,
            device,
            genesisRecord: fixture.genesisRecord,
          });
        });
        await execute(
          Effect.gen(function* () {
            const runtime = yield* openRuntime;
            const history = new DatabaseSync(join(directory, 'runtime', 'history.sqlite'));
            const cache = history.prepare('SELECT name FROM cache WHERE id=1').get();
            if (!cache || typeof cache.name !== 'string') throw new Error('missing feed cache');
            const feed = new DatabaseSync(join(directory, 'runtime', cache.name));
            const db = fault === 'feed' ? feed : history;
            db.exec(
              `CREATE TRIGGER fail_compaction BEFORE UPDATE OF origin ON ${fault === 'feed' ? 'feed_meta' : 'cache'} BEGIN SELECT RAISE(ABORT,'synthetic auxiliary failure'); END`
            );
            try {
              yield* runtime.ingest(page(fixture.records, 0, 64));
              yield* runtime.ingest(page(fixture.records, 64, 70));
              expect((yield* runtime.status()).length).toBe(70);
              expect(history.prepare('SELECT COUNT(*) AS n FROM records').get()?.n).toBe(70);
              yield* runtime.ingest(page(fixture.records, 70));
              expect((yield* runtime.status()).length).toBe(71);
              expect(warnings).toEqual([
                ['[E2EE] Ledger compaction pending', { code: 'e2ee_ledger_compaction_pending' }],
              ]);
            } finally {
              db.exec('DROP TRIGGER fail_compaction');
              feed.close();
              history.close();
            }
          })
        );
        await execute(
          Effect.gen(function* () {
            const runtime = yield* openRuntime;
            expect((yield* runtime.status()).length).toBe(71);
          })
        );
      } finally {
        warn.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(['history', 'pin'] as const)(
    'classifies authoritative %s damage without replacing originals or trusted pins',
    async (damage) => {
      const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-history-recovery-'));
      try {
        const fixture = await execute(setup(directory));
        const openRuntime = Effect.gen(function* () {
          const custody = yield* makeCliE2eeCustody({
            directory: join(directory, 'machine'),
            keyring: noKeyring,
          });
          const device = yield* custody.openDevice(fixture.genesis);
          return yield* makeCliE2eeRuntime({
            directory: join(directory, 'runtime'),
            workspaceId: 'workspace',
            custody,
            device,
            genesisRecord: fixture.genesisRecord,
          });
        });
        await execute(
          Effect.flatMap(openRuntime, (runtime) => runtime.ingest(page(fixture.records)))
        );
        const pinPath = join(directory, 'runtime', 'ledger-pin.sqlite');
        const pin = new DatabaseSync(pinPath);
        const trusted = pin.prepare('SELECT * FROM ledger_pin').all();
        if (damage === 'pin') pin.exec('UPDATE ledger_pin SET count=0');
        pin.close();
        const damaged = fixture.record.slice();
        damaged[damaged.length - 1] ^= 1;
        const history = new DatabaseSync(join(directory, 'runtime', 'history.sqlite'));
        if (damage === 'history')
          history.prepare('UPDATE records SET record=? WHERE position=1').run(damaged);
        const result = await execute(Effect.result(openRuntime));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isSuccess(result)) throw new Error('expected local recovery failure');
        expect(result.failure).toMatchObject({
          code:
            damage === 'history' ? 'local-history-recovery-required' : 'trusted-pin-unavailable',
        });
        const after = new DatabaseSync(pinPath);
        if (damage === 'history') {
          expect(after.prepare('SELECT * FROM ledger_pin').all()).toEqual(trusted);
          expect(
            new Uint8Array(
              history.prepare('SELECT record FROM records WHERE position=1').get()!
                .record as Uint8Array
            )
          ).toEqual(damaged);
        } else expect(after.prepare('SELECT count FROM ledger_pin').get()!.count).toBe(0);
        after.close();
        history.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(['history', 'pin'] as const)(
    'preserves a corrupt %s SQLite image and distinguishes it from temporary I/O',
    async (damage) => {
      const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-corrupt-image-'));
      try {
        const fixture = await execute(setup(directory));
        const openRuntime = Effect.gen(function* () {
          const custody = yield* makeCliE2eeCustody({
            directory: join(directory, 'machine'),
            keyring: noKeyring,
          });
          const device = yield* custody.openDevice(fixture.genesis);
          return yield* makeCliE2eeRuntime({
            directory: join(directory, 'runtime'),
            workspaceId: 'workspace',
            custody,
            device,
            genesisRecord: fixture.genesisRecord,
          });
        });
        await execute(openRuntime);
        const path = join(
          directory,
          'runtime',
          damage === 'history' ? 'history.sqlite' : 'ledger-pin.sqlite'
        );
        const original = Buffer.from('synthetic damaged SQLite image');
        await fs.writeFile(path, original);
        const failed = await execute(Effect.result(openRuntime));
        expect(Result.isFailure(failed)).toBe(true);
        if (Result.isSuccess(failed)) throw new Error('expected local damage');
        expect(failed.failure).toMatchObject({
          code:
            damage === 'history' ? 'local-history-recovery-required' : 'trusted-pin-unavailable',
        });
        expect(await readFile(path)).toEqual(original);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('reopens entirely offline with the same accepted position and credential', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-runtime-'));
    try {
      const fixture = await execute(setup(directory));
      const fetch = vi.fn(() => Promise.reject(new Error('network must not be used')));
      vi.stubGlobal('fetch', fetch);
      const first = await execute(
        Effect.gen(function* () {
          const custody = yield* makeCliE2eeCustody({
            directory: join(directory, 'machine'),
            keyring: noKeyring,
          });
          const device = yield* custody.openDevice(fixture.genesis);
          const runtime = yield* makeCliE2eeRuntime({
            directory: join(directory, 'runtime'),
            workspaceId: 'workspace',
            custody,
            device,
            genesisRecord: fixture.genesisRecord,
          });
          const status = yield* runtime.ingest(page([fixture.genesisRecord, fixture.record]));
          expect(status.length).toBe(2);
          expect(status.hasCurrentKey).toBe(false);
          expect(yield* runtime.credential()).toBe(fixture.credential);
          return status;
        })
      );
      const reopened = await execute(
        Effect.gen(function* () {
          const custody = yield* makeCliE2eeCustody({
            directory: join(directory, 'machine'),
            keyring: noKeyring,
          });
          const device = yield* custody.openDevice(fixture.genesis);
          const runtime = yield* makeCliE2eeRuntime({
            directory: join(directory, 'runtime'),
            workspaceId: 'workspace',
            custody,
            device,
            genesisRecord: fixture.genesisRecord,
          });
          return yield* runtime.status();
        })
      );
      expect(reopened).toEqual(first);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reopens a retained feed after its 64-record threshold and recovers a damaged disposable cache locally', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-retained-'));
    try {
      const fixture = await execute(setup(directory, 67));
      await execute(
        Effect.gen(function* () {
          const custody = yield* makeCliE2eeCustody({
            directory: join(directory, 'machine'),
            keyring: noKeyring,
          });
          const device = yield* custody.openDevice(fixture.genesis);
          const runtime = yield* makeCliE2eeRuntime({
            directory: join(directory, 'runtime'),
            workspaceId: 'workspace',
            custody,
            device,
            genesisRecord: fixture.genesisRecord,
          });
          yield* runtime.ingest(page(fixture.records, 0, 64));
          expect((yield* runtime.ingest(page(fixture.records, 64))).length).toBe(67);
        })
      );
      const inspect = () =>
        execute(
          Effect.gen(function* () {
            const custody = yield* makeCliE2eeCustody({
              directory: join(directory, 'machine'),
              keyring: noKeyring,
            });
            const device = yield* custody.openDevice(fixture.genesis);
            const runtime = yield* makeCliE2eeRuntime({
              directory: join(directory, 'runtime'),
              workspaceId: 'workspace',
              custody,
              device,
              genesisRecord: fixture.genesisRecord,
            });
            return yield* runtime.status();
          })
        );
      const before = await inspect();
      expect(before.length).toBe(67);
      const cache = new DatabaseSync(join(directory, 'runtime', 'history.sqlite'));
      try {
        const origin = JSON.parse(
          String(cache.prepare('SELECT origin FROM cache WHERE id=1').get()?.origin)
        );
        expect(origin.length).toBe(67);
        cache.prepare('UPDATE cache SET origin=? WHERE id=1').run('{corrupt');
      } finally {
        cache.close();
      }
      expect(await inspect()).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps startup and reopen local while a single background history request is pending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-host-'));
    vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
    let host: Awaited<ReturnType<typeof openCliE2eePairingRuntimeLegacy>> | undefined;
    let resolveHistory: ((page: E2eeWorkspaceHistoryPage) => void) | undefined;
    try {
      const fixture = await execute(setup(directory));
      const material = await prepareCliE2eeMachineLegacy({
        accountId: 'account',
        machineId: 'machine',
        frontendSigningPublicKey: fixture.sender,
        workspaceId: 'workspace',
        genesisHash: hex(fixture.genesis.toBytes()),
        genesisRecordHex: hex(fixture.genesisRecord),
        membershipId: '0a'.repeat(16),
        pairingSessionId: '0b'.repeat(16),
        keyring: noKeyring,
      });
      expect(material.protection).toBe('file');
      const credentialPath = join(
        getLodyDataDir(),
        'e2ee',
        createHash('sha256').update('account').digest('hex'),
        'workspace',
        'custody',
        `device-credential-${hex(fixture.genesis.toBytes())}-${material.signingPublicKey}.sealed`
      );
      const originalCredential = await readFile(credentialPath);
      await fs.unlink(credentialPath);
      await expect(
        prepareCliE2eeMachineLegacy({
          accountId: 'account',
          machineId: 'machine',
          frontendSigningPublicKey: fixture.sender,
          workspaceId: 'workspace',
          genesisHash: hex(fixture.genesis.toBytes()),
          genesisRecordHex: hex(fixture.genesisRecord),
          membershipId: '0a'.repeat(16),
          pairingSessionId: '0b'.repeat(16),
          keyring: noKeyring,
        })
      ).rejects.toThrow();
      await expect(fs.stat(credentialPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await fs.writeFile(credentialPath, originalCredential, { mode: 0o600 });

      for (const changed of [
        { frontendSigningPublicKey: '01'.repeat(32) },
        { membershipId: '01'.repeat(16) },
        { machineId: 'another-machine' },
      ]) {
        await expect(
          prepareCliE2eeMachineLegacy({
            accountId: 'account',
            machineId: 'machine',
            frontendSigningPublicKey: fixture.sender,
            workspaceId: 'workspace',
            genesisHash: hex(fixture.genesis.toBytes()),
            genesisRecordHex: hex(fixture.genesisRecord),
            membershipId: '0a'.repeat(16),
            pairingSessionId: '0b'.repeat(16),
            keyring: noKeyring,
            ...changed,
          })
        ).rejects.toThrow();
      }

      const proofContext = {
        genesis: fixture.genesis,
        pairingSessionId: Buffer.from(material.pairingSessionId, 'hex'),
        signingPublicKey: Result.getOrThrow(
          Bytes.signingPublicKey(Buffer.from(material.signingPublicKey, 'hex'))
        ),
        credentialHash: Buffer.from(material.credentialHash, 'hex'),
      };
      expect(
        Result.isSuccess(
          verifyDeviceCredentialBinding(proofContext, Buffer.from(material.bindingSignature, 'hex'))
        )
      ).toBe(true);
      expect(
        Result.isFailure(
          verifyDeviceCredentialBinding(
            { ...proofContext, pairingSessionId: new Uint8Array(16) },
            Buffer.from(material.bindingSignature, 'hex')
          )
        )
      ).toBe(true);
      expect(material).toEqual(
        await prepareCliE2eeMachineLegacy({
          accountId: 'account',
          machineId: 'machine',
          frontendSigningPublicKey: fixture.sender,
          workspaceId: 'workspace',
          genesisHash: hex(fixture.genesis.toBytes()),
          genesisRecordHex: hex(fixture.genesisRecord),
          membershipId: '0a'.repeat(16),
          pairingSessionId: '0b'.repeat(16),
          keyring: noKeyring,
        })
      );
      const admission = await execute(
        Effect.gen(function* () {
          const custody = yield* makeNodeE2eeCustody({
            directory: join(directory, 'owner'),
            wrapper,
          });
          const owner = yield* custody.openDevice(fixture.genesis);
          const view = Result.getOrThrow(
            verifyLedger({
              anchor: fixture.genesis,
              records: [fixture.genesisRecord],
              checkpoint: { length: 1, head: hashRecordBytes(fixture.genesisRecord) },
            })
          );
          return yield* signLedgerRecord(
            Result.getOrThrow(
              prepareLedgerCommand(view, owner.publicKey, {
                _tag: 'AdmitDevice',
                kind: 'machine',
                machineId: 'machine',
                signingPublicKey: Result.getOrThrow(
                  Bytes.signingPublicKey(Buffer.from(material.signingPublicKey, 'hex'))
                ),
                encryptionPublicKey: Result.getOrThrow(
                  Bytes.encryptionPublicKey(Buffer.from(material.encryptionPublicKey, 'hex'))
                ),
                possessionSignature: Result.getOrThrow(
                  Bytes.signature(Buffer.from(material.possessionSignature, 'hex'))
                ),
              })
            ),
            owner
          );
        })
      );
      let history = Promise.withResolvers<E2eeWorkspaceHistoryPage>();
      resolveHistory = history.resolve;
      const cloud = {
        getHistory: () => history.promise,
        getContentToken: async () => {
          throw new Error('local open must not request content token');
        },
        mailboxCall: async (method: string) =>
          method === 'fetch' ? { items: [], next: null } : null,
      } as CloudE2eePort;
      const options = {
        accountId: 'account',
        machineId: 'machine',
        frontendSigningPublicKey: fixture.sender,
        workspaceId: 'workspace',
        genesisHash: hex(fixture.genesis.toBytes()),
        cloud,
        keyring: noKeyring,
        onUnavailable: () => {
          throw new Error('unexpected background failure');
        },
      };
      host = await openCliE2eePairingRuntimeLegacy(options);
      expect((await host.status()).length).toBe(1);
      expect('content' in host).toBe(false);
      await expect(openCliE2eeWorkspaceLegacy(options)).rejects.toThrow('e2ee_pairing_required');
      const records = [fixture.genesisRecord, admission];
      history.resolve({
        ...page(records),
        workspaceId: 'workspace',
        genesisHash: options.genesisHash,
      });
      await host.refresh();
      expect((await host.status()).length).toBe(2);
      await host.close();
      history = Promise.withResolvers<E2eeWorkspaceHistoryPage>();
      resolveHistory = history.resolve;
      host = await openCliE2eePairingRuntimeLegacy(options);
      expect((await host.status()).length).toBe(2);
      history.resolve({
        ...page(records, 2),
        workspaceId: 'workspace',
        genesisHash: options.genesisHash,
      });
      await host.refresh();
      await host.close();
      host = undefined;
    } finally {
      // Always resolve a scripted native owner before awaiting its close.
      if (host) {
        resolveHistory?.({
          workspaceId: 'workspace',
          genesisHash: '',
          startIndex: 0,
          recordsHex: [],
          nextCursor: null,
          position: 'invalid',
          checkpoint: { length: 0, headHash: '' },
        });
        await host.close().catch(() => undefined);
      }
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('continues an interrupted first activation from another explicitly approving same-member frontend', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-second-frontend-'));
    vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
    let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
    try {
      const accountId = 'synthetic-second-frontend-account';
      const machineDirectory = join(
        getLodyDataDir(),
        'e2ee',
        createHash('sha256').update(accountId).digest('hex'),
        'workspace'
      );
      await fs.mkdir(machineDirectory, { recursive: true, mode: 0o700 });
      const fixture = await execute(
        Effect.gen(function* () {
          const custody = yield* makeNodeE2eeCustody({
            directory: join(directory, 'owner'),
            wrapper,
          });
          const a0 = yield* custody.prepareDevice();
          const membershipId = Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10)));
          const key = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(20)));
          const signed = yield* signGenesisRecord({
            signer: a0,
            encryptionPublicKey: a0.enc,
            initialKey: key,
            userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(30))),
            membershipId,
          });
          const a = yield* custody.retainDevice(signed.genesis, a0);
          const bCustody = yield* makeNodeE2eeCustody({
            directory: join(directory, 'second-frontend'),
            wrapper,
          });
          const b = yield* bCustody.createDevice(signed.genesis, 'personal');
          const context = {
            accountId,
            machineId: 'machine',
            workspaceId: 'workspace',
            genesisHash: hex(signed.genesis.toBytes()),
            genesisRecordHex: hex(signed.record),
            membershipId: hex(membershipId.toBytes()),
            frontendSigningPublicKey: hex(a.publicKey.toBytes()),
            pairingSessionId: '11'.repeat(16),
          };
          const acquire = makeCliE2eeCustody({
            directory: join(machineDirectory, 'custody'),
            keyring: noKeyring,
          });
          const prepare = (input: typeof context) =>
            Effect.scoped(
              Effect.gen(function* () {
                const journal = yield* openMachinePairingJournal(machineDirectory);
                return yield* journal.prepare(input, acquire);
              })
            );
          const original = yield* prepare(context);
          const records = [signed.record];
          let view = Result.getOrThrow(
            verifyLedger({
              anchor: signed.genesis,
              records,
              checkpoint: { length: 1, head: hashRecordBytes(signed.record) },
            })
          );
          const append = Effect.fnUntraced(function* (
            command: Parameters<typeof prepareLedgerCommand>[2]
          ) {
            const record = yield* signLedgerRecord(
              Result.getOrThrow(prepareLedgerCommand(view, a.publicKey, command)),
              a
            );
            records.push(record);
            view = Result.getOrThrow(
              extendLedger(view, [record], {
                length: records.length,
                head: hashRecordBytes(record),
              })
            );
          });
          yield* append({
            _tag: 'AdmitDevice',
            kind: 'machine',
            machineId: 'machine',
            signingPublicKey: Result.getOrThrow(
              Bytes.signingPublicKey(Buffer.from(original.signingPublicKey, 'hex'))
            ),
            encryptionPublicKey: Result.getOrThrow(
              Bytes.encryptionPublicKey(Buffer.from(original.encryptionPublicKey, 'hex'))
            ),
            possessionSignature: Result.getOrThrow(
              Bytes.signature(Buffer.from(original.possessionSignature, 'hex'))
            ),
          });
          yield* append(
            yield* prepareDeviceAdmission({
              genesis: signed.genesis,
              membershipId,
              signer: b,
              encryptionPublicKey: b.enc,
              kind: 'personal',
            })
          );
          const foreign = yield* custody.prepareDevice();
          const foreignMembership = Result.getOrThrow(
            Bytes.membershipId(new Uint8Array(16).fill(40))
          );
          yield* append({
            _tag: 'AdmitMember',
            membershipId: foreignMembership,
            request: yield* prepareJoinRequest({
              genesis: signed.genesis,
              requestId: Result.getOrThrow(Bytes.requestId(new Uint8Array(16).fill(50))),
              userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(60))),
              encryptionPublicKey: foreign.enc,
              expiresAt: null,
              signer: foreign,
            }),
          });
          const db = new DatabaseSync(':memory:');
          try {
            db.exec('CREATE TABLE records(position INTEGER PRIMARY KEY,record BLOB NOT NULL)');
            records.forEach((record, index) =>
              db.prepare('INSERT INTO records VALUES(?,?)').run(index, record)
            );
            const desktop = makeDesktopLocalPairing({
              db,
              workspaceId: 'workspace',
              genesis: signed.genesis,
              genesisRecord: signed.record,
              signer: b,
              current: () => Effect.succeed(view),
            });
            const bContext = { ...context, ...(yield* desktop.context()) };
            const material = yield* prepare(bContext);
            expect(material.signingPublicKey).toBe(original.signingPublicKey);
            expect(material.credentialHash).toBe(original.credentialHash);
            expect(
              yield* desktop.stage({ ok: true, type: 'prepare', machineId: 'machine', ...material })
            ).toMatchObject({ admitted: true });
            // Explicit B approval continues activation; it never duplicates A's admission.
            expect(yield* desktop.approve(material.pairingSessionId)).toBeNull();
            yield* desktop.confirmed(material.pairingSessionId);
            const confirm = (
              input: typeof context,
              candidateView = view,
              candidateRecords = records
            ) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const journal = yield* openMachinePairingJournal(machineDirectory);
                  yield* journal.confirm(input, candidateView, candidateRecords);
                })
              );
            // A did not complete journal.confirm or receive a key before interruption.
            const journalDb = new DatabaseSync(join(machineDirectory, 'pairings.sqlite'));
            try {
              journalDb.exec(
                "CREATE TRIGGER unavailable_admission BEFORE UPDATE OF admission ON pairings BEGIN SELECT RAISE(ABORT, 'synthetic admission storage failure'); END"
              );
              const unavailable = yield* Effect.result(confirm(bContext));
              expect(Result.isFailure(unavailable)).toBe(true);
              if (Result.isFailure(unavailable)) expect(unavailable.failure.code).toBe('storage');
              expect(
                journalDb
                  .prepare('SELECT admission FROM pairings WHERE session=?')
                  .get(bContext.pairingSessionId)?.admission
              ).toBeNull();
              journalDb.exec('DROP TRIGGER unavailable_admission');
            } finally {
              journalDb.close();
            }
            yield* confirm(bContext);
            yield* confirm(bContext); // native SQLite and custody reopen
            expect(Result.isFailure(yield* Effect.result(confirm(context)))).toBe(true);
            for (const [index, changed] of [
              { frontendSigningPublicKey: '01'.repeat(32) },
              { frontendSigningPublicKey: hex(foreign.publicKey.toBytes()) },
              { machineId: 'different-machine' },
            ].entries()) {
              const invalid = {
                ...bContext,
                ...changed,
                pairingSessionId: String(index + 2).repeat(32),
              };
              yield* prepare(invalid);
              const rejected = yield* Effect.result(confirm(invalid));
              expect(Result.isFailure(rejected)).toBe(true);
              if (Result.isFailure(rejected)) expect(rejected.failure.code).toBe('not-admitted');
            }
            const revokedRecord = yield* signLedgerRecord(
              Result.getOrThrow(
                prepareLedgerCommand(view, a.publicKey, {
                  _tag: 'RevokeDevice',
                  target: b.publicKey,
                })
              ),
              a
            );
            const revokedRecords = [...records, revokedRecord];
            const revokedView = Result.getOrThrow(
              extendLedger(view, [revokedRecord], {
                length: revokedRecords.length,
                head: hashRecordBytes(revokedRecord),
              })
            );
            const revokedContext = { ...bContext, pairingSessionId: '77'.repeat(16) };
            yield* prepare(revokedContext);
            const revoked = yield* Effect.result(
              confirm(revokedContext, revokedView, revokedRecords)
            );
            expect(Result.isFailure(revoked)).toBe(true);
            if (Result.isFailure(revoked)) expect(revoked.failure.code).toBe('not-admitted');
            const resumedContext = { ...bContext, ...(yield* desktop.context()) };
            const resumed = yield* prepare(resumedContext);
            yield* desktop.stage({ ok: true, type: 'prepare', machineId: 'machine', ...resumed });
            expect(yield* desktop.approve(resumedContext.pairingSessionId)).toBeNull();
            const confirmed = yield* desktop.confirmed(resumedContext.pairingSessionId);
            expect(confirmed.pairingSessionId).toBe(resumedContext.pairingSessionId);
            yield* confirm(resumedContext);
            expect(resumed.signingPublicKey).toBe(original.signingPublicKey);
            expect(resumed.credentialHash).toBe(original.credentialHash);
            const machine = yield* acquire;
            const device = yield* machine.openDevice(signed.genesis);
            const frame = yield* prepareEpochEnvelope({
              context: {
                genesis: signed.genesis,
                epoch: Result.getOrThrow(Bytes.epochNumber(0)),
                sender: a.publicKey,
                recipient: device.publicKey,
              },
              key,
              signer: a,
              ledger: () => Effect.succeed(view),
            });
            const credential = yield* machine.deviceCredential(signed.genesis, device.publicKey);
            return {
              originalContext: context,
              context: resumedContext,
              confirmed,
              material: resumed,
              records,
              frame,
              sender: hex(a.publicKey.toBytes()),
              credential,
            };
          } finally {
            db.close();
          }
        })
      );
      let reportHex: string | undefined;
      const cloud = {
        getHistory: async (input: Parameters<CloudE2eePort['getHistory']>[0]) => ({
          ...page(fixture.records, input.after ? fixture.records.length : 0),
          workspaceId: 'workspace',
          genesisHash: fixture.context.genesisHash,
        }),
        getContentToken: async () => {
          throw new Error('unexpected-content-token');
        },
        mailboxCall: async (
          method: keyof E2eeMailboxRequests,
          input: E2eeMailboxRequests[keyof E2eeMailboxRequests]
        ) => {
          if (method === 'fetch')
            return {
              items: [{ sender: fixture.sender, frameHex: hex(fixture.frame) }],
              next: null,
            };
          if (method === 'status')
            return {
              ...(input as E2eeMailboxRequests['status']).slot,
              revision: 0,
              status: reportHex ? 'InstallationReported' : 'EnvelopeStored',
            };
          if (method === 'report') {
            reportHex = (input as E2eeMailboxRequests['report']).reportHex;
            return null;
          }
          throw new Error('unexpected-mailbox-operation');
        },
      } as CloudE2eePort;
      const options = {
        accountId,
        workspaceId: 'workspace',
        genesisHash: fixture.context.genesisHash,
        pairingSessionId: fixture.context.pairingSessionId,
        frontendSigningPublicKey: fixture.context.frontendSigningPublicKey,
        expectedSigningPublicKey: fixture.material.signingPublicKey,
        cloud,
        keyring: noKeyring,
        onUnavailable: () => undefined,
      };
      await expect(
        validateCliE2eePairingIntentLegacy({
          ...fixture.originalContext,
          signingPublicKey: fixture.material.signingPublicKey,
        })
      ).rejects.toThrow();
      await validateCliE2eePairingIntentLegacy({
        ...fixture.context,
        signingPublicKey: fixture.material.signingPublicKey,
      });
      await retainCliE2eeWorkspaceBinding(accountId, {
        workspaceId: 'workspace',
        genesisHash: fixture.context.genesisHash,
        genesisRecordHex: fixture.context.genesisRecordHex,
      });
      await expect(openCliE2eeWorkspaceLegacy(options)).rejects.toThrow('e2ee_pairing_required');
      await activateCliE2eeWorkspaceLegacy(options);
      expect(reportHex).toBeTypeOf('string');
      await activateCliE2eeWorkspaceLegacy(options);
      expect(JSON.parse(await readFile(join(machineDirectory, 'activation.json'), 'utf8'))).toEqual(
        { genesisHash: options.genesisHash, signingPublicKey: options.expectedSigningPublicKey }
      );
      host = await openCliE2eeWorkspaceLegacy(options);
      await host.refresh();
      expect(await host.status()).toMatchObject({
        hasCurrentKey: true,
        devicePublicKey: options.expectedSigningPublicKey,
      });
      await host.close();
      host = undefined;
    } finally {
      await host?.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the first checkpoint for every cursor page before receiving and installing keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-paged-cloud-'));
    vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
    let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
    try {
      const accountId = 'synthetic-paged-account';
      const machineDirectory = join(
        getLodyDataDir(),
        'e2ee',
        createHash('sha256').update(accountId).digest('hex'),
        'workspace',
        'custody'
      );
      const fixture = await execute(setup(directory, 67, machineDirectory));
      const binding = {
        workspaceId: 'workspace',
        genesisHash: hex(fixture.genesis.toBytes()),
        genesisRecordHex: hex(fixture.genesisRecord),
      };
      const preparedPairing = await prepareCliE2eeMachineLegacy({
        accountId,
        machineId: 'machine',
        frontendSigningPublicKey: fixture.sender,
        ...binding,
        membershipId: '0a'.repeat(16),
        pairingSessionId: '72'.repeat(16),
        keyring: noKeyring,
      });
      const first = {
        ...page(fixture.records, 0, 64),
        workspaceId: binding.workspaceId,
        genesisHash: binding.genesisHash,
      };
      const last = {
        ...page(fixture.records, 64),
        workspaceId: binding.workspaceId,
        genesisHash: binding.genesisHash,
      };
      const diagnostics: string[] = [];
      let reportHex: string | undefined;
      let deliverEnvelope = false;
      const cloud = {
        getHistory: async (input: Parameters<CloudE2eePort['getHistory']>[0]) => {
          if (input.cursor) {
            // Mirror the backend's cursor contract instead of forgiving a missing checkpoint.
            if (
              input.cursor !== first.nextCursor ||
              input.after !== undefined ||
              input.checkpoint?.length !== first.checkpoint.length ||
              input.checkpoint.headHash !== first.checkpoint.headHash
            )
              throw new Error('cursor_requires_original_checkpoint');
            return last;
          }
          if (input.checkpoint !== undefined) throw new Error('checkpoint_requires_cursor');
          if (input.after !== undefined) {
            if (input.after !== last.position) throw new Error('unexpected_after');
            return { ...last, startIndex: fixture.records.length, recordsHex: [] };
          }
          return first;
        },
        getContentToken: async () => {
          throw new Error('local_refresh_must_not_request_content_token');
        },
        mailboxCall: async (
          method: keyof E2eeMailboxRequests,
          input: E2eeMailboxRequests[keyof E2eeMailboxRequests]
        ) => {
          if (method === 'fetch')
            return {
              items: deliverEnvelope
                ? [{ sender: fixture.sender, frameHex: hex(fixture.frame) }]
                : [],
              next: null,
            };
          if (method === 'status')
            return {
              ...(input as E2eeMailboxRequests['status']).slot,
              revision: 0,
              status: reportHex ? 'InstallationReported' : 'EnvelopeStored',
            };
          if (method === 'report') {
            reportHex = (input as E2eeMailboxRequests['report']).reportHex;
            return null;
          }
          throw new Error('unexpected_mailbox_operation');
        },
      } as CloudE2eePort;
      const hostOptions = {
        pairingSessionId: preparedPairing.pairingSessionId,
        frontendSigningPublicKey: fixture.sender,
        expectedSigningPublicKey: preparedPairing.signingPublicKey,
        accountId,
        workspaceId: binding.workspaceId,
        genesisHash: binding.genesisHash,
        cloud,
        keyring: noKeyring,
        onUnavailable: () => {
          diagnostics.push('background-unavailable');
        },
      };
      await expect(openCliE2eeWorkspaceLegacy(hostOptions)).rejects.toThrow(
        'e2ee_pairing_required'
      );
      for (const changed of [
        { frontendSigningPublicKey: '01'.repeat(32) },
        { pairingSessionId: '01'.repeat(16) },
        { expectedSigningPublicKey: '01'.repeat(32) },
      ]) {
        await expect(
          activateCliE2eeWorkspaceLegacy({ ...hostOptions, ...changed })
        ).rejects.toThrow(/e2ee_(pairing_unconfirmed|binding_conflict)/);
        expect(reportHex).toBeUndefined();
      }
      await expect(activateCliE2eeWorkspaceLegacy(hostOptions)).rejects.toThrow(
        'e2ee_waiting_for_key'
      );
      const journalPath = join(machineDirectory, '..', 'pairings.sqlite');
      const journal = new DatabaseSync(journalPath);
      const originalAdmission = journal
        .prepare('SELECT admission FROM pairings WHERE session=?')
        .get(preparedPairing.pairingSessionId)?.admission as Uint8Array;
      expect(originalAdmission).toBeInstanceOf(Uint8Array);
      const damaged = new Uint8Array(originalAdmission);
      damaged[damaged.length - 1] ^= 1;
      journal
        .prepare('UPDATE pairings SET admission=? WHERE session=?')
        .run(damaged, preparedPairing.pairingSessionId);
      deliverEnvelope = true;
      await expect(activateCliE2eeWorkspaceLegacy(hostOptions)).rejects.toThrow(
        /e2ee_(pairing_unconfirmed|binding_conflict)/
      );
      expect(reportHex).toBeUndefined();
      journal
        .prepare('UPDATE pairings SET admission=? WHERE session=?')
        .run(originalAdmission, preparedPairing.pairingSessionId);
      journal.close();
      diagnostics.length = 0;

      await expect(openCliE2eeWorkspaceLegacy(hostOptions)).rejects.toThrow(
        'e2ee_pairing_required'
      );
      deliverEnvelope = true;
      await activateCliE2eeWorkspaceLegacy(hostOptions);
      const { retainCliE2eeMachineBootstrapLegacy, loadCliE2eeMachineBootstrapLegacy } =
        await import('../src/lib/e2ee/workspace-legacy');
      const routing = {
        accountId,
        workspaceId: binding.workspaceId,
        genesisHash: binding.genesisHash,
        signingPublicKey: preparedPairing.signingPublicKey,
        machineId: 'machine',
        deploymentUrl: 'https://cloud.synthetic.test',
      };
      await retainCliE2eeMachineBootstrapLegacy(routing, noKeyring);
      expect(
        (
          await loadCliE2eeMachineBootstrapLegacy(
            `${accountId}/${binding.workspaceId}`,
            'machine',
            noKeyring
          )
        ).credential
      ).toBe(fixture.credential);
      const { Scope: bootstrapScope, Exit: bootstrapExit } = await import('effect');
      const leaseScope = await Effect.runPromise(bootstrapScope.make());
      await Effect.runPromise(
        leaseE2eeIdentity(join(machineDirectory, '..'), true).pipe(
          bootstrapScope.provide(leaseScope)
        )
      );
      try {
        await expect(
          loadCliE2eeMachineBootstrapLegacy(
            `${accountId}/${binding.workspaceId}`,
            'machine',
            noKeyring
          )
        ).rejects.toThrow('e2ee_identity-busy');
        await expect(retainCliE2eeMachineBootstrapLegacy(routing, noKeyring)).rejects.toThrow(
          'e2ee_identity-busy'
        );
      } finally {
        await Effect.runPromise(bootstrapScope.close(leaseScope, bootstrapExit.void));
      }
      const routingPath = join(machineDirectory, '..', 'remote-bootstrap.json');
      const retainedRouting = await readFile(routingPath, 'utf8');
      await fs.writeFile(
        routingPath,
        JSON.stringify({
          ...JSON.parse(retainedRouting),
          deploymentUrl: 'https://foreign.synthetic.test',
        })
      );
      await expect(
        loadCliE2eeMachineBootstrapLegacy(
          `${accountId}/${binding.workspaceId}`,
          'machine',
          noKeyring
        )
      ).rejects.toThrow('e2ee_binding_conflict');
      await fs.writeFile(routingPath, retainedRouting);
      const originalFs =
        await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      for (const file of [
        'activation.json',
        'binding.json',
        join('custody', `${binding.genesisHash}.machine.device`),
      ]) {
        const failure = Object.assign(new Error('synthetic file descriptor exhaustion'), {
          code: 'EMFILE',
        });
        const failedPath = join(machineDirectory, '..', file);
        const fileOpen = vi.spyOn(fs, 'open').mockImplementation((path, ...args) => {
          if (path === failedPath) return Promise.reject(failure);
          return originalFs.open(path, ...args);
        });
        try {
          await expect(openCliE2eeWorkspaceLegacy(hostOptions)).rejects.toBe(failure);
        } finally {
          fileOpen.mockRestore();
        }
        host = await openCliE2eeWorkspaceLegacy(hostOptions);
        expect((await host.status()).hasCurrentKey).toBe(true);
        await host.close();
        host = undefined;
      }
      host = await openCliE2eeWorkspaceLegacy(hostOptions);
      await host.refresh();
      const status = await host.status();
      expect(status.length).toBe(fixture.records.length);
      expect(status.position).toBe(last.position);
      expect(status.hasCurrentKey).toBe(true);
      expect(reportHex).toMatch(/^[0-9a-f]+$/);
      expect(diagnostics).toEqual([]);
      await host.close();
      host = await openCliE2eeWorkspaceLegacy({
        ...hostOptions,
        cloud: {
          ...cloud,
          getHistory: async () => {
            throw new Error('offline');
          },
        },
        onUnavailable: () => {},
      });
      expect((await host.status()).hasCurrentKey).toBe(true);
      expect((await host.status()).length).toBe(fixture.records.length);
    } finally {
      await host?.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe('same-machine ledger handoff and in-place promotion', () => {
    /** A genuine admitted machine identity, its mailbox envelope and history from `setup`. */
    const handoffFixture = async (name: string, count: number) => {
      const directory = await mkdtemp(join(tmpdir(), `cli-e2ee-handoff-${name}-`));
      vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
      const accountId = `synthetic-handoff-${name}`;
      const identity = join(
        getLodyDataDir(),
        'e2ee',
        createHash('sha256').update(accountId).digest('hex'),
        'workspace'
      );
      const fixture = await execute(setup(directory, count, join(identity, 'custody')));
      const genesisHash = hex(fixture.genesis.toBytes());
      const prepared = await prepareCliE2eeMachineLegacy({
        accountId,
        machineId: 'machine',
        frontendSigningPublicKey: fixture.sender,
        workspaceId: 'workspace',
        genesisHash,
        genesisRecordHex: hex(fixture.genesisRecord),
        membershipId: '0a'.repeat(16),
        pairingSessionId: '73'.repeat(16),
        keyring: noKeyring,
      });
      if ('superseded' in prepared) throw new Error('unexpected superseded preparation');
      const historyReads: Parameters<CloudE2eePort['getHistory']>[0][] = [];
      let history: (
        input: Parameters<CloudE2eePort['getHistory']>[0]
      ) => ReturnType<typeof page> = () => {
        throw new Error('history_must_not_be_read');
      };
      const cloud = {
        getHistory: async (input: Parameters<CloudE2eePort['getHistory']>[0]) => {
          historyReads.push(input);
          return { ...history(input), workspaceId: 'workspace', genesisHash };
        },
        getContentToken: async () => {
          throw new Error('unexpected_content_token');
        },
        mailboxCall: async (
          method: keyof E2eeMailboxRequests,
          input: E2eeMailboxRequests[keyof E2eeMailboxRequests]
        ) => {
          if (method === 'fetch')
            return {
              items: [{ sender: fixture.sender, frameHex: hex(fixture.frame) }],
              next: null,
            };
          if (method === 'status')
            return {
              ...(input as E2eeMailboxRequests['status']).slot,
              revision: 0,
              status: 'InstallationReported',
            };
          if (method === 'report') return null;
          throw new Error('unexpected_mailbox_operation');
        },
      } as CloudE2eePort;
      const options = {
        machineId: 'machine',
        accountId,
        workspaceId: 'workspace',
        genesisHash,
        pairingSessionId: prepared.pairingSessionId,
        frontendSigningPublicKey: fixture.sender,
        expectedSigningPublicKey: prepared.signingPublicKey,
        cloud,
        keyring: noKeyring,
        onUnavailable: () => undefined,
      };
      const leaseFree = () =>
        Effect.runPromise(
          Effect.scoped(leaseE2eeIdentity(identity, true)).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false))
          )
        );
      return {
        directory,
        identity,
        fixture,
        options,
        historyReads,
        serve: (next: typeof history) => {
          history = next;
        },
        leaseFree,
      };
    };

    it('activates from a verified desktop ledger handoff without reading history, then starts the runtime on the same owner without reopening custody', async () => {
      const t = await handoffFixture('offline', 67);
      let promoted:
        | Awaited<ReturnType<typeof activateAndPromoteCliE2eeWorkspaceLegacy>>
        | undefined;
      const original = join(t.identity, 'custody', `${t.options.genesisHash}.machine.device`);
      const originalOpens = () =>
        vi.mocked(fs.open).mock.calls.filter(([path]) => path === original).length;
      try {
        const before = originalOpens();
        promoted = await activateAndPromoteCliE2eeWorkspaceLegacy({
          ...t.options,
          // More records than one history page: the handoff is one verified page.
          ledgerHandoff: {
            recordsHex: t.fixture.records.map(hex),
            position: page(t.fixture.records).position,
          },
        });
        expect(t.historyReads).toEqual([]);
        const activationOpens = originalOpens() - before;
        expect(activationOpens).toBeGreaterThan(0);
        expect(await promoted.status()).toMatchObject({
          length: t.fixture.records.length,
          hasCurrentKey: true,
          devicePublicKey: t.options.expectedSigningPublicKey,
        });
        expect(JSON.parse(await readFile(join(t.identity, 'activation.json'), 'utf8'))).toEqual({
          genesisHash: t.options.genesisHash,
          signingPublicKey: t.options.expectedSigningPublicKey,
        });
        // The promoted owner holds the identity lease: reset cannot archive under it.
        expect(await t.leaseFree()).toBe(false);
        let attached: unknown;
        const create = vi
          .spyOn(LoroDocumentManager, 'create')
          .mockImplementation(async (_workspaceId, _userId, _logger, managerOptions) => {
            attached = managerOptions?.encryptedWorkspace;
            throw new Error('synthetic room attach failure');
          });
        try {
          await expect(
            Lody.create({
              logger: getLogger('e2ee-handoff-test'),
              workspaceId: 'workspace' as WorkspaceId,
              contentMode: 'e2ee',
              genesisHash: t.options.genesisHash,
              token: 'token',
              userId: t.options.accountId,
              machineId: 'machine',
              machineName: 'machine',
              cloudPort: { ...createTestCloudPort(), e2ee: t.options.cloud },
              encryptedWorkspace: promoted,
            } as unknown as Parameters<typeof Lody.create>[0])
          ).rejects.toThrow('synthetic room attach failure');
        } finally {
          create.mockRestore();
        }
        // Rooms attach to the activated owner; custody and SQLite opened exactly once.
        expect(attached).toBe(promoted);
        expect(originalOpens() - before).toBe(activationOpens);
        // A failed start before Lody owns the workspace releases it for reset or retry.
        expect(await t.leaseFree()).toBe(true);
        await expect(promoted.status()).rejects.toThrow('e2ee_closed');
      } finally {
        await promoted?.close();
        vi.unstubAllEnvs();
        await rm(t.directory, { recursive: true, force: true });
      }
    });

    it('rejects a tampered handoff without retaining any of it and activates from genuine history', async () => {
      const t = await handoffFixture('tampered', 2);
      let promoted:
        | Awaited<ReturnType<typeof activateAndPromoteCliE2eeWorkspaceLegacy>>
        | undefined;
      try {
        const forged = t.fixture.records.map((record) => new Uint8Array(record));
        forged[1]![forged[1]!.length - 1]! ^= 1;
        t.serve(() => page(t.fixture.records));
        promoted = await activateAndPromoteCliE2eeWorkspaceLegacy({
          ...t.options,
          ledgerHandoff: {
            recordsHex: forged.map(hex),
            position: 'p1:workspace:2:forged-offset:0',
          },
        });
        // The network read starts from genesis: no forged record or position was kept.
        expect(t.historyReads).toEqual([
          { workspaceId: 'workspace', credential: expect.any(String) },
        ]);
        expect(await promoted.status()).toMatchObject({
          length: 2,
          position: page(t.fixture.records).position,
          hasCurrentKey: true,
        });
      } finally {
        await promoted?.close();
        vi.unstubAllEnvs();
        await rm(t.directory, { recursive: true, force: true });
      }
    });

    it('continues a stale handoff prefix that lacks the admission from history at its position', async () => {
      const t = await handoffFixture('stale', 2);
      let promoted:
        | Awaited<ReturnType<typeof activateAndPromoteCliE2eeWorkspaceLegacy>>
        | undefined;
      try {
        const prefix = page(t.fixture.records, 0, 1).position;
        t.serve((input) => {
          if (input.after !== prefix) throw new Error('unexpected_history_request');
          return page(t.fixture.records, 1);
        });
        promoted = await activateAndPromoteCliE2eeWorkspaceLegacy({
          ...t.options,
          ledgerHandoff: { recordsHex: [hex(t.fixture.genesisRecord)], position: prefix },
        });
        expect(t.historyReads.map((input) => input.after)).toEqual([prefix]);
        expect(await promoted.status()).toMatchObject({ length: 2, hasCurrentKey: true });
      } finally {
        await promoted?.close();
        vi.unstubAllEnvs();
        await rm(t.directory, { recursive: true, force: true });
      }
    });
  });

  it.each(['not-a-staging-recipient', 'temporary-io'])(
    'installs a late-admitted machine key from the real mailbox despite %s',
    async (reason) => {
      const directory = await mkdtemp(join(tmpdir(), 'cli-staging-mailbox-'));
      try {
        const fixture = await execute(setup(directory, 2, join(directory, 'machine'), true, true));
        await execute(
          Effect.gen(function* () {
            const custody = yield* makeCliE2eeCustody({
              directory: join(directory, 'late-machine'),
              keyring: noKeyring,
            });
            const device = yield* custody.createDevice(fixture.genesis);
            const ownerCustody = yield* makeNodeE2eeCustody({
              directory: join(directory, 'owner'),
              wrapper,
            });
            const owner = yield* ownerCustody.openDevice(fixture.genesis);
            const records = [...fixture.records, ...fixture.rotationSuffix];
            let view = Result.getOrThrow(
              verifyLedger({
                anchor: fixture.genesis,
                records,
                checkpoint: { length: records.length, head: hashRecordBytes(records.at(-1)!) },
              })
            );
            const admission = yield* prepareDeviceAdmission({
              genesis: fixture.genesis,
              membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10))),
              signer: device,
              encryptionPublicKey: device.enc,
              kind: 'machine',
              machineId: 'late-machine',
            });
            const record = yield* signLedgerRecord(
              Result.getOrThrow(prepareLedgerCommand(view, owner.publicKey, admission)),
              owner
            );
            records.push(record);
            view = Result.getOrThrow(
              extendLedger(view, [record], {
                length: records.length,
                head: hashRecordBytes(record),
              })
            );
            expect(
              fixture.stagedGroup!.envelopes.some(
                (row) => row.recipient === hex(device.publicKey.toBytes())
              )
            ).toBe(false);
            const mailboxHost = yield* makeSqliteKeyMailbox({
              path: join(directory, 'mailbox.sqlite'),
              mode: 'create',
              genesis: fixture.genesis,
              ledger: () => Effect.succeed(view),
            });
            const mailbox = Context.get(
              yield* Layer.build(referenceKeyMailbox(mailboxHost, device.publicKey)),
              KeyMailbox
            );
            const runtime = yield* makeCliE2eeRuntime({
              directory: join(directory, 'runtime'),
              workspaceId: 'workspace',
              custody,
              device,
              genesisRecord: fixture.genesisRecord,
              mailbox,
              staging: { readGroup: () => Effect.fail(new Error(reason)) },
            });
            yield* runtime.ingest(page(records));
            // A permanently denied source must neither stop mailbox polling nor invent a key.
            for (let attempt = 0; attempt < 2; attempt++) {
              yield* runtime.receiveKeys();
              expect((yield* runtime.status()).hasCurrentKey).toBe(false);
              expect((yield* runtime.status()).writeEpoch).toBeNull();
            }
            const frame = yield* prepareEpochEnvelope({
              context: {
                genesis: fixture.genesis,
                epoch: Result.getOrThrow(Bytes.epochNumber(1)),
                sender: owner.publicKey,
                recipient: device.publicKey,
              },
              key: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(72))),
              signer: owner,
              ledger: () => Effect.succeed(view),
            });
            const senderMailbox = Context.get(
              yield* Layer.build(referenceKeyMailbox(mailboxHost, owner.publicKey)),
              KeyMailbox
            );
            yield* senderMailbox.put('01'.repeat(16), frame);
            yield* runtime.receiveKeys();
            expect((yield* runtime.status()).hasCurrentKey).toBe(true);
            const binding = yield* runtime.binding('doc:late-machine', 'loro', 1);
            const input = {
              context: {
                protocol: 'loro-streams-crdt-payload-protection' as const,
                version: 2 as const,
                kind: 'update_batch' as const,
              },
              plaintext: new Uint8Array([4, 5]),
              additionalData: () => new Uint8Array([3]),
            };
            const sealed = yield* binding.seal(input);
            expect(
              yield* binding.open({ ...input, ...sealed, additionalData: new Uint8Array([3]) })
            ).toEqual(input.plaintext);
            // The late join installed K1 only; its cached write hint must be requalified.
            const recoveryKey = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(73)));
            const baseKey = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(20)));
            for (const op of [
              [9, [2]],
              [
                11,
                2,
                Result.getOrThrow(commitEpochKey(fixture.genesis, 2, recoveryKey)).toBytes(),
                0,
                Result.getOrThrow(
                  sealHistoryPacket({
                    genesis: fixture.genesis,
                    epoch: 2,
                    baseEpoch: 0,
                    currentKey: recoveryKey,
                    previousKey: baseKey,
                  })
                ),
              ],
            ] as const) {
              const body = Result.getOrThrow(
                encodeCbor([view.head.toBytes(), owner.publicKey.toBytes(), op])
              );
              const record = yield* signLedgerRecord(
                Result.getOrThrow(prepareLedgerRecord(view, body)),
                owner
              );
              records.push(record);
              view = Result.getOrThrow(
                extendLedger(view, [record], {
                  head: hashRecordBytes(record),
                  length: records.length,
                })
              );
            }
            yield* runtime.ingest(page(records));
            expect((yield* runtime.status()).writeEpoch).toBeNull();
            expect((yield* runtime.status()).writeEpoch).toBeNull();
          })
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  // Opening an encrypted runtime with a mailbox must not create key-maintenance journals:
  // receive.sqlite appears with the first key reception and repair.sqlite only when a
  // repair is actually queued.
  it('creates the receive journal on first key reception and never opens an unused repair journal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-lazy-journals-'));
    try {
      const fixture = await execute(setup(directory));
      const journals = async () =>
        (await readdir(join(directory, 'runtime'))).filter((name) =>
          ['receive.sqlite', 'repair.sqlite'].includes(name)
        );
      await execute(
        Effect.gen(function* () {
          const view = Result.getOrThrow(
            verifyLedger({
              anchor: fixture.genesis,
              records: fixture.records,
              checkpoint: {
                head: hashRecordBytes(fixture.records.at(-1)!),
                length: fixture.records.length,
              },
            })
          );
          const custody = yield* makeCliE2eeCustody({
            directory: join(directory, 'machine'),
            keyring: noKeyring,
          });
          const device = yield* custody.openDevice(fixture.genesis);
          const backend = yield* makeSqliteKeyMailbox({
            path: join(directory, 'mailbox.sqlite'),
            mode: 'create',
            genesis: fixture.genesis,
            ledger: () => Effect.succeed(view),
          });
          const sender = Result.getOrThrow(
            Bytes.signingPublicKey(Buffer.from(fixture.sender, 'hex'))
          );
          yield* Context.get(
            yield* Layer.build(referenceKeyMailbox(backend, sender)),
            KeyMailbox
          ).put('ad'.repeat(16), fixture.frame);
          const runtime = yield* makeCliE2eeRuntime({
            directory: join(directory, 'runtime'),
            workspaceId: 'workspace',
            custody,
            device,
            genesisRecord: fixture.genesisRecord,
            mailbox: Context.get(
              yield* Layer.build(referenceKeyMailbox(backend, device.publicKey)),
              KeyMailbox
            ),
          });
          yield* runtime.ingest(page(fixture.records));
          expect(yield* Effect.promise(journals)).toEqual([]);
          yield* runtime.receiveKeys();
          expect((yield* runtime.status()).hasCurrentKey).toBe(true);
          expect(yield* Effect.promise(journals)).toEqual(['receive.sqlite']);
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not reject a good mailbox envelope after a temporary installed-key write failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-mailbox-io-'));
    try {
      const fixture = await execute(setup(directory));
      await execute(
        Effect.gen(function* () {
          const view = Result.getOrThrow(
            verifyLedger({
              anchor: fixture.genesis,
              records: fixture.records,
              checkpoint: {
                head: hashRecordBytes(fixture.records.at(-1)!),
                length: fixture.records.length,
              },
            })
          );
          const custody = yield* makeCliE2eeCustody({
            directory: join(directory, 'machine'),
            keyring: noKeyring,
          });
          const device = yield* custody.openDevice(fixture.genesis);
          const mailboxPath = join(directory, 'mailbox.sqlite');
          const backend = yield* makeSqliteKeyMailbox({
            path: mailboxPath,
            mode: 'create',
            genesis: fixture.genesis,
            ledger: () => Effect.succeed(view),
          });
          const sender = Result.getOrThrow(
            Bytes.signingPublicKey(Buffer.from(fixture.sender, 'hex'))
          );
          const outgoing = Context.get(
            yield* Layer.build(referenceKeyMailbox(backend, sender)),
            KeyMailbox
          );
          const mailbox = Context.get(
            yield* Layer.build(referenceKeyMailbox(backend, device.publicKey)),
            KeyMailbox
          );
          yield* outgoing.put('ad'.repeat(16), fixture.frame);
          const runtime = yield* makeCliE2eeRuntime({
            directory: join(directory, 'runtime'),
            workspaceId: 'workspace',
            custody,
            device,
            genesisRecord: fixture.genesisRecord,
            mailbox,
          });
          yield* runtime.ingest(page(fixture.records));
          const local = new DatabaseSync(join(directory, 'runtime', 'installed-keys.sqlite'));
          const remote = new DatabaseSync(mailboxPath);
          try {
            local.exec(
              "CREATE TRIGGER block_install BEFORE INSERT ON installed_epoch_keys BEGIN SELECT RAISE(ABORT,'synthetic storage unavailable'); END"
            );
            const failed = yield* Effect.result(runtime.receiveKeys());
            expect(Result.isFailure(failed)).toBe(true);
            expect(remote.prepare('SELECT count(*) AS n FROM mailbox_rejected').get()!.n).toBe(0);
            expect(remote.prepare('SELECT revision FROM mailbox_slots').get()!.revision).toBe(0);
            local.exec('DROP TRIGGER block_install');
            yield* runtime.receiveKeys();
            expect((yield* runtime.status()).hasCurrentKey).toBe(true);
          } finally {
            remote.close();
            local.close();
          }
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('installs a committed staged epoch on a machine after the publisher scope is gone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-staged-epoch-'));
    let elapsed = 0;
    const realClock = Effect.runSync(Clock.Clock);
    const clock: Clock.Clock = Object.assign(Object.create(realClock), {
      currentTimeMillisUnsafe: () => 1_800_000_000_000 + elapsed,
      monotonicTimeNanosUnsafe: () => BigInt(elapsed) * 1_000_000n,
    });
    try {
      const fixture = await execute(setup(directory, 2, join(directory, 'machine'), true, true));
      const stagedGroup = fixture.stagedGroup;
      if (!stagedGroup) throw new Error('missing synthetic group');
      const mailbox: KeyMailbox['Service'] = {
        fetch: (slot) =>
          Effect.succeed({
            items: slot === 0 ? [{ sender: fixture.sender, frame: fixture.frame }] : [],
            next: null,
          }),
        status: (slot) => Effect.succeed({ ...slot, revision: 0, status: 'NeedsEnvelope' }),
        report: () => Effect.void,
        put: () => Effect.void,
        read: () => Effect.succeed(null),
        repair: () => Effect.void,
      };
      const records = [...fixture.records, ...fixture.rotationSuffix];
      const request = {
        context: {
          protocol: 'loro-streams-crdt-payload-protection',
          version: 2,
          kind: 'update_batch',
        } as const,
        plaintext: new Uint8Array([1, 2]),
        additionalData: () => new Uint8Array([3]),
      };
      let retained: { header: Uint8Array; sealed: Uint8Array } | undefined;
      for (const reopened of [false, true])
        await execute(
          Effect.gen(function* () {
            const custody = yield* makeCliE2eeCustody({
              directory: join(directory, 'machine'),
              keyring: noKeyring,
            });
            const device = yield* custody.openDevice(fixture.genesis);
            const runtime = yield* makeCliE2eeRuntime({
              directory: join(directory, 'runtime'),
              workspaceId: 'workspace',
              custody,
              device,
              genesisRecord: fixture.genesisRecord,
              mailbox,
              staging: { readGroup: () => Effect.succeed(stagedGroup) },
            });
            if (!reopened) {
              yield* runtime.ingest(page(fixture.records));
              yield* runtime.receiveKeys();
              const prior = yield* runtime.binding('doc:after-rotation', 'loro', 0);
              retained = yield* prior.seal(request);
              yield* runtime.ingest(page(records, fixture.records.length));
            }
            expect((yield* runtime.status()).hasCurrentKey).toBe(false);
            const retainedStatus = yield* runtime.status();
            expect(retainedStatus.writeEpoch, JSON.stringify({ reopened, ...retainedStatus })).toBe(
              0
            );
            const old = yield* runtime.binding('doc:after-rotation', 'loro', 0);
            elapsed = reopened ? 900_000 : 899_999;
            const outcome = yield* Effect.result(old.seal(request));
            if (reopened)
              expect(outcome).toMatchObject({
                _tag: 'Failure',
                failure: { code: 'key-update-required' },
              });
            else
              expect(
                Result.getOrThrow(inspectContentFrame(Result.getOrThrow(outcome).sealed)).epoch
              ).toBe(0);
            if (!retained) throw new Error('missing pre-rotation original');
            expect(
              yield* old.open({ ...request, ...retained, additionalData: new Uint8Array([3]) })
            ).toEqual(request.plaintext);
            if (!reopened) return;
            yield* runtime.receiveKeys();
            expect((yield* runtime.status()).hasCurrentKey).toBe(true);
            const sealed = yield* old.seal({
              context: {
                protocol: 'loro-streams-crdt-payload-protection',
                version: 2,
                kind: 'update_batch',
              },
              plaintext: new Uint8Array([1, 2]),
              additionalData: () => new Uint8Array([3]),
            });
            expect(Result.getOrThrow(inspectContentFrame(sealed.sealed)).epoch).toBe(1);
            expect(sealed.sealed.length).toBeGreaterThan(2);
          }).pipe(Effect.provideService(Clock.Clock, clock))
        );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('installs a real signed envelope, reports it, and protects content after reopening', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-receive-'));
    try {
      const fixture = await execute(setup(directory));
      let report: Uint8Array | undefined;
      const mailbox: KeyMailbox['Service'] = {
        fetch: () =>
          Effect.succeed({ items: [{ sender: fixture.sender, frame: fixture.frame }], next: null }),
        status: (slot) =>
          Effect.succeed({
            ...slot,
            revision: 0,
            status: report ? 'InstallationReported' : 'EnvelopeStored',
          }),
        report: (value) =>
          Effect.sync(() => {
            report = value.slice();
          }),
        put: () => Effect.void,
        read: () => Effect.succeed(null),
        repair: () => Effect.void,
      };
      const context = {
        protocol: 'loro-streams-crdt-payload-protection' as const,
        version: 2 as const,
        kind: 'update_batch' as const,
      };
      const plaintext = new TextEncoder().encode('CANARY-SYNTHETIC-CLI-CONTENT');
      const sealed = await execute(
        Effect.gen(function* () {
          const custody = yield* makeCliE2eeCustody({
            directory: join(directory, 'machine'),
            keyring: noKeyring,
          });
          const device = yield* custody.openDevice(fixture.genesis);
          const runtime = yield* makeCliE2eeRuntime({
            directory: join(directory, 'runtime'),
            workspaceId: 'workspace',
            custody,
            device,
            genesisRecord: fixture.genesisRecord,
            mailbox,
          });
          yield* runtime.ingest(page(fixture.records));
          yield* runtime.receiveKeys();
          expect((yield* runtime.status()).hasCurrentKey).toBe(true);
          const binding = yield* runtime.binding('doc:synthetic', 'loro', 0);
          return yield* binding.seal({
            context,
            plaintext,
            additionalData: (header) => new Uint8Array([...header, 9]),
          });
        })
      );
      expect(report?.length).toBeGreaterThan(0);
      expect(Buffer.from(sealed.sealed).includes(plaintext)).toBe(false);
      const reopened = await execute(
        Effect.gen(function* () {
          const custody = yield* makeCliE2eeCustody({
            directory: join(directory, 'machine'),
            keyring: noKeyring,
          });
          const device = yield* custody.openDevice(fixture.genesis);
          const runtime = yield* makeCliE2eeRuntime({
            directory: join(directory, 'runtime'),
            workspaceId: 'workspace',
            custody,
            device,
            genesisRecord: fixture.genesisRecord,
          });
          expect((yield* runtime.status()).hasCurrentKey).toBe(true);
          const binding = yield* runtime.binding('doc:synthetic', 'loro', 0);
          return yield* binding.open({
            ...sealed,
            context,
            additionalData: new Uint8Array([...sealed.header, 9]),
          });
        })
      );
      expect(reopened).toEqual(plaintext);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps an existing content binding sending when another device is revoked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-rotation-stop-'));
    try {
      const fixture = await execute(setup(directory, 2, join(directory, 'machine'), true));
      const mailbox: KeyMailbox['Service'] = {
        fetch: () =>
          Effect.succeed({ items: [{ sender: fixture.sender, frame: fixture.frame }], next: null }),
        status: (slot) => Effect.succeed({ ...slot, revision: 0, status: 'EnvelopeStored' }),
        report: () => Effect.void,
        put: () => Effect.void,
        read: () => Effect.succeed(null),
        repair: () => Effect.void,
      };
      await execute(
        Effect.gen(function* () {
          const custody = yield* makeCliE2eeCustody({
            directory: join(directory, 'machine'),
            keyring: noKeyring,
          });
          const device = yield* custody.openDevice(fixture.genesis);
          const runtime = yield* makeCliE2eeRuntime({
            directory: join(directory, 'runtime'),
            workspaceId: 'workspace',
            custody,
            device,
            genesisRecord: fixture.genesisRecord,
            mailbox,
          });
          yield* runtime.ingest(page(fixture.records));
          yield* runtime.receiveKeys();
          const binding = yield* runtime.binding('doc:synthetic', 'loro', 0);
          const plaintext = new TextEncoder().encode('local edit retained after revocation');
          const request = {
            context: {
              protocol: 'loro-streams-crdt-payload-protection',
              version: 2,
              kind: 'update_batch',
            } as const,
            plaintext,
            additionalData: () => new Uint8Array([3]),
          };
          const before = yield* binding.seal(request);
          expect(before.sealed.byteLength).toBeGreaterThan(plaintext.byteLength);
          const full = [...fixture.records, ...fixture.rotationSuffix];
          yield* runtime.ingest(page(full, fixture.records.length));
          expect((yield* runtime.status()).rotationRequired).toBe(true);
          expect((yield* runtime.status()).hasCurrentKey).toBe(true);
          expect(Result.isSuccess(yield* Effect.result(binding.seal(request)))).toBe(true);
          expect(new TextDecoder().decode(plaintext)).toBe('local edit retained after revocation');
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a tampered suffix without advancing, then accepts a valid retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-tamper-'));
    try {
      const fixture = await execute(setup(directory));
      await execute(
        Effect.gen(function* () {
          const custody = yield* makeCliE2eeCustody({
            directory: join(directory, 'machine'),
            keyring: noKeyring,
          });
          const device = yield* custody.openDevice(fixture.genesis);
          const runtime = yield* makeCliE2eeRuntime({
            directory: join(directory, 'runtime'),
            workspaceId: 'workspace',
            custody,
            device,
            genesisRecord: fixture.genesisRecord,
          });
          const damaged = fixture.record.slice();
          damaged[damaged.length - 1] ^= 1;
          expect(
            Result.isFailure(
              yield* Effect.result(runtime.ingest(page([fixture.genesisRecord, damaged])))
            )
          ).toBe(true);
          expect((yield* runtime.status()).position).toBe(null);
          expect(
            (yield* runtime.ingest(page([fixture.genesisRecord, fixture.record]))).length
          ).toBe(2);
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it('records an exact device revocation so the next offer uses a fresh identity offline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-device-revoked-'));
  vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
  const { CloudE2eeDeviceRevoked } = await import('../src/lib/cloud-e2ee-errors');
  const accountId = 'revoked-account';
  const root = join(
    getLodyDataDir(),
    'e2ee',
    createHash('sha256').update(accountId).digest('hex'),
    'workspace'
  );
  let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
  try {
    const fixture = await execute(setup(directory, 2, join(root, 'custody')));
    const binding = {
      workspaceId: 'workspace',
      genesisHash: hex(fixture.genesis.toBytes()),
      genesisRecordHex: hex(fixture.genesisRecord),
    };
    await retainCliE2eeWorkspaceBinding(accountId, binding);
    const key = await execute(
      Effect.gen(function* () {
        const custody = yield* makeCliE2eeCustody({
          directory: join(root, 'custody'),
          keyring: noKeyring,
        });
        return hex((yield* custody.openDevice(fixture.genesis)).publicKey.toBytes());
      })
    );
    await fs.writeFile(
      join(root, 'activation.json'),
      JSON.stringify({ genesisHash: binding.genesisHash, signingPublicKey: key })
    );
    let revoked = false;
    const removed: string[] = [];
    host = await openCliE2eeWorkspaceLegacy({
      accountId,
      ...binding,
      keyring: noKeyring,
      onUnavailable: () => {},
      onRemoved: async (reason) => {
        removed.push(String(reason));
      },
      cloud: {
        getHistory: async () => {
          if (revoked) throw new Error('unauthorized');
          return page(fixture.records);
        },
        getContentToken: async () => {
          throw new CloudE2eeDeviceRevoked();
        },
        mailboxCall: async (method: string) => {
          if (method === 'fetch') return { items: [], next: null };
          throw new Error('unavailable');
        },
      } as unknown as CloudE2eePort,
    });
    await host.refresh();
    const history = join(host.repositoryDirectory, 'roost');
    const sibling = join(root, '..', 'sibling', 'content', binding.genesisHash, key, 'roost');
    await fs.mkdir(history, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
    for (const name of [
      'history.sqlite3',
      'history.sqlite3-wal',
      'history.sqlite3-shm',
      'history.sqlite3.identity.sqlite3',
    ])
      await fs.writeFile(join(history, name), 'synthetic');
    await fs.writeFile(join(sibling, 'history.sqlite3'), 'sibling history');
    revoked = true;
    await host.refresh();
    await host.removalCleanup();
    await expect(fs.stat(history)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(join(sibling, 'history.sqlite3'), 'utf8')).toBe('sibling history');
    expect(removed).toEqual(['device-revoked']);
    // Membership and local data stay; only this identity is retired.
    await expect(fs.readFile(join(root, 'removed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.readFile(join(root, 'revoked-device.json'), 'utf8'))).toEqual({
      genesisHash: binding.genesisHash,
      signingPublicKey: key,
    });
    await host.close();
    host = undefined;
    // Simulate an interrupted wipe. The receipt must finish it even with no backend.
    await fs.mkdir(history, { recursive: true });
    await fs.writeFile(join(history, 'history.sqlite3-wal'), 'pending');
    await expect(
      openCliE2eeWorkspaceLegacy({
        accountId,
        ...binding,
        keyring: noKeyring,
        cloud: {} as CloudE2eePort,
        onUnavailable: () => {},
      })
    ).rejects.toThrow('e2ee_device_revoked');
    await expect(fs.stat(history)).rejects.toMatchObject({ code: 'ENOENT' });
    const next = await prepareCliE2eeMachineLegacy({
      accountId,
      ...binding,
      machineId: 'synthetic-machine',
      frontendSigningPublicKey: fixture.sender,
      membershipId: 'ef'.repeat(16),
      pairingSessionId: 'ef'.repeat(16),
      keyring: noKeyring,
    });
    if ('superseded' in next) throw new Error('unexpected supersession');
    expect(next.signingPublicKey).not.toBe(key);
    // The retired original stays as historical evidence; it is never offered again.
    expect(
      await fs.readFile(
        join(root, 'custody', `${binding.genesisHash}-${key}.machine-revoked.device`)
      )
    ).toBeInstanceOf(Buffer);
  } finally {
    await host?.close().catch(() => undefined);
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it('discovers device revocation from the bounded authority check without a caller refresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-authority-check-'));
  vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
  const { CloudE2eeDeviceRevoked } = await import('../src/lib/cloud-e2ee-errors');
  const accountId = 'authority-check-account';
  const root = join(
    getLodyDataDir(),
    'e2ee',
    createHash('sha256').update(accountId).digest('hex'),
    'workspace'
  );
  let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
  const intervals: Array<() => void> = [];
  const realSetInterval = globalThis.setInterval;
  const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
    callback: Parameters<typeof setInterval>[0],
    delay?: number,
    ...args: never[]
  ) => {
    if (delay === 5 * 60_000) {
      intervals.push(() => {
        if (typeof callback === 'function') callback(...args);
      });
      return 0 as unknown as ReturnType<typeof setInterval>;
    }
    return realSetInterval(callback, delay, ...args);
  }) as typeof setInterval);
  try {
    const fixture = await execute(setup(directory, 2, join(root, 'custody')));
    const binding = {
      workspaceId: 'workspace',
      genesisHash: hex(fixture.genesis.toBytes()),
      genesisRecordHex: hex(fixture.genesisRecord),
    };
    await retainCliE2eeWorkspaceBinding(accountId, binding);
    const key = await execute(
      Effect.gen(function* () {
        const custody = yield* makeCliE2eeCustody({
          directory: join(root, 'custody'),
          keyring: noKeyring,
        });
        return hex((yield* custody.openDevice(fixture.genesis)).publicKey.toBytes());
      })
    );
    await fs.writeFile(
      join(root, 'activation.json'),
      JSON.stringify({ genesisHash: binding.genesisHash, signingPublicKey: key })
    );
    const removed: string[] = [];
    const removedSignal = Promise.withResolvers<void>();
    host = await openCliE2eeWorkspaceLegacy({
      accountId,
      ...binding,
      keyring: noKeyring,
      onUnavailable: () => {},
      onRemoved: async (reason) => {
        removed.push(String(reason));
        removedSignal.resolve();
      },
      cloud: {
        getHistory: async () => page(fixture.records),
        getContentToken: async () => {
          throw new CloudE2eeDeviceRevoked();
        },
        mailboxCall: async (method: string) => {
          if (method === 'fetch') return { items: [], next: null };
          throw new Error('unavailable');
        },
      } as unknown as CloudE2eePort,
    });
    await host.refresh();
    expect(intervals).toHaveLength(1);
    intervals[0]!();
    await removedSignal.promise;
    await host.removalCleanup();
    expect(removed).toEqual(['device-revoked']);
    expect(JSON.parse(await fs.readFile(join(root, 'revoked-device.json'), 'utf8'))).toEqual({
      genesisHash: binding.genesisHash,
      signingPublicKey: key,
    });
  } finally {
    await host?.close().catch(() => undefined);
    intervalSpy.mockRestore();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps the J07 owner-retired member fence when the verified ledger cannot advance', () => {
  const deviceKey = 'cd'.repeat(32);
  const authority = {
    membershipId: 'ef'.repeat(16),
    ownerMembershipId: 'ef'.repeat(16),
    devicePresent: true,
    memberPresent: true,
    length: 11,
    generation: 0,
  };
  const observed = createDaemonLossRegistry(true);
  const receipt = observed.register(
    { workspaceId: 'workspace', machineId: 'machine', accountId: 'account', deviceKey },
    () => ({
      intakeClosed: true,
      pending: {
        processorActive: 0,
        processorQueued: 0,
        watcherChecks: 0,
        executionTurns: 0,
        executionBookkeeping: 0,
      },
    }),
    () => authority
  );
  receipt!.loss('e2ee_member_removed');
  receipt!.retired();
  expect(observed.inspect('workspace', deviceKey)).toMatchObject({
    code: 'e2ee_member_removed',
    fence: 'owner-retired',
    drained: true,
    retired: true,
    authorityLength: 11,
    authorityGeneration: 0,
  });
});

it('retries a transient history refresh without waiting for the periodic check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-history-retry-'));
  vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
  const accountId = 'history-retry-account';
  const root = join(
    getLodyDataDir(),
    'e2ee',
    createHash('sha256').update(accountId).digest('hex'),
    'workspace'
  );
  let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
  try {
    const fixture = await execute(setup(directory, 2, join(root, 'custody')));
    const binding = {
      workspaceId: 'workspace',
      genesisHash: hex(fixture.genesis.toBytes()),
      genesisRecordHex: hex(fixture.genesisRecord),
    };
    await retainCliE2eeWorkspaceBinding(accountId, binding);
    const key = await execute(
      Effect.gen(function* () {
        const custody = yield* makeCliE2eeCustody({
          directory: join(root, 'custody'),
          keyring: noKeyring,
        });
        return hex((yield* custody.openDevice(fixture.genesis)).publicKey.toBytes());
      })
    );
    await fs.writeFile(
      join(root, 'activation.json'),
      JSON.stringify({ genesisHash: binding.genesisHash, signingPublicKey: key })
    );
    let historyCalls = 0;
    let failNext = false;
    let retryAt = 0;
    const retried = Promise.withResolvers<void>();
    host = await openCliE2eeWorkspaceLegacy({
      accountId,
      ...binding,
      keyring: noKeyring,
      onUnavailable: () => {},
      cloud: {
        getHistory: async () => {
          historyCalls++;
          if (retryAt !== 0 && historyCalls === retryAt) retried.resolve();
          if (failNext) {
            failNext = false;
            throw new Error('temporary_network_failure');
          }
          return page(fixture.records);
        },
        getContentToken: async () => ({
          token: 'synthetic-token',
          bucketId: 'synthetic-bucket',
          gatewayBaseUrl: 'https://synthetic.invalid',
          expiresIn: 60,
          expiresAt: 1_000_000,
        }),
        mailboxCall: async (method: string) => {
          if (method === 'fetch') return { items: [], next: null };
          throw new Error('unavailable');
        },
      } as unknown as CloudE2eePort,
    });
    await host.refresh();
    const callsAfterOpen = historyCalls;
    retryAt = callsAfterOpen + 2;
    const retryCallbacks: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
      delay?: number,
      ...args: never[]
    ) => {
      if (delay === 1_000) {
        retryCallbacks.push(() => {
          if (typeof callback === 'function') callback(...args);
        });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    try {
      failNext = true;
      await host.refresh();
      expect(historyCalls).toBe(callsAfterOpen + 1);
      expect(retryCallbacks).toHaveLength(1);
      retryCallbacks[0]!();
      await retried.promise;
      expect(historyCalls).toBe(callsAfterOpen + 2);
      expect((await host.status()).length).toBe(fixture.records.length);
    } finally {
      timeoutSpy.mockRestore();
    }
  } finally {
    await host?.close().catch(() => undefined);
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it('fences a credential-confirmed revoked device when the verified ledger cannot advance', () => {
  const deviceKey = 'ab'.repeat(32);
  const authority = {
    membershipId: 'cd'.repeat(16),
    ownerMembershipId: 'cd'.repeat(16),
    devicePresent: true,
    memberPresent: true,
    length: 14,
    generation: 0,
  };
  const observed = createDaemonLossRegistry(true);
  const receipt = observed.register(
    { workspaceId: 'workspace', machineId: 'machine', accountId: 'account', deviceKey },
    () => ({
      intakeClosed: true,
      pending: {
        processorActive: 0,
        processorQueued: 0,
        watcherChecks: 0,
        executionTurns: 0,
        executionBookkeeping: 0,
      },
    }),
    () => authority
  );
  expect(receipt).toBeDefined();
  expect(observed.inspect('workspace', deviceKey)).toMatchObject({
    code: null,
    fence: null,
    drained: false,
    authorityLength: 14,
    authorityGeneration: 0,
  });
  receipt!.loss('e2ee_device_revoked');
  receipt!.retired();
  expect(observed.inspect('workspace', deviceKey)).toMatchObject({
    code: 'e2ee_device_revoked',
    fence: 'owner-retired',
    drained: true,
    retired: true,
    authorityLength: 14,
    authorityGeneration: 0,
  });
  // The exact refusal is scoped to this daemon's identity, not another requester.
  expect(observed.inspect('workspace', 'ef'.repeat(32))).toMatchObject({
    code: null,
    fence: null,
    drained: false,
  });
});

it.each(['history', 'renewal', 'account-race', 'close-race', 'receipt-error'] as const)(
  'member removal drains the machine owner before erasing managed data and requires a fresh member (%s)',
  async (source) => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-member-removal-'));
    vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
    const accountId = 'removed-account';
    const root = join(
      getLodyDataDir(),
      'e2ee',
      createHash('sha256').update(accountId).digest('hex'),
      'workspace'
    );
    let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
    let store: CliSqliteRepoStore | undefined;
    let replacementStore: CliSqliteRepoStore | undefined;
    let replacementHost: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
    const historyEntered = Promise.withResolvers<void>();
    const historyReleased = Promise.withResolvers<void>();
    let holdHistory = false;
    let restoreMarkerWrite: (() => void) | undefined;
    const markerFailure = new Error('synthetic removal marker disk error');
    const ownerEntered = Promise.withResolvers<void>();
    const tokenScope = await Effect.runPromise(TokenScope.make());
    const ownerReleased = Promise.withResolvers<void>();
    try {
      const fixture = await execute(setup(directory, 2, join(root, 'custody')));
      const binding = {
        workspaceId: 'workspace',
        genesisHash: hex(fixture.genesis.toBytes()),
        genesisRecordHex: hex(fixture.genesisRecord),
      };
      await retainCliE2eeWorkspaceBinding(accountId, binding);
      const key = await execute(
        Effect.gen(function* () {
          const custody = yield* makeCliE2eeCustody({
            directory: join(root, 'custody'),
            keyring: noKeyring,
          });
          return hex((yield* custody.openDevice(fixture.genesis)).publicKey.toBytes());
        })
      );
      await fs.writeFile(
        join(root, 'activation.json'),
        JSON.stringify({ genesisHash: binding.genesisHash, signingPublicKey: key })
      );
      const project = join(directory, 'user-project');
      await fs.mkdir(project);
      await fs.writeFile(join(project, 'keep.txt'), 'user source');
      let denied = false;
      let rejection = 'e2ee_device_revoked';
      let tokenRemoved = false;
      const cloud = {
        createContentTokenProvider: () =>
          Effect.gen(function* () {
            const ports = makeLoroStreamsTokenWebPorts({
              credential: Effect.succeed('synthetic-credential'),
              fetchImpl: async () => {
                if (tokenRemoved) throw new CloudE2eeMemberRemoved();
                return Response.json({
                  token: 'synthetic-token',
                  expiresIn: 900,
                  expiresAt: 1_000_000,
                  gatewayBaseUrl: 'https://synthetic.invalid',
                });
              },
            });
            const provider = yield* makeLoroStreamsTokenProvider({
              endpoint: 'https://synthetic.invalid',
              workspaceId: 'workspace',
            }).pipe(
              Effect.provideService(LoroStreamsTokenPorts, {
                ...ports,
                now: Effect.succeed(100_000),
              })
            );
            return { ...provider, getBucketId: () => 'synthetic-bucket' };
          }),
        getHistory: async () => {
          if (denied) {
            if (holdHistory) {
              historyEntered.resolve();
              await historyReleased.promise;
            }
            throw new Error('unauthorized');
          }
          return page(fixture.records);
        },
        getContentToken: async () => {
          if (rejection === 'e2ee_member_removed') throw new CloudE2eeMemberRemoved();
          throw new Error(rejection);
        },
        mailboxCall: async (method: string) => {
          if (method === 'fetch') return { items: [], next: null };
          throw new Error('unavailable');
        },
      } as unknown as CloudE2eePort;
      const options = {
        accountId,
        ...binding,
        cloud,
        keyring: noKeyring,
        onUnavailable: () => {},
        onRemoved: async () => {
          await store?.sqliteStore.close();
          ownerEntered.resolve();
          if (source !== 'receipt-error') await ownerReleased.promise;
        },
      };
      host = await openCliE2eeWorkspaceLegacy(options);
      await host.refresh();
      store = await createCliSqliteRepoStore(
        'workspace' as never,
        undefined,
        host.repositoryDirectory
      );
      const roost = join(host.repositoryDirectory, 'roost');
      await fs.mkdir(roost, { recursive: true });
      await fs.writeFile(join(roost, 'history.sqlite3.identity.sqlite3'), 'synthetic identity');
      const repo = store.baseDir;
      const originalDoc = new LoroDoc();
      originalDoc.getText('text').insert(0, 'synthetic local content');
      originalDoc.commit();
      await store.storageAdapter.save({
        type: 'doc-snapshot',
        docId: 'original',
        snapshot: originalDoc.export({ mode: 'snapshot' }),
      });
      denied = true;
      await host.refresh();
      // A single-device revoke or network error preserves all local originals.
      expect((await store.storageAdapter.loadDoc('original'))?.getText('text').toString()).toBe(
        'synthetic local content'
      );
      expect(await host.status()).toMatchObject({ devicePublicKey: key });
      rejection = 'e2ee_member_removed';
      if (source === 'receipt-error') {
        const realOpen = vi.mocked(fs.open).getMockImplementation();
        if (!realOpen) throw new Error('missing real filesystem fixture');
        vi.mocked(fs.open).mockImplementation((...args) => {
          if (
            typeof args[0] === 'string' &&
            args[0].includes('/removed-') &&
            args[0].endsWith('.pending')
          )
            return Promise.reject(markerFailure);
          return realOpen(...args);
        });
        restoreMarkerWrite = () => {
          vi.mocked(fs.open).mockImplementation(realOpen);
        };
        await host.refresh();
        await ownerEntered.promise;
        await expect(host.removalCleanup()).rejects.toBe(markerFailure);
        // Even without the parent calling close, terminal cleanup releases custody.
        await Effect.runPromise(Effect.scoped(leaseE2eeIdentity(root, true)));
        await expect(host.close()).rejects.toBe(markerFailure);
        expect((await fs.stat(store.dbPath)).isFile()).toBe(true);
        return;
      }

      if (source === 'close-race') {
        holdHistory = true;
        const refreshing = host.refresh();
        await historyEntered.promise;
        const closing = host.close();
        historyReleased.resolve();
        await refreshing;
        await closing;
        // This short durable phase must finish even though full erasure waits below.
        expect(JSON.parse(await fs.readFile(join(root, 'removed.json'), 'utf8'))).toMatchObject({
          signingPublicKey: key,
        });
      } else if (source === 'history' || source === 'account-race') await host.refresh();
      else if (source === 'renewal') {
        denied = false;
        const provider = await Effect.runPromise(
          host.tokens.createTokenProvider().pipe(TokenScope.provide(tokenScope))
        );
        expect(await Effect.runPromise(provider.getToken())).toBe('synthetic-token');
        tokenRemoved = true;
        await Effect.runPromise(provider.invalidate('unauthorized'));
        expect(Result.isFailure(await Effect.runPromise(Effect.result(provider.getToken())))).toBe(
          true
        );
      } else {
        denied = false;
        host.content.snapshotUpload?.onSnapshotRecovery?.(
          'https://synthetic.invalid/stream/synthetic-document',
          true
        );
        await ownerEntered.promise;
      }
      await expect(host.status()).rejects.toThrow('e2ee_member_removed');
      await ownerEntered.promise;
      await Effect.runPromise(TokenScope.close(tokenScope, TokenExit.void));
      expect((await fs.stat(join(repo, 'repo.sqlite3'))).isFile()).toBe(true);
      if (source === 'account-race') {
        await host.close();
        const nextAccount = 'replacement-account';
        const nextRoot = join(
          getLodyDataDir(),
          'e2ee',
          createHash('sha256').update(nextAccount).digest('hex'),
          'workspace'
        );
        const nextFixture = await execute(
          setup(join(directory, 'replacement'), 2, join(nextRoot, 'custody'))
        );
        const nextBinding = {
          workspaceId: 'workspace',
          genesisHash: hex(nextFixture.genesis.toBytes()),
          genesisRecordHex: hex(nextFixture.genesisRecord),
        };
        await retainCliE2eeWorkspaceBinding(nextAccount, nextBinding);
        const nextKey = await execute(
          Effect.gen(function* () {
            const custody = yield* makeCliE2eeCustody({
              directory: join(nextRoot, 'custody'),
              keyring: noKeyring,
            });
            return hex((yield* custody.openDevice(nextFixture.genesis)).publicKey.toBytes());
          })
        );
        await fs.writeFile(
          join(nextRoot, 'activation.json'),
          JSON.stringify({ genesisHash: nextBinding.genesisHash, signingPublicKey: nextKey })
        );
        replacementHost = await openCliE2eeWorkspaceLegacy({
          ...options,
          accountId: nextAccount,
          ...nextBinding,
          onRemoved: undefined,
          cloud: { ...cloud, getHistory: async () => page(nextFixture.records) },
        });
        await replacementHost.refresh();
        replacementStore = await createCliSqliteRepoStore(
          'workspace' as never,
          undefined,
          replacementHost.repositoryDirectory
        );
        const doc = new LoroDoc();
        doc.getText('text').insert(0, 'replacement account unsynced content');
        doc.commit();
        await replacementStore.storageAdapter.save({
          type: 'doc-snapshot',
          docId: 'replacement',
          snapshot: doc.export({ mode: 'snapshot' }),
        });
      }
      ownerReleased.resolve();
      await host.removalCleanup();
      if (replacementStore) {
        expect((await fs.stat(replacementStore.dbPath)).isFile()).toBe(true);
        expect(
          (await replacementStore.storageAdapter.loadDoc('replacement'))?.getText('text').toString()
        ).toBe('replacement account unsynced content');
      }

      await expect(fs.stat(roost)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(join(repo, 'repo.sqlite3'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        fs.readFile(join(root, 'custody', binding.genesisHash + '.machine.device'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(join(project, 'keep.txt'), 'utf8')).toBe('user source');
      await expect(openCliE2eeWorkspaceLegacy(options)).rejects.toThrow('e2ee_member_removed');
      const tombstone = JSON.parse(await fs.readFile(join(root, 'removed.json'), 'utf8')) as {
        membershipId: string;
      };
      await expect(
        prepareCliE2eeMachineLegacy({
          ...options,
          machineId: 'synthetic-machine',
          frontendSigningPublicKey: fixture.sender,
          membershipId: tombstone.membershipId,
          pairingSessionId: 'fe'.repeat(16),
        })
      ).rejects.toThrow('e2ee_member_removed');
      const next = await prepareCliE2eeMachineLegacy({
        ...options,
        machineId: 'synthetic-machine',
        frontendSigningPublicKey: fixture.sender,
        membershipId: 'ef'.repeat(16),
        pairingSessionId: 'ef'.repeat(16),
      });
      expect(next).not.toHaveProperty('superseded');
      expect('signingPublicKey' in next && next.signingPublicKey).not.toBe(key);
    } finally {
      restoreMarkerWrite?.();
      historyReleased.resolve();
      ownerReleased.resolve();
      await replacementStore?.sqliteStore.close();
      await replacementHost?.close();
      await store?.sqliteStore.close();
      await host?.removalCleanup().catch(() => undefined);
      await Effect.runPromise(TokenScope.close(tokenScope, TokenExit.void));
      await host?.close().catch((cause: unknown) => {
        if (source !== 'receipt-error') throw cause;
      });
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

describe('remote machine command', () => {
  it('keeps waiting after admission until the approving desktop delivers the current key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remote-machine-key-wait-'));
    vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
    const legacy = await import('../src/lib/e2ee/workspace-legacy');
    const { pairRemoteMachineLegacy } = await import('../src/lib/e2ee/remote-pairing');
    let keyDelivered = false;
    const activation = vi
      .spyOn(legacy, 'activateCliE2eeWorkspaceLegacy')
      .mockImplementation(async () => {
        if (!keyDelivered) throw new Error('e2ee_waiting_for_key');
      });
    const retained = vi
      .spyOn(legacy, 'retainCliE2eeMachineBootstrapLegacy')
      .mockResolvedValue(undefined as never);
    try {
      const { offer, encoded } = await admittedBeforeKey(directory);
      const statuses: string[] = [];
      let polls = 0;
      const result = await pairRemoteMachineLegacy({
        encodedOffer: encoded,
        machineId: 'machine',
        cloud: {} as CloudE2eePort,
        signal: new AbortController().signal,
        keyring: noKeyring,
        claim: async (body) => {
          const { material } = JSON.parse(body);
          return {
            pairingSessionId: offer.pairingSessionId,
            status: polls === 0 ? 'claimed' : 'admitted',
            expiresAt: offer.expiresAt,
            material,
            location: null,
          };
        },
        show: (value) => statuses.push(value.status),
        // Explicit signal: the desktop's refresh delivers the key during the second key wait.
        wait: async () => {
          polls += 1;
          if (statuses.filter((status) => status === 'waiting-for-key').length === 2)
            keyDelivered = true;
        },
        now: () => 0,
      });

      expect(result).toMatchObject({ workspaceId: 'workspace', machineId: 'machine', ready: true });
      expect(statuses).toContain('waiting-for-key');
    } finally {
      activation.mockRestore();
      retained.mockRestore();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stops waiting for the key at its deadline and keeps other activation failures terminal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remote-machine-key-deadline-'));
    vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
    const legacy = await import('../src/lib/e2ee/workspace-legacy');
    const { pairRemoteMachineLegacy } = await import('../src/lib/e2ee/remote-pairing');
    let failure = new Error('e2ee_waiting_for_key');
    const activation = vi
      .spyOn(legacy, 'activateCliE2eeWorkspaceLegacy')
      .mockImplementation(async () => {
        throw failure;
      });
    try {
      const { offer, encoded } = await admittedBeforeKey(directory);
      let clock = 0;
      const run = () =>
        pairRemoteMachineLegacy({
          encodedOffer: encoded,
          machineId: 'machine',
          cloud: {} as CloudE2eePort,
          signal: new AbortController().signal,
          keyring: noKeyring,
          claim: async (body) => ({
            pairingSessionId: offer.pairingSessionId,
            status: 'admitted',
            expiresAt: offer.expiresAt,
            material: JSON.parse(body).material,
            location: null,
          }),
          show: () => {},
          wait: async () => {
            clock += 60_000;
          },
          now: () => clock,
        });
      await expect(run()).rejects.toThrow('e2ee_waiting_for_key');
      expect(clock).toBeGreaterThanOrEqual(10 * 60_000);

      clock = 0;
      failure = new Error('e2ee_binding_conflict');
      await expect(run()).rejects.toThrow('e2ee_binding_conflict');
      expect(clock).toBe(0);
    } finally {
      activation.mockRestore();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['earlier claim by another machine', 'command cancelled after a second claim'] as const)(
    'stops without activating when the pairing command shows an %s',
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), 'remote-machine-claimed-elsewhere-'));
      vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
      const legacy = await import('../src/lib/e2ee/workspace-legacy');
      const { pairRemoteMachineLegacy } = await import('../src/lib/e2ee/remote-pairing');
      const activation = vi
        .spyOn(legacy, 'activateCliE2eeWorkspaceLegacy')
        .mockResolvedValue(undefined as never);
      try {
        const { offer, encoded } = await admittedBeforeKey(directory);
        await expect(
          pairRemoteMachineLegacy({
            encodedOffer: encoded,
            machineId: 'machine',
            cloud: {} as CloudE2eePort,
            signal: new AbortController().signal,
            keyring: noKeyring,
            claim: async (body) => {
              const { material } = JSON.parse(body);
              return scenario === 'earlier claim by another machine'
                ? {
                    pairingSessionId: offer.pairingSessionId,
                    status: 'admitted',
                    expiresAt: offer.expiresAt,
                    material: { ...material, machineId: 'other-machine' },
                    location: null,
                  }
                : {
                    pairingSessionId: offer.pairingSessionId,
                    status: 'conflict',
                    expiresAt: offer.expiresAt,
                    material: null,
                    noAdmissionReserved: true,
                    location: null,
                  };
            },
            show: () => {},
            wait: async () => {},
            now: () => 0,
          })
        ).rejects.toThrow('e2ee_pairing_claimed_by_another_machine');
        expect(activation).not.toHaveBeenCalled();
      } finally {
        activation.mockRestore();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('re-pairs a revoked machine with a fresh identity instead of offering its revoked key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remote-machine-revoked-'));
    vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
    try {
      await execute(
        Effect.gen(function* () {
          const { makeDesktopRemotePairing } = yield* Effect.promise(
            () => import('../../electron/src/main/services/e2ee-remote-pairing.mts')
          );
          const { pairRemoteMachineLegacy } = yield* Effect.promise(
            () => import('../src/lib/e2ee/remote-pairing')
          );
          const { CloudE2eeDeviceRevoked } = yield* Effect.promise(
            () => import('../src/lib/cloud-e2ee-errors')
          );
          const custody = yield* makeNodeE2eeCustody({
            directory: join(directory, 'owner'),
            wrapper,
          });
          const prepared = yield* custody.prepareDevice();
          const signed = yield* signGenesisRecord({
            signer: prepared,
            encryptionPublicKey: prepared.enc,
            initialKey: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(21))),
            userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(31))),
            membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(11))),
          });
          const signer = yield* custody.retainDevice(signed.genesis, prepared);
          let view = Result.getOrThrow(
            verifyLedger({
              anchor: signed.genesis,
              records: [signed.record],
              checkpoint: { length: 1, head: hashRecordBytes(signed.record) },
            })
          );
          const db = new DatabaseSync(join(directory, 'desktop.sqlite'));
          yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
          db.exec('CREATE TABLE records(position INTEGER PRIMARY KEY, record BLOB)');
          db.prepare('INSERT INTO records VALUES(0,?)').run(signed.record);
          const append = (record: Uint8Array) => {
            view = Result.getOrThrow(
              extendLedger(view, [record], {
                length: view.length + 1,
                head: hashRecordBytes(record),
              })
            );
            db.prepare('INSERT INTO records VALUES(?,?)').run(view.length - 1, record);
          };
          const remote = makeDesktopRemotePairing({
            db,
            workspaceId: 'workspace',
            genesis: signed.genesis,
            genesisRecord: signed.record,
            signer,
            current: () => Effect.succeed(view),
          });
          const args = {
            accountId: 'remote-account',
            deploymentUrl: 'https://cloud.synthetic.test',
            ingressUrl: 'https://edge.synthetic.test',
          };
          // First pairing: admitted into the verified ledger.
          const first = yield* remote.offer(args);
          const original = yield* Effect.promise(() =>
            prepareCliE2eeMachineLegacy({ ...first, machineId: 'machine', keyring: noKeyring })
          );
          if ('superseded' in original) throw new Error('unexpected supersession');
          const material = (value: typeof original) => ({
            ...value,
            machineId: 'machine',
            ok: true as const,
            type: 'prepare' as const,
          });
          const request = yield* remote.approve(
            first.pairingSessionId,
            yield* remote.stage(first.pairingSessionId, material(original))
          );
          if (!request) throw new Error('expected admission');
          append(new Uint8Array(Buffer.from(request.recordHex, 'hex')));
          yield* remote.retire(first.pairingSessionId);
          // The owner revokes the stopped machine; core keeps its keys in device history.
          append(
            yield* signLedgerRecord(
              Result.getOrThrow(
                prepareLedgerCommand(view, signer.publicKey, {
                  _tag: 'RevokeDevice',
                  target: Result.getOrThrow(
                    Bytes.signingPublicKey(
                      new Uint8Array(Buffer.from(original.signingPublicKey, 'hex'))
                    )
                  ),
                })
              ),
              signer
            )
          );
          // A machine that cannot learn its revocation still offers the old key:
          // the desktop names the reason instead of a generic invalid input.
          const unknowing = yield* remote.offer(args);
          const reused = yield* Effect.promise(() =>
            prepareCliE2eeMachineLegacy({ ...unknowing, machineId: 'machine', keyring: noKeyring })
          );
          if ('superseded' in reused) throw new Error('unexpected supersession');
          expect(reused.signingPublicKey).toBe(original.signingPublicKey);
          const refused = yield* Effect.result(
            remote.stage(unknowing.pairingSessionId, material(reused))
          );
          expect(Result.isFailure(refused) && refused.failure).toMatchObject({
            message: 'e2ee_pairing_key_revoked',
          });
          yield* remote.retire(unknowing.pairingSessionId, true);
          // The real command path learns the exact revocation and offers a new identity.
          const next = yield* remote.offer(args);
          const probes: string[] = [];
          let staged: string | undefined;
          const outcome = yield* Effect.promise(() =>
            pairRemoteMachineLegacy({
              encodedOffer: Buffer.from(JSON.stringify(next)).toString('base64url'),
              machineId: 'machine',
              keyring: noKeyring,
              signal: new AbortController().signal,
              cloud: {
                getContentToken: async (input: { credential: string }) => {
                  probes.push(input.credential);
                  throw new CloudE2eeDeviceRevoked();
                },
              } as unknown as CloudE2eePort,
              claim: async (body) => {
                const sent = JSON.parse(body).material;
                staged = await Effect.runPromise(remote.stage(next.pairingSessionId, sent));
                return {
                  pairingSessionId: next.pairingSessionId,
                  status: 'cancelled',
                  expiresAt: next.expiresAt,
                  material: sent,
                  location: null,
                };
              },
              show: () => {},
            }).catch((error: unknown) => error)
          );
          expect(outcome).toMatchObject({ message: 'e2ee_pairing_cancelled_create_new_command' });
          expect(probes).toHaveLength(1);
          expect(staged).toEqual(expect.any(String));
          const fresh = JSON.parse(
            String(db.prepare('SELECT material FROM remote_local_pairing').get()?.material)
          ) as { signingPublicKey: string; encryptionPublicKey: string };
          expect(fresh.signingPublicKey).not.toBe(original.signingPublicKey);
          expect(fresh.encryptionPublicKey).not.toBe(original.encryptionPublicKey);
        })
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains material-bound consent and exact signatures across restart without touching local pairing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remote-machine-command-'));
    vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
    try {
      await execute(
        Effect.gen(function* () {
          const { makeDesktopRemotePairing } = yield* Effect.promise(
            () => import('../../electron/src/main/services/e2ee-remote-pairing.mts')
          );
          const { decodeRemoteMachineOffer } = yield* Effect.promise(
            () => import('../src/lib/e2ee/remote-pairing')
          );
          const { remoteMachineSummary } = yield* Effect.promise(
            () => import('@lody/shared/e2ee-remote-pairing')
          );
          const custody = yield* makeNodeE2eeCustody({
            directory: join(directory, 'owner'),
            wrapper,
          });
          const prepared = yield* custody.prepareDevice();
          const membershipId = Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(11)));
          const signed = yield* signGenesisRecord({
            signer: prepared,
            encryptionPublicKey: prepared.enc,
            initialKey: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(21))),
            userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(31))),
            membershipId,
          });
          const signer = yield* custody.retainDevice(signed.genesis, prepared);
          let view = Result.getOrThrow(
            verifyLedger({
              anchor: signed.genesis,
              records: [signed.record],
              checkpoint: { length: 1, head: hashRecordBytes(signed.record) },
            })
          );
          const db = new DatabaseSync(join(directory, 'desktop.sqlite'));
          yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
          db.exec('CREATE TABLE records(position INTEGER PRIMARY KEY, record BLOB)');
          db.prepare('INSERT INTO records VALUES(0,?)').run(signed.record);
          const input = {
            db,
            workspaceId: 'workspace',
            genesis: signed.genesis,
            genesisRecord: signed.record,
            signer,
            current: () => Effect.succeed(view),
          };
          const local = makeDesktopLocalPairing(input);
          const localSession = (yield* local.context()).pairingSessionId;
          let remote = makeDesktopRemotePairing(input);
          const args = {
            accountId: 'remote-account',
            deploymentUrl: 'https://cloud.synthetic.test',
            ingressUrl: 'https://edge.synthetic.test',
          };
          const offer = yield* remote.offer(args);
          const encoded = Buffer.from(JSON.stringify(offer)).toString('base64url');
          expect(decodeRemoteMachineOffer(encoded)).toEqual(offer);
          for (const patch of [
            { workspaceId: 'other' },
            { frontendSigningPublicKey: '01'.repeat(32) },
            { ingressUrl: 'https://foreign.synthetic.test' },
          ]) {
            expect(() =>
              decodeRemoteMachineOffer(
                Buffer.from(JSON.stringify({ ...offer, ...patch })).toString('base64url')
              )
            ).toThrow();
          }
          const preparedMachine = yield* Effect.promise(() =>
            prepareCliE2eeMachineLegacy({ ...offer, machineId: 'machine', keyring: noKeyring })
          );
          if ('superseded' in preparedMachine) throw new Error('unexpected supersession');
          const material = {
            ...preparedMachine,
            machineId: 'machine',
            ok: true as const,
            type: 'prepare' as const,
          };
          const summary = yield* remote.stage(offer.pairingSessionId, material);
          expect(summary).toBe(yield* Effect.promise(() => remoteMachineSummary(offer, material)));
          expect(
            (yield* Effect.result(remote.approve(offer.pairingSessionId, '00'.repeat(32))))._tag
          ).toBe('Failure');
          expect(db.prepare('SELECT record FROM remote_local_pairing').get()?.record).toBeNull();
          const request = yield* remote.approve(offer.pairingSessionId, summary);
          expect(request?.machinePairingSessionId).toBe(offer.pairingSessionId);
          remote = makeDesktopRemotePairing(input);
          expect(yield* remote.offer(args)).toEqual(offer);
          expect(yield* remote.approve(offer.pairingSessionId, summary)).toEqual(request);
          expect((yield* local.context()).pairingSessionId).toBe(localSession);
          if (!request) throw new Error('expected first admission');
          expect((yield* Effect.result(remote.retire(offer.pairingSessionId)))._tag).toBe(
            'Failure'
          );
          // Cancellation serialized before writer reservation proves no dispatch.
          yield* remote.retire(offer.pairingSessionId, true);
          const resumedOffer = yield* remote.offer(args);
          const resumed = yield* Effect.promise(() =>
            prepareCliE2eeMachineLegacy({
              ...resumedOffer,
              machineId: 'machine',
              keyring: noKeyring,
            })
          );
          if ('superseded' in resumed) throw new Error('unexpected supersession');
          const resumedSummary = yield* remote.stage(resumedOffer.pairingSessionId, {
            ...resumed,
            machineId: 'machine',
            ok: true,
            type: 'prepare',
          });
          const resumedRequest = yield* remote.approve(
            resumedOffer.pairingSessionId,
            resumedSummary
          );
          if (!resumedRequest) throw new Error('expected resumed admission');
          const record = new Uint8Array(Buffer.from(resumedRequest.recordHex, 'hex'));
          view = Result.getOrThrow(
            extendLedger(view, [record], { length: 2, head: hashRecordBytes(record) })
          );
          db.prepare('INSERT INTO records VALUES(1,?)').run(record);
          expect(yield* remote.confirmed(resumedOffer.pairingSessionId)).toMatchObject({
            signingPublicKey: material.signingPublicKey,
          });
          yield* remote.retire(resumedOffer.pairingSessionId);
          expect(db.prepare('SELECT record FROM remote_pairing_archive').get()?.record).toEqual(
            record
          );
          const next = yield* remote.offer(args);
          expect(next.pairingSessionId).not.toBe(offer.pairingSessionId);
          const retried = yield* Effect.promise(() =>
            prepareCliE2eeMachineLegacy({ ...next, machineId: 'machine', keyring: noKeyring })
          );
          if ('superseded' in retried) throw new Error('unexpected supersession');
          expect(retried.signingPublicKey).toBe(material.signingPublicKey);
          const nextSummary = yield* remote.stage(next.pairingSessionId, {
            ...retried,
            machineId: 'machine',
            ok: true,
            type: 'prepare',
          });
          expect(nextSummary).not.toBe(summary);
          expect(yield* remote.approve(next.pairingSessionId, nextSummary)).toBeNull();
        })
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('encrypted queued input evidence', () => {
  it('starts a shared member queued input as that member', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        yield* h.send('member-turn', h.memberRpc);
        const claimed = yield* h.claim(yield* h.promote());
        expect(claimed).toMatchObject({
          state: 'claimed',
          principal: 'member',
          origin: { requesterDevice: hex(h.member.publicKey.toBytes()) },
        });
      })
    ));

  it('starts an owner device queued input as the owner', () =>
    run(false, (h) =>
      Effect.gen(function* () {
        yield* h.send('owner-turn', h.ownerRpc);
        expect(yield* h.claim(yield* h.promote())).toMatchObject({
          state: 'claimed',
          principal: 'owner',
        });
      })
    ));

  // The signature covers the input config, never the displayed items, so a start
  // runs exactly that signed input whatever another writer does to the items.
  it('runs the signed input, not rewritten items, under the owner signature', () =>
    run(false, (h) =>
      Effect.gen(function* () {
        yield* h.send('owner-items', h.ownerRpc);
        yield* h.promote();
        h.replaceItems('owner-items', 'replaced by another writer');
        h.doc.commit();
        const started = yield* h.startFromHistory('owner-items');
        expect(started.claimed).toMatchObject({ state: 'claimed', principal: 'owner' });
        expect(started.runs).toBe('owner-items');
      })
    ));

  it('runs the signed prompt when a composer row loses its blocks and items are rewritten', () =>
    run(false, (h) =>
      Effect.gen(function* () {
        yield* h.send('owner-blocks', h.ownerRpc);
        yield* h.promote();
        h.rewriteRow('owner-blocks', (config) => {
          delete config.inputBlocks;
        });
        h.replaceItems('owner-blocks', 'replaced by another writer');
        h.doc.commit();
        const started = yield* h.startFromHistory('owner-blocks');
        expect(started.claimed).toMatchObject({ state: 'claimed', principal: 'owner' });
        expect(started.runs).toBe('owner-blocks');
      })
    ));

  it('applies the original signer authorization to a queued input', () =>
    run(false, (h) =>
      Effect.gen(function* () {
        yield* h.send('unshared-turn', h.memberRpc);
        expect(yield* h.claim(yield* h.promote())).toEqual({
          state: 'denied',
          reason: 'e2ee_machine_not_shared',
        });
      })
    ));

  it('rechecks membership for a queued input written before removal', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        yield* h.send('removed-turn', h.memberRpc);
        const turn = yield* h.promote();
        yield* h.append({ _tag: 'DeclareCapabilities', capabilities: [1] });
        yield* h.append({ _tag: 'RemoveMember', membershipId: h.membershipId });
        expect(yield* h.claim(turn)).toMatchObject({ state: 'denied' });
      })
    ));

  it('starts a message that reaches a machine which was offline for three days', () =>
    run(false, (h) =>
      Effect.gen(function* () {
        yield* h.send('late-turn', h.ownerRpc);
        h.machineClock.now += threeDays;
        expect(yield* h.claim(yield* h.promote())).toMatchObject({
          state: 'claimed',
          principal: 'owner',
        });
      })
    ));

  it('refuses, with a reason, a message a removed member sent three days earlier', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        yield* h.send('removed-late-turn', h.memberRpc);
        const turn = yield* h.promote();
        yield* h.append({ _tag: 'DeclareCapabilities', capabilities: [1] });
        yield* h.append({ _tag: 'RemoveMember', membershipId: h.membershipId });
        h.machineClock.now += threeDays;
        // The watcher must not keep such a message waiting before it reaches the claim.
        expect(
          yield* h.execution.resolveRequester({
            workspaceId: 'workspace',
            sessionId: queuedSessionId,
            userTurnId: turn.id,
            inputConfig: turn.inputConfig,
          })
        ).toEqual({ state: 'denied' });
        expect(yield* h.claim(turn)).toEqual({
          state: 'denied',
          reason: 'e2ee_sender_not_authorized',
        });
      })
    ));

  it('starts a replayed message ID only once, however late it arrives', () =>
    run(false, (h) =>
      Effect.gen(function* () {
        yield* h.send('replayed-turn', h.ownerRpc);
        const turn = yield* h.promote();
        h.machineClock.now += threeDays;
        expect(yield* h.claim(turn)).toMatchObject({ state: 'claimed' });
        h.machineClock.now += threeDays;
        expect((yield* h.claim(turn)).state).not.toBe('claimed');
      })
    ));

  it('rechecks device state for a queued input written before revocation', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        yield* h.send('revoked-turn', h.memberRpc);
        const turn = yield* h.promote();
        yield* h.append({ _tag: 'RevokeDevice', target: h.member.publicKey }, h.member);
        expect(yield* h.claim(turn)).toMatchObject({ state: 'denied' });
      })
    ));

  it('refuses a queued input with no signed intent', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        yield* h.send('bare-turn');
        expect(yield* h.claim(yield* h.promote())).toEqual({
          state: 'denied',
          reason: 'e2ee_signature_missing',
        });
      })
    ));

  it('does not start a queued input that differs from its original', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        yield* h.send('changed-turn', h.memberRpc);
        const turn = yield* h.promote();
        const changed = { ...(turn.inputConfig as object), prompt: 'different' };
        expect(yield* h.claim({ ...turn, inputConfig: changed })).toEqual({
          state: 'denied',
          reason: 'e2ee_signature_invalid',
        });
      })
    ));

  it('starts a machine-authored queued input from its own signed intent', () =>
    run(false, (h) =>
      Effect.gen(function* () {
        const intent = yield* h.signIntent(
          h.device,
          'automation-turn',
          h.clientConfig('automation-turn')
        );
        yield* h.pushRow('automation-turn', memberAccount, queuedConfig('automation-turn'), intent);
        expect(yield* h.claim(yield* h.promote())).toMatchObject({
          state: 'claimed',
          principal: 'owner',
        });
      })
    ));

  it('does not start a machine-authored queued input after its row changes', () =>
    run(false, (h) =>
      Effect.gen(function* () {
        const intent = yield* h.signIntent(
          h.device,
          'edited-automation',
          h.clientConfig('signed-config')
        );
        yield* h.pushRow(
          'edited-automation',
          memberAccount,
          queuedConfig('edited-automation'),
          intent
        );
        expect(yield* h.claim(yield* h.promote())).toEqual({
          state: 'denied',
          reason: 'e2ee_signature_invalid',
        });
      })
    ));

  it('carries the machine resume target through a signed queued input', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        yield* h.send('resume-turn', h.memberRpc);
        const turn = yield* h.promote();
        expect(turn.inputConfig).toMatchObject({ resume: 'machine-acp-session' });
        expect(yield* h.claim(turn)).toMatchObject({ state: 'claimed', principal: 'member' });
      })
    ));

  it('does not start a promoted row whose signed content changed after promotion', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        yield* h.send('rewritten-turn', h.ownerRpc);
        const turn = yield* h.promote();
        const live = h.rewriteRow('rewritten-turn', (config) => {
          config.modelId = 'other-model';
        });
        expect(yield* h.claim({ ...turn, inputConfig: live })).toEqual({
          state: 'denied',
          reason: 'e2ee_signature_invalid',
        });
      })
    ));

  it('runs a promoted row as its signer whatever display account it names', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        yield* h.send('relabelled-turn', h.memberRpc);
        const turn = yield* h.promote();
        h.historyRow('relabelled-turn').set('userId', 'other-account');
        h.doc.commit();
        // The display account cannot choose the requester; a direct claim naming it is refused.
        expect(yield* h.rawClaim({ ...turn, userId: 'other-account' })).toEqual({
          state: 'denied',
        });
        expect(yield* h.claim({ ...turn, userId: 'other-account' })).toMatchObject({
          state: 'claimed',
          principal: 'member',
        });
      })
    ));

  it('requires this machine own signature for an automation row', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        const config = { ...queuedConfig('automation-row'), _lodyAutomation: automationOrigin };
        const intent = yield* h.prepareOriginal(
          h.memberRpc,
          'automation-row',
          ownerAccount,
          h.clientConfig('automation-row', config)
        );
        yield* h.pushRow('automation-row', ownerAccount, config, intent);
        expect(yield* h.claim(yield* h.promote())).toEqual({ state: 'denied' });
      })
    ));

  it('binds an automation input to its machine-signed content', () =>
    run(false, (h) =>
      Effect.gen(function* () {
        const config = { ...queuedConfig('automation-signed'), _lodyAutomation: automationOrigin };
        const intent = yield* h.signIntent(
          h.device,
          'automation-signed',
          h.clientConfig('automation-signed', config)
        );
        yield* h.pushRow('automation-signed', ownerAccount, config, intent);
        const turn = yield* h.promote();
        expect(turn.inputConfig).toMatchObject({ _lodyAutomation: automationOrigin });
        expect(yield* h.claim(turn)).toMatchObject({ state: 'claimed', principal: 'owner' });
      })
    ));

  it('does not accept a signature for different automation provenance', () =>
    run(false, (h) =>
      Effect.gen(function* () {
        const receipted = {
          ...queuedConfig('automation-other'),
          _lodyAutomation: automationOrigin,
        };
        const row = {
          ...receipted,
          _lodyAutomation: { ...automationOrigin, ruleId: 'other-rule' },
        };
        const intent = yield* h.signIntent(
          h.device,
          'automation-other',
          h.clientConfig('automation-other', receipted)
        );
        yield* h.pushRow('automation-other', ownerAccount, row, intent);
        expect(yield* h.claim(yield* h.promote())).toEqual({
          state: 'denied',
          reason: 'e2ee_signature_invalid',
        });
      })
    ));

  it('treats a client-written queued marker as that client own input', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        const turn = yield* h.writeMemberRow('marked-turn', memberAccount);
        yield* h.prepareOriginal(h.ownerRpc, 'marked-turn', ownerAccount, turn.inputConfig);
        expect(yield* h.claim(turn)).toMatchObject({
          state: 'claimed',
          principal: 'member',
          origin: { requesterDevice: hex(h.member.publicKey.toBytes()) },
        });
      })
    ));

  it.each([
    ['a queued original', true],
    ['a directly written row', false],
  ] as const)('runs %s labelled as the machine account as its member', (_name, queued) =>
    run(true, (h) =>
      Effect.gen(function* () {
        const turn = queued
          ? yield* Effect.gen(function* () {
              yield* h.send('labelled-turn', h.memberRpc, ownerAccount);
              return yield* h.promote();
            })
          : yield* h.writeMemberRow('labelled-turn', ownerAccount);
        expect(yield* h.rawClaim(turn)).toEqual({ state: 'denied' });
        expect(yield* h.claim(turn)).toMatchObject({ state: 'claimed', principal: 'member' });
      })
    )
  );

  it('runs a queued input as its signer, not the requester its row names', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        const intent = yield* h.prepareOriginal(h.ownerRpc, 'mismatched-turn', ownerAccount);
        yield* h.pushRow('mismatched-turn', memberAccount, queuedConfig('mismatched-turn'), intent);
        const turn = yield* h.promote();
        expect(yield* h.rawClaim(turn)).toEqual({ state: 'denied' });
        expect(yield* h.claim(turn)).toMatchObject({ state: 'claimed', principal: 'owner' });
      })
    ));

  it('does not start a member input that names another member', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        const turn = yield* h.writeMemberRow('other-member-turn', 'other-member-account');
        expect(yield* h.rawClaim(turn)).toEqual({ state: 'denied' });
      })
    ));

  it('starts a member input under its verified identity', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        const turn = yield* h.writeMemberRow('verified-member-turn', 'other-member-account');
        const requester = yield* h.execution.resolveRequester({
          workspaceId: 'workspace',
          sessionId: queuedSessionId,
          userTurnId: turn.id,
          inputConfig: turn.inputConfig,
        });
        expect(requester).toEqual({ userId: `e2ee-member:${h.memberCryptoUser}` });
        expect(
          yield* h.claim({
            ...turn,
            userId: (requester as { userId: string }).userId,
          })
        ).toMatchObject({ state: 'claimed', principal: 'member' });
      })
    ));
});
