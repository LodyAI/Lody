import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Context, Effect, Fiber, Layer, Result } from 'effect';
import { LoroDoc } from 'loro-crdt';
import {
  StreamsCrdt,
  createLoroDocAdapter,
  createInitialRemoteCursor,
  type JsonObject,
} from '@loro-dev/streams-crdt/loro';
import { fileURLToPath } from 'node:url';
import {
  makeLoroStreamsTokenProvider,
  makeLoroStreamsTokenWebPorts,
  LoroStreamsTokenPorts,
} from '@lody/shared';
import { encodeEpochStagedGroup } from '@lody/e2ee-core/host';
import { startProcessLegacy } from '@lody/shared/node/process';
import { describe, expect, it, vi } from 'vitest';
import {
  Bytes,
  verifyDeviceCredentialBinding,
  hashRecordBytes,
  extendLedger,
  prepareJoinRequest,
  prepareDeviceAdmission,
  prepareEpochEnvelope,
  prepareLedgerRecord,
  encodeCbor,
  commitEpochKey,
  sealHistoryPacket,
  getCommittedEpochStagingKey,
  prepareLedgerCommand,
  signGenesisRecord,
  signLedgerRecord,
  verifyLedger,
} from '@lody/e2ee-core/protocol';
import { makeNodeE2eeCustody, type KekWrapper } from '@lody/e2ee-core/adapters/node-custody';
import { makeCliE2eeCustody } from '../src/lib/e2ee/custody';
import { makeCliE2eeRuntime } from '../src/lib/e2ee/runtime';
import { openMachinePairingJournal } from '../src/lib/e2ee/pairing-journal';
import { Lody } from '../src/lib/lody';
import { makeDesktopLocalPairing } from '../../electron/src/main/services/e2ee-local-pairing.mts';
import {
  openCliE2eeWorkspaceLegacy,
  openCliE2eePairingRuntimeLegacy,
  activateCliE2eeWorkspaceLegacy,
  prepareCliE2eeMachineLegacy,
  retainCliE2eeWorkspaceBinding,
  validateCliE2eePairingIntentLegacy,
} from '../src/lib/e2ee/workspace-legacy';
import type { CloudE2eePort } from '@lody/platform';
import type { EpochStagedGroup } from '@lody/e2ee-core';
import { KeyMailbox } from '@lody/e2ee-core/services';
import { makeSqliteKeyMailbox, referenceKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite';
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
  includeRotation = false,
  publishRotation = false
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
      machineId: 'machine',
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
    let stagedGroup: EpochStagedGroup | undefined;
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
      if (publishRotation) {
        let rotated = Result.getOrThrow(
          extendLedger(withOther, [revoked], {
            length: withOther.length + 1,
            head: hashRecordBytes(revoked),
          })
        );
        const key = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(72)));
        const commitment = Result.getOrThrow(commitEpochKey(signed.genesis, 1, key));
        const packet = Result.getOrThrow(
          sealHistoryPacket({
            genesis: signed.genesis,
            epoch: 1,
            currentKey: key,
            previousKey: initialKey,
          })
        );
        const publication = yield* signLedgerRecord(
          Result.getOrThrow(
            prepareLedgerRecord(
              rotated,
              Result.getOrThrow(
                encodeCbor([
                  rotated.head.toBytes(),
                  owner.publicKey.toBytes(),
                  [7, 1, commitment.toBytes(), packet],
                ])
              )
            )
          ),
          owner
        );
        rotated = Result.getOrThrow(
          extendLedger(rotated, [publication], {
            length: rotated.length + 1,
            head: hashRecordBytes(publication),
          })
        );
        const envelopes = [];
        for (const recipient of [owner.publicKey, machine.publicKey]) {
          const envelope = yield* prepareEpochEnvelope({
            context: {
              genesis: signed.genesis,
              epoch: Result.getOrThrow(Bytes.epochNumber(1)),
              sender: owner.publicKey,
              recipient,
            },
            key,
            signer: owner,
            ledger: () => Effect.succeed(rotated),
          });
          envelopes.push({ recipient: hex(recipient.toBytes()), frame: envelope });
        }
        stagedGroup = {
          ...Result.getOrThrow(getCommittedEpochStagingKey(rotated, 1)),
          record: publication,
          envelopes,
        };
        rotationSuffix.push(publication);
      }
      yield* custody.discardDevice(other);
    }
    return {
      rotationSuffix,
      stagedGroup,
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

  it.each([false, true, 'published', 'epoch'] as const)(
    'releases the real SDK save queue before storage recovery when rotation=%s',
    async (rotation) => {
      const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-storage-retry-'));
      vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
      let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
      let prepare: ReturnType<typeof vi.spyOn> | undefined;
      let stream: StreamsCrdt<JsonObject> | undefined;
      let doc: LoroDoc | undefined;
      let firstWrite: Promise<unknown> | undefined;
      const historyEntered = Promise.withResolvers<void>();
      const releaseHistory = Promise.withResolvers<void>();
      const receiveEntered = Promise.withResolvers<void>();
      const releaseReceive = Promise.withResolvers<void>();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const accountId = 'storage-retry-account';
        const root = join(
          getLodyDataDir(),
          'e2ee',
          createHash('sha256').update(accountId).digest('hex'),
          'workspace'
        );
        const fixture = await execute(
          setup(
            directory,
            2,
            join(root, 'custody'),
            Boolean(rotation),
            rotation === 'published' || rotation === 'epoch'
          )
        );
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
        let issuedToken = 'epoch-token-old';
        let holdHistory = false;
        let holdReceive = false;
        const cloud = {
          getHistory: async () => {
            if (holdHistory) {
              historyEntered.resolve();
              await releaseHistory.promise;
            }
            return history;
          },
          readEpochGroup: async () => {
            if (holdReceive) {
              receiveEntered.resolve();
              await releaseReceive.promise;
            }
            return fixture.stagedGroup ? encodeEpochStagedGroup(fixture.stagedGroup) : null;
          },
          createContentTokenProvider: () =>
            Effect.gen(function* () {
              const provider = yield* makeLoroStreamsTokenProvider({
                endpoint: 'https://synthetic.invalid/token',
                workspaceId: 'workspace',
              }).pipe(
                Effect.provideService(
                  LoroStreamsTokenPorts,
                  makeLoroStreamsTokenWebPorts({
                    credential: Effect.succeed('synthetic-token'),
                    fetchImpl: async () =>
                      Response.json({
                        token: issuedToken,
                        expiresIn: 900,
                        expiresAt: Date.now() + 900_000,
                        gatewayBaseUrl: 'https://synthetic.invalid',
                      }),
                  })
                )
              );
              return { ...provider, getBucketId: () => 'synthetic-content' };
            }),
          mailboxCall: async (
            method: keyof E2eeMailboxRequests,
            input: E2eeMailboxRequests[keyof E2eeMailboxRequests]
          ) => {
            if (method === 'fetch') {
              if (holdReceive) {
                receiveEntered.resolve();
                await releaseReceive.promise;
              }
              return {
                items:
                  (input as E2eeMailboxRequests['fetch']).epoch === 0
                    ? [{ sender: fixture.sender, frameHex: hex(fixture.frame) }]
                    : [],
                next: null,
              };
            }
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
        unavailable = false;
        // Read the real revocation inside the repair, while its old SDK save is queued.
        if (rotation)
          history = page([
            ...fixture.records,
            ...(rotation === 'epoch' ? fixture.rotationSuffix : fixture.rotationSuffix.slice(0, 2)),
          ]);
        holdHistory = true;
        holdReceive = true;
        const frames: Uint8Array[] = [];
        const url = 'https://cycle.synthetic.invalid/ds/content/room';
        doc = new LoroDoc();
        stream = new StreamsCrdt({
          streamUrl: url,
          adapter: createLoroDocAdapter(doc),
          e2ee: protection.config,
          remoteCursorStore: {
            load: async () =>
              createInitialRemoteCursor({
                streamUrl: url,
                nextOffset: '00000000000000000000',
                serverLowerBoundVersion: {},
              }),
            save: async () => {},
          },
          fetch: async (_url, init) => {
            if (init?.method === 'POST')
              frames.push(new Uint8Array(await new Response(init.body).arrayBuffer()));
            const headers = new Headers(init?.headers);
            return new Response(null, {
              status: 200,
              headers: {
                'Content-Type': 'application/octet-stream',
                'Stream-Next-Offset': '00000000000000000100',
                'Stream-Up-To-Date': 'true',
                'Producer-Epoch': headers.get('Producer-Epoch') ?? '0',
                'Producer-Seq': headers.get('Producer-Seq') ?? '0',
              },
            });
          },
        });
        doc.getText('draft').insert(0, 'retained local edit');
        doc.commit();
        let ended: Awaited<ReturnType<StreamsCrdt<JsonObject>['appendWriteOnly']>> | undefined;
        firstWrite = stream.appendWriteOnly().then((result) => {
          ended = result;
          return result;
        });
        await historyEntered.promise;
        // After entry into the held history read, only Promise work remains in the
        // failed SDK save. Drain it deterministically without advancing a deadline.
        await vi.advanceTimersByTimeAsync(0);
        expect(ended?.ok).toBe(false);
        releaseHistory.resolve();
        const recovery = host.refresh(); // Queue-external receipt; never awaited by seal.
        await receiveEntered.promise;
        expect((await stream.appendWriteOnly()).ok).toBe(true);
        expect(doc.getText('draft').toString()).toBe('retained local edit');
        const receivedDoc = new LoroDoc();
        const reader = new StreamsCrdt({
          streamUrl: url,
          adapter: createLoroDocAdapter(receivedDoc),
          e2ee: protection.config,
          remoteCursorStore: {
            load: async () =>
              createInitialRemoteCursor({
                streamUrl: url,
                nextOffset: '00000000000000000000',
                serverLowerBoundVersion: {},
              }),
            save: async () => {},
          },
          fetch: async () =>
            new Response(Buffer.concat(frames), {
              status: 200,
              headers: {
                'Content-Type': 'application/octet-stream',
                'Stream-Next-Offset': '00000000000000000100',
                'Stream-Up-To-Date': 'true',
              },
            }),
        });
        try {
          expect((await reader.catchup()).ok).toBe(true);
          expect(receivedDoc.getText('draft').toString()).toBe('retained local edit');
        } finally {
          await reader.close();
          receivedDoc.free();
        }
        releaseReceive.resolve();
        await recovery;
        holdHistory = false;
        holdReceive = false;
        if (rotation === 'published') {
          const active = host;
          await execute(
            Effect.scoped(
              Effect.gen(function* () {
                if (!active.tokens.createTokenProvider)
                  throw new Error('missing native token factory');
                const token = yield* active.tokens.createTokenProvider();
                expect(yield* token.getToken()).toBe('epoch-token-old');
                issuedToken = 'epoch-token-new';
                history = page([...fixture.records, ...fixture.rotationSuffix]);
                yield* Effect.promise(() => active.refresh());
                expect((yield* Effect.promise(() => active.status())).epochPhase).toBe('ready');
                expect(yield* token.getToken()).toBe('epoch-token-new');
                const sealed = yield* Effect.promise(() => protection.config.provider.seal(input));
                expect(
                  yield* Effect.promise(() =>
                    protection.config.provider.open({
                      ...sealed,
                      context: input.context,
                      additionalData: new Uint8Array([...sealed.header, 9]),
                    })
                  )
                ).toEqual(input.plaintext);
              })
            )
          );
          return;
        }
        if (rotation) {
          history = page([...fixture.records, ...fixture.rotationSuffix]);
          const stillAvailable = await protection.config.provider.seal(input);
          expect(
            await protection.config.provider.open({
              ...stillAvailable,
              context: input.context,
              additionalData: new Uint8Array([...stillAvailable.header, 9]),
            })
          ).toEqual(input.plaintext);
          expect((await host.status()).epochPhase).toBe('ready');
          return;
        }
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
        releaseHistory.resolve();
        releaseReceive.resolve();
        await firstWrite;
        await stream?.close();
        doc?.free();
        prepare?.mockRestore();
        await host?.close();
        vi.useRealTimers();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

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

  it.each([
    ['staged', 'custody'],
    ['activated', 'custody'],
    ['staged', 'device'],
    ['activated', 'device'],
    ['activated', 'legacy-device'],
  ] as const)(
    'pairs again after %s machine %s loss only in a new explicit session, retaining old evidence',
    async (phase, loss) => {
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
        let records = [fixture.genesisRecord];
        let frame: Uint8Array | undefined;
        let report = false;
        const prepare = (session: string) =>
          prepareCliE2eeMachineLegacy({
            accountId,
            machineId: 'machine',
            frontendSigningPublicKey: fixture.sender,
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
                    machineId: 'machine',
                    replaces: (() => {
                      const previous = [...view.inspectState().devices].find(
                        ([, device]) => device.kind === 'machine' && device.machineId === 'machine'
                      )?.[0];
                      return previous
                        ? Result.getOrThrow(Bytes.signingPublicKey(Buffer.from(previous, 'hex')))
                        : null;
                    })(),
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
          await activateCliE2eeWorkspaceLegacy({
            ...options,
            pairingSessionId: original.pairingSessionId,
            frontendSigningPublicKey: fixture.sender,
            expectedSigningPublicKey: original.signingPublicKey,
          });
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
        if (loss === 'legacy-device')
          await fs.rename(
            join(
              root,
              'custody',
              `device-credential-${hex(fixture.genesis.toBytes())}-${original.signingPublicKey}.sealed`
            ),
            join(root, 'custody', `device-credential-${hex(fixture.genesis.toBytes())}.sealed`)
          );
        const journal = new DatabaseSync(join(root, 'pairings.sqlite'));
        const retainedMaterial = journal
          .prepare('SELECT material FROM pairings WHERE session=?')
          .get(original.pairingSessionId)?.material;
        journal.close();
        const originals = new Map(
          (await readdir(join(root, 'custody')))
            .filter((name) => !name.endsWith('.device'))
            .map((name) => [name, Buffer.alloc(0)])
        );
        for (const name of originals.keys())
          originals.set(name, await readFile(join(root, 'custody', name)));
        await rm(
          loss === 'custody'
            ? join(root, 'custody')
            : join(root, 'custody', `${hex(fixture.genesis.toBytes())}.machine.device`),
          { recursive: true }
        );
        await expect(openCliE2eeWorkspaceLegacy(options)).rejects.toThrow('e2ee_pairing_required');
        await expect(prepare('01'.repeat(16))).rejects.toThrow();
        const replacement = await prepare('02'.repeat(16));
        expect(replacement.signingPublicKey).not.toBe(original.signingPublicKey);
        expect(replacement.credentialHash).not.toBe(original.credentialHash);
        if (loss !== 'custody')
          for (const [name, bytes] of originals)
            expect(await readFile(join(root, 'custody', name))).toEqual(bytes);
        await admit(replacement);
        await activateCliE2eeWorkspaceLegacy({
          ...options,
          pairingSessionId: replacement.pairingSessionId,
          frontendSigningPublicKey: fixture.sender,
          expectedSigningPublicKey: replacement.signingPublicKey,
        });
        expect(
          JSON.parse(await readFile(join(root, 'activation.json'), 'utf8')).signingPublicKey
        ).toBe(replacement.signingPublicKey);
        host = await openCliE2eeWorkspaceLegacy(options);
        await host.refresh();
        expect((await host.status()).hasCurrentKey).toBe(true);
        expect((await host.status()).devicePublicKey).toBe(replacement.signingPublicKey);
        expect(await readdir(join(root, 'runtime'))).toEqual(expect.arrayContaining(oldRuntime));
        expect(report).toBe(true);
        expect(await readdir(join(root, 'runtime'))).toContain(replacement.signingPublicKey);
        const retainedJournal = new DatabaseSync(join(root, 'pairings.sqlite'));
        expect(
          retainedJournal
            .prepare('SELECT material FROM pairings WHERE session=?')
            .get(original.pairingSessionId)?.material
        ).toBe(retainedMaterial);
        retainedJournal.close();
        const following = await prepare('03'.repeat(16));
        expect(following.signingPublicKey).toBe(replacement.signingPublicKey);
        expect(following.encryptionPublicKey).toBe(replacement.encryptionPublicKey);
        expect(following.credentialHash).toBe(replacement.credentialHash);
      } finally {
        await host?.close();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ['scoped', 'acquire', 'same'],
    ['scoped', 'acquire', 'successor'],
    ['scoped', 'device', 'same'],
    ['scoped', 'device', 'successor'],
    ['legacy', 'acquire', 'same'],
    ['legacy', 'acquire', 'successor'],
    ['legacy', 'device', 'same'],
    ['legacy', 'device', 'successor'],
  ] as const)(
    'retries replacement with old %s evidence after %s failure through %s session',
    async (location, phase, retry) => {
      const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-old-evidence-'));
      try {
        const fixture = await execute(setup(directory));
        const root = join(directory, 'journal');
        await fs.mkdir(root);
        const context = {
          accountId: 'account',
          machineId: 'machine',
          workspaceId: 'workspace',
          genesisHash: hex(fixture.genesis.toBytes()),
          genesisRecordHex: hex(fixture.genesisRecord),
          membershipId: '0a'.repeat(16),
          frontendSigningPublicKey: fixture.sender,
        };
        const custody = makeCliE2eeCustody({
          directory: join(root, 'custody'),
          keyring: noKeyring,
        });
        const prepare = (session: string, acquire = custody) =>
          execute(
            Effect.gen(function* () {
              const journal = yield* openMachinePairingJournal(root);
              return yield* journal.prepare(
                { ...context, pairingSessionId: session.repeat(16) },
                acquire
              );
            })
          );
        const original = await prepare('01');
        const scoped = join(
          root,
          'custody',
          `device-credential-${context.genesisHash}-${original.signingPublicKey}.sealed`
        );
        const credentialPath =
          location === 'legacy'
            ? join(root, 'custody', `device-credential-${context.genesisHash}.sealed`)
            : scoped;
        if (location === 'legacy') await fs.rename(scoped, credentialPath);
        const protectedCredential = await readFile(credentialPath);
        await fs.unlink(join(root, 'custody', `${context.genesisHash}.machine.device`));
        const failure = new Error('synthetic transient failure before device publication');
        const interrupted =
          phase === 'acquire'
            ? Effect.fail(failure)
            : custody.pipe(
                Effect.map((owner) => ({
                  ...owner,
                  createDevice: () => Effect.fail(failure),
                }))
              );
        await expect(prepare('02', interrupted)).rejects.toThrow('synthetic transient failure');
        const next = await prepare(retry === 'same' ? '02' : '03');
        expect(next.signingPublicKey).not.toBe(original.signingPublicKey);
        expect(next.credentialHash).not.toBe(original.credentialHash);
        expect(await readFile(credentialPath)).toEqual(protectedCredential);
        if (retry === 'successor')
          await expect(prepare('02')).rejects.toMatchObject({ code: 'superseded' });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(['credential-before', 'credential-after', 'sign', 'material'] as const)(
    'resumes replacement originals after an interrupted %s preparation',
    async (phase) => {
      const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-preparation-'));
      try {
        const fixture = await execute(setup(directory));
        const root = join(directory, 'journal');
        await fs.mkdir(root);
        const context = {
          accountId: 'account',
          machineId: 'machine',
          workspaceId: 'workspace',
          genesisHash: hex(fixture.genesis.toBytes()),
          genesisRecordHex: hex(fixture.genesisRecord),
          membershipId: '0a'.repeat(16),
          frontendSigningPublicKey: fixture.sender,
        };
        let inject = false;
        const injected = new Error(`synthetic ${phase} failure`);
        const acquire = makeCliE2eeCustody({
          directory: join(root, 'custody'),
          keyring: noKeyring,
        }).pipe(
          Effect.map((custody) => ({
            ...custody,
            prepareDeviceCredential: (genesis, key) =>
              Effect.gen(function* () {
                if (inject && phase === 'credential-before') {
                  inject = false;
                  return yield* Effect.fail(injected);
                }
                const value = yield* custody.prepareDeviceCredential(genesis, key);
                if (inject && phase === 'credential-after') {
                  inject = false;
                  return yield* Effect.fail(injected);
                }
                return value;
              }),
            createDevice: (genesis) =>
              custody.createDevice(genesis).pipe(
                Effect.map((device) => ({
                  ...device,
                  sign: (bytes) => {
                    if (inject && phase === 'sign') {
                      inject = false;
                      return Effect.fail(injected);
                    }
                    return device.sign(bytes);
                  },
                }))
              ),
          }))
        );
        // A fresh Scope for every call proves reopening native storage, rather
        // than retaining a successful in-memory handle after the failure.
        const prepare = (session: string) =>
          execute(
            Effect.gen(function* () {
              const journal = yield* openMachinePairingJournal(root);
              return yield* journal.prepare({ ...context, pairingSessionId: session }, acquire);
            })
          );
        const original = await prepare('01'.repeat(16));
        await rm(join(root, 'custody'), { recursive: true });
        const db = new DatabaseSync(join(root, 'pairings.sqlite'));
        try {
          const old = db
            .prepare('SELECT material FROM pairings WHERE session=?')
            .get(original.pairingSessionId);
          if (phase === 'material')
            db.exec(
              "CREATE TRIGGER transient_failure BEFORE UPDATE OF material ON pairings BEGIN SELECT RAISE(ABORT,'synthetic material failure'); END"
            );
          inject = true;
          await expect(prepare('02'.repeat(16))).rejects.toThrow();
          const stage = db
            .prepare('SELECT creating,material FROM pairings WHERE session=?')
            .get('02'.repeat(16));
          expect(stage).toMatchObject({ creating: 1, material: null });
          const retainedKey = await execute(
            Effect.gen(function* () {
              const custody = yield* makeCliE2eeCustody({
                directory: join(root, 'custody'),
                keyring: noKeyring,
              });
              return hex((yield* custody.openDevice(fixture.genesis)).publicKey.toBytes());
            })
          );
          if (phase === 'material') db.exec('DROP TRIGGER transient_failure');
          const recovered = await prepare('03'.repeat(16));
          await expect(prepare('02'.repeat(16))).rejects.toThrow();
          expect(recovered.signingPublicKey).toBe(retainedKey);
          expect(recovered.signingPublicKey).not.toBe(original.signingPublicKey);
          expect(await prepare('03'.repeat(16))).toEqual(recovered);
          const following = await prepare('04'.repeat(16));
          expect(following.signingPublicKey).toBe(recovered.signingPublicKey);
          expect(following.credentialHash).toBe(recovered.credentialHash);
          expect(
            db
              .prepare('SELECT material FROM pairings WHERE session=?')
              .get(original.pairingSessionId)
          ).toEqual(old);
        } finally {
          db.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(['scoped', 'legacy'] as const)(
    'takes over an unfinished generation with %s credential after custody failure without replacing originals or letting the old session publish',
    async (location) => {
      const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-generation-takeover-'));
      try {
        const fixture = await execute(setup(directory));
        const root = join(directory, 'journal');
        await fs.mkdir(root);
        const context = {
          accountId: 'account',
          machineId: 'machine',
          workspaceId: 'workspace',
          genesisHash: hex(fixture.genesis.toBytes()),
          genesisRecordHex: hex(fixture.genesisRecord),
          membershipId: '0a'.repeat(16),
          frontendSigningPublicKey: fixture.sender,
        };
        let fail = false;
        let original: { signingPublicKey: string; credentialHash: string } | undefined;
        const custody = makeCliE2eeCustody({
          directory: join(root, 'custody'),
          keyring: noKeyring,
        }).pipe(
          Effect.map((owner) => ({
            ...owner,
            prepareDeviceCredential: (genesis, key) =>
              owner.prepareDeviceCredential(genesis, key).pipe(
                Effect.flatMap((credential) => {
                  if (fail) {
                    fail = false;
                    original = {
                      signingPublicKey: hex(key.toBytes()),
                      credentialHash: credential.credentialHash,
                    };
                    return Effect.fail(new Error('synthetic custody result lost'));
                  }
                  return Effect.succeed(credential);
                })
              ),
          }))
        );
        const prepare = (session: string) =>
          execute(
            Effect.gen(function* () {
              const journal = yield* openMachinePairingJournal(root);
              return yield* journal.prepare({ ...context, pairingSessionId: session }, custody);
            })
          );
        const previous = await prepare('01'.repeat(16));
        const originalDb = new DatabaseSync(join(root, 'pairings.sqlite'));
        const originalMaterial = originalDb
          .prepare('SELECT material FROM pairings WHERE session=?')
          .get(previous.pairingSessionId)?.material;
        originalDb.close();
        await rm(join(root, 'custody'), { recursive: true });
        fail = true;
        await expect(prepare('02'.repeat(16))).rejects.toThrow();
        if (!original) throw new Error('failed preparation did not retain originals');
        const devicePath = join(root, 'custody', context.genesisHash + '.machine.device');
        const scopedCredential = join(
          root,
          'custody',
          `device-credential-${context.genesisHash}-${original.signingPublicKey}.sealed`
        );
        const credentialPath =
          location === 'legacy'
            ? join(root, 'custody', `device-credential-${context.genesisHash}.sealed`)
            : scopedCredential;
        if (location === 'legacy') await fs.rename(scopedCredential, credentialPath);
        const protectedCredential = await readFile(credentialPath);
        await fs.rename(devicePath, devicePath + '.retained');
        await expect(prepare('03'.repeat(16))).rejects.toMatchObject({ code: 'conflict' });
        await expect(readFile(devicePath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(credentialPath)).toEqual(protectedCredential);
        await fs.rename(devicePath + '.retained', devicePath);
        const recovered = await prepare('03'.repeat(16));
        expect(recovered).toMatchObject(original);
        expect(recovered.signingPublicKey).not.toBe(previous.signingPublicKey);
        await expect(prepare('02'.repeat(16))).rejects.toThrow();
        expect(await prepare('03'.repeat(16))).toEqual(recovered);
        const db = new DatabaseSync(join(root, 'pairings.sqlite'));
        try {
          expect(
            db.prepare('SELECT material FROM pairings WHERE session=?').get('02'.repeat(16))
              ?.material
          ).toBeNull();
          expect(
            db
              .prepare('SELECT material FROM pairings WHERE session=?')
              .get(previous.pairingSessionId)?.material
          ).toBe(originalMaterial);
          expect(
            db.prepare('SELECT session FROM current_identity WHERE singleton=1').get()?.session
          ).toBe(recovered.pairingSessionId);
        } finally {
          db.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('allows a first generation to recover in another session after custody acquisition fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-first-takeover-'));
    try {
      const fixture = await execute(setup(directory));
      const root = join(directory, 'journal');
      await fs.mkdir(root);
      const context = {
        accountId: 'account',
        machineId: 'machine',
        workspaceId: 'workspace',
        genesisHash: hex(fixture.genesis.toBytes()),
        genesisRecordHex: hex(fixture.genesisRecord),
        membershipId: '0a'.repeat(16),
        frontendSigningPublicKey: fixture.sender,
      };
      const rejected = new Error('synthetic custody unavailable');
      const prepare = (session: string, fail = false) =>
        execute(
          Effect.gen(function* () {
            const journal = yield* openMachinePairingJournal(root);
            return yield* journal.prepare(
              { ...context, pairingSessionId: session },
              fail
                ? Effect.fail(rejected)
                : makeCliE2eeCustody({ directory: join(root, 'custody'), keyring: noKeyring })
            );
          })
        );
      await expect(prepare('01'.repeat(16), true)).rejects.toBe(rejected);
      const recovered = await prepare('02'.repeat(16));
      expect(await prepare('02'.repeat(16))).toEqual(recovered);
      await expect(prepare('01'.repeat(16))).rejects.toThrow();
      const db = new DatabaseSync(join(root, 'pairings.sqlite'));
      try {
        expect(
          db.prepare('SELECT creating,material FROM pairings WHERE session=?').get('01'.repeat(16))
        ).toMatchObject({ creating: -1, material: null });
      } finally {
        db.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not take an unfinished generation across its account, workspace, machine, genesis or member scope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-takeover-scope-'));
    try {
      const fixture = await execute(setup(directory));
      const root = join(directory, 'journal');
      await fs.mkdir(root);
      const context = {
        accountId: 'account',
        machineId: 'machine',
        workspaceId: 'workspace',
        genesisHash: hex(fixture.genesis.toBytes()),
        genesisRecordHex: hex(fixture.genesisRecord),
        membershipId: '0a'.repeat(16),
        frontendSigningPublicKey: fixture.sender,
        pairingSessionId: '01'.repeat(16),
      };
      await expect(
        execute(
          Effect.gen(function* () {
            const journal = yield* openMachinePairingJournal(root);
            return yield* journal.prepare(
              context,
              Effect.fail(new Error('synthetic custody failure'))
            );
          })
        )
      ).rejects.toThrow();
      for (const change of [
        { accountId: 'other-account' },
        { workspaceId: 'other-workspace' },
        { machineId: 'other-machine' },
        { genesisHash: 'ab'.repeat(32) },
        { genesisRecordHex: '00' },
        { membershipId: 'ab'.repeat(16) },
      ]) {
        await expect(
          execute(
            Effect.gen(function* () {
              const journal = yield* openMachinePairingJournal(root);
              return yield* journal.prepare(
                { ...context, ...change, pairingSessionId: '02'.repeat(16) },
                Effect.die(new Error('must not acquire custody'))
              );
            })
          )
        ).rejects.toMatchObject({ code: 'conflict' });
      }
      const interruptedDb = new DatabaseSync(join(root, 'pairings.sqlite'));
      try {
        interruptedDb.exec(
          "CREATE TRIGGER refuse_takeover BEFORE UPDATE OF creating ON pairings WHEN NEW.session='" +
            '02'.repeat(16) +
            "' BEGIN SELECT RAISE(ABORT,'synthetic takeover storage failure'); END"
        );
        await expect(
          execute(
            Effect.gen(function* () {
              const journal = yield* openMachinePairingJournal(root);
              return yield* journal.prepare(
                { ...context, pairingSessionId: '02'.repeat(16) },
                Effect.die(new Error('failed transaction cannot acquire custody'))
              );
            })
          )
        ).rejects.toMatchObject({ code: 'storage' });
        expect(
          interruptedDb
            .prepare('SELECT creating,material FROM pairings WHERE session=?')
            .get(context.pairingSessionId)
        ).toMatchObject({ creating: 1, material: null });
        expect(
          interruptedDb.prepare('SELECT context FROM pairings WHERE session=?').get('02'.repeat(16))
        ).toBeUndefined();
        interruptedDb.exec('DROP TRIGGER refuse_takeover');
      } finally {
        interruptedDb.close();
      }
      const recovered = await execute(
        Effect.gen(function* () {
          const journal = yield* openMachinePairingJournal(root);
          return yield* journal.prepare(
            { ...context, pairingSessionId: '02'.repeat(16) },
            makeCliE2eeCustody({ directory: join(root, 'custody'), keyring: noKeyring })
          );
        })
      );
      expect(recovered.pairingSessionId).toBe('02'.repeat(16));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fences an old prepare that finishes signing after another session takes its generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-late-generation-'));
    try {
      const fixture = await execute(setup(directory));
      const root = join(directory, 'journal');
      await fs.mkdir(root);
      const context = {
        accountId: 'account',
        machineId: 'machine',
        workspaceId: 'workspace',
        genesisHash: hex(fixture.genesis.toBytes()),
        genesisRecordHex: hex(fixture.genesisRecord),
        membershipId: '0a'.repeat(16),
        frontendSigningPublicKey: fixture.sender,
      };
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      await execute(
        Effect.gen(function* () {
          const journal = yield* openMachinePairingJournal(root);
          const custody = yield* makeCliE2eeCustody({
            directory: join(root, 'custody'),
            keyring: noKeyring,
          });
          let blocked = false;
          const acquire = Effect.succeed({
            ...custody,
            createDevice: (genesis: Parameters<typeof custody.createDevice>[0]) =>
              custody.createDevice(genesis).pipe(
                Effect.map((device) => ({
                  ...device,
                  sign: (bytes: Uint8Array) => {
                    if (blocked) return device.sign(bytes);
                    blocked = true;
                    return Effect.promise(() => {
                      entered.resolve();
                      return release.promise;
                    }).pipe(Effect.andThen(device.sign(bytes)));
                  },
                }))
              ),
          });
          const old = yield* Effect.forkChild(
            Effect.result(
              journal.prepare({ ...context, pairingSessionId: '01'.repeat(16) }, acquire)
            )
          );
          yield* Effect.promise(() => entered.promise);
          let current;
          try {
            current = yield* journal.prepare(
              { ...context, pairingSessionId: '02'.repeat(16) },
              acquire
            );
          } finally {
            release.resolve();
          }
          const late = yield* Fiber.join(old);
          expect(late).toMatchObject({ _tag: 'Failure', failure: { code: 'conflict' } });
          expect((yield* journal.retained('02'.repeat(16))).material).toEqual(current);
          expect((yield* Effect.result(journal.retained('01'.repeat(16))))._tag).toBe('Failure');
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers the same custody originals in a new process session after the generating process exits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-generation-crash-'));
    try {
      const fixture = await execute(setup(directory));
      const root = join(directory, 'journal');
      await fs.mkdir(root);
      const context = {
        accountId: 'account',
        machineId: 'machine',
        workspaceId: 'workspace',
        genesisHash: hex(fixture.genesis.toBytes()),
        genesisRecordHex: hex(fixture.genesisRecord),
        membershipId: '0a'.repeat(16),
        frontendSigningPublicKey: fixture.sender,
        pairingSessionId: '01'.repeat(16),
      };
      const script = `
        import {Effect} from 'effect';
        const {openMachinePairingJournal}=await import(process.argv[1]);
        const {makeCliE2eeCustody}=await import(process.argv[2]);
        const root=process.argv[3],context=JSON.parse(process.argv[4]);
        try { await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
          const journal=yield* openMachinePairingJournal(root);
          const custody=makeCliE2eeCustody({directory:root+'/custody',keyring:async()=>{throw new Error('synthetic absent keyring');}}).pipe(Effect.map(owner=>({...owner,prepareDeviceCredential:(genesis,key)=>owner.prepareDeviceCredential(genesis,key).pipe(Effect.tap(credential=>Effect.sync(()=>{
            process.send({signingPublicKey:Buffer.from(key.toBytes()).toString('hex'),credentialHash:credential.credentialHash});
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
            throw new Error('crash fixture unexpectedly resumed');
          })))})));
          yield* journal.prepare(context,custody);
        }))); }catch(error){process.send({failure:String(error.stack??error)});process.exitCode=1;}
      `;
      const phase = Promise.withResolvers<{ signingPublicKey: string; credentialHash: string }>();
      const deadline = AbortSignal.timeout(15_000);
      const abort = () =>
        phase.reject(new Error('generating child did not retain custody originals'));
      deadline.addEventListener('abort', abort, { once: true });
      const child = startProcessLegacy({
        command: process.execPath,
        args: [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          script,
          fileURLToPath(new URL('../src/lib/e2ee/pairing-journal.ts', import.meta.url)),
          fileURLToPath(new URL('../src/lib/e2ee/custody.ts', import.meta.url)),
          root,
          JSON.stringify(context),
        ],
        options: { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
        processGroup: true,
        onSpawned: (process) => {
          let stderr = '';
          process.stderr?.on('data', (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-8192);
          });
          process.once('error', phase.reject);
          process.once('exit', (code, signal) =>
            phase.reject(
              new Error(
                'child exited before retained originals: ' + code + '/' + signal + ': ' + stderr
              )
            )
          );
          process.on('message', (message: unknown) => {
            const value = message as { signingPublicKey?: string; credentialHash?: string };
            if (
              typeof value.signingPublicKey === 'string' &&
              typeof value.credentialHash === 'string'
            )
              phase.resolve({
                signingPublicKey: value.signingPublicKey,
                credentialHash: value.credentialHash,
              });
            else phase.reject(new Error('generation fixture failed: ' + JSON.stringify(message)));
          });
        },
      });
      const retained = await (async () => {
        try {
          const original = await phase.promise;
          await expect(execute(openMachinePairingJournal(root))).rejects.toMatchObject({
            code: 'storage',
            cause: { errcode: 5 },
          });
          const device = await readFile(
            join(root, 'custody', context.genesisHash + '.machine.device')
          );
          const credential = await readFile(
            join(
              root,
              'custody',
              'device-credential-' +
                context.genesisHash +
                '-' +
                original.signingPublicKey +
                '.sealed'
            )
          );
          return { original, device, credential };
        } finally {
          deadline.removeEventListener('abort', abort);
          await child.terminate({ graceMs: 0, killWaitMs: 5000 });
        }
      })();
      const exit = await child.exited;
      if (process.platform === 'win32') expect(exit.code).not.toBeNull();
      else expect(['SIGTERM', 'SIGKILL']).toContain(exit.signal);
      const recovered = await execute(
        Effect.gen(function* () {
          const journal = yield* openMachinePairingJournal(root);
          return yield* journal.prepare(
            { ...context, pairingSessionId: '02'.repeat(16) },
            makeCliE2eeCustody({ directory: join(root, 'custody'), keyring: noKeyring })
          );
        })
      );
      expect(recovered).toMatchObject(retained.original);
      expect(
        await readFile(join(root, 'custody', context.genesisHash + '.machine.device'))
      ).toEqual(retained.device);
      expect(
        await readFile(
          join(
            root,
            'custody',
            'device-credential-' +
              context.genesisHash +
              '-' +
              retained.original.signingPublicKey +
              '.sealed'
          )
        )
      ).toEqual(retained.credential);
      await expect(
        execute(
          Effect.gen(function* () {
            const journal = yield* openMachinePairingJournal(root);
            return yield* journal.prepare(
              context,
              Effect.die(new Error('retired session cannot acquire custody'))
            );
          })
        )
      ).rejects.toMatchObject({ code: 'superseded' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lets a superseded unsigned desktop retry after another same-member frontend only prepares', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-superseded-desktop-'));
    vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
    const databases: DatabaseSync[] = [];
    try {
      await execute(
        Effect.gen(function* () {
          const fixture = yield* setup(directory);
          const ownerCustody = yield* makeNodeE2eeCustody({
            directory: join(directory, 'owner'),
            wrapper,
          });
          const owner = yield* ownerCustody.openDevice(fixture.genesis);
          const secondCustody = yield* makeNodeE2eeCustody({
            directory: join(directory, 'second'),
            wrapper,
          });
          const second = yield* secondCustody.createDevice(fixture.genesis);
          const membershipId = Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10)));
          let view = Result.getOrThrow(
            verifyLedger({
              anchor: fixture.genesis,
              records: fixture.records,
              checkpoint: { length: 2, head: hashRecordBytes(fixture.record) },
            })
          );
          const admission = yield* prepareDeviceAdmission({
            genesis: fixture.genesis,
            membershipId,
            signer: second,
            encryptionPublicKey: second.enc,
            kind: 'personal',
          });
          const admitted = yield* signLedgerRecord(
            Result.getOrThrow(prepareLedgerCommand(view, owner.publicKey, admission)),
            owner
          );
          view = Result.getOrThrow(
            extendLedger(view, [admitted], { length: 3, head: hashRecordBytes(admitted) })
          );
          const desktop = (name: string, signer: typeof owner) => {
            const db = new DatabaseSync(join(directory, name + '.sqlite'));
            databases.push(db);
            db.exec('CREATE TABLE records(position INTEGER PRIMARY KEY,record BLOB NOT NULL)');
            for (const [position, record] of [...fixture.records, admitted].entries())
              db.prepare('INSERT INTO records VALUES(?,?)').run(position, record);
            return {
              db,
              pair: makeDesktopLocalPairing({
                db,
                workspaceId: 'workspace',
                genesis: fixture.genesis,
                genesisRecord: fixture.genesisRecord,
                signer,
                current: () => Effect.succeed(view),
              }),
            };
          };
          const a = desktop('a', owner),
            b = desktop('b', second);
          const first = yield* a.pair.context();
          const accountId = 'account';
          const root = join(
            getLodyDataDir(),
            'e2ee',
            createHash('sha256').update(accountId).digest('hex'),
            'workspace'
          );
          yield* Effect.promise(() => fs.mkdir(root, { recursive: true, mode: 0o700 }));
          const acquire = makeCliE2eeCustody({
            directory: join(root, 'custody'),
            keyring: noKeyring,
          });
          const outage = new Error('synthetic result lost after retained credential');
          const lost = acquire.pipe(
            Effect.map((custody) => ({
              ...custody,
              prepareDeviceCredential: (
                genesis: Parameters<typeof custody.prepareDeviceCredential>[0],
                key: Parameters<typeof custody.prepareDeviceCredential>[1]
              ) =>
                custody
                  .prepareDeviceCredential(genesis, key)
                  .pipe(Effect.flatMap(() => Effect.fail(outage))),
            }))
          );
          const firstResult = yield* Effect.result(
            Effect.scoped(
              Effect.gen(function* () {
                const journal = yield* openMachinePairingJournal(root);
                return yield* journal.prepare({ accountId, machineId: 'machine', ...first }, lost);
              })
            )
          );
          expect(firstResult).toMatchObject({ _tag: 'Failure', failure: outage });
          // Generic failure alone leaves A's original empty session untouched.
          expect((yield* a.pair.context()).pairingSessionId).toBe(first.pairingSessionId);
          const next = yield* b.pair.context();
          const call = (context: typeof first) =>
            Effect.tryPromise(() =>
              prepareCliE2eeMachineLegacy({
                ...context,
                accountId,
                machineId: 'machine',
                keyring: noKeyring,
              })
            );
          const material = yield* call(next);
          if ('superseded' in material) throw new Error('successor was not prepared');
          expect(
            (yield* Effect.result(
              call({ ...first, frontendSigningPublicKey: hex(second.publicKey.toBytes()) })
            ))._tag
          ).toBe('Failure');
          const receipt = yield* call(first);
          expect(receipt).toEqual({ superseded: true, pairingSessionId: first.pairingSessionId });
          // A failed archive transaction retains the receipt's original session and retries safely.
          a.db.exec(
            "CREATE TRIGGER fail_retirement BEFORE INSERT ON retired_local_pairings BEGIN SELECT RAISE(ABORT,'synthetic retirement failure'); END"
          );
          expect((yield* Effect.result(a.pair.retireSuperseded(first.pairingSessionId)))._tag).toBe(
            'Failure'
          );
          expect((yield* a.pair.context()).pairingSessionId).toBe(first.pairingSessionId);
          a.db.exec('DROP TRIGGER fail_retirement');
          yield* a.pair.retireSuperseded(first.pairingSessionId);
          expect(a.db.prepare('SELECT session FROM retired_local_pairings').get()?.session).toBe(
            first.pairingSessionId
          );
          const fresh = yield* a.pair.context();
          expect(fresh.pairingSessionId).not.toBe(first.pairingSessionId);
          const recovered = yield* call(fresh);
          expect(recovered).toMatchObject({
            signingPublicKey: material.signingPublicKey,
            credentialHash: material.credentialHash,
          });
          if ('superseded' in recovered) throw new Error('fresh session was not prepared');
          yield* a.pair.stage({ ok: true, type: 'prepare', machineId: 'machine', ...recovered });
          expect((yield* Effect.result(a.pair.retireSuperseded(fresh.pairingSessionId)))._tag).toBe(
            'Failure'
          );
          yield* a.pair.approve(fresh.pairingSessionId);
          expect((yield* Effect.result(a.pair.retireSuperseded(fresh.pairingSessionId)))._tag).toBe(
            'Failure'
          );
          expect((yield* Effect.result(a.pair.retireSuperseded(first.pairingSessionId)))._tag).toBe(
            'Failure'
          );
          expect(yield* call(first)).toEqual(receipt);
          expect((yield* a.pair.context()).pairingSessionId).toBe(fresh.pairingSessionId);
        })
      );
    } finally {
      for (const db of databases) db.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('publishes the current identity independently of earlier session insertion order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-current-identity-'));
    try {
      const fixture = await execute(setup(directory));
      const root = join(directory, 'journal');
      await fs.mkdir(root);
      const context = {
        accountId: 'account',
        machineId: 'machine',
        workspaceId: 'workspace',
        genesisHash: hex(fixture.genesis.toBytes()),
        genesisRecordHex: hex(fixture.genesisRecord),
        membershipId: '0a'.repeat(16),
        frontendSigningPublicKey: fixture.sender,
      };
      const prepare = (session: string) =>
        execute(
          Effect.gen(function* () {
            const journal = yield* openMachinePairingJournal(root);
            return yield* journal.prepare(
              { ...context, pairingSessionId: session },
              makeCliE2eeCustody({ directory: join(root, 'custody'), keyring: noKeyring })
            );
          })
        );
      // A publishes custody but fails material publication. Rejected B therefore
      // already exists before the later successfully completed session C.
      await execute(openMachinePairingJournal(root));
      const db = new DatabaseSync(join(root, 'pairings.sqlite'));
      try {
        db.exec(
          "CREATE TRIGGER fail_first_material BEFORE UPDATE OF material ON pairings BEGIN SELECT RAISE(ABORT,'synthetic material failure'); END"
        );
        await expect(prepare('01'.repeat(16))).rejects.toThrow();
        // An unstarted row from an interrupted earlier call predates C; its
        // insertion order cannot identify the current published generation.
        const prior = db
          .prepare('SELECT context FROM pairings WHERE session=?')
          .get('01'.repeat(16));
        const b = { pairingSessionId: '02'.repeat(16) };
        db.prepare('INSERT INTO pairings(session,context) VALUES(?,?)').run(
          b.pairingSessionId,
          JSON.stringify({ ...JSON.parse(String(prior?.context)), ...b })
        );
        db.exec('DROP TRIGGER fail_first_material');
        const current = await prepare('03'.repeat(16));
        await rm(join(root, 'custody'), { recursive: true });
        db.exec(
          "CREATE TRIGGER failed_pointer_publication BEFORE UPDATE OF session ON current_identity BEGIN SELECT RAISE(ABORT,'synthetic pointer failure'); END"
        );
        await expect(prepare(b.pairingSessionId)).rejects.toThrow();
        expect(
          db.prepare('SELECT material FROM pairings WHERE session=?').get(b.pairingSessionId)
            ?.material
        ).toBeNull();
        expect(
          db.prepare('SELECT session FROM current_identity WHERE singleton=1').get()?.session
        ).toBe(current.pairingSessionId);
        db.exec('DROP TRIGGER failed_pointer_publication');
        const replacement = await prepare(b.pairingSessionId);
        expect(replacement.signingPublicKey).not.toBe(current.signingPublicKey);
        expect(await prepare(b.pairingSessionId)).toEqual(replacement);
        const following = await prepare('04'.repeat(16));
        expect(following.signingPublicKey).toBe(replacement.signingPublicKey);
        expect(following.credentialHash).toBe(replacement.credentialHash);
        await expect(prepare('01'.repeat(16))).rejects.toThrow();
        expect(await prepare('04'.repeat(16))).toEqual(following);
      } finally {
        db.close();
      }
    } finally {
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
          })
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('installs a committed staged epoch on a machine after the publisher scope is gone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-staged-epoch-'));
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
              yield* runtime.ingest(page(records, fixture.records.length));
            }
            expect((yield* runtime.status()).hasCurrentKey).toBe(false);
            const retainedStatus = yield* runtime.status();
            expect(retainedStatus.writeEpoch, JSON.stringify({ reopened, ...retainedStatus })).toBe(
              0
            );
            const old = yield* runtime.binding('doc:after-rotation', 'loro', 0);
            const retained = yield* old.seal({
              context: {
                protocol: 'loro-streams-crdt-payload-protection',
                version: 2,
                kind: 'update_batch',
              },
              plaintext: new Uint8Array([1, 2]),
              additionalData: () => new Uint8Array([3]),
            });
            expect(retained.sealed.length).toBeGreaterThan(2);
            if (!reopened) return;
            yield* runtime.receiveKeys();
            expect((yield* runtime.status()).hasCurrentKey).toBe(true);
            const binding = yield* runtime.binding('doc:after-rotation', 'loro', 1);
            const sealed = yield* binding.seal({
              context: {
                protocol: 'loro-streams-crdt-payload-protection',
                version: 2,
                kind: 'update_batch',
              },
              plaintext: new Uint8Array([1, 2]),
              additionalData: () => new Uint8Array([3]),
            });
            expect(sealed.sealed.length).toBeGreaterThan(2);
          })
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
