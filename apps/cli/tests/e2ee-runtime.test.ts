import { authorizeEncryptedSchedule } from '../src/lib/e2ee/schedule-execution-authorization';
import {
  scheduleDefinitionFingerprint,
  recordScheduleAuthorization,
  manualScheduleRunKey,
  type ScheduleAuthorizationRequest,
} from '@lody/shared';
import {
  ScheduleRepository,
  getScheduleRoomId,
  getScheduleRegistryFlockDocId,
  type WorkspaceId,
  type ScheduleDocument,
} from '@lody/shared';
import { ScheduleEngine, type ScheduleEnginePorts } from '../src/lib/schedules/schedule-engine';
import { ScheduleStore } from '../src/lib/schedules/schedule-store';
import { LoroRepo } from 'loro-repo';
import { SessionDocument, type LoroDocumentManager } from '../src/lib/loro/doc';
import { prepareSessionInput, resolveTurnDispatchConfig } from '../src/commands/session';
import {
  materializePreparedSessionInput,
  commitPreparedSessionDispatch,
} from '../src/lib/prepared-session-input';
import {
  buildScheduleRunTarget,
  buildScheduleSessionCreateOptions,
  withScheduledMessageInput,
} from '../src/lib/schedules/schedule-run-preparation';
import {
  getSessionRoomId,
  type SessionId,
  type MachineMeta,
  type AgentConfigMeta,
} from '@lody/shared';
import type { AuthContext } from '../src/lib/command-runtime';
import type { WorkspaceSummary } from '../src/lib/workspace';
import { makeE2eeRpcNative, E2eeRpcOriginals } from '@lody/loro-streams-rpc/e2ee-native';
import { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { makeExecutionOriginRecovery } from '../src/lib/e2ee/execution-origin-recovery';
import { ExecutionOrigins } from '../src/lib/e2ee/execution-origins';
import { makeEncryptedAgentExecution, lazyExecutionJournal } from '../src/lib/e2ee/agent-execution';
import {
  createCliSqliteRepoStore,
  type CliSqliteRepoStore,
} from '../src/lib/loro/sqlite-repo-store';
import { CloudE2eeMemberRemoved } from '../src/lib/cloud-e2ee-errors';
import { randomUUID } from 'node:crypto';
import { resetCliE2eeIdentity } from '../src/lib/e2ee/reset-identity';
import { leaseE2eeIdentity } from '@lody/shared/node/e2ee-identity';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  Context,
  Clock,
  Effect,
  Fiber,
  Layer,
  Result,
  Scope as TokenScope,
  Exit as TokenExit,
} from 'effect';
import { LoroDoc, LoroMap } from 'loro-crdt';
import { z } from 'zod';
import { createCloudE2eePort } from '../src/lib/cloud-cli-port';
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
import { it as effectIt } from '@effect/vitest';
import { TestClock } from 'effect/testing';
import {
  Bytes,
  inspectContentFrame,
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
  sealRpcRequestContent,
} from '@lody/e2ee-core/protocol';
import { encodeE2eeRpcRequestBody } from '../../../packages/loro-streams-rpc/src/e2ee-wire';
import { e2eeRpcResource } from '@lody/loro-streams-rpc/e2ee-resource';
import * as rpcLedgerCatchUp from '../src/lib/e2ee/rpc-ledger-catch-up';
import { makeNodeE2eeCustody, type KekWrapper } from '@lody/e2ee-core/adapters/node-custody';
import { makeCliE2eeCustody } from '../src/lib/e2ee/custody';
import { makeCliE2eeRuntime } from '../src/lib/e2ee/runtime';
import { makeCliE2eeExecutionAuthorization } from '../src/lib/e2ee/execution-authorization';
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
  publishRotation = false,
  includeGuestMachine = false
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
    let guestMachine:
      | { device: typeof machine; custody: typeof machineCustody; requester: string }
      | undefined;
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
      if (includeGuestMachine) {
        const guestCustody = yield* makeCliE2eeCustody({
          directory: join(directory, 'guest-machine'),
          keyring: noKeyring,
        });
        const guestDevice = yield* guestCustody.createDevice(signed.genesis);
        const command = yield* prepareDeviceAdmission({
          genesis: signed.genesis,
          membershipId: member,
          signer: guestDevice,
          encryptionPublicKey: guestDevice.enc,
          kind: 'machine',
          machineId: 'guest-machine',
        });
        const admitted = yield* signLedgerRecord(
          Result.getOrThrow(prepareLedgerCommand(current, joining.publicKey, command)),
          joining
        );
        records.push(admitted);
        current = Result.getOrThrow(
          extendLedger(current, [admitted], {
            length: records.length,
            head: hashRecordBytes(admitted),
          })
        );
        const demoted = yield* signLedgerRecord(
          Result.getOrThrow(
            prepareLedgerCommand(current, owner.publicKey, {
              _tag: 'SetRole',
              membershipId: member,
              role: 'guest',
            })
          ),
          owner
        );
        records.push(demoted);
        current = Result.getOrThrow(
          extendLedger(current, [demoted], {
            length: records.length,
            head: hashRecordBytes(demoted),
          })
        );
        guestMachine = {
          device: guestDevice,
          custody: guestCustody,
          requester: hex(joining.publicKey.toBytes()),
        };
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
      guestMachine,
      owner,
      current,
      membershipId,
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
  it.each(['cold-ledger', 'fresh-ledger', 'joined-refresh'] as const)(
    'receives the current RPC key through the real workspace with %s',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-rpc-key-catch-up-'));
      vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
      vi.stubEnv('LODY_HTTP_TRANSPORT', 'default');
      let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
      let oldRefresh: Promise<void> | undefined;
      const receiveEntered = Promise.withResolvers<void>();
      const releaseReceive = Promise.withResolvers<void>();
      const joinedRefresh = Promise.withResolvers<void>();
      let holdReceive = false;
      let advanceDuringJoin: (() => Promise<void>) | undefined;
      const originalCatchUp = rpcLedgerCatchUp.makeLedgerCatchUp;
      const catchUpSpy =
        mode === 'joined-refresh'
          ? vi.spyOn(rpcLedgerCatchUp, 'makeLedgerCatchUp').mockImplementation((options) =>
              originalCatchUp({
                ...options,
                catchUp: async () => {
                  const result = options.catchUp();
                  await advanceDuringJoin?.();
                  joinedRefresh.resolve();
                  return await result;
                },
              })
            )
          : undefined;
      const doc = new LoroDoc();
      try {
        const accountId = 'synthetic-rpc-key-account';
        const root = join(
          getLodyDataDir(),
          'e2ee',
          createHash('sha256').update(accountId).digest('hex'),
          'workspace'
        );
        const fixture = await execute(setup(directory, 2, join(root, 'custody'), true, true));
        const stagedGroup = fixture.stagedGroup;
        if (!stagedGroup) throw new Error('missing synthetic epoch publication');
        await retainCliE2eeWorkspaceBinding(accountId, {
          workspaceId: 'workspace',
          genesisHash: hex(fixture.genesis.toBytes()),
          genesisRecordHex: hex(fixture.genesisRecord),
        });
        const devicePublicKey = await execute(
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
          JSON.stringify({
            genesisHash: hex(fixture.genesis.toBytes()),
            signingPublicKey: devicePublicKey,
          })
        );
        let history = page(fixture.records);
        // The hosted readGroup boundary accepts precisely these four fields.
        // Use the real HTTP adapter: the native locator also carries a local
        // signer, which must not leak into this strict wire object.
        const stagingKey = z.strictObject({
          genesis: z.string(),
          epoch: z.number(),
          commitment: z.string(),
          recordHash: z.string(),
        });
        vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
          const request = JSON.parse(init.body as string);
          expect(request.path).toBe('e2eeEpochStaging:readGroup');
          const parsed = stagingKey.safeParse(request.args[0].key);
          return Response.json(
            parsed.success
              ? { status: 'success', value: encodeEpochStagedGroup(stagedGroup) }
              : {
                  status: 'error',
                  errorMessage: 'ArgumentValidationError: extra staging key field',
                }
          );
        });
        const stagingPort = createCloudE2eePort({
          authBaseUrl: 'https://synthetic-staging.convex.cloud',
        });
        const cloud = {
          getHistory: async () => history,
          readEpochGroup: stagingPort.readEpochGroup,
          mailboxCall: async (
            method: keyof E2eeMailboxRequests,
            input: E2eeMailboxRequests[keyof E2eeMailboxRequests]
          ) => {
            if (method === 'fetch') {
              if (holdReceive) {
                holdReceive = false;
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
        const active = host;
        await host.refresh();
        expect(await host.status()).toMatchObject({ epoch: 0, hasCurrentKey: true });
        if (mode === 'joined-refresh') {
          holdReceive = true;
          oldRefresh = host.refresh();
          await receiveEntered.promise;
        }
        history = page([...fixture.records, ...fixture.rotationSuffix]);
        const advanceLedger = async () => {
          expect(
            await Effect.runPromise(active.authorizeExecution('workspace', fixture.sender))
          ).toMatchObject({ _tag: 'Authorized' });
          expect(await active.status()).toMatchObject({
            epoch: 1,
            writeEpoch: 0,
            hasCurrentKey: false,
          });
        };
        if (mode === 'fresh-ledger') await advanceLedger();
        if (mode === 'joined-refresh') advanceDuringJoin = advanceLedger;
        const input = {
          sessionId: 'synthetic-session',
          userTurnId: 'synthetic-turn-23',
          userId: 'display-only',
          timestamp: new Date(1000).toISOString(),
          inputConfig: { prompt: 'SYNTHETIC_AFTER_ROTATION' },
        };
        const frame = await execute(
          Effect.gen(function* () {
            const custody = yield* makeNodeE2eeCustody({
              directory: join(directory, 'owner'),
              wrapper,
            });
            const signer = yield* custody.openDevice(fixture.genesis);
            return yield* sealRpcRequestContent({
              scope: {
                genesis: hex(fixture.genesis.toBytes()),
                resource: e2eeRpcResource('machine'),
                epoch: 1,
              },
              epochKey: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(72))),
              signer,
              plaintext: encodeE2eeRpcRequestBody({
                requestId: new Uint8Array(16).fill(23),
                expiresAt: 901000,
                method: 'session/dispatch-turn',
                params: new TextEncoder().encode(JSON.stringify(input)),
              }),
            });
          })
        );
        doc.getMap('rpcDispatchOriginals').set(input.userTurnId, hex(frame));
        doc.commit();
        const original = Effect.runPromise(
          host.resolveVerifiedExecutionOriginal(
            {
              workspaceId: 'workspace',
              sessionId: input.sessionId,
              userTurnId: input.userTurnId,
              inputConfig: input.inputConfig,
            },
            doc
          )
        );
        if (mode === 'joined-refresh') {
          await joinedRefresh.promise;
          releaseReceive.resolve();
        }
        expect(await original).toMatchObject({
          requesterDevice: fixture.sender,
          expiresAt: 901000,
        });
        expect(await host.status()).toMatchObject({ epoch: 1, writeEpoch: 1, hasCurrentKey: true });
      } finally {
        releaseReceive.resolve();
        await oldRefresh;
        await host?.close();
        catchUpSpy?.mockRestore();
        doc.free();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  effectIt.effect('bounds missing-origin reads, aborts their I/O and allows another attempt', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), 'origin-read-timeout-'))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
        );
        const entered = Promise.withResolvers<void>();
        let aborted = false;
        let stalled = true;
        let retried = false;
        const origins = new ExecutionOrigins(join(directory, 'origins.sqlite'));
        const recovery = makeExecutionOriginRecovery(
          origins,
          async (_input, signal) => {
            if (!stalled) {
              retried = true;
              return { messages: [], before: '0', atStart: true };
            }
            entered.resolve();
            return await new Promise((_, reject) =>
              signal.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  reject(new Error('aborted'));
                },
                { once: true }
              )
            );
          },
          { workspaceId: 'workspace', credential: 'synthetic-device-credential' },
          `lody-e2ee:${'ab'.repeat(32)}`
        );
        const request = yield* Effect.forkChild(
          recovery.recover('session-session', { peer: '1', counter: 0 }, () =>
            Effect.die('no frame')
          )
        );
        yield* Effect.promise(() => entered.promise);
        yield* TestClock.adjust(3000);
        yield* Fiber.join(request);
        expect(aborted).toBe(true);
        stalled = false;
        yield* recovery.recover('session-session', { peer: '1', counter: 0 }, () =>
          Effect.die('no frame')
        );
        expect(retried).toBe(true);
      })
    )
  );

  it('binds signed history to its device and ledger actor, independently of display account IDs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-turn-origins-'));
    const source = new LoroDoc();
    const replica = new LoroDoc();
    const user = '1e'.repeat(32);
    const displayAccountId = 'another-display-account';
    const originalsFile = join(directory, 'origins.sqlite');
    const origins = new ExecutionOrigins(originalsFile);
    const resource = 'doc:session-session';
    const wrapUpdate = (update: Uint8Array) => {
      const batch = new Uint8Array(update.length + 4);
      new DataView(batch.buffer).setUint32(0, update.length, false);
      batch.set(update, 4);
      return batch;
    };
    try {
      await execute(
        Effect.gen(function* () {
          const custody = yield* makeNodeE2eeCustody({
            directory: join(directory, 'custody'),
            wrapper,
          });
          const prepared = yield* custody.prepareDevice();
          const membershipId = Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10)));
          const signed = yield* signGenesisRecord({
            signer: prepared,
            encryptionPublicKey: prepared.enc,
            initialKey: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(20))),
            userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(30))),
            membershipId,
          });
          const owner = yield* custody.retainDevice(signed.genesis, prepared);
          const other = yield* custody.prepareDevice();
          let view = Result.getOrThrow(
            verifyLedger({
              anchor: signed.genesis,
              records: [signed.record],
              checkpoint: { length: 1, head: hashRecordBytes(signed.record) },
            })
          );
          const admitted = yield* prepareDeviceAdmission({
            genesis: signed.genesis,
            membershipId,
            signer: other,
            encryptionPublicKey: other.enc,
            kind: 'personal',
          });
          const addition = yield* signLedgerRecord(
            Result.getOrThrow(prepareLedgerCommand(view, owner.publicKey, admitted)),
            owner
          );
          view = Result.getOrThrow(
            extendLedger(view, [addition], { length: 2, head: hashRecordBytes(addition) })
          );
          const forSigner = (signer: typeof owner | typeof other) =>
            makeStreamsUpdateBinding({
              genesis: signed.genesis,
              resource,
              model: 'loro',
              writeEpoch: 'current',
              signer,
              ledger: () => Effect.succeed(view),
              readEpochKey: () => Effect.fromResult(Bytes.epochKey(new Uint8Array(32).fill(20))),
            });
          const ownerBinding = yield* forSigner(owner);
          const otherBinding = yield* forSigner(other);
          const addTurn = (
            id: string,
            userId: string,
            peer: string,
            binding: typeof ownerBinding
          ) =>
            Effect.gen(function* () {
              source.setPeerId(peer as `${number}`);
              const from = source.version();
              const row = source
                .getList('history')
                .insertContainer(source.getList('history').length, new LoroMap());
              row.set('id', id);
              row.set('role', 'user');
              row.set('userId', userId);
              row.set('timestamp', '1970-01-01T00:00:00.100Z');
              row.set('inputConfig', { prompt: id });
              row.set('items', [{ type: 'text', text: id }]);
              source.commit();
              const update = source.export({ mode: 'update', from });
              const context = {
                protocol: 'loro-streams-crdt-payload-protection',
                version: 2,
                kind: 'update_batch',
              } as const;
              const sealed = yield* binding.seal({
                context,
                plaintext: wrapUpdate(update),
                additionalData: (header) => Uint8Array.from([...header, 9]),
              });
              const request = {
                ...sealed,
                context,
                additionalData: Uint8Array.from([...sealed.header, 9]),
              };
              const opened = yield* ownerBinding.openAuthenticated(request);
              origins.retain(resource, request, opened.plaintext);
              opened.plaintext.fill(0);
              replica.import(update);
              return { row, request };
            });
          yield* addTurn('active', user, '1', ownerBinding);
          yield* addTurn('revoked', user, '2', otherBinding);
          yield* addTurn('mismatch', displayAccountId, '1', ownerBinding);
          yield* addTurn('edited', user, '1', ownerBinding);
          const revokedKey = hex(other.publicKey.toBytes());
          const revocation = yield* signLedgerRecord(
            Result.getOrThrow(
              prepareLedgerCommand(view, owner.publicKey, {
                _tag: 'RevokeDevice',
                target: other.publicKey,
              })
            ),
            owner
          );
          view = Result.getOrThrow(
            extendLedger(view, [revocation], { length: 3, head: hashRecordBytes(revocation) })
          );
          expect(view.inspectState().members.has(hex(membershipId.toBytes()))).toBe(true);
          const forged = new LoroDoc();
          try {
            forged.setPeerId('2');
            const row = forged.getList('history').insertContainer(0, new LoroMap());
            row.set('id', 'different-turn');
            row.set('role', 'user');
            row.set('userId', user);
            row.set('timestamp', '1970-01-01T00:00:00.100Z');
            row.set('inputConfig', { prompt: 'different-turn' });
            row.set('items', [{ type: 'text', text: 'different-turn' }]);
            forged.commit();
            const context = {
              protocol: 'loro-streams-crdt-payload-protection',
              version: 2,
              kind: 'update_batch',
            } as const;
            const frame = yield* ownerBinding.seal({
              context,
              plaintext: wrapUpdate(forged.export({ mode: 'update' })),
              additionalData: (header) => Uint8Array.from([...header, 9]),
            });
            const request = {
              ...frame,
              context,
              additionalData: Uint8Array.from([...frame.header, 9]),
            };
            const verified = yield* ownerBinding.openAuthenticated(request);
            const substituted = new ExecutionOrigins(join(directory, 'substituted.sqlite'));
            substituted.retain(resource, request, verified.plaintext);
            verified.plaintext.fill(0);
            expect(
              yield* Effect.scoped(
                substituted.resolve(
                  {
                    workspaceId: 'workspace',
                    sessionId: 'session',
                    userTurnId: 'revoked',
                    requesterUserId: user,
                    inputConfig: { prompt: 'revoked' },
                  },
                  replica,
                  ownerBinding.openAuthenticated
                )
              )
            ).toBeUndefined();
          } finally {
            forged.free();
          }
          const relabeled = replica.getList('history').get(2) as LoroMap;
          relabeled.set('userId', 'updated-display-account');
          replica.commit();
          const checkedDevices: string[] = [];
          const gate = makeEncryptedAgentExecution({
            genesis: hex(signed.genesis.toBytes()),
            workspaceId: 'workspace',
            targetMachineId: 'machine',
            journal: lazyExecutionJournal(join(directory, 'execution.sqlite'), () => 100),
            resolveVerifiedOriginal: (intent) =>
              Effect.scoped(
                new ExecutionOrigins(originalsFile).resolve(
                  intent,
                  replica,
                  ownerBinding.openAuthenticated
                )
              ),
            authorizeExecution: (_workspaceId, device) =>
              Effect.sync(() => {
                checkedDevices.push(device);
                return view.inspectState().devices.has(device)
                  ? { _tag: 'Authorized' as const }
                  : { _tag: 'Denied' as const, reason: 'not-authorized' };
              }),
          });
          const intent = (userTurnId: string, requesterUserId = user) => ({
            workspaceId: 'workspace',
            sessionId: 'session',
            userTurnId,
            requesterUserId,
            inputConfig: { prompt: userTurnId },
          });
          expect((yield* gate.claim(intent('active'))).state).toBe('claimed');
          expect((yield* gate.claim(intent('revoked'))).state).toBe('denied');
          expect(checkedDevices).toEqual([hex(owner.publicKey.toBytes()), revokedKey]);
          expect(
            yield* Effect.scoped(
              origins.resolve(
                intent('mismatch', displayAccountId),
                replica,
                ownerBinding.openAuthenticated
              )
            )
          ).toMatchObject({ requesterCryptoUserId: user });
          expect((yield* gate.claim(intent('mismatch', displayAccountId))).state).toBe('claimed');
          expect(checkedDevices).toEqual([
            hex(owner.publicKey.toBytes()),
            revokedKey,
            hex(owner.publicKey.toBytes()),
          ]);
          const edited = replica.getList('history').get(3) as LoroMap;
          edited.set('inputConfig', { prompt: 'substituted' });
          replica.commit();
          expect(
            (yield* gate.claim({ ...intent('edited'), inputConfig: { prompt: 'substituted' } }))
              .state
          ).toBe('denied');
          const noOriginal = new ExecutionOrigins(join(directory, 'missing-origins.sqlite'));
          expect(
            yield* Effect.scoped(
              noOriginal.resolve(intent('active'), replica, ownerBinding.openAuthenticated)
            )
          ).toEqual({ state: 'pending-evidence', expiresAt: 900100 });
          const corrupt = { ...(yield* addTurn('bad-signature', user, '1', ownerBinding)).request };
          corrupt.sealed = Uint8Array.from(corrupt.sealed);
          corrupt.sealed[corrupt.sealed.length - 1] ^= 1;
          expect(
            Result.isFailure(yield* Effect.result(ownerBinding.openAuthenticated(corrupt)))
          ).toBe(true);
        })
      );
      expect((await readFile(originalsFile)).includes(Buffer.from('bad-signature'))).toBe(false);
    } finally {
      source.free();
      replica.free();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['signature', 'conflict', 'defect'] as const)(
    'bounds background ledger recovery after %s rejection, preserves the verified view and supports explicit retry',
    async (failure) => {
      const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-ledger-retry-'));
      vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
      try {
        const accountId = 'ledger-retry-account';
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
        const signingPublicKey = await execute(
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
          JSON.stringify({ genesisHash: hex(fixture.genesis.toBytes()), signingPublicKey })
        );
        let history = page(fixture.records);
        let reads = 0;
        let revision = 0;
        let retryFailed = () => {};
        let reportSent = () => {};
        const cloud = {
          getHistory: async () => {
            reads++;
            return history;
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
                revision,
                status: 'EnvelopeStored',
              };
            if (method === 'report') {
              reportSent();
              return null;
            }
            throw new Error('unexpected mailbox operation');
          },
        } as CloudE2eePort;
        host = await openCliE2eeWorkspaceLegacy({
          accountId,
          workspaceId: 'workspace',
          genesisHash: hex(fixture.genesis.toBytes()),
          cloud,
          keyring: noKeyring,
          onUnavailable: () => {
            queueMicrotask(() => retryFailed());
          },
        });
        await host.refresh();
        const verified = await host.status();
        if (host.content.mode !== 'protected') throw new Error('expected protected workspace');
        const protection = host.content.resolve({ kind: 'doc', docId: 'retry' });
        if (protection.mode !== 'protected') throw new Error('expected protected room');
        const input = {
          context: {
            protocol: 'loro-streams-crdt-payload-protection',
            version: 2,
            kind: 'update_batch',
          } as const,
          plaintext: new TextEncoder().encode('retained edit'),
          additionalData: () => new Uint8Array([7]),
        };
        const damaged = fixture.record.slice();
        damaged[damaged.length - 1] ^= 1;
        const rejectedHistory = () => {
          if (failure === 'signature') return page([...fixture.records, damaged], 2);
          if (failure === 'conflict') return page([fixture.genesisRecord, damaged]);
          return {
            ...page(fixture.records),
            get startIndex(): number {
              throw new Error('synthetic unclassified ingest defect');
            },
          };
        };
        history = rejectedHistory();
        await host.refresh();
        const before = reads;
        for (const [index, delay] of [250, 1_000, 4_000].entries()) {
          const failed = Promise.withResolvers<void>();
          retryFailed = failed.resolve;
          await vi.advanceTimersByTimeAsync(delay);
          expect(reads - before).toBe(index + 1);
          await failed.promise;
        }
        expect(reads - before).toBe(3);
        expect((await host.status()).headHash).toBe(verified.headHash);
        expect((await host.status()).length).toBe(verified.length);
        await expect(protection.config.provider.seal(input)).rejects.toThrow('e2ee_invalid_ledger');
        history = page(fixture.records);
        await vi.advanceTimersByTimeAsync(100_000);
        expect(reads - before).toBe(3);
        await host.refresh(); // Explicit retry resets the bounded episode.
        await expect(protection.config.provider.seal(input)).resolves.toHaveProperty('sealed');
        history = rejectedHistory();
        await host.refresh();
        history = page(fixture.records);
        revision++;
        const installed = Promise.withResolvers<void>();
        reportSent = installed.resolve;
        await vi.advanceTimersByTimeAsync(250);
        await installed.promise;
        await expect(protection.config.provider.seal(input)).resolves.toHaveProperty('sealed');
        history = page([fixture.genesisRecord, damaged]);
        await host.refresh();
        await host.close();
        const afterClose = reads;
        await vi.advanceTimersByTimeAsync(100_000);
        expect(reads).toBe(afterClose);
      } finally {
        await host?.close();
        vi.useRealTimers();
        vi.unstubAllEnvs();
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
        const snapshotInput = {
          ...input,
          context: {
            ...input.context,
            kind: 'snapshot' as const,
            continuationOffset: '00000000000000000100',
          },
        };
        expect(await host.content.snapshotUpload.canUpload()).toBe(true);
        if (rotation === 'epoch') {
          const graceSnapshot = await protection.config.provider.seal(snapshotInput);
          expect(
            Result.getOrThrow(inspectContentFrame(graceSnapshot.sealed, 'doc-snapshot')).epoch
          ).toBe(0);
          expect((await stream.appendWriteOnly()).ok).toBe(true);
          expect(frames.length).toBeGreaterThan(0);
          expect(doc.getText('draft').toString()).toBe('retained local edit');
          releaseReceive.resolve();
          await recovery;
        }
        const retainedSnapshot = await protection.config.provider.seal(snapshotInput);
        expect(
          Result.getOrThrow(inspectContentFrame(retainedSnapshot.sealed, 'doc-snapshot')).epoch
        ).toBe(rotation === 'epoch' ? 1 : 0);
        expect(
          await protection.config.provider.open({
            ...retainedSnapshot,
            context: snapshotInput.context,
            additionalData: new Uint8Array([...retainedSnapshot.header, 9]),
          })
        ).toEqual(input.plaintext);
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
                const changedSnapshot = yield* Effect.promise(() =>
                  protection.config.provider.seal(snapshotInput)
                );
                expect(
                  Result.getOrThrow(inspectContentFrame(changedSnapshot.sealed, 'doc-snapshot'))
                    .epoch
                ).toBe(1);
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
        const turnDoc = new LoroDoc();
        try {
          const turn = turnDoc.getList('history').insertContainer(0, new LoroMap());
          turn.set('id', 'original');
          turn.set('role', 'user');
          turn.set('userId', '1e'.repeat(32));
          turn.set('timestamp', '1970-01-01T00:00:00.100Z');
          turn.set('inputConfig', { prompt: 'original' });
          turn.set('items', [{ type: 'text', text: 'original' }]);
          turnDoc.commit();
          const update = turnDoc.export({ mode: 'update' });
          const plaintext = new Uint8Array(update.length + 4);
          new DataView(plaintext.buffer).setUint32(0, update.length, false);
          plaintext.set(update, 4);
          const turnProtection = host.content.resolve({ kind: 'doc', docId: 'session-origin' });
          if (turnProtection.mode !== 'protected') throw new Error('missing turn protection');
          const original = await turnProtection.config.provider.seal({ ...input, plaintext });
          await turnProtection.config.provider.open({
            ...original,
            context: input.context,
            additionalData: new Uint8Array([...original.header, 9]),
          });
          expect(
            await Effect.runPromise(
              host.resolveVerifiedExecutionOriginal(
                {
                  workspaceId: 'workspace',
                  sessionId: 'origin',
                  userTurnId: 'original',
                  requesterUserId: '1e'.repeat(32),
                  inputConfig: { prompt: 'original' },
                },
                turnDoc
              )
            )
          ).toEqual({
            requesterDevice: (await host.status()).devicePublicKey,
            requesterCryptoUserId: '1e'.repeat(32),
            expiresAt: 900100,
          });
        } finally {
          turnDoc.free();
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

  it.each([
    'credential-missing',
    'credential-corrupt',
    'device-corrupt',
    'kek-missing',
    'selector-missing',
    'journal-conflict',
  ] as const)(
    'explicit reset preserves all surviving originals and creates independent keys after %s',
    async (damage) => {
      const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-reset-'));
      vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
      try {
        const fixture = await execute(setup(directory));
        const accountId = 'reset-account',
          workspaceId = 'workspace';
        const root = join(
          getLodyDataDir(),
          'e2ee',
          createHash('sha256').update(accountId).digest('hex'),
          workspaceId
        );
        // Keep OS protection available so lost selectors cannot authorize file fallback.
        const keyringRows = new Map<string, string>();
        const keyring = async (account: string) => ({
          getPassword: async () => keyringRows.get(account),
          setPassword: async (value: string) => {
            keyringRows.set(account, value);
          },
          deleteCredential: async () => {
            keyringRows.delete(account);
          },
        });
        const input = {
          accountId,
          workspaceId,
          machineId: 'machine',
          genesisHash: hex(fixture.genesis.toBytes()),
          genesisRecordHex: hex(fixture.genesisRecord),
          membershipId: '0a'.repeat(16),
          frontendSigningPublicKey: fixture.sender,
          keyring,
        };
        const first = await prepareCliE2eeMachineLegacy({
          ...input,
          pairingSessionId: '01'.repeat(16),
        });
        if ('superseded' in first) throw new Error('unexpected superseded');
        const credentialPath = join(
          root,
          'custody',
          `device-credential-${input.genesisHash}-${first.signingPublicKey}.sealed`
        );
        if (damage === 'credential-missing') await rm(credentialPath);
        if (damage === 'credential-corrupt') await fs.writeFile(credentialPath, 'damaged');
        if (damage === 'device-corrupt')
          await fs.writeFile(
            join(root, 'custody', `${input.genesisHash}.machine.device`),
            'damaged'
          );
        if (damage === 'kek-missing') await rm(join(root, 'custody', 'kek.safe-storage'));
        if (damage === 'selector-missing') await rm(join(root, 'custody', 'protection'));
        if (damage === 'journal-conflict') {
          const db = new DatabaseSync(join(root, 'pairings.sqlite'));
          db.prepare('UPDATE pairings SET material=?').run('{}');
          db.close();
        }
        await expect(
          prepareCliE2eeMachineLegacy({ ...input, pairingSessionId: '02'.repeat(16) })
        ).rejects.toThrow();
        const snapshot = async (path: string): Promise<Record<string, string>> => {
          const result: Record<string, string> = {};
          for (const entry of await readdir(path, { withFileTypes: true })) {
            if (entry.isDirectory())
              for (const [key, value] of Object.entries(await snapshot(join(path, entry.name))))
                result[`${entry.name}/${key}`] = value;
            else result[entry.name] = hex(await readFile(join(path, entry.name)));
          }
          return result;
        };
        const old = await snapshot(root);
        const reset = { accountId, workspaceId, resetId: randomUUID(), now: 1700000000000 };
        const archive = await execute(resetCliE2eeIdentity(reset));
        if (!archive) throw new Error('expected archive');
        expect(await snapshot(archive)).toEqual(old);
        const second = await prepareCliE2eeMachineLegacy({
          ...input,
          pairingSessionId: '03'.repeat(16),
        });
        if ('superseded' in second) throw new Error('unexpected superseded');
        expect(second.signingPublicKey).not.toBe(first.signingPublicKey);
        expect(second.credentialHash).not.toBe(first.credentialHash);
        expect(await snapshot(archive)).toEqual(old);
        if (old['custody/kek.safe-storage'])
          expect(hex(await readFile(join(root, 'custody', 'kek.safe-storage')))).not.toBe(
            old['custody/kek.safe-storage']
          );
        const journal = new DatabaseSync(join(root, 'pairings.sqlite'));
        expect(journal.prepare('SELECT session FROM pairings').all()).toEqual([
          { session: '03'.repeat(16) },
        ]);
        journal.close();
        const beforeRetry = await snapshot(root);
        expect(await execute(resetCliE2eeIdentity(reset))).toBe(archive);
        expect(await snapshot(root)).toEqual(beforeRetry);
      } finally {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

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
    revoked = true;
    await host.refresh();
    await host.removalCleanup();
    expect(removed).toEqual(['device-revoked']);
    // Membership and local data stay; only this identity is retired.
    await expect(fs.readFile(join(root, 'removed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.readFile(join(root, 'revoked-device.json'), 'utf8'))).toEqual({
      genesisHash: binding.genesisHash,
      signingPublicKey: key,
    });
    await host.close();
    host = undefined;
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

it.each(['history', 'renewal', 'snapshot', 'account-race', 'close-race', 'receipt-error'] as const)(
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
  // Admission is visible before the approving desktop has delivered the current key.
  const admittedBeforeKey = async (directory: string) => {
    const { makeDesktopRemotePairing } =
      await import('../../electron/src/main/services/e2ee-remote-pairing.mts');
    return execute(
      Effect.gen(function* () {
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
        const view = Result.getOrThrow(
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
        const offer = yield* makeDesktopRemotePairing({
          db,
          workspaceId: 'workspace',
          genesis: signed.genesis,
          genesisRecord: signed.record,
          signer,
          current: () => Effect.succeed(view),
        }).offer({
          accountId: 'remote-account',
          deploymentUrl: 'https://cloud.synthetic.test',
          ingressUrl: 'https://edge.synthetic.test',
        });
        return { offer, encoded: Buffer.from(JSON.stringify(offer)).toString('base64url') };
      })
    );
  };

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

const executionFixture = Effect.fnUntraced(function* (directory: string, count = 2) {
  const fixture = yield* setup(directory, count);
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
  for (let start = 0; start < fixture.records.length; start += 64)
    yield* runtime.ingest(
      page(fixture.records, start, Math.min(start + 64, fixture.records.length))
    );
  const baseClock = yield* Clock.Clock;
  const io = {
    wall: 0,
    monotonic: 0,
    offline: false,
    reads: 0,
    respond: async (_input: Parameters<CloudE2eePort['getHistory']>[0]) => page(fixture.records),
  };
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => io.wall,
    currentTimeMillis: Effect.sync(() => io.wall),
    currentTimeNanosUnsafe: () => BigInt(io.wall) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(io.wall) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(io.monotonic) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(io.monotonic) * 1_000_000n),
    sleep: (duration) => baseClock.sleep(duration),
  };
  const makeGate = (sharing?: Parameters<typeof makeCliE2eeExecutionAuthorization>[0]['sharing']) =>
    makeCliE2eeExecutionAuthorization({
      sharing,
      workspaceId: 'workspace',
      credential: fixture.credential,
      runtime,
      cloud: {
        getHistory: async (input) => {
          expect(input.credential).toBe(fixture.credential);
          expect(input.workspaceId).toBe('workspace');
          io.reads++;
          if (io.offline) throw new Error('synthetic network failure');
          return io.respond(input);
        },
      },
    }).pipe(Effect.provideService(Clock.Clock, clock));
  const gate = yield* makeGate();
  return { fixture, runtime, gate, makeGate, io, device };
});

const retainSignedScheduleUpdate = Effect.fnUntraced(function* (
  origins: ExecutionOrigins,
  docId: string,
  doc: LoroDoc,
  binding: Effect.Success<ReturnType<typeof makeStreamsUpdateBinding>>,
  from?: ReturnType<LoroDoc['version']>
) {
  const update = doc.export({ mode: 'update', from });
  const plaintext = new Uint8Array(4 + update.length);
  new DataView(plaintext.buffer).setUint32(0, update.length, false);
  plaintext.set(update, 4);
  const context = {
    protocol: 'loro-streams-crdt-payload-protection',
    version: 2,
    kind: 'update_batch',
  } as const;
  const sealed = yield* binding.seal({
    context,
    plaintext,
    additionalData: (header) => Uint8Array.from([...header, 9]),
  });
  const request = { ...sealed, context, additionalData: Uint8Array.from([...sealed.header, 9]) };
  const opened = yield* binding.openAuthenticated(request);
  origins.retain(`doc:${docId}`, request, opened.plaintext);
  opened.plaintext.fill(0);
  return request;
});

describe('machine execution authorization freshness', () => {
  effectIt.effect.each([
    'valid',
    'no-source-capability',
    'foreign-source',
    'pending-source',
    'tampered-before-claim',
    'project-shared',
    'project-unshared',
    'source-withdrawn',
  ] as const)(
    'authorizes the machine-signed scheduled turn after production preparation and handoff, with one shared claim (%s)',
    (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), 'scheduled-execution-'))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
          );
          const {
            fixture,
            runtime,
            gate: authorization,
            makeGate,
            device,
          } = yield* executionFixture(directory);
          let sourceSigner: Parameters<typeof makeStreamsUpdateBinding>[0]['signer'] =
            fixture.owner;
          const sharedSource = ['project-shared', 'project-unshared', 'source-withdrawn'].includes(
            mode
          );
          if (mode === 'foreign-source' || sharedSource) {
            const custody = yield* makeNodeE2eeCustody({
              directory: join(directory, 'foreign-source'),
              wrapper,
            });
            const attacker = yield* custody.prepareDevice();
            const request = yield* prepareJoinRequest({
              genesis: fixture.genesis,
              requestId: Result.getOrThrow(Bytes.requestId(new Uint8Array(16).fill(94))),
              userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(95))),
              encryptionPublicKey: attacker.enc,
              expiresAt: null,
              signer: attacker,
            });
            const record = yield* signLedgerRecord(
              Result.getOrThrow(
                prepareLedgerCommand(fixture.current, fixture.owner.publicKey, {
                  _tag: 'AdmitMember',
                  membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(96))),
                  request,
                })
              ),
              fixture.owner
            );
            const start = fixture.records.length;
            fixture.records.push(record);
            fixture.current = Result.getOrThrow(
              extendLedger(fixture.current, [record], {
                length: fixture.records.length,
                head: hashRecordBytes(record),
              })
            );
            yield* runtime.ingest(page(fixture.records, start));
            sourceSigner = attacker;
          }
          const repo = yield* Effect.acquireRelease(
            Effect.promise(() => LoroRepo.create({})),
            (ownedRepo) => Effect.promise(() => ownedRepo.destroy())
          );
          const scheduleRepository = new ScheduleRepository(repo, 'workspace' as WorkspaceId, {
            protectedContent: true,
          });
          const document = yield* Effect.promise(() =>
            scheduleRepository.save({
              scheduleId: 'reserved-message',
              actorId: 'display-owner',
              now: 0,
              activationId: 'activation',
              activityId: 'create',
              create: true,
              draft: {
                title: 'Scheduled',
                prompt: 'Scheduled hello',
                machineId: 'machine',
                ...(mode === 'project-unshared'
                  ? {
                      project: {
                        kind: 'local' as const,
                        localProjectId: 'private-project' as import('@lody/shared').LocalProjectId,
                      },
                    }
                  : {}),
                trigger: { kind: 'once', at: '1970-01-01T00:01:00.000Z' },
                misfirePolicy: { kind: 'run_once' },
                overlapPolicy: 'queue_one',
                agent: { agentConfigId: 'agent' },
                retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86400000 },
              },
            })
          );
          const scheduleDoc = (yield* Effect.promise(() =>
            repo.openPersistedDoc(getScheduleRoomId('reserved-message'))
          )).doc;
          const origins = new ExecutionOrigins(join(directory, 'origins.sqlite'));
          const scheduleBinding = yield* makeStreamsUpdateBinding({
            genesis: fixture.genesis,
            resource: `doc:${getScheduleRoomId('reserved-message')}`,
            model: 'loro',
            writeEpoch: 'current',
            signer: sourceSigner,
            ledger: () => Effect.succeed(fixture.current),
            readEpochKey: () => Effect.fromResult(Bytes.epochKey(new Uint8Array(32).fill(20))),
          });
          yield* retainSignedScheduleUpdate(
            origins,
            getScheduleRoomId('reserved-message'),
            scheduleDoc,
            scheduleBinding
          );
          let sharingCurrent = true;
          const sourceGate = sharedSource
            ? yield* makeGate((_requester, localProjectId) =>
                Effect.succeed({
                  allowed: localProjectId === undefined || localProjectId === 'shared-project',
                  isCurrent: () => sharingCurrent,
                })
              )
            : authorization;
          const scheduleOptions = {
            workspaceId: 'workspace',
            doc: scheduleDoc,
            origins,
            open: scheduleBinding.openAuthenticated,
            authorizeExecution: sourceGate.authorizeExecution,
            isExecutionOpen: () => true,
          };
          if (mode === 'project-unshared') {
            expect(
              (yield* Effect.scoped(
                authorizeEncryptedSchedule({
                  ...scheduleOptions,
                  request: {
                    scheduleId: 'reserved-message',
                    definitionFingerprint: scheduleDefinitionFingerprint(document),
                  },
                })
              ))._tag
            ).toBe('Denied');
          }
          const authorizeSchedule = (
            request: ScheduleAuthorizationRequest,
            localProjectId?: string
          ) =>
            Effect.scoped(
              authorizeEncryptedSchedule({
                ...scheduleOptions,
                request,
                executionTarget: { localProjectId },
              })
            ).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (mode === 'source-withdrawn') sharingCurrent = false;
                })
              )
            );
          const sessionId = 'scheduled-chat' as SessionId;
          const handle = yield* Effect.promise(() =>
            repo.openPersistedDoc(getSessionRoomId(sessionId))
          );
          const session = new SessionDocument(repo, sessionId, async () => {});
          session.handle = handle;
          session.composeSessionData(handle.doc, undefined, { historyBackend: 'loro' });
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => session.destroy({ preserveStatus: true }))
          );
          const manager = {
            repo,
            syncMetaOrThrow: async () => {},
            getOrCreateSessionDoc: async () => session,
          } as unknown as LoroDocumentManager;
          const prepared = withScheduledMessageInput(
            yield* Effect.promise(() =>
              prepareSessionInput(
                { userId: 'display-owner', machineId: 'machine' } as AuthContext,
                { id: 'workspace', contentMode: 'e2ee' } as WorkspaceSummary,
                manager,
                'Scheduled hello',
                buildScheduleSessionCreateOptions({
                  sessionId,
                  userTurnId: 'scheduled-turn',
                  agentConfigId: 'agent',
                  title: 'Scheduled',
                }),
                { ...resolveTurnDispatchConfig({}), inheritSessionDefaults: false },
                buildScheduleRunTarget({
                  targetMachine: {
                    id: 'machine',
                    ownerUserId: 'display-owner',
                    protocolCapabilities: {},
                  } as MachineMeta,
                  agentConfig: {
                    id: 'agent',
                    machineId: 'machine',
                    cliType: 'claude',
                    agentType: 'claude',
                  } as AgentConfigMeta,
                })
              )
            ),
            { inputBlocks: [{ type: 'text', text: 'Scheduled hello' }] }
          );
          prepared.userTurn.timestamp = new Date(yield* Clock.currentTimeMillis).toISOString();
          prepared.userTurn.scheduleRun = {
            scheduleId: 'reserved-message',
            turnId: prepared.userTurn.id,
            title: 'Scheduled',
            definitionFingerprint: scheduleDefinitionFingerprint(document),
          };
          yield* Effect.promise(() => materializePreparedSessionInput(manager, prepared));
          expect(
            (yield* Effect.promise(() => repo.getDocMeta(getSessionRoomId(sessionId))))?.meta
              .latestUserMsgId
          ).toBeUndefined();
          yield* Effect.promise(() => commitPreparedSessionDispatch(manager, prepared));
          expect(
            (yield* Effect.promise(() => repo.getDocMeta(getSessionRoomId(sessionId))))?.meta
              .latestUserMsgId
          ).toBe('scheduled-turn');
          const binding = yield* makeStreamsUpdateBinding({
            genesis: fixture.genesis,
            resource: `doc:${getSessionRoomId(sessionId)}`,
            model: 'loro',
            writeEpoch: 'current',
            signer: device,
            ledger: () => Effect.succeed(fixture.current),
            readEpochKey: () => Effect.fromResult(Bytes.epochKey(new Uint8Array(32).fill(20))),
          });
          const storedTurn = (yield* Effect.sync(() => session.sessionData.history.readAll())).find(
            (turn) => turn.id === prepared.userTurn.id
          );
          const intent = {
            workspaceId: 'workspace',
            ...(sharedSource
              ? {
                  localProjectIds: [
                    mode === 'project-unshared' ? 'private-project' : 'shared-project',
                  ],
                }
              : {}),
            sessionId,
            userTurnId: prepared.userTurn.id,
            requesterUserId: 'display-owner',
            inputConfig: storedTurn?.inputConfig,
          };
          const makeExecution = () =>
            makeEncryptedAgentExecution({
              genesis: hex(fixture.genesis.toBytes()),
              workspaceId: 'workspace',
              targetMachineId: 'machine',
              journal: lazyExecutionJournal(join(directory, 'execution.sqlite'), () => 0),
              resolveVerifiedOriginal: (input) =>
                Effect.scoped(origins.resolve(input, handle.doc, binding.openAuthenticated)),
              authorizeExecution: authorization.authorizeExecution,
              ...(mode !== 'no-source-capability'
                ? {
                    authorizeSchedule:
                      mode === 'pending-source'
                        ? () =>
                            Effect.succeed({
                              _tag: 'Denied' as const,
                              reason: 'e2ee_schedule_evidence_pending',
                            })
                        : authorizeSchedule,
                  }
                : {}),
            });
          const execution = makeExecution();
          expect((yield* execution.claim(intent)).state).toBe('pending-evidence');
          const update = handle.doc.export({ mode: 'update' });
          const plaintext = new Uint8Array(4 + update.length);
          new DataView(plaintext.buffer).setUint32(0, update.length, false);
          plaintext.set(update, 4);
          const context = {
            protocol: 'loro-streams-crdt-payload-protection',
            version: 2,
            kind: 'update_batch',
          } as const;
          const sealed = yield* binding.seal({
            context,
            plaintext,
            additionalData: (header) => Uint8Array.from([...header, 9]),
          });
          const request = {
            ...sealed,
            context,
            additionalData: Uint8Array.from([...sealed.header, 9]),
          };
          const opened = yield* binding.openAuthenticated(request);
          origins.retain(`doc:${getSessionRoomId(sessionId)}`, request, opened.plaintext);
          opened.plaintext.fill(0);
          expect(
            yield* Effect.scoped(origins.resolve(intent, handle.doc, binding.openAuthenticated))
          ).toMatchObject({ requesterDevice: hex(device.publicKey.toBytes()) });
          if (mode === 'tampered-before-claim') {
            const prompt = scheduleDoc.getText('prompt');
            const prior = prompt.toString();
            prompt.delete(0, prior.length);
            prompt.insert(0, prior);
            scheduleDoc.commit();
          }
          const claim = yield* execution.claim(intent);
          if (mode === 'pending-source') {
            expect(claim.state).toBe('pending-evidence');
            yield* TestClock.adjust(900_000);
            expect((yield* execution.claim(intent)).state).toBe('expired');
            return;
          }
          if (mode !== 'valid' && mode !== 'project-shared') {
            expect(claim.state).toBe('denied');
            if (mode === 'project-unshared')
              expect(claim).toMatchObject({ reason: 'e2ee_machine_not_shared' });
            return;
          }
          expect(claim.state).toBe('claimed');
          expect((yield* makeExecution().claim(intent)).state).toBe('uncertain');
          if (claim.state !== 'claimed') throw new Error('expected execution permit');
          yield* execution.complete(claim.permit);
          expect((yield* makeExecution().claim(intent)).state).toBe('completed');
        })
      )
  );

  effectIt.effect.each(['owner-resave', 'owner-cancel', 'concurrent-cancel'] as const)(
    'rejects a foreign member schedule and requires owner review before remote delivery (%s)',
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), 'scheduled-execution-'))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
          );
          const { fixture, runtime, gate: authorization } = yield* executionFixture(directory);
          const repo = yield* Effect.acquireRelease(
            Effect.promise(() => LoroRepo.create({})),
            (ownedRepo) => Effect.promise(() => ownedRepo.destroy())
          );

          // A second real ledger member cannot start the victim machine directly.
          const attackerCustody = yield* makeNodeE2eeCustody({
            directory: join(directory, 'attacker'),
            wrapper,
          });
          const attacker = yield* attackerCustody.prepareDevice();
          const membershipId = Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(91)));
          const joinRequest = yield* prepareJoinRequest({
            genesis: fixture.genesis,
            requestId: Result.getOrThrow(Bytes.requestId(new Uint8Array(16).fill(92))),
            userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(93))),
            encryptionPublicKey: attacker.enc,
            expiresAt: null,
            signer: attacker,
          });
          const admission = yield* signLedgerRecord(
            Result.getOrThrow(
              prepareLedgerCommand(fixture.current, fixture.owner.publicKey, {
                _tag: 'AdmitMember',
                membershipId,
                request: joinRequest,
              })
            ),
            fixture.owner
          );
          const start = fixture.records.length;
          fixture.records.push(admission);
          fixture.current = Result.getOrThrow(
            extendLedger(fixture.current, [admission], {
              length: fixture.records.length,
              head: hashRecordBytes(admission),
            })
          );
          yield* runtime.ingest(page(fixture.records, start));
          expect(
            yield* authorization.authorizeExecution('workspace', hex(attacker.publicKey.toBytes()))
          ).toEqual({ _tag: 'Denied', reason: 'e2ee_machine_not_shared' });
          let attackerClosed = false;
          const attackerRepo = yield* Effect.acquireRelease(
            Effect.promise(() => LoroRepo.create({})),
            (r) => Effect.promise(() => (attackerClosed ? Promise.resolve() : r.destroy()))
          );
          const ws = 'workspace' as WorkspaceId;
          const attackRepository = new ScheduleRepository(attackerRepo, ws, {
            protectedContent: true,
          });
          const origins = new ExecutionOrigins(join(directory, 'schedule-origins.sqlite'));
          let scheduleBinding:
            | Effect.Success<ReturnType<typeof makeStreamsUpdateBinding>>
            | undefined;
          // Caller-controlled actorId is only an ordinary CRDT field, not signer evidence.
          yield* Effect.promise(() =>
            attackRepository.save({
              scheduleId: 'forged-owner',
              actorId: 'display-owner',
              now: 0,
              activationId: 'attack-activation',
              activityId: 'attack-create',
              create: true,
              draft: {
                title: 'Forged owner',
                machineId: 'machine',
                prompt: 'ATTACKER_CHOSEN_PROMPT',
                message: { inputBlocks: [{ type: 'text', text: 'ATTACKER_CHOSEN_PROMPT' }] },
                destination: { kind: 'existing_session', sessionId: 'remote-chat' },
                trigger: { kind: 'once', at: '1970-01-01T00:01:00.000Z' },
                misfirePolicy: { kind: 'run_once' },
                overlapPolicy: 'queue_one',
                agent: { agentConfigId: 'agent', modeId: 'safe' },
                retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86400000 },
              },
            })
          );
          const docId = getScheduleRoomId('forged-owner');
          const registryId = getScheduleRegistryFlockDocId(ws);
          const sourceDoc = yield* Effect.promise(() => attackerRepo.openPersistedDoc(docId));
          const targetDoc = yield* Effect.promise(() => repo.openPersistedDoc(docId));
          const sourceRegistry = yield* Effect.promise(() => attackerRepo.openFlockDoc(registryId));
          const targetRegistry = yield* Effect.promise(() => repo.openFlockDoc(registryId));
          const transfer = Effect.fnUntraced(function* (
            source: LoroDoc,
            registry: typeof sourceRegistry.flock,
            signer: Parameters<typeof makeStreamsUpdateBinding>[0]['signer'],
            from?: ReturnType<LoroDoc['version']>
          ) {
            for (const item of [
              {
                resource: `doc:${docId}`,
                model: 'loro' as const,
                bytes: source.export({ mode: 'update', from }),
                apply: (bytes: Uint8Array) => targetDoc.doc.import(bytes),
              },
              {
                resource: `flock:${registryId}`,
                model: 'flock' as const,
                bytes: registry.exportFile(),
                apply: (bytes: Uint8Array) => targetRegistry.flock.importFile(bytes),
              },
            ]) {
              const binding = yield* makeStreamsUpdateBinding({
                genesis: fixture.genesis,
                resource: item.resource,
                model: item.model,
                writeEpoch: 'current',
                signer,
                ledger: () => Effect.succeed(fixture.current),
                readEpochKey: () => Effect.fromResult(Bytes.epochKey(new Uint8Array(32).fill(20))),
              });
              const plaintext = new Uint8Array(4 + item.bytes.length);
              new DataView(plaintext.buffer).setUint32(0, item.bytes.length, false);
              plaintext.set(item.bytes, 4);
              const context = {
                protocol: 'loro-streams-crdt-payload-protection',
                version: 2,
                kind: 'update_batch',
              } as const;
              const sealed = yield* binding.seal({
                context,
                plaintext,
                additionalData: (header) => Uint8Array.from([...header, 9]),
              });
              const request = {
                ...sealed,
                context,
                additionalData: Uint8Array.from([...sealed.header, 9]),
              };
              const opened = yield* binding.openAuthenticated(request);
              if (item.model === 'loro') {
                origins.retain(item.resource, request, opened.plaintext);
                scheduleBinding = binding;
              }
              item.apply(opened.plaintext.subarray(4));
              opened.plaintext.fill(0);
            }
          });
          yield* transfer(sourceDoc.doc, sourceRegistry.flock, attacker);
          const forged = yield* Effect.promise(() =>
            new ScheduleRepository(repo, ws).read('forged-owner')
          );
          if (!forged || !scheduleBinding) throw new Error('missing forged schedule');
          expect(
            yield* origins.resolveSchedule(
              {
                scheduleId: 'forged-owner',
                definitionFingerprint: scheduleDefinitionFingerprint(forged),
              },
              targetDoc.doc,
              scheduleBinding.openAuthenticated
            )
          ).toEqual([hex(attacker.publicKey.toBytes())]);
          const machineRepository = new ScheduleRepository(repo, ws);
          type Prepared = {
            prompt: string;
            message?: ScheduleDocument['message'];
            userTurnId: string;
            sessionId: string;
          };
          const scheduleStore = new ScheduleStore<Prepared>(':memory:');
          yield* Effect.addFinalizer(() => Effect.sync(() => scheduleStore.close()));
          let now = 60000;
          const delivered = new Map<
            string,
            { sessionId: string; message?: ScheduleDocument['message']; prompt: string }
          >();
          const handoffs: string[] = [];
          let reviewClosed = false;
          const ports = {
            workspaceId: ws,
            machineId: 'machine',
            userId: 'display-owner',
            encrypted: true,
            store: scheduleStore,
            now: () => now,
            disabled: () => false,
            ready: () => true,
            authorize: (request) =>
              Effect.runPromise(
                Effect.scoped(
                  authorizeEncryptedSchedule({
                    workspaceId: ws,
                    request,
                    doc: targetDoc.doc,
                    origins,
                    open: (input) =>
                      scheduleBinding
                        ? scheduleBinding.openAuthenticated(input)
                        : Effect.die('missing schedule binding'),
                    authorizeExecution: authorization.authorizeExecution,
                    isExecutionOpen: () => true,
                  })
                )
              ).then((result) => result._tag === 'Authorized'),
            list: () => machineRepository.list(),
            read: (id) => machineRepository.read(id),
            validateTarget: async () => {},
            prepare: async (run) => {
              expect(attackerClosed && reviewClosed).toBe(true);
              return {
                prompt: run.prompt,
                message: run.message,
                userTurnId: run.userTurnId,
                sessionId: run.sessionId,
              };
            },
            materialize: async () => {},
            isDispatched: async (prepared) => delivered.has(prepared.userTurnId),
            dispatch: async (prepared) => {
              handoffs.push(prepared.userTurnId);
              delivered.set(prepared.userTurnId, {
                prompt: prepared.prompt,
                message: prepared.message,
                sessionId: prepared.sessionId,
              });
            },
            isFinished: async () => false,
            publish: async () => {},
            onError: () => {},
          } satisfies ScheduleEnginePorts<Prepared>;
          const engine = new ScheduleEngine(ports);
          yield* Effect.promise(() => engine.evaluate());
          expect([...delivered.values()]).toEqual([]);
          expect(scheduleStore.history(ws, 'forged-owner')[0]).toMatchObject({
            state: 'retry_wait',
            errorCode: 'E2EE_SCHEDULE_NOT_AUTHORIZED',
          });
          // An owner opens the same verified CRDT state on an independent client,
          // reviews the payload and explicitly saves a new future activation.
          const reviewRepo = yield* Effect.acquireRelease(
            Effect.promise(() => LoroRepo.create({})),
            (r) => Effect.promise(() => (reviewClosed ? Promise.resolve() : r.destroy()))
          );
          const reviewDoc = (yield* Effect.promise(() => reviewRepo.openPersistedDoc(docId))).doc;
          reviewDoc.import(targetDoc.doc.export({ mode: 'update' }));
          const reviewRegistry = yield* Effect.promise(() => reviewRepo.openFlockDoc(registryId));
          reviewRegistry.flock.importFile(targetRegistry.flock.exportFile());
          const reviewFrom = reviewDoc.version();
          const reviewRepository = new ScheduleRepository(reviewRepo, ws, {
            protectedContent: true,
          });
          const reviewed = yield* Effect.promise(() =>
            reviewRepository.save({
              scheduleId: 'forged-owner',
              actorId: 'display-owner',
              now: 60001,
              activationId: 'owner-reviewed',
              activityId: 'owner-save',
              create: false,
              draft: {
                ...forged.definition,
                prompt: 'OWNER_REVIEWED_MESSAGE',
                message: { inputBlocks: [{ type: 'text', text: 'OWNER_REVIEWED_MESSAGE' }] },
                trigger: { kind: 'once', at: '1970-01-01T00:02:00.000Z' },
              },
            })
          );
          yield* transfer(reviewDoc, reviewRegistry.flock, fixture.owner, reviewFrom);
          const ownerBinding = scheduleBinding;
          if (!ownerBinding) throw new Error('missing owner schedule binding');
          expect(
            yield* origins.resolveSchedule(
              {
                scheduleId: 'forged-owner',
                definitionFingerprint: scheduleDefinitionFingerprint(reviewed),
              },
              targetDoc.doc,
              ownerBinding.openAuthenticated
            )
          ).toEqual([hex(fixture.owner.publicKey.toBytes())]);
          if (scenario !== 'owner-resave') {
            const cancelFrom = reviewDoc.version();
            if (scenario === 'concurrent-cancel') {
              sourceDoc.doc.import(reviewDoc.export({ mode: 'update' }));
              sourceRegistry.flock.importFile(reviewRegistry.flock.exportFile());
              const editFrom = sourceDoc.doc.version();
              yield* Effect.promise(() =>
                attackRepository.save({
                  scheduleId: 'forged-owner',
                  actorId: 'display-owner',
                  now: 60002,
                  activationId: 'stale-phone-edit',
                  activityId: 'phone-edit',
                  create: false,
                  draft: {
                    ...reviewed.definition,
                    prompt: 'CONCURRENT_UNAPPROVED_EDIT',
                    message: {
                      inputBlocks: [{ type: 'text', text: 'CONCURRENT_UNAPPROVED_EDIT' }],
                    },
                  },
                })
              );
              yield* transfer(sourceDoc.doc, sourceRegistry.flock, attacker, editFrom);
            }
            yield* Effect.promise(() =>
              reviewRepository.setEnabled({
                scheduleId: 'forged-owner',
                actorId: 'display-owner',
                enabled: false,
                now: 60002,
                activationId: 'owner-cancel',
                requestId: 'cancel',
              })
            );
            yield* transfer(reviewDoc, reviewRegistry.flock, fixture.owner, cancelFrom);
            expect(
              (yield* Effect.promise(() => machineRepository.read('forged-owner')))?.definition
                .enabled
            ).toBe(false);
          }
          // Clients stop before the due slot. Only the receiving machine owns
          // the clock, authorization and persistent occurrence ledger afterward.
          yield* Effect.promise(() => attackerRepo.destroy());
          attackerClosed = true;
          yield* Effect.promise(() => reviewRepo.destroy());
          reviewClosed = true;
          now = 119999;
          yield* Effect.promise(() => engine.evaluate());
          expect([...delivered.values()]).toEqual([]);
          now = 120000;
          yield* Effect.promise(() => Promise.all([engine.evaluate(), engine.evaluate()]));
          const restarted = new ScheduleEngine(ports);
          now = 121000;
          yield* Effect.promise(() => Promise.all([restarted.evaluate(), restarted.evaluate()]));
          const dispatched = scheduleStore
            .history(ws, 'forged-owner')
            .filter((run) => run.state === 'dispatched');
          if (scenario === 'owner-resave') {
            expect([...delivered.values()]).toEqual([
              {
                prompt: 'OWNER_REVIEWED_MESSAGE',
                sessionId: 'remote-chat',
                message: { inputBlocks: [{ type: 'text', text: 'OWNER_REVIEWED_MESSAGE' }] },
              },
            ]);
            expect(dispatched).toHaveLength(1);
            expect([...delivered.keys()]).toEqual([dispatched[0]?.userTurnId]);
            expect(handoffs).toEqual([...delivered.keys()]);
          } else {
            expect([...delivered.values()]).toEqual([]);
            expect(dispatched).toEqual([]);
            expect(handoffs).toEqual([]);
          }
        })
      )
  );
  effectIt.effect.each([
    'prompt',
    'machineId',
    'project',
    'enabled',
    'trigger',
    'same-value',
    'snapshot-only',
    'manual-forgery',
    'manual-valid',
    'manual-valid-other-device',
    'revoked-author',
    'concurrent-edit',
    'concurrent-timeline',
  ] as const)('binds schedule execution to the current signed declaration (%s)', (mutation) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), 'schedule-proof-'))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
        );
        const { fixture, runtime, gate, device } = yield* executionFixture(directory);
        const custody = yield* makeNodeE2eeCustody({
          directory: join(directory, 'schedule-author'),
          wrapper,
        });
        const writer = yield* custody.prepareDevice();
        const admission = yield* prepareDeviceAdmission({
          genesis: fixture.genesis,
          membershipId: fixture.membershipId,
          signer: writer,
          encryptionPublicKey: writer.enc,
          kind: 'personal',
        });
        const admitted = yield* signLedgerRecord(
          Result.getOrThrow(
            prepareLedgerCommand(fixture.current, fixture.owner.publicKey, admission)
          ),
          fixture.owner
        );
        const admissionStart = fixture.records.length;
        fixture.records.push(admitted);
        fixture.current = Result.getOrThrow(
          extendLedger(fixture.current, [admitted], {
            length: fixture.records.length,
            head: hashRecordBytes(admitted),
          })
        );
        yield* runtime.ingest(page(fixture.records, admissionStart));
        const repo = yield* Effect.acquireRelease(
          Effect.promise(() => LoroRepo.create({})),
          (owned) => Effect.promise(() => owned.destroy())
        );
        const ws = 'workspace' as WorkspaceId;
        const repository = new ScheduleRepository(repo, ws, { protectedContent: true });
        const document = yield* Effect.promise(() =>
          repository.save({
            scheduleId: 'proof',
            actorId: 'display-owner',
            now: 0,
            activationId: 'active',
            activityId: 'create',
            create: true,
            draft: {
              title: 'Proof',
              prompt: 'Original prompt',
              machineId: 'machine',
              trigger: { kind: 'once', at: '1970-01-01T00:01:00.000Z' },
              misfirePolicy: { kind: 'run_once' },
              overlapPolicy: 'queue_one',
              agent: { agentConfigId: 'agent' },
              retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86400000 },
            },
          })
        );
        const docId = getScheduleRoomId('proof');
        const doc = (yield* Effect.promise(() => repo.openPersistedDoc(docId))).doc;
        const binding = yield* makeStreamsUpdateBinding({
          genesis: fixture.genesis,
          resource: `doc:${docId}`,
          model: 'loro',
          writeEpoch: 'current',
          signer: writer,
          ledger: () => Effect.succeed(fixture.current),
          readEpochKey: () => Effect.fromResult(Bytes.epochKey(new Uint8Array(32).fill(20))),
        });
        const origins = new ExecutionOrigins(join(directory, 'origins.sqlite'));
        yield* retainSignedScheduleUpdate(origins, docId, doc, binding);
        let request: ScheduleAuthorizationRequest = {
          scheduleId: 'proof',
          definitionFingerprint: scheduleDefinitionFingerprint(document),
        };
        const authorize = (
          source = origins,
          concurrent: false | 'execution' | 'timeline' = false
        ) =>
          authorizeEncryptedSchedule({
            workspaceId: ws,
            request,
            doc,
            origins: source,
            open: binding.openAuthenticated,
            isExecutionOpen: () => true,
            authorizeExecution: (workspaceId, signer) =>
              gate.authorizeExecution(workspaceId, signer).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (concurrent === 'timeline') {
                      const activity = doc.getList('timeline').pushContainer(new LoroMap());
                      activity.set('id', 'unrelated');
                      doc.commit();
                    }
                    if (concurrent === 'execution') {
                      doc.getMap('definition').set('enabled', false);
                      doc.commit();
                    }
                  })
                )
              ),
          });
        const sourceGrant = yield* authorize();
        expect(sourceGrant).toMatchObject({ _tag: 'Authorized' });
        if (sourceGrant._tag === 'Authorized') expect(sourceGrant.isCurrent?.()).toBe(true);
        const from = doc.version();
        if (mutation === 'snapshot-only') {
          const snapshot = new LoroDoc();
          snapshot.import(doc.export({ mode: 'snapshot' }));
          try {
            const empty = new ExecutionOrigins(join(directory, 'snapshot-only.sqlite'));
            expect(
              (yield* authorizeEncryptedSchedule({
                workspaceId: ws,
                request,
                doc: snapshot,
                origins: empty,
                open: binding.openAuthenticated,
                isExecutionOpen: () => true,
                authorizeExecution: gate.authorizeExecution,
              }))._tag
            ).toBe('Denied');
          } finally {
            snapshot.free();
          }
          return;
        }
        if (
          mutation === 'manual-forgery' ||
          mutation === 'manual-valid' ||
          mutation === 'manual-valid-other-device'
        ) {
          request = { ...request, manualRunKey: manualScheduleRunKey('proof', 'manual') };
          if (mutation !== 'manual-forgery') {
            yield* Effect.promise(() =>
              repository.requestRun({
                scheduleId: 'proof',
                actorId: 'display-owner',
                manualRunId: 'manual',
                now: 0,
              })
            );
            const manualBinding =
              mutation === 'manual-valid-other-device'
                ? yield* makeStreamsUpdateBinding({
                    genesis: fixture.genesis,
                    resource: `doc:${docId}`,
                    model: 'loro',
                    writeEpoch: 'current',
                    signer: fixture.owner,
                    ledger: () => Effect.succeed(fixture.current),
                    readEpochKey: () =>
                      Effect.fromResult(Bytes.epochKey(new Uint8Array(32).fill(20))),
                  })
                : binding;
            yield* retainSignedScheduleUpdate(origins, docId, doc, manualBinding, from);
          }
          expect((yield* authorize())._tag).toBe(
            mutation !== 'manual-forgery' ? 'Authorized' : 'Denied'
          );
          return;
        }
        if (mutation === 'revoked-author') {
          const start = fixture.records.length;
          const record = yield* signLedgerRecord(
            Result.getOrThrow(
              prepareLedgerCommand(fixture.current, fixture.owner.publicKey, {
                _tag: 'RevokeDevice',
                target: writer.publicKey,
              })
            ),
            fixture.owner
          );
          fixture.records.push(record);
          fixture.current = Result.getOrThrow(
            extendLedger(fixture.current, [record], {
              length: fixture.records.length,
              head: hashRecordBytes(record),
            })
          );
          yield* runtime.ingest(page(fixture.records, start));
          expect((yield* authorize())._tag).toBe('Denied');
          return;
        }
        if (mutation === 'concurrent-timeline') {
          expect((yield* authorize(origins, 'timeline'))._tag).toBe('Authorized');
          return;
        }
        if (mutation === 'concurrent-edit') {
          expect((yield* authorize(origins, 'execution'))._tag).toBe('Denied');
          return;
        }
        if (mutation === 'prompt' || mutation === 'same-value') {
          const text = doc.getText('prompt');
          text.delete(0, text.length);
          text.insert(0, mutation === 'same-value' ? 'Original prompt' : 'Attacker prompt');
        } else {
          const values = {
            machineId: 'other-machine',
            enabled: false,
            project: { kind: 'local', localProjectId: 'attacker-project' },
            trigger: { kind: 'once', at: '1970-01-01T00:02:00.000Z' },
          };
          doc.getMap('definition').set(mutation, values[mutation]);
        }
        doc.commit();
        const changed = yield* Effect.promise(() => repository.read('proof'));
        if (!changed) throw new Error('missing changed definition');
        request = { ...request, definitionFingerprint: scheduleDefinitionFingerprint(changed) };
        expect((yield* authorize())._tag).toBe('Denied');
        // A deliberate owner save can authorize the newly displayed definition.
        recordScheduleAuthorization(doc, changed);
        yield* retainSignedScheduleUpdate(origins, docId, doc, binding, from);
        expect((yield* authorize())._tag).toBe('Authorized');
        expect(yield* gate.authorizeExecution(ws, hex(device.publicKey.toBytes()))).toMatchObject({
          _tag: 'Authorized',
        });
      })
    )
  );

  it('requires its own authenticated read, expires at 15 minutes from read start, and rechecks after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'execution-authorization-'));
    let sender = '';
    let credential = '';
    let genesisRecord = new Uint8Array();
    try {
      await execute(
        Effect.gen(function* () {
          const { fixture, runtime, gate, io, device } = yield* executionFixture(directory);
          sender = fixture.sender;
          credential = fixture.credential;
          genesisRecord = fixture.genesisRecord;
          // Even a fully verified offline ledger grants no fresh execution authority.
          io.offline = true;
          expect(yield* gate.authorizeExecution('workspace', sender)).toMatchObject({
            _tag: 'Denied',
            reason: 'unavailable',
          });
          expect((yield* runtime.status()).length).toBe(2);
          io.offline = false;
          io.respond = async () => {
            io.wall += 60_000;
            io.monotonic += 60_000;
            return page(fixture.records);
          };
          expect(yield* gate.authorizeExecution('workspace', sender)).toMatchObject({
            _tag: 'Authorized',
          });
          io.wall = io.monotonic = 899_999;
          io.offline = true;
          expect(yield* gate.authorizeExecution('workspace', sender)).toMatchObject({
            _tag: 'Authorized',
          });
          // Another device cannot borrow this device's cached authorization.
          expect(
            yield* gate.authorizeExecution('workspace', hex(device.publicKey.toBytes()))
          ).toMatchObject({ _tag: 'Denied' });
          io.wall = io.monotonic = 900_000;
          expect(yield* gate.authorizeExecution('workspace', sender)).toMatchObject({
            _tag: 'Denied',
            reason: 'unavailable',
          });
          io.offline = false;
          expect(yield* gate.authorizeExecution('workspace', sender)).toMatchObject({
            _tag: 'Authorized',
          });
          expect(yield* gate.authorizeExecution('other-workspace', sender)).toMatchObject({
            _tag: 'Denied',
            reason: 'invalid-request',
          });
          expect(yield* gate.authorizeExecution('workspace', 'not-a-key')).toMatchObject({
            _tag: 'Denied',
            reason: 'invalid-request',
          });
        })
      );
      // Close the actual custody/SQLite Scope and reopen the same durable files offline.
      await execute(
        Effect.gen(function* () {
          const custody = yield* makeCliE2eeCustody({
            directory: join(directory, 'machine'),
            keyring: noKeyring,
          });
          const device = yield* custody.openDevice(
            Result.getOrThrow(Bytes.genesisHash(hashRecordBytes(genesisRecord).toBytes()))
          );
          const runtime = yield* makeCliE2eeRuntime({
            directory: join(directory, 'runtime'),
            workspaceId: 'workspace',
            custody,
            device,
            genesisRecord,
          });
          const gate = yield* makeCliE2eeExecutionAuthorization({
            workspaceId: 'workspace',
            credential,
            runtime,
            cloud: {
              getHistory: async () => {
                throw new Error('offline after restart');
              },
            },
          });
          expect((yield* runtime.status()).length).toBe(2);
          expect(yield* gate.authorizeExecution('workspace', sender)).toMatchObject({
            _tag: 'Denied',
            reason: 'unavailable',
          });
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('shares concurrent refreshes, preserves siblings after cancellation, and retries a failed read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'execution-flight-'));
    try {
      await execute(
        Effect.gen(function* () {
          const { fixture, gate, io, device } = yield* executionFixture(directory);
          const entered = Promise.withResolvers<void>();
          const released = Promise.withResolvers<ReturnType<typeof page>>();
          io.respond = async () => {
            entered.resolve();
            return released.promise;
          };
          const first = yield* Effect.forkChild(
            gate.authorizeExecution('workspace', fixture.sender)
          );
          yield* Effect.promise(() => entered.promise);
          const sibling = yield* Effect.forkChild(
            gate.authorizeExecution('workspace', fixture.sender),
            { startImmediately: true }
          );
          const machineSibling = yield* Effect.forkChild(
            gate.authorizeExecution('workspace', hex(device.publicKey.toBytes())),
            { startImmediately: true }
          );
          yield* Fiber.interrupt(first);
          released.resolve(page(fixture.records));
          expect(yield* Fiber.join(sibling)).toMatchObject({ _tag: 'Authorized' });
          expect(yield* Fiber.join(machineSibling)).toMatchObject({ _tag: 'Authorized' });
          expect(io.reads).toBe(1);
          io.wall = io.monotonic = 900_000;
          const failing = Promise.withResolvers<ReturnType<typeof page>>();
          const retryEntered = Promise.withResolvers<void>();
          io.respond = async () => {
            retryEntered.resolve();
            return failing.promise;
          };
          const deniedRequests = yield* Effect.forkChild(
            Effect.all(
              [
                gate.authorizeExecution('workspace', fixture.sender),
                gate.authorizeExecution('workspace', fixture.sender),
              ],
              { concurrency: 'unbounded' }
            )
          );
          yield* Effect.promise(() => retryEntered.promise);
          failing.reject(new Error('synthetic outage'));
          expect(yield* Fiber.join(deniedRequests)).toEqual([
            { _tag: 'Denied', reason: 'unavailable' },
            { _tag: 'Denied', reason: 'unavailable' },
          ]);
          expect(io.reads).toBe(2);
          io.respond = async () => page(fixture.records);
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('terminal invalidation fences cached authority and in-flight refreshes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'execution-invalidation-'));
    try {
      await execute(
        Effect.gen(function* () {
          const { fixture, gate, io, device } = yield* executionFixture(directory);
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
          const entered = Promise.withResolvers<void>();
          const released = Promise.withResolvers<ReturnType<typeof page>>();
          io.respond = async () => {
            entered.resolve();
            return released.promise;
          };
          const other = yield* Effect.forkChild(
            gate.authorizeExecution('workspace', hex(device.publicKey.toBytes()))
          );
          yield* Effect.promise(() => entered.promise);
          gate.invalidate();
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toEqual({
            _tag: 'Denied',
            reason: 'closed',
          });
          released.resolve(page(fixture.records));
          expect(yield* Fiber.join(other)).toEqual({ _tag: 'Denied', reason: 'closed' });
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toEqual({
            _tag: 'Denied',
            reason: 'closed',
          });
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('authorizes Guest reads on its own admitted machine while denying execution and foreign machines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'guest-read-authority-'));
    try {
      await execute(
        Effect.gen(function* () {
          const f = yield* setup(directory, 3, join(directory, 'machine'), false, false, true);
          const guest = f.guestMachine;
          if (!guest) throw new Error('missing Guest machine fixture');
          const runtime = yield* makeCliE2eeRuntime({
            directory: join(directory, 'guest-runtime'),
            workspaceId: 'workspace',
            custody: guest.custody,
            device: guest.device,
            genesisRecord: f.genesisRecord,
          });
          yield* runtime.ingest(page(f.records));
          const gate = yield* makeCliE2eeExecutionAuthorization({
            workspaceId: 'workspace',
            credential: 'synthetic',
            runtime,
            cloud: { getHistory: async () => page(f.records) },
          });
          const rpc = makeE2eeRpcNative({
            workspaceId: 'workspace',
            requesterDevice: hex(guest.device.publicKey.toBytes()),
            originals: new E2eeRpcOriginals(join(directory, 'guest-rpc.sqlite')),
            ledger: runtime.executionLedger,
            binding: () => Effect.die('Guest dispatch must never reach signing'),
          });
          const prepared = yield* rpc
            .prepareDispatch('guest-machine', {
              sessionId: 'synthetic-session',
              userTurnId: 'synthetic-turn',
              userId: 'display-only',
              timestamp: new Date(0).toISOString(),
              inputConfig: { prompt: 'synthetic' },
            })
            .pipe(Effect.result);
          expect(prepared._tag).toBe('Failure');
          if (prepared._tag === 'Failure')
            expect(prepared.failure).toMatchObject({ message: 'e2ee_rpc_denied' });
          expect(yield* gate.authorizeRead('workspace', guest.requester)).toEqual({
            _tag: 'Authorized',
          });
          expect(yield* gate.authorizeExecution('workspace', guest.requester)).toEqual({
            _tag: 'Denied',
            reason: 'not-authorized',
          });
          expect(yield* gate.authorizeRead('workspace', f.sender)).toEqual({
            _tag: 'Denied',
            reason: 'e2ee_machine_not_owned',
          });
          gate.invalidate();
          expect(yield* gate.authorizeRead('workspace', guest.requester)).toEqual({
            _tag: 'Denied',
            reason: 'closed',
          });
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects cross-member roles and immediately applies same-member revocation without renewing cached authority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'execution-membership-'));
    try {
      await execute(
        Effect.gen(function* () {
          const { fixture, runtime, gate, io } = yield* executionFixture(directory, 3);
          let current = fixture.current;
          const memberEntry = [...current.inspectState().members].find(
            ([, member]) => member.role === 'member'
          );
          if (!memberEntry) throw new Error('missing synthetic member');
          const [memberId] = memberEntry;
          const requester = [...current.inspectState().devices].find(
            ([, device]) => hex(device.membershipId.toBytes()) === memberId
          );
          if (!requester) throw new Error('missing synthetic requester');
          const [key, device] = requester;
          const append = Effect.fnUntraced(function* (
            command: Parameters<typeof prepareLedgerCommand>[2]
          ) {
            const record = yield* signLedgerRecord(
              Result.getOrThrow(prepareLedgerCommand(current, fixture.owner.publicKey, command)),
              fixture.owner
            );
            fixture.records.push(record);
            current = Result.getOrThrow(
              extendLedger(current, [record], {
                length: fixture.records.length,
                head: hashRecordBytes(record),
              })
            );
            yield* runtime.ingest(page(fixture.records));
          });
          for (const role of ['member', 'admin', 'guest', 'member'] as const) {
            if (
              role !== 'member' ||
              current.inspectState().members.get(memberId)?.role !== 'member'
            )
              yield* append({ _tag: 'SetRole', membershipId: device.membershipId, role });
            expect(yield* gate.authorizeExecution('workspace', key)).toMatchObject({
              _tag: 'Denied',
              reason: role === 'guest' ? 'not-authorized' : 'e2ee_machine_not_shared',
            });
          }
          const extraCustody = yield* makeNodeE2eeCustody({
            directory: join(directory, 'extra'),
            wrapper,
          });
          const extra = yield* extraCustody.prepareDevice();
          yield* append(
            yield* prepareDeviceAdmission({
              genesis: fixture.genesis,
              membershipId: fixture.membershipId,
              signer: extra,
              encryptionPublicKey: extra.enc,
              kind: 'personal',
            })
          );
          const extraKey = hex(extra.publicKey.toBytes());
          expect(yield* gate.authorizeExecution('workspace', extraKey)).toMatchObject({
            _tag: 'Authorized',
          });
          // Historical author records remain, but known revocation rejects the cached grant immediately.
          yield* append({ _tag: 'RevokeDevice', target: extra.publicKey });
          io.offline = true;
          expect(yield* gate.authorizeExecution('workspace', extraKey)).toEqual({
            _tag: 'Denied',
            reason: 'not-authorized',
          });
          io.offline = false;
          const recovery = yield* extraCustody.prepareDevice();
          yield* append(
            yield* prepareDeviceAdmission({
              genesis: fixture.genesis,
              membershipId: fixture.membershipId,
              signer: recovery,
              encryptionPublicKey: recovery.enc,
              kind: 'recovery',
            })
          );
          expect(
            yield* gate.authorizeExecution('workspace', hex(recovery.publicKey.toBytes()))
          ).toEqual({ _tag: 'Denied', reason: 'not-authorized' });
          const outsider = yield* extraCustody.prepareDevice();
          expect(
            yield* gate.authorizeExecution('workspace', hex(outsider.publicKey.toBytes()))
          ).toEqual({
            _tag: 'Denied',
            reason: 'not-authorized',
          });
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
          yield* append({ _tag: 'DeclareCapabilities', capabilities: [1] });
          yield* append({ _tag: 'RemoveMember', membershipId: device.membershipId });
          expect(yield* gate.authorizeExecution('workspace', key)).toMatchObject({
            _tag: 'Denied',
          });
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
          yield* append({
            _tag: 'RevokeDevice',
            target: Result.getOrThrow(
              Bytes.signingPublicKey(Buffer.from((yield* runtime.status()).devicePublicKey, 'hex'))
            ),
          });
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toEqual({
            _tag: 'Denied',
            reason: 'not-authorized',
          });
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('denies a shared start when a verified member removal lands while the sharing check yields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'execution-sharing-removal-'));
    try {
      await execute(
        Effect.gen(function* () {
          const { fixture, runtime, makeGate } = yield* executionFixture(directory, 3);
          let current = fixture.current;
          const memberEntry = [...current.inspectState().members].find(
            ([, member]) => member.role === 'member'
          );
          if (!memberEntry) throw new Error('missing synthetic member');
          const [memberId] = memberEntry;
          const requester = [...current.inspectState().devices].find(
            ([, device]) => hex(device.membershipId.toBytes()) === memberId
          );
          if (!requester) throw new Error('missing synthetic requester');
          const [key, device] = requester;
          const append = Effect.fnUntraced(function* (
            command: Parameters<typeof prepareLedgerCommand>[2]
          ) {
            const record = yield* signLedgerRecord(
              Result.getOrThrow(prepareLedgerCommand(current, fixture.owner.publicKey, command)),
              fixture.owner
            );
            fixture.records.push(record);
            current = Result.getOrThrow(
              extendLedger(current, [record], {
                length: fixture.records.length,
                head: hashRecordBytes(record),
              })
            );
            yield* runtime.ingest(page(fixture.records));
          });
          yield* append({ _tag: 'DeclareCapabilities', capabilities: [1] });
          let removeDuringCheck = false;
          const gate = yield* makeGate(() =>
            Effect.gen(function* () {
              // The owner's removal is verified and ingested while this check yields;
              // the policy read itself still answers "shared".
              if (removeDuringCheck) {
                removeDuringCheck = false;
                yield* append({ _tag: 'RemoveMember', membershipId: device.membershipId });
              }
              return { allowed: true, isCurrent: () => true };
            })
          );
          const shared = yield* gate.authorizeExecution('workspace', key);
          expect(shared).toMatchObject({ _tag: 'Authorized' });
          removeDuringCheck = true;
          const raced = yield* gate.authorizeExecution('workspace', key);
          expect(raced).toMatchObject({ _tag: 'Denied', reason: 'not-authorized' });
          // The grant from before the removal can no longer admit a start either.
          expect(shared._tag === 'Authorized' && shared.isCurrent?.()).toBe(false);
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects rollback, corrupted pages and reads that exhaust their freshness budget; keeps other owners usable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'execution-isolation-'));
    try {
      await execute(
        Effect.gen(function* () {
          const first = yield* executionFixture(join(directory, 'first'));
          const other = yield* executionFixture(join(directory, 'other'));
          first.io.respond = async () => page(first.fixture.records.slice(0, 1));
          expect(
            yield* first.gate.authorizeExecution('workspace', first.fixture.sender)
          ).toMatchObject({ _tag: 'Denied' });
          first.io.respond = async () => ({ ...page(first.fixture.records), recordsHex: ['00'] });
          expect(
            yield* first.gate.authorizeExecution('workspace', first.fixture.sender)
          ).toMatchObject({ _tag: 'Denied' });
          first.io.respond = async () => {
            first.io.wall = first.io.monotonic = 900_000;
            return page(first.fixture.records);
          };
          expect(
            yield* first.gate.authorizeExecution('workspace', first.fixture.sender)
          ).toMatchObject({ _tag: 'Denied' });
          expect(
            yield* other.gate.authorizeExecution('workspace', other.fixture.sender)
          ).toMatchObject({
            _tag: 'Authorized',
          });
          // Neither local reads nor a previously created content binding depend on this gate.
          expect(yield* first.runtime.status()).toMatchObject({ length: 2 });
          yield* first.runtime.binding('local-document', 'loro', 0);
          first.io.respond = async () => page(first.fixture.records);
          expect(
            yield* first.gate.authorizeExecution('workspace', first.fixture.sender)
          ).toMatchObject({
            _tag: 'Authorized',
          });
          // Wall-clock rollback cannot lengthen the monotonic lease.
          first.io.wall -= 1;
          first.io.offline = true;
          expect(
            yield* first.gate.authorizeExecution('workspace', first.fixture.sender)
          ).toMatchObject({ _tag: 'Denied' });
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  effectIt.effect(
    'bounds a stalled refresh and ignores late replies while allowing a later retry',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), 'execution-timeout-'))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
          );
          const { fixture, runtime, gate, io } = yield* executionFixture(directory);
          const entered = Promise.withResolvers<void>();
          const late = Promise.withResolvers<ReturnType<typeof page>>();
          io.respond = async () => {
            entered.resolve();
            return late.promise;
          };
          const request = yield* Effect.forkChild(
            gate.authorizeExecution('workspace', fixture.sender)
          );
          yield* Effect.promise(() => entered.promise);
          yield* TestClock.adjust(30_000);
          expect(yield* Fiber.join(request)).toEqual({ _tag: 'Denied', reason: 'unavailable' });
          // A stopped producer has no continuation that could ingest a late response.
          late.resolve({ ...page(fixture.records), recordsHex: ['00'] });
          io.respond = async () => page(fixture.records);
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
          expect(yield* runtime.status()).toMatchObject({ length: 2 });
        })
      )
  );

  it('reads all pages at one checkpoint and rejects a checkpoint change before granting execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'execution-pages-'));
    try {
      await execute(
        Effect.gen(function* () {
          const { fixture, gate, io } = yield* executionFixture(directory, 67);
          io.respond = async (input) => {
            if (!input.cursor) return page(fixture.records, 0, 64);
            expect(input.checkpoint).toEqual(page(fixture.records).checkpoint);
            return {
              ...page(fixture.records, 64),
              checkpoint: { length: 67, headHash: '00'.repeat(32) },
            };
          };
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toEqual({
            _tag: 'Denied',
            reason: 'unavailable',
          });
          io.respond = async (input) =>
            input.cursor ? page(fixture.records, 64) : page(fixture.records, 0, 64);
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
