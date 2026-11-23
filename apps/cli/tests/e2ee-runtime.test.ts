import { ScheduleRepository } from '@lody/shared/schedule-repository';
import { reuseRuntimeKeyPairs } from './e2ee-runtime-key-pairs';
import type { AuthorityStamp } from '../src/lib/e2ee/authority-clock';
import { executeScheduleCommand } from '../src/lib/schedules/schedule-command-service';
import { getLogger } from '../src/utils/logger';
import {
  E2EE_INTENT_KIND,
  encodeE2eeIntentRecord,
  manualScheduleRunKey,
  scheduleDefinitionFingerprint,
  turnExecutionDigest,
} from '@lody/shared';
import { getScheduleRoomId, type WorkspaceId } from '@lody/shared';
import { LoroRepo } from 'loro-repo';
import { LoroDocumentManager } from '../src/lib/loro/doc';
import { CloudE2eeLedgerOutage } from '../src/lib/cloud-e2ee-errors';
import { randomUUID } from 'node:crypto';
import { resetCliE2eeIdentity } from '../src/lib/e2ee/reset-identity';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Effect, Fiber, Result } from 'effect';
import { LoroDoc, LoroMap } from 'loro-crdt';
import { z } from 'zod';
import { createCloudE2eePort } from '../src/lib/cloud-cli-port';
import {
  StreamsCrdt,
  createInitialRemoteCursor,
  createLoroDocAdapter,
  type JsonObject,
} from '@loro-dev/streams-crdt/loro';
import { fileURLToPath } from 'node:url';
import {
  LoroStreamsTokenPorts,
  makeLoroStreamsTokenProvider,
  makeLoroStreamsTokenWebPorts,
} from '@lody/shared';
import { encodeEpochStagedGroup } from '@lody/e2ee-core/host';
import { startProcessLegacy } from '@lody/shared/node/process';
import { describe, expect, it, vi } from 'vitest';
import {
  Bytes,
  extendLedger,
  hashRecordBytes,
  inspectContentFrame,
  prepareDeviceAdmission,
  prepareEpochEnvelope,
  prepareLedgerCommand,
  signExecutionIntent,
  signGenesisRecord,
  signLedgerRecord,
  verifyLedger,
} from '@lody/e2ee-core/protocol';
import * as rpcLedgerCatchUp from '../src/lib/e2ee/rpc-ledger-catch-up';
import { makeNodeE2eeCustody } from '@lody/e2ee-core/adapters/node-custody';
import { makeCliE2eeCustody } from '../src/lib/e2ee/custody';
import { openMachinePairingJournal } from '../src/lib/e2ee/pairing-journal';
import { Lody } from '../src/lib/lody';
import { makeDesktopLocalPairing } from '../../electron/src/main/services/e2ee-local-pairing.mts';
import {
  activateCliE2eeWorkspaceLegacy,
  openCliE2eePairingRuntimeLegacy,
  openCliE2eeWorkspaceLegacy,
  prepareCliE2eeMachineLegacy,
  retainCliE2eeWorkspaceBinding,
} from '../src/lib/e2ee/workspace-legacy';
import type { CloudE2eePort } from '@lody/platform';
import type { E2eeMailboxRequests } from '@lody/cloud-api';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { execute, hex, iroh, noKeyring, page, setup, wrapper } from './e2ee-runtime-helpers';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
reuseRuntimeKeyPairs();

describe('machine E2EE local runtime', () => {
  it.skipIf(!iroh)(
    'opens the iroh endpoint as the retained ledger device and wipes the handed seed',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-iroh-identity-'));
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const owner = yield* makeNodeE2eeCustody({
                directory: join(directory, 'owner'),
                wrapper,
              });
              const prepared = yield* owner.prepareDevice();
              const signed = yield* signGenesisRecord({
                signer: prepared,
                encryptionPublicKey: prepared.enc,
                initialKey: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(20))),
                userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(30))),
                membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10))),
              });
              yield* owner.retainDevice(signed.genesis, prepared);
              const custody = yield* makeCliE2eeCustody({
                directory: join(directory, 'machine'),
                keyring: noKeyring,
              });
              const machine = yield* custody.createDevice(signed.genesis);
              let handed: Uint8Array | undefined;
              const endpoint = yield* custody.withTransportSeed(
                signed.genesis,
                machine.publicKey,
                (seed) => {
                  handed = seed;
                  return iroh!.openEndpoint(
                    Buffer.from(seed.buffer, seed.byteOffset, seed.byteLength),
                    { relayUrls: [], accept: true }
                  );
                }
              );
              try {
                // Senders dial the ledger signing key; nothing else names this device.
                expect(endpoint.endpointId).toBe(
                  Buffer.from(machine.publicKey.toBytes()).toString('hex')
                );
                expect(handed && handed.every((byte) => byte === 0)).toBe(true);
                // A different identity is refused without opening anything.
                let opened = false;
                const refused = yield* Effect.exit(
                  custody.withTransportSeed(signed.genesis, prepared.publicKey, async () => {
                    opened = true;
                  })
                );
                expect(refused._tag).toBe('Failure');
                expect(opened).toBe(false);
              } finally {
                yield* Effect.promise(() => endpoint.close());
              }
            })
          )
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('signs local Schedule changes with machine custody and refuses other targets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-local-schedules-'));
    vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
    vi.stubEnv('LODY_SESSION_ID', 'stale-daemon-session');
    vi.stubEnv('LODY_AGENT_SESSION_ID', 'stale-daemon-agent');
    vi.stubEnv('LODY_PARENT_SESSION_ID', '');
    let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
    const repo = await LoroRepo.create({});
    let manager: LoroDocumentManager | undefined;
    try {
      const accountId = 'synthetic-schedule-account';
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
      host = await openCliE2eeWorkspaceLegacy({
        machineId: 'machine',
        accountId,
        workspaceId: 'workspace',
        genesisHash: hex(fixture.genesis.toBytes()),
        keyring: noKeyring,
        onUnavailable: () => {},
        cloud: {
          getHistory: async () => page(fixture.records),
          mailboxCall: async (method) => {
            if (method === 'fetch')
              return {
                items: [{ sender: fixture.sender, frameHex: hex(fixture.frame) }],
                next: null,
              };
            if (method === 'report') return null;
            throw new Error('unexpected mailbox operation');
          },
        } as CloudE2eePort,
      });
      await host.refresh();
      const runtime = host;
      const ws = 'workspace' as WorkspaceId;
      manager = new LoroDocumentManager({
        repo,
        workspaceId: ws,
        userId: 'owner',
        metaSub: null,
        logger: getLogger('schedule-test'),
        encryptedWorkspace: runtime,
      });
      await repo.upsertDocMeta('machine-machine', {
        id: 'machine',
        ownerUserId: 'owner',
        protocolCapabilities: { schedules: 2 },
      });
      await repo.upsertDocMeta('agent-agent', {
        id: 'agent',
        machineId: 'machine',
        name: 'Synthetic Agent',
        cliType: 'custom',
        agentType: 'synthetic',
      });
      const context = {
        manager,
        workspace: {
          id: 'workspace',
          name: 'Synthetic',
          slug: 'synthetic',
          contentMode: 'e2ee' as const,
        },
        auth: {
          token: 'synthetic-token',
          userId: 'owner',
          userName: 'Owner',
          userEmail: '',
          machineId: 'machine',
          machineName: 'Synthetic',
        },
        localOnly: true,
      };

      const repository = new ScheduleRepository(repo, ws, {
        protectedContent: true,
        signDeclaration: runtime.signScheduleDeclaration,
      });
      const unsigned = new ScheduleRepository(repo, ws, { protectedContent: true });
      const draft = {
        misfirePolicy: { kind: 'skip' as const },
        overlapPolicy: 'skip' as const,
        retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86400000 },
        title: 'Local task',
        machineId: 'machine',
        prompt: 'Synthetic prompt',
        trigger: { kind: 'manual' as const },
        agent: { agentConfigId: 'agent' },
      };
      const save = (create: boolean, requestId: string, prompt: string) =>
        executeScheduleCommand(context, {
          action: create ? 'create' : 'edit',
          scheduleId: 'local',
          draft: { ...draft, prompt },
          requestId,
        });
      const authorize = async (manualRunKey?: string) => {
        const document = await repository.read('local');
        if (!document) throw new Error('missing schedule');
        const { doc } = await repo.openPersistedDoc(getScheduleRoomId('local'));
        return runtime.authorizeScheduleExecutionLegacy(
          {
            scheduleId: 'local',
            definitionFingerprint: scheduleDefinitionFingerprint(document),
            manualRunKey,
          },
          doc
        );
      };
      await save(true, 'create', draft.prompt);
      expect(await authorize()).toMatchObject({ _tag: 'Authorized' });
      await save(false, 'edit', 'Updated synthetic prompt');
      expect(await authorize()).toMatchObject({ _tag: 'Authorized' });
      await executeScheduleCommand(context, {
        action: 'run',
        scheduleId: 'local',
        requestId: 'before-pause',
      });
      const beforePause = await repository.read('local');
      if (!beforePause) throw new Error('missing pre-pause Schedule');
      const oldRequest = {
        scheduleId: 'local',
        definitionFingerprint: scheduleDefinitionFingerprint(beforePause),
        manualRunKey: manualScheduleRunKey('local', 'before-pause'),
      };
      const before = (await repo.openPersistedDoc(getScheduleRoomId('local'))).doc.toJSON();
      const pause = {
        scheduleId: 'local',
        enabled: false,
        actorId: 'owner',
        now: 2,
        activationId: 'pause',
        requestId: 'pause',
      };
      await unsigned.setEnabled(pause);
      await unsigned.setEnabled(pause);
      expect(await authorize()).toMatchObject({
        _tag: 'Denied',
        reason: 'e2ee_schedule_not_authorized',
      });
      const pausedDoc = (await repo.openPersistedDoc(getScheduleRoomId('local'))).doc;
      expect(pausedDoc.toJSON().scheduleAuthorizations).toEqual(before.scheduleAuthorizations);
      expect((await repository.read('local'))?.definition.activationId).toBe('pause');
      expect(await runtime.authorizeScheduleExecutionLegacy(oldRequest, pausedDoc)).toMatchObject({
        _tag: 'Denied',
      });
      await expect(
        unsigned.requestRun({
          scheduleId: 'local',
          actorId: 'owner',
          manualRunId: 'unsigned-paused',
          now: 3,
        })
      ).rejects.toThrow('e2ee_signature_unavailable');
      await executeScheduleCommand(context, {
        action: 'run',
        scheduleId: 'local',
        requestId: 'paused-run',
      });
      await executeScheduleCommand(context, {
        action: 'run',
        scheduleId: 'local',
        requestId: 'paused-run',
      });
      expect(await authorize(manualScheduleRunKey('local', 'paused-run'))).toMatchObject({
        _tag: 'Authorized',
      });
      expect(await authorize()).toMatchObject({
        _tag: 'Denied',
        reason: 'e2ee_schedule_not_authorized',
      });
      expect((await repository.read('local'))?.definition.enabled).toBe(false);
      await expect(
        unsigned.setEnabled({
          ...pause,
          enabled: true,
          activationId: 'unsigned-resume',
          requestId: 'unsigned-resume',
        })
      ).rejects.toThrow('e2ee_signature_unavailable');
      pausedDoc.getText('prompt').insert(0, 'tampered');
      await expect(
        unsigned.setEnabled({ ...pause, enabled: true, requestId: 'unsigned-resume' })
      ).rejects.toThrow('e2ee_signature_unavailable');
      await executeScheduleCommand(context, {
        action: 'resume',
        scheduleId: 'local',
        requestId: 'resume',
      });
      expect(await authorize()).toMatchObject({ _tag: 'Authorized' });
      // A retry of the old pause cannot replace the newer signed declaration.
      await unsigned.setEnabled(pause);
      expect(await authorize()).toMatchObject({ _tag: 'Authorized' });
      await executeScheduleCommand(context, {
        action: 'run',
        scheduleId: 'local',
        requestId: 'run',
      });
      expect(await authorize(manualScheduleRunKey('local', 'run'))).toMatchObject({
        _tag: 'Authorized',
      });
      const document = await repository.read('local');
      if (!document) throw new Error('missing schedule');
      for (const key of [undefined, manualScheduleRunKey('local', 'foreign')])
        await expect(
          runtime.signScheduleDeclaration(
            { ...document, definition: { ...document.definition, machineId: 'other-machine' } },
            key
          )
        ).rejects.toThrow('personal device');
    } finally {
      if (manager) await manager.cleanUp();
      else {
        await host?.close();
        await repo.destroy();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('selects the new epoch when every key install outlasts its deadline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-slow-key-install-'));
    vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
    vi.stubEnv('LODY_HTTP_TRANSPORT', 'default');
    let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
    let slow = false;
    // Each slow mailbox page waits for the test, which first lets the 10 s deadline pass.
    const pages: { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }[] =
      [];
    let slowFetches = 0;
    const nextPage = () => {
      const signals = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      pages.push(signals);
      return signals;
    };
    try {
      const accountId = 'synthetic-slow-key-account';
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
      vi.stubGlobal('fetch', async () =>
        Response.json({ status: 'success', value: encodeEpochStagedGroup(stagedGroup) })
      );
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
            // A slow link: every mailbox page takes longer than the install deadline.
            if (slow) {
              const page = pages[slowFetches++] ?? nextPage();
              page.entered.resolve();
              await page.release.promise;
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
      expect(await host.status()).toMatchObject({ epoch: 0, epochPhase: 'ready' });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      slow = true;
      const first = nextPage();
      const second = nextPage();
      history = page([...fixture.records, ...fixture.rotationSuffix]);
      void host.refresh();
      await first.entered.promise;
      // The install outlasts its deadline, and the 1 s retry finds it still running.
      await vi.advanceTimersByTimeAsync(11_000);
      first.release.resolve();
      // A finished slow install must select the epoch, not fetch the mailbox again.
      const selected = async () => {
        for (let turn = 0; turn < 500; turn++) {
          if ((await host!.status()).epochPhase === 'ready') return 'selected';
          await new Promise((resolve) => setImmediate(resolve));
        }
        return 'still installing';
      };
      const outcome = await Promise.race([
        second.entered.promise.then(() => 'fetched again'),
        selected(),
      ]);
      second.release.resolve();
      expect(outcome).toBe('selected');
      expect(await host.status()).toMatchObject({
        epoch: 1,
        hasCurrentKey: true,
        epochPhase: 'ready',
      });
    } finally {
      for (const page of pages) page.release.resolve();
      vi.useRealTimers();
      await host?.close();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it.each(['cold-ledger', 'fresh-ledger', 'joined-refresh'] as const)(
    'verifies a signed input across an epoch rotation with %s, without its new key',
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
          inputConfig: {
            prompt: 'SYNTHETIC_AFTER_ROTATION',
            cliType: 'builtin',
            agentType: 'codex',
          },
        };
        // A signed intent depends on no epoch: a rotation the machine has not caught up
        // with yet cannot invalidate an input signed before or after it.
        const e2eeIntent = await execute(
          Effect.gen(function* () {
            const custody = yield* makeNodeE2eeCustody({
              directory: join(directory, 'owner'),
              wrapper,
            });
            const signer = yield* custody.openDevice(fixture.genesis);
            const signature = yield* signExecutionIntent({
              kind: E2EE_INTENT_KIND.memberInput,
              genesis: fixture.genesis,
              workspaceId: 'workspace',
              targetMachineId: 'machine',
              scope: input.sessionId,
              messageId: input.userTurnId,
              contentDigest: Buffer.from(
                turnExecutionDigest({ inputConfig: input.inputConfig })!,
                'hex'
              ),
              signer,
            });
            return encodeE2eeIntentRecord({
              kind: E2EE_INTENT_KIND.memberInput,
              signer: signer.publicKey.toBytes(),
              signature: signature.toBytes(),
            });
          })
        );
        const row = doc.getList('history').insertContainer(0, new LoroMap());
        row.set('id', input.userTurnId);
        row.set('role', 'user');
        row.set('inputConfig', input.inputConfig);
        row.set('e2eeIntent', e2eeIntent);
        doc.commit();
        if (mode === 'joined-refresh') releaseReceive.resolve();
        expect(
          await Effect.runPromise(
            host.resolveVerifiedExecutionOriginal(
              {
                workspaceId: 'workspace',
                sessionId: input.sessionId,
                userTurnId: input.userTurnId,
                inputConfig: input.inputConfig,
              },
              doc
            )
          )
        ).toMatchObject({ requesterDevice: fixture.sender });
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

  it.each(['signature', 'conflict', 'defect'] as const)(
    'keeps retrying background ledger recovery after %s rejection and preserves the verified view',
    async (failure) => {
      const directory = await mkdtemp(join(tmpdir(), 'cli-e2ee-ledger-retry-'));
      vi.stubEnv('LODY_DATA_DIR', join(directory, 'profile'));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let host: Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>> | undefined;
      const authorityConfirmations: AuthorityStamp[] = [];
      let mailboxDown = false;
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
        let pagedHistory: ReturnType<typeof page>[] = [];
        let reads = 0;
        let revision = 0;
        let retryFailed = () => {};
        let reportSent = () => {};
        const cloud = {
          getHistory: async () => {
            reads++;
            return pagedHistory.shift() ?? history;
          },
          mailboxCall: async (
            method: keyof E2eeMailboxRequests,
            input: E2eeMailboxRequests[keyof E2eeMailboxRequests]
          ) => {
            if (mailboxDown) throw new Error('synthetic mailbox failure');
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
          onAuthorityConfirmed: (startedAt) => authorityConfirmations.push(startedAt),
        });
        // A confirmed ledger read wakes every waiting turn (no document named).
        const woken: Array<string | undefined> = [];
        host.subscribeExecutionEvidence((roomId) => woken.push(roomId));
        await host.refresh();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(woken).toContain(undefined);
        expect(authorityConfirmations.length).toBeGreaterThan(0);
        // Key work has its own failures: the verified read below still counts.
        const beforeMailboxFailure = authorityConfirmations.length;
        mailboxDown = true;
        await host.refresh();
        mailboxDown = false;
        expect(authorityConfirmations.length).toBeGreaterThan(beforeMailboxFailure);
        await host.refresh();
        // A signed older prefix is accepted as a no-op, but it is not a latest read.
        const beforeOlderPrefix = authorityConfirmations.length;
        history = page(fixture.records.slice(0, -1));
        await host.refresh();
        expect(authorityConfirmations).toHaveLength(beforeOlderPrefix);
        // The same checkpoint as the trusted head is an ordinary overlapping read.
        history = page(fixture.records);
        await host.refresh();
        expect(authorityConfirmations.length).toBeGreaterThan(beforeOlderPrefix);
        // Every page of one read has to name the checkpoint of the first page.
        const beforeChangedCheckpoint = authorityConfirmations.length;
        const unavailable = Promise.withResolvers<void>();
        retryFailed = unavailable.resolve;
        pagedHistory = [page(fixture.records, 0, 1), page(fixture.records.slice(0, -1), 1)];
        await host.refresh();
        await unavailable.promise;
        retryFailed = () => {};
        expect(authorityConfirmations).toHaveLength(beforeChangedCheckpoint);
        await vi.advanceTimersByTimeAsync(250);
        await host.refresh();
        expect(authorityConfirmations.length).toBeGreaterThan(beforeChangedCheckpoint);
        // A background read that moves back ends an outage window, and a later read reopens one.
        const answer = cloud.getHistory;
        const outageRead = async (): Promise<never> => {
          throw new CloudE2eeLedgerOutage();
        };
        const authorize = () =>
          Effect.runPromise(host!.authorizeExecution('workspace', fixture.sender));
        cloud.getHistory = outageRead;
        const held = await authorize();
        if (held._tag !== 'Authorized') throw new Error('expected an outage authorization');
        expect(held.isCurrent?.()).toBe(true);
        cloud.getHistory = async () => page(fixture.records.slice(0, -1));
        await host.refresh();
        expect(held.isCurrent?.()).toBe(false);
        cloud.getHistory = outageRead;
        await expect(authorize()).resolves.toMatchObject({ _tag: 'Denied' });
        cloud.getHistory = async () => page(fixture.records);
        await host.refresh();
        cloud.getHistory = outageRead;
        await expect(authorize()).resolves.toMatchObject({ _tag: 'Authorized' });
        // An ordinary 15-minute grant does not depend on the window.
        cloud.getHistory = async () => page(fixture.records);
        await host.refresh();
        const fresh = await authorize();
        if (fresh._tag !== 'Authorized') throw new Error('expected a fresh authorization');
        cloud.getHistory = async () => page(fixture.records.slice(0, -1));
        await host.refresh();
        expect(fresh.isCurrent?.()).toBe(true);
        await expect(authorize()).resolves.toMatchObject({ _tag: 'Authorized' });
        cloud.getHistory = answer;
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
        const confirmedBefore = authorityConfirmations.length;
        await host.refresh();
        const before = reads;
        // Retries never stop while the ledger is rejected: they double from 250 ms, capped
        // at five minutes (owner decision 2026-11-10).
        for (const [index, delay] of [250, 500, 1_000, 2_000].entries()) {
          const failed = Promise.withResolvers<void>();
          retryFailed = failed.resolve;
          await vi.advanceTimersByTimeAsync(delay - 1);
          expect(reads - before).toBe(index);
          await vi.advanceTimersByTimeAsync(1);
          expect(reads - before).toBe(index + 1);
          await failed.promise;
        }
        expect((await host.status()).headHash).toBe(verified.headHash);
        expect((await host.status()).length).toBe(verified.length);
        // A refused seal requests one more retry; let that attempt fail before the fix.
        const sealRetry = Promise.withResolvers<void>();
        retryFailed = sealRetry.resolve;
        await expect(protection.config.provider.seal(input)).rejects.toThrow('e2ee_invalid_ledger');
        await sealRetry.promise;
        expect(authorityConfirmations).toHaveLength(confirmedBefore);
        // The next scheduled retry recovers on its own once the history is good again.
        history = page(fixture.records);
        retryFailed = () => undefined;
        const readsBeforeRecovery = reads;
        // However the backoff stands, one five-minute ceiling always includes a retry.
        await vi.advanceTimersByTimeAsync(300_000);
        expect(reads).toBeGreaterThan(readsBeforeRecovery);
        await vi.waitFor(() =>
          expect(authorityConfirmations.length).toBeGreaterThan(confirmedBefore)
        );
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
          // A received frame wakes the turns waiting in its own document.
          const woken: Array<string | undefined> = [];
          const detachEvidence = host.subscribeExecutionEvidence((roomId) => woken.push(roomId));
          await turnProtection.config.provider.open({
            ...original,
            context: input.context,
            additionalData: new Uint8Array([...original.header, 9]),
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          detachEvidence();
          expect(woken).toContain('session-origin');
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
    ['acquire', 'same'],
    ['acquire', 'successor'],
    ['device', 'same'],
    ['device', 'successor'],
  ] as const)(
    'retries replacement with old evidence after %s failure through %s session',
    async (phase, retry) => {
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
        const credentialPath = join(
          root,
          'custody',
          `device-credential-${context.genesisHash}-${original.signingPublicKey}.sealed`
        );
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

  it('takes over an unfinished generation after custody failure without replacing originals or letting the old session publish', async () => {
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
      const credentialPath = join(
        root,
        'custody',
        `device-credential-${context.genesisHash}-${original.signingPublicKey}.sealed`
      );
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
          db.prepare('SELECT material FROM pairings WHERE session=?').get('02'.repeat(16))?.material
        ).toBeNull();
        expect(
          db.prepare('SELECT material FROM pairings WHERE session=?').get(previous.pairingSessionId)
            ?.material
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
  });

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
});
