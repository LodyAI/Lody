import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Effect, Result } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import {
  Bytes,
  verifyDeviceCredentialBinding,
  hashRecordBytes,
  extendLedger,
  prepareJoinRequest,
  prepareDeviceAdmission,
  prepareEpochEnvelope,
  prepareLedgerCommand,
  signGenesisRecord,
  signLedgerRecord,
  verifyLedger,
} from '@lody/e2ee-core/protocol';
import { makeNodeE2eeCustody, type KekWrapper } from '@lody/e2ee-core/adapters/node-custody';
import { makeCliE2eeCustody } from '../src/lib/e2ee/custody';
import { makeCliE2eeRuntime } from '../src/lib/e2ee/runtime';
import { Lody } from '../src/lib/lody';
import {
  openCliE2eeWorkspaceLegacy,
  openCliE2eePairingRuntimeLegacy,
  activateCliE2eeWorkspaceLegacy,
  prepareCliE2eeMachineLegacy,
  retainCliE2eeWorkspaceBinding,
} from '../src/lib/e2ee/workspace-legacy';
import type { CloudE2eePort } from '@lody/platform';
import type { KeyMailbox } from '@lody/e2ee-core/services';
import type { E2eeWorkspaceHistoryPage, E2eeMailboxRequests } from '@lody/cloud-api';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const wrappingKey = Buffer.alloc(32, 78);
const wrapper: KekWrapper = {
  protection: 'os-keystore',
  wrap: async (value) => {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce);
    return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
  },
  unwrap: async (value) => {
    const decipher = createDecipheriv('aes-256-gcm', wrappingKey, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(-16));
    return {
      result: Buffer.concat([
        decipher.update(value.subarray(12, -16)),
        decipher.final(),
      ]).toString(),
      shouldReEncrypt: false,
    };
  },
};
const noKeyring = async () => {
  throw new Error('synthetic missing keyring');
};
const execute = <A, E>(work: Effect.Effect<A, E, import('effect').Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(work));
const setup = (
  directory: string,
  count = 2,
  machineDirectory = join(directory, 'machine'),
  includeRotation = false
) =>
  Effect.gen(function* () {
    const custody = yield* makeNodeE2eeCustody({ directory: join(directory, 'owner'), wrapper });
    const prepared = yield* custody.prepareDevice();
    const membershipId = Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10)));
    const initialKey = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(20)));
    const signed = yield* signGenesisRecord({
      signer: prepared,
      encryptionPublicKey: prepared.enc,
      initialKey,
      userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(30))),
      membershipId,
    });
    const owner = yield* custody.retainDevice(signed.genesis, prepared);
    const machineCustody = yield* makeCliE2eeCustody({
      directory: machineDirectory,
      keyring: noKeyring,
    });
    const machine = yield* machineCustody.createDevice(signed.genesis);
    const view = Result.getOrThrow(
      verifyLedger({
        anchor: signed.genesis,
        records: [signed.record],
        checkpoint: { length: 1, head: hashRecordBytes(signed.record) },
      })
    );
    const admission = yield* prepareDeviceAdmission({
      genesis: signed.genesis,
      membershipId,
      signer: machine,
      encryptionPublicKey: machine.enc,
      kind: 'machine',
    });
    const record = yield* signLedgerRecord(
      Result.getOrThrow(prepareLedgerCommand(view, owner.publicKey, admission)),
      owner
    );
    const records = [signed.record, record];
    let current = Result.getOrThrow(
      extendLedger(view, [record], { length: 2, head: hashRecordBytes(record) })
    );
    if (count > 2) {
      const joining = yield* custody.prepareDevice();
      const member = Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(40)));
      const request = yield* prepareJoinRequest({
        genesis: signed.genesis,
        requestId: Result.getOrThrow(Bytes.requestId(new Uint8Array(16).fill(50))),
        userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(60))),
        encryptionPublicKey: joining.enc,
        expiresAt: null,
        signer: joining,
      });
      for (let index = 2; index < count; index++) {
        const command =
          index === 2
            ? { _tag: 'AdmitMember' as const, membershipId: member, request }
            : {
                _tag: 'SetRole' as const,
                membershipId: member,
                role: index % 2 ? ('admin' as const) : ('member' as const),
              };
        const next = yield* signLedgerRecord(
          Result.getOrThrow(prepareLedgerCommand(current, owner.publicKey, command)),
          owner
        );
        records.push(next);
        current = Result.getOrThrow(
          extendLedger(current, [next], { length: records.length, head: hashRecordBytes(next) })
        );
      }
      yield* custody.discardDevice(joining);
    }
    const frame = yield* prepareEpochEnvelope({
      context: {
        genesis: signed.genesis,
        epoch: Result.getOrThrow(Bytes.epochNumber(0)),
        sender: owner.publicKey,
        recipient: machine.publicKey,
      },
      key: initialKey,
      signer: owner,
      ledger: () => Effect.succeed(current),
    });
    const credential = yield* machineCustody.prepareDeviceCredential(
      signed.genesis,
      machine.publicKey
    );
    const rotationSuffix: Uint8Array[] = [];
    if (includeRotation) {
      const other = yield* custody.prepareDevice();
      const add = yield* prepareDeviceAdmission({
        genesis: signed.genesis,
        membershipId,
        signer: other,
        encryptionPublicKey: other.enc,
        kind: 'personal',
      });
      const admitted = yield* signLedgerRecord(
        Result.getOrThrow(prepareLedgerCommand(current, owner.publicKey, add)),
        owner
      );
      const withOther = Result.getOrThrow(
        extendLedger(current, [admitted], {
          length: current.length + 1,
          head: hashRecordBytes(admitted),
        })
      );
      const revoked = yield* signLedgerRecord(
        Result.getOrThrow(
          prepareLedgerCommand(withOther, owner.publicKey, {
            _tag: 'RevokeDevice',
            target: other.publicKey,
          })
        ),
        owner
      );
      rotationSuffix.push(admitted, revoked);
      yield* custody.discardDevice(other);
    }
    return {
      rotationSuffix,
      genesis: signed.genesis,
      genesisRecord: signed.record,
      record,
      records,
      frame,
      sender: hex(owner.publicKey.toBytes()),
      credential: credential.credential,
    };
  });
const page = (records: Uint8Array[], start = 0, end = records.length) => ({
  startIndex: start,
  recordsHex: records.slice(start, end).map(hex),
  position: `p1:workspace:${end}:offset-${end}:0`,
  nextCursor: end === records.length ? null : `cursor-${end}`,
  checkpoint: { length: records.length, headHash: hex(hashRecordBytes(records.at(-1)!).toBytes()) },
});

describe('machine E2EE local runtime', () => {
  it('recovers a temporary ledger storage failure on the next write without a Streams reconnect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-storage-retry-'));
    vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
    let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
    let prepare: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const accountId = 'storage-retry-account';
      const root = join(
        getLodyDataDir(),
        'e2ee',
        createHash('sha256').update(accountId).digest('hex'),
        'workspace'
      );
      const fixture = await execute(setup(directory, 2, join(root, 'custody')));
      await retainCliE2eeWorkspaceBinding(accountId, {
        workspaceId: 'workspace',
        genesisHash: hex(fixture.genesis.toBytes()),
        genesisRecordHex: hex(fixture.genesisRecord),
      });
      await fs.writeFile(
        join(root, 'activation.json'),
        JSON.stringify({
          genesisHash: hex(fixture.genesis.toBytes()),
          signingPublicKey: await execute(
            Effect.gen(function* () {
              const custody = yield* makeCliE2eeCustody({
                directory: join(root, 'custody'),
                keyring: noKeyring,
              });
              return hex((yield* custody.openDevice(fixture.genesis)).publicKey.toBytes());
            })
          ),
        })
      );
      let history = page(fixture.records);
      const cloud = {
        getHistory: async () => history,
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
              status: 'EnvelopeStored',
            };
          if (method === 'report') return null;
          throw new Error('unexpected mailbox operation');
        },
      } as CloudE2eePort;
      host = await openCliE2eeWorkspaceLegacy({
        accountId,
        workspaceId: 'workspace',
        genesisHash: hex(fixture.genesis.toBytes()),
        cloud,
        keyring: noKeyring,
        onUnavailable: () => {},
      });
      await host.refresh();
      expect((await host.status()).hasCurrentKey).toBe(true);
      const originalPrepare = DatabaseSync.prototype.prepare;
      let unavailable = true;
      prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (sql) {
        if (unavailable && sql.includes('position>=? AND position<?'))
          throw Object.assign(new Error('synthetic SQLite busy'), { code: 'SQLITE_BUSY' });
        return originalPrepare.call(this, sql);
      });
      await host.refresh();
      if (host.content.mode !== 'protected') throw new Error('expected encrypted content');
      const protection = host.content.resolve({ kind: 'doc', docId: 'synthetic' });
      if (protection.mode !== 'protected') throw new Error('expected protected room');
      const input = {
        context: {
          protocol: 'loro-streams-crdt-payload-protection',
          version: 2,
          kind: 'update_batch',
        } as const,
        plaintext: new TextEncoder().encode('retained local edit'),
        additionalData: (header: Uint8Array) => new Uint8Array([...header, 9]),
      };
      await expect(protection.config.provider.seal(input)).rejects.toThrow('e2ee_invalid_ledger');
      unavailable = false;
      const sealed = await protection.config.provider.seal(input);
      expect(Buffer.from(sealed.sealed).includes(input.plaintext)).toBe(false);
      expect(
        await protection.config.provider.open({
          ...sealed,
          context: input.context,
          additionalData: new Uint8Array([...sealed.header, 9]),
        })
      ).toEqual(input.plaintext);
      // A conflicting ledger is still fenced; fixing the source does not turn a
      // write retry into an automatic security-conflict recovery.
      const damaged = fixture.record.slice();
      damaged[damaged.length - 1] ^= 1;
      history = page([fixture.genesisRecord, damaged]);
      await host.refresh();
      history = page(fixture.records);
      await expect(protection.config.provider.seal(input)).rejects.toThrow('e2ee_invalid_ledger');
      await host.refresh();
      await expect(protection.config.provider.seal(input)).resolves.toHaveProperty('sealed');
    } finally {
      prepare?.mockRestore();
      await host?.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not refresh or acknowledge an old live device as the approved replacement', async () => {
    let refreshed = false;
    const lody = Object.assign(Object.create(Lody.prototype), {
      encryptedWorkspace: {
        status: async () => ({ devicePublicKey: 'old-device' }),
        refresh: async () => {
          refreshed = true;
        },
      },
    }) as Lody;
    expect(await lody.refreshEncryptedWorkspace('new-device')).toBe(false);
    expect(refreshed).toBe(false);
  });

  it.each(['staged', 'activated'] as const)(
    'pairs again after %s machine custody loss, retaining old runtime evidence',
    async (phase) => {
      const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-repair-'));
      vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
      let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
      try {
        const fixture = await execute(setup(directory));
        const accountId = 'replacement-account';
        const root = join(
          getLodyDataDir(),
          'e2ee',
          createHash('sha256').update(accountId).digest('hex'),
          'workspace'
        );
        let records = [...fixture.records];
        let frame: Uint8Array | undefined;
        let report = false;
        const prepare = (session: string) =>
          prepareCliE2eeMachineLegacy({
            accountId,
            workspaceId: 'workspace',
            genesisHash: hex(fixture.genesis.toBytes()),
            genesisRecordHex: hex(fixture.genesisRecord),
            membershipId: '0a'.repeat(16),
            pairingSessionId: session,
            keyring: noKeyring,
          });
        const admit = (material: Awaited<ReturnType<typeof prepare>>) =>
          execute(
            Effect.gen(function* () {
              const custody = yield* makeNodeE2eeCustody({
                directory: join(directory, 'owner'),
                wrapper,
              });
              const owner = yield* custody.openDevice(fixture.genesis);
              let view = Result.getOrThrow(
                verifyLedger({
                  anchor: fixture.genesis,
                  records,
                  checkpoint: { length: records.length, head: hashRecordBytes(records.at(-1)!) },
                })
              );
              const recipient = Result.getOrThrow(
                Bytes.signingPublicKey(Buffer.from(material.signingPublicKey, 'hex'))
              );
              const record = yield* signLedgerRecord(
                Result.getOrThrow(
                  prepareLedgerCommand(view, owner.publicKey, {
                    _tag: 'AdmitDevice',
                    kind: 'machine',
                    signingPublicKey: recipient,
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
              records = [...records, record];
              view = Result.getOrThrow(
                extendLedger(view, [record], {
                  length: records.length,
                  head: hashRecordBytes(record),
                })
              );
              frame = yield* prepareEpochEnvelope({
                context: {
                  genesis: fixture.genesis,
                  epoch: Result.getOrThrow(Bytes.epochNumber(0)),
                  sender: owner.publicKey,
                  recipient,
                },
                key: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(20))),
                signer: owner,
                ledger: () => Effect.succeed(view),
              });
              report = false;
            })
          );
        const cloud = {
          getHistory: async (input: Parameters<CloudE2eePort['getHistory']>[0]) => ({
            ...page(records, input.after ? Number(input.after.split(':')[2]) : 0),
            workspaceId: 'workspace',
            genesisHash: hex(fixture.genesis.toBytes()),
          }),
          mailboxCall: async (
            method: string,
            input: E2eeMailboxRequests[keyof E2eeMailboxRequests]
          ) => {
            if (method === 'fetch')
              return {
                items: frame ? [{ sender: fixture.sender, frameHex: hex(frame) }] : [],
                next: null,
              };
            if (method === 'status')
              return {
                ...(input as E2eeMailboxRequests['status']).slot,
                revision: 0,
                status: report ? 'InstallationReported' : 'EnvelopeStored',
              };
            if (method === 'report') {
              report = true;
              return null;
            }
            throw new Error('unexpected mailbox operation');
          },
        } as CloudE2eePort;
        const options = {
          accountId,
          workspaceId: 'workspace',
          genesisHash: hex(fixture.genesis.toBytes()),
          cloud,
          keyring: noKeyring,
          onUnavailable: () => {},
        };
        const original = await prepare('01'.repeat(16));
        if (phase === 'activated') {
          await admit(original);
          await activateCliE2eeWorkspaceLegacy(options);
          host = await openCliE2eeWorkspaceLegacy(options);
          await host.refresh();
          expect((await host.status()).hasCurrentKey).toBe(true);
          await host.close();
          host = undefined;
        } else {
          const pending = await openCliE2eePairingRuntimeLegacy(options);
          await pending.refresh();
          await pending.close();
        }
        const oldRuntime = await readdir(join(root, 'runtime'));
        await rm(join(root, 'custody'), { recursive: true });
        const replacement = await prepare('02'.repeat(16));
        expect(replacement.signingPublicKey).not.toBe(original.signingPublicKey);
        await admit(replacement);
        await activateCliE2eeWorkspaceLegacy(options);
        expect(
          JSON.parse(await readFile(join(root, 'activation.json'), 'utf8')).signingPublicKey
        ).toBe(replacement.signingPublicKey);
        host = await openCliE2eeWorkspaceLegacy(options);
        await host.refresh();
        expect((await host.status()).hasCurrentKey).toBe(true);
        expect((await host.status()).devicePublicKey).toBe(replacement.signingPublicKey);
        expect(await readdir(join(root, 'runtime'))).toEqual(expect.arrayContaining(oldRuntime));
        expect(report).toBe(true);
      } finally {
        await host?.close();
        vi.unstubAllEnvs();
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
        workspaceId: 'workspace',
        genesisHash: hex(fixture.genesis.toBytes()),
        genesisRecordHex: hex(fixture.genesisRecord),
        membershipId: '0a'.repeat(16),
        pairingSessionId: '0b'.repeat(16),
        keyring: noKeyring,
      });
      expect(material.protection).toBe('file');
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
      await retainCliE2eeWorkspaceBinding(accountId, binding);
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
      await expect(activateCliE2eeWorkspaceLegacy(hostOptions)).rejects.toThrow(
        'e2ee_waiting_for_key'
      );
      await expect(openCliE2eeWorkspaceLegacy(hostOptions)).rejects.toThrow(
        'e2ee_pairing_required'
      );
      deliverEnvelope = true;
      await activateCliE2eeWorkspaceLegacy(hostOptions);
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

  it('stops an existing content binding when another device is revoked, retaining local edits', async () => {
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
          expect(Result.isFailure(yield* Effect.result(binding.seal(request)))).toBe(true);
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
