import { recordScheduleAuthorization } from '@lody/shared/schedule-authorization';
import { readScheduleAuthorization } from '@lody/shared/schedule-authorization';
import { ScheduleRepository } from '@lody/shared/schedule-repository';
import { reuseRuntimeKeyPairs } from './e2ee-runtime-key-pairs';
import { authorizeCliE2eeSessionTarget } from '../src/lib/e2ee/execution-authorization';
import { createDaemonLossRegistry } from '../src/lib/e2ee/client-loss-observer';
import { authorizeEncryptedSchedule } from '../src/lib/e2ee/schedule-execution-authorization';
import {
  decodeE2eeIntentRecord,
  encodeE2eeIntentRecord,
  manualScheduleRunKey,
  scheduleDeclarationSubject,
  scheduleDefinitionFingerprint,
  type ScheduleAuthorizationRequest,
} from '@lody/shared';
import {
  getScheduleRegistryFlockDocId,
  getScheduleRoomId,
  type ScheduleDocument,
  type WorkspaceId,
} from '@lody/shared';
import { ScheduleEngine, type ScheduleEnginePorts } from '../src/lib/schedules/schedule-engine';
import { ScheduleStore } from '../src/lib/schedules/schedule-store';
import { LoroRepo } from 'loro-repo';
import { LoroDocumentManager, SessionDocument } from '../src/lib/loro/doc';
import { prepareSessionInput, resolveTurnDispatchConfig } from '../src/commands/session';
import {
  commitPreparedSessionDispatch,
  materializePreparedSessionInput,
} from '../src/lib/prepared-session-input';
import {
  buildScheduleRunTarget,
  buildScheduleSessionCreateOptions,
  withScheduledMessageInput,
} from '../src/lib/schedules/schedule-run-preparation';
import {
  getSessionRoomId,
  type AgentConfigMeta,
  type MachineMeta,
  type SessionId,
} from '@lody/shared';
import type { AuthContext } from '../src/lib/command-runtime';
import type { WorkspaceSummary } from '../src/lib/workspace';
import { E2eeRpcOriginals, makeE2eeRpcNative } from '@lody/loro-streams-rpc/e2ee-native';
import { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { makeVerifiedExecutionIntent } from '../src/lib/e2ee/execution-intent-verification';
import { lazyExecutionJournal, makeEncryptedAgentExecution } from '../src/lib/e2ee/agent-execution';
import { CloudE2eeLedgerOutage } from '../src/lib/cloud-e2ee-errors';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Clock, Effect, Fiber, Result } from 'effect';
import { LoroDoc, LoroMap } from 'loro-crdt';
import { describe, expect, it, vi } from 'vitest';
import { it as effectIt } from '@effect/vitest';
import { TestClock } from 'effect/testing';
import {
  Bytes,
  extendLedger,
  hashRecordBytes,
  prepareDeviceAdmission,
  prepareJoinRequest,
  prepareLedgerCommand,
  signExecutionIntent,
  signLedgerRecord,
} from '@lody/e2ee-core/protocol';
import { makeNodeE2eeCustody } from '@lody/e2ee-core/adapters/node-custody';
import { makeCliE2eeCustody } from '../src/lib/e2ee/custody';
import { makeCliE2eeRuntime } from '../src/lib/e2ee/runtime';
import { makeCliE2eeExecutionAuthorization } from '../src/lib/e2ee/execution-authorization';
import {
  execute,
  executionFixture,
  hex,
  memberAccount,
  noKeyring,
  ownerAccount,
  page,
  queuedInputHarness,
  queuedSessionId,
  queuedTimestamp,
  run,
  setup,
  testDeclarationSigner,
  testIntentSigner,
  testMachineInputSigner,
  wrapper,
} from './e2ee-runtime-helpers';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
reuseRuntimeKeyPairs();

describe('encrypted queued input evidence', () => {
  it('keeps the machine account for an owner device input', () =>
    run(false, (h) =>
      Effect.gen(function* () {
        yield* h.send('owner-label-turn', h.ownerRpc);
        const turn = yield* h.promote();
        expect(
          yield* h.execution.resolveRequester({
            workspaceId: 'workspace',
            sessionId: queuedSessionId,
            userTurnId: turn.id,
            inputConfig: turn.inputConfig,
          })
        ).toEqual({ userId: ownerAccount });
        expect(yield* h.claim(turn)).toMatchObject({ state: 'claimed', principal: 'owner' });
      })
    ));

  it.each([
    ['shared', true, { allowed: true }],
    ['unshared', false, { allowed: false, reason: 'not_visible' }],
  ] as const)('decides a %s member machine access locally', (_name, shared, expected) =>
    run(shared, (h) =>
      Effect.gen(function* () {
        expect(yield* h.execution.verifyRequesterAccess(h.memberRequester)).toEqual(expected);
      })
    )
  );

  it('reaches another machine only as this machine owner', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        expect(yield* h.execution.verifyMachineTarget(h.memberRequester, 'other-machine')).toEqual({
          allowed: false,
          reason: 'not_visible',
        });
        expect(yield* h.execution.verifyMachineTarget(ownerAccount, 'other-machine')).toEqual({
          allowed: true,
        });
      })
    ));

  it('routes encrypted machine access away from the workspace service', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        const { MessageHandler } = yield* Effect.promise(
          () => import('../src/lib/message-handler')
        );
        const handler = Object.create(MessageHandler.prototype) as InstanceType<
          typeof MessageHandler
        >;
        let asked = 0;
        Object.assign(handler, {
          encryptedExecution: h.execution,
          machineId: 'machine',
          userId: ownerAccount,
          cloudPort: {
            access: {
              verifyMachineAccess: async () => {
                asked += 1;
                return { allowed: true };
              },
            },
          },
        });
        const check = handler as unknown as {
          checkEncryptedMachineAccess: (target: {
            machineId: string;
            requesterUserId: string;
          }) => Promise<unknown>;
          verifyRequesterMachineAccess: (input: { requesterUserId: string }) => Promise<unknown>;
        };
        const allowed = { allowed: true };
        expect(
          yield* Effect.promise(() =>
            check.checkEncryptedMachineAccess({
              machineId: 'machine',
              requesterUserId: h.memberRequester,
            })
          )
        ).toEqual(allowed);
        expect(
          yield* Effect.promise(() =>
            check.verifyRequesterMachineAccess({ requesterUserId: h.memberRequester })
          )
        ).toEqual(allowed);
        expect(asked).toBe(0);
      })
    ));

  it.each([
    ['ios-simulator', 'iosSimulatorService'],
    ['android-emulator', 'androidEmulatorService'],
  ] as const)('applies the member device gate to %s agent control', (kind, service) =>
    run(true, (h) =>
      Effect.gen(function* () {
        const { MessageHandler } = yield* Effect.promise(
          () => import('../src/lib/message-handler')
        );
        const handler = Object.create(MessageHandler.prototype) as InstanceType<
          typeof MessageHandler
        >;
        let controlled = 0;
        Object.assign(handler, {
          encryptedExecution: {
            ...h.execution,
            authorizeAgentControl: () => Effect.succeed(false),
          },
          executionService: {
            getActiveInvocationContext: () => ({ requesterUserId: h.memberRequester }),
            getEncryptedControlPrincipal: () => ({
              kind: 'member',
              requesterDevice: 'device',
              localProjectIds: [],
            }),
          },
          [service]: {
            controlFromAgent: async () => {
              controlled += 1;
              return { success: true };
            },
          },
        });
        const response = yield* Effect.promise(() =>
          (
            handler as unknown as {
              dispatchLocalMachineRpc: (request: unknown) => Promise<{ error?: string }>;
            }
          ).dispatchLocalMachineRpc({
            method: `${kind}/agent-control`,
            params: { sessionId: 'session', command: {} },
          })
        );
        expect(response).toMatchObject({ success: false, error: 'denied' });
        expect(controlled).toBe(0);
      })
    )
  );

  it('keeps a derived start pending when current root authority is temporarily unavailable', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        yield* h.writeMemberRow('root', memberAccount);
        const child = yield* h.writeDerivedRow('child', 'root');
        h.io.wall += 15 * 60_000;
        h.io.monotonic += 15 * 60_000;
        h.io.offline = true;
        expect(
          yield* h.execution.resolveRequester({
            workspaceId: 'workspace',
            sessionId: queuedSessionId,
            userTurnId: child.id,
            inputConfig: child.inputConfig,
          })
        ).toEqual({ state: 'pending' });
        expect(yield* h.rawClaim({ ...child, userId: h.memberRequester })).toEqual({
          state: 'pending-evidence',
        });
        h.io.offline = false;
        expect((yield* h.claim(child)).state).toBe('claimed');
      })
    ));

  it('starts all twenty-two same-machine Owner descendants of one personal-device root', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        yield* h.send('owner-root', h.ownerRpc);
        expect((yield* h.claim(yield* h.promote())).state).toBe('claimed');
        for (let i = 1; i <= 22; i++) {
          const child = yield* h.writeDerivedRow(`owner-child-${i}`, 'owner-root');
          expect(yield* h.claim(child)).toMatchObject({ state: 'claimed', principal: 'owner' });
        }
      })
    ));

  it('verifies and starts Owner cross-machine delegation without local-only provenance', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        yield* h.send('owner-root', h.ownerRpc);
        expect((yield* h.claim(yield* h.promote())).state).toBe('claimed');
        const target = yield* h.makeRemoteExecution();
        const { MessageHandler } = yield* Effect.promise(
          () => import('../src/lib/message-handler')
        );
        const handler = Object.assign(Object.create(MessageHandler.prototype), {
          encryptedExecution: h.execution,
          machineId: 'machine',
          executionService: {
            getActiveInvocationContext: () => ({ sourceTurnId: 'owner-root' }),
            getEncryptedControlPrincipal: () => ({ kind: 'owner' }),
          },
        }) as {
          classifyEncryptedDerivation: (
            ref: { sessionId: string; userTurnId: string },
            target: { machineId: string; userTurnId: string }
          ) => Promise<unknown>;
        };
        expect(
          yield* Effect.promise(() =>
            handler.classifyEncryptedDerivation(
              { sessionId: queuedSessionId, userTurnId: 'owner-root' },
              { machineId: 'machine', userTurnId: 'same-machine-child' }
            )
          )
        ).toEqual({
          principal: 'owner',
          origin: { sessionId: queuedSessionId, userTurnId: 'owner-root' },
        });
        const classification = yield* Effect.promise(() =>
          handler.classifyEncryptedDerivation(
            { sessionId: queuedSessionId, userTurnId: 'owner-root' },
            { machineId: 'machine-B', userTurnId: 'remote-child' }
          )
        );
        expect(classification).toBe('owner');
        const inputConfig = h.clientConfig('remote-child');
        const e2eeIntent = yield* h.signIntent(
          h.device,
          'remote-child',
          inputConfig,
          {},
          'machine-B'
        );
        yield* Effect.promise(() =>
          h.session.sessionData.commands.appendTurn({
            id: 'remote-child',
            role: 'user',
            userId: ownerAccount,
            status: 'pending',
            timestamp: queuedTimestamp,
            inputConfig,
            e2eeIntent,
            items: [{ type: 'text', text: 'remote child' }],
            fileDiff: [],
          } as never)
        );
        h.doc.commit();
        expect(
          yield* target.claim({
            workspaceId: 'workspace',
            sessionId: queuedSessionId,
            userTurnId: 'remote-child',
            requesterUserId: ownerAccount,
            inputConfig,
          })
        ).toMatchObject({ state: 'claimed', principal: 'owner' });
        let active = true;
        const nextHandler = Object.assign(Object.create(MessageHandler.prototype), {
          encryptedExecution: target,
          machineId: 'machine-B',
          executionService: {
            getActiveInvocationContext: () =>
              active ? { sourceTurnId: 'remote-child' } : undefined,
            getEncryptedControlPrincipal: () => (active ? { kind: 'owner' } : undefined),
          },
        }) as typeof handler;
        // Both a live second hop and Operation recovery use B's own machine-signed path.
        for (const running of [true, false]) {
          active = running;
          for (const machineId of ['machine-B', 'machine-C']) {
            expect(
              yield* Effect.promise(() =>
                nextHandler.classifyEncryptedDerivation(
                  { sessionId: queuedSessionId, userTurnId: 'remote-child' },
                  { machineId, userTurnId: `next-${running}-${machineId}` }
                )
              )
            ).toBe('owner');
          }
        }
        yield* h.append({ _tag: 'RevokeDevice', target: h.device.publicKey });
        for (const machineId of ['machine-B', 'machine-C']) {
          yield* Effect.promise(() =>
            expect(
              nextHandler.classifyEncryptedDerivation(
                { sessionId: queuedSessionId, userTurnId: 'remote-child' },
                { machineId, userTurnId: `revoked-${machineId}` }
              )
            ).rejects.toThrow('e2ee_derivation_denied')
          );
        }
        yield* h.append({ _tag: 'RevokeDevice', target: h.fixture.owner.publicKey });
        yield* Effect.promise(() =>
          expect(
            handler.classifyEncryptedDerivation(
              { sessionId: queuedSessionId, userTurnId: 'owner-root' },
              { machineId: 'machine-B', userTurnId: 'after-revocation' }
            )
          ).rejects.toThrow('e2ee_derivation_denied')
        );
      })
    ));

  it('retains the shared root quota after fifteen starts and a journal/execution restart', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        yield* h.writeMemberRow('quota-root', memberAccount);
        for (let i = 1; i <= 21; i++) {
          if (i === 16) h.restartExecution();
          const turn = yield* h.writeDerivedRow(
            `quota-child-${i}`,
            i === 1 ? 'quota-root' : `quota-child-${i - 1}`
          );
          expect((yield* h.claim(turn)).state).toBe(i <= 20 ? 'claimed' : 'denied');
        }
      })
    ));

  it.each(['member', 'owner'] as const)(
    'flattens %s multi-hop delegation to its signed root',
    (principal) =>
      run(true, (h) =>
        Effect.gen(function* () {
          yield* h.send('root', principal === 'owner' ? h.ownerRpc : h.memberRpc);
          const rootTurn = yield* h.promote();
          expect((yield* h.claim(rootTurn)).state).toBe('claimed');
          const child = yield* h.writeDerivedRow('child', 'root');
          expect(yield* h.claim(child)).toMatchObject({
            state: 'claimed',
            principal: principal === 'owner' ? 'owner' : 'derived',
          });
          const grandchild = yield* h.writeDerivedRow('grandchild', 'child');
          expect(h.historyRow('grandchild').toJSON().derivedFrom).toEqual({
            sessionId: queuedSessionId,
            userTurnId: 'root',
          });
          expect((yield* h.claim(grandchild)).state).toBe('claimed');
        })
      )
  );

  it.each(['removed', 'revoked', 'unshared', 'owner-revoked'] as const)(
    'refuses pending descendants and new derivations when the root is %s',
    (mode) =>
      run(true, (h) =>
        Effect.gen(function* () {
          if (mode === 'owner-revoked') {
            yield* h.send('root', h.ownerRpc);
            yield* h.promote();
          } else yield* h.writeMemberRow('root', memberAccount);
          const child = yield* h.writeDerivedRow('child', 'root');
          expect((yield* h.claim(child)).state).toBe('claimed');
          const grandchild = yield* h.writeDerivedRow('grandchild', 'child');
          if (mode === 'removed') {
            yield* h.append({ _tag: 'DeclareCapabilities', capabilities: [1] });
            yield* h.append({ _tag: 'RemoveMember', membershipId: h.membershipId });
          } else if (mode === 'revoked') {
            yield* h.append({ _tag: 'RevokeDevice', target: h.member.publicKey }, h.member);
          } else if (mode === 'owner-revoked') {
            yield* h.append({ _tag: 'RevokeDevice', target: h.fixture.owner.publicKey });
          } else h.sharing.allowed = false;
          expect(
            yield* h.execution.classifyOrigin({ sessionId: queuedSessionId, userTurnId: 'child' })
          ).toBe('denied');
          expect(
            yield* h.execution.resolveRequester({
              workspaceId: 'workspace',
              sessionId: queuedSessionId,
              userTurnId: grandchild.id,
              inputConfig: grandchild.inputConfig,
            })
          ).toEqual({ state: 'denied' });
          expect((yield* h.claim(grandchild)).state).toBe('denied');
          expect(yield* Effect.result(h.writeDerivedRow('later', 'child'))).toMatchObject({
            _tag: 'Failure',
          });
        })
      )
  );

  it('classifies a derivation origin by the queued input signer', () =>
    run(true, (h) =>
      Effect.gen(function* () {
        yield* h.send('origin-member', h.memberRpc);
        yield* h.promote();
        expect(
          yield* h.execution.classifyOrigin({
            sessionId: queuedSessionId,
            userTurnId: 'origin-member',
          })
        ).toBe('member');
        yield* h.send('origin-bare');
        yield* h.promote();
        expect(
          yield* h.execution.classifyOrigin({
            sessionId: queuedSessionId,
            userTurnId: 'origin-bare',
          })
        ).toBe('denied');
      })
    ));
});

describe('machine execution authorization freshness', () => {
  it('waits for a ledger read that is unavailable instead of refusing the turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'execution-unavailable-'));
    try {
      await execute(
        Effect.gen(function* () {
          let authorization: { _tag: 'Authorized' } | { _tag: 'Denied'; reason: 'unavailable' } = {
            _tag: 'Denied',
            reason: 'unavailable',
          };
          let journalNow = 0;
          const gate = makeEncryptedAgentExecution({
            machineUserId: 'synthetic-machine-account',
            genesis: '11'.repeat(32),
            workspaceId: 'workspace',
            targetMachineId: 'machine',
            journal: lazyExecutionJournal(join(directory, 'execution.sqlite'), () => journalNow),
            resolveVerifiedOriginal: () =>
              Effect.succeed({
                requesterDevice: 'aa'.repeat(32),
                requesterCryptoUserId: 'bb'.repeat(32),
              }),
            authorizeExecution: () => Effect.sync(() => authorization),
          });
          const intent = (userTurnId: string) => ({
            workspaceId: 'workspace',
            sessionId: 'session',
            userTurnId,
            requesterUserId: 'synthetic-member',
            inputConfig: { prompt: userTurnId },
          });
          // A slow or failed read decides nothing: the turn waits, however long it takes.
          expect((yield* gate.claim(intent('slow-backend'))).state).toBe('pending-evidence');
          journalNow += 3 * 24 * 60 * 60_000;
          expect((yield* gate.claim(intent('slow-backend'))).state).toBe('pending-evidence');
          authorization = { _tag: 'Authorized' };
          expect((yield* gate.claim(intent('slow-backend'))).state).toBe('claimed');
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
            signDeclaration: testDeclarationSigner(fixture.genesis, 'workspace', sourceSigner),
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
            genesis: fixture.genesis,
            doc: scheduleDoc,
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
          const resolve = makeVerifiedExecutionIntent({
            workspaceId: 'workspace',
            genesis: fixture.genesis,
            selfDevice: hex(device.publicKey.toBytes()),
            isClosed: () => false,
            readIncoming: () => Effect.succeed(undefined),
            openDispatch: () => Effect.die('no realtime request in this test'),
            ledger: runtime.executionLedger,
            refreshLedger: authorization.refreshLedger,
          });
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
            isEncryptedWorkspace: () => true,
            signMachineInput: testMachineInputSigner(fixture.genesis, 'workspace', device),
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
              machineUserId: 'synthetic-machine-account',
              genesis: hex(fixture.genesis.toBytes()),
              workspaceId: 'workspace',
              targetMachineId: 'machine',
              journal: lazyExecutionJournal(join(directory, 'execution.sqlite'), () => 0),
              resolveVerifiedOriginal: (input) => resolve(input, handle.doc),
              authorizeExecution: authorization.authorizeExecution,
              ...(mode !== 'no-source-capability'
                ? {
                    authorizeSchedule:
                      mode === 'pending-source'
                        ? () =>
                            Effect.succeed({
                              _tag: 'Denied' as const,
                              reason: 'unavailable',
                            })
                        : authorizeSchedule,
                  }
                : {}),
            });
          const execution = makeExecution();
          // The machine signed its own scheduled input when it wrote it; no frame is needed.
          expect(yield* resolve(intent, handle.doc)).toMatchObject({
            requesterDevice: hex(device.publicKey.toBytes()),
          });
          if (mode === 'tampered-before-claim') {
            const prompt = scheduleDoc.getText('prompt');
            prompt.insert(0, 'Changed: ');
            scheduleDoc.commit();
          }
          const claim = yield* execution.claim(intent);
          if (mode === 'pending-source') {
            // Waiting on an unavailable read never turns into a refusal over time.
            expect(claim.state).toBe('pending-evidence');
            yield* TestClock.adjust(3 * 24 * 60 * 60_000);
            expect((yield* execution.claim(intent)).state).toBe('pending-evidence');
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
            signDeclaration: testDeclarationSigner(fixture.genesis, ws, attacker),
          });
          /** The device that signed the current definition declaration, from the record itself. */
          const declarationSigner = (doc: LoroDoc) => {
            const value = readScheduleAuthorization(doc)?.value as
              | { e2eeIntent?: string }
              | undefined;
            const record = decodeE2eeIntentRecord(value?.e2eeIntent);
            return record ? hex(record.signer) : undefined;
          };
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
              item.apply(opened.plaintext.subarray(4));
              opened.plaintext.fill(0);
            }
          });
          yield* transfer(sourceDoc.doc, sourceRegistry.flock, attacker);
          const forged = yield* Effect.promise(() =>
            new ScheduleRepository(repo, ws).read('forged-owner')
          );
          if (!forged) throw new Error('missing forged schedule');
          // Caller-controlled actorId names the owner; the signature names the attacker.
          expect(declarationSigner(targetDoc.doc)).toBe(hex(attacker.publicKey.toBytes()));
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
                    genesis: fixture.genesis,
                    request,
                    doc: targetDoc.doc,
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
            signDeclaration: testDeclarationSigner(fixture.genesis, ws, fixture.owner),
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
          expect(declarationSigner(targetDoc.doc)).toBe(hex(fixture.owner.publicKey.toBytes()));
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
        /** A setter's device signs the declaration over the fingerprint it computes. */
        const declarationSigner =
          (signer: Parameters<typeof signExecutionIntent>[0]['signer']) =>
          async (
            declared: Parameters<typeof scheduleDeclarationSubject>[0],
            manualRunKey?: string
          ) => {
            const subject = scheduleDeclarationSubject(declared, manualRunKey);
            const signature = await Effect.runPromise(
              signExecutionIntent({
                ...subject,
                genesis: fixture.genesis,
                workspaceId: ws,
                contentDigest: Buffer.from(subject.contentDigest, 'hex'),
                signer,
              })
            );
            return encodeE2eeIntentRecord({
              kind: subject.kind,
              signer: signer.publicKey.toBytes(),
              signature: signature.toBytes(),
            });
          };
        const repository = new ScheduleRepository(repo, ws, {
          protectedContent: true,
          signDeclaration: declarationSigner(writer),
        });
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
        let request: ScheduleAuthorizationRequest = {
          scheduleId: 'proof',
          definitionFingerprint: scheduleDefinitionFingerprint(document),
        };
        const authorize = (concurrent: false | 'execution' | 'timeline' = false) =>
          authorizeEncryptedSchedule({
            workspaceId: ws,
            genesis: fixture.genesis,
            request,
            doc,
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
            // The signed declaration is part of the document state, so a snapshot carries it.
            expect(
              (yield* authorizeEncryptedSchedule({
                workspaceId: ws,
                genesis: fixture.genesis,
                request,
                doc: snapshot,
                isExecutionOpen: () => true,
                authorizeExecution: gate.authorizeExecution,
              }))._tag
            ).toBe('Authorized');
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
            const manualRepository =
              mutation === 'manual-valid-other-device'
                ? new ScheduleRepository(repo, ws, {
                    protectedContent: true,
                    signDeclaration: declarationSigner(fixture.owner),
                  })
                : repository;
            yield* Effect.promise(() =>
              manualRepository.requestRun({
                scheduleId: 'proof',
                actorId: 'display-owner',
                manualRunId: 'manual',
                now: 0,
              })
            );
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
          expect((yield* authorize('timeline'))._tag).toBe('Authorized');
          return;
        }
        if (mutation === 'concurrent-edit') {
          expect((yield* authorize('execution'))._tag).toBe('Denied');
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
        // The signature covers content, never document operations: rewriting the same value
        // changes nothing that runs, while any other change needs a new declaration.
        expect((yield* authorize())._tag).toBe(mutation === 'same-value' ? 'Authorized' : 'Denied');
        // A deliberate owner save can authorize the newly displayed definition.
        recordScheduleAuthorization(
          doc,
          changed,
          undefined,
          yield* Effect.promise(() => declarationSigner(writer)(changed))
        );
        if (mutation === 'enabled') {
          expect(yield* authorize()).toMatchObject({
            _tag: 'Denied',
            reason: 'e2ee_schedule_not_authorized',
          });
          return;
        }
        expect((yield* authorize())._tag).toBe('Authorized');
        // A declaration without a signature never authorizes, whoever wrote it.
        recordScheduleAuthorization(doc, changed);
        expect(yield* authorize()).toMatchObject({
          _tag: 'Denied',
          reason: 'e2ee_signature_missing',
        });
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

  describe('backend outage windows', () => {
    const FIFTEEN_MINUTES = 900_000;
    const HOUR = 3_600_000;
    const withOutage = (
      body: (
        input: Effect.Success<ReturnType<typeof executionFixture>>
      ) => Effect.Effect<void, unknown>
    ) =>
      (async () => {
        const directory = await mkdtemp(join(tmpdir(), 'execution-outage-'));
        try {
          await execute(
            Effect.gen(function* () {
              const fixture = yield* executionFixture(directory);
              const { gate, io } = fixture;
              expect(
                yield* gate.authorizeExecution('workspace', fixture.fixture.sender)
              ).toMatchObject({ _tag: 'Authorized' });
              io.respond = async () => {
                throw new CloudE2eeLedgerOutage();
              };
              yield* body(fixture);
            })
          );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      })();
    const at = (io: { wall: number; monotonic: number }, ms: number) => {
      io.wall = io.monotonic = ms;
    };

    it('keeps the same member executing for 4 hours from the last successful read', () =>
      withOutage(({ fixture, gate, io }) =>
        Effect.gen(function* () {
          at(io, FIFTEEN_MINUTES);
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
            principal: 'owner',
          });
          at(io, 4 * HOUR - 1);
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
          at(io, 4 * HOUR);
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toEqual({
            _tag: 'Denied',
            reason: 'unavailable',
          });
        })
      ));

    it('keeps the same member reading for 24 hours from the last successful read', () =>
      withOutage(({ fixture, gate, io }) =>
        Effect.gen(function* () {
          at(io, 24 * HOUR - 1);
          expect(yield* gate.authorizeRead('workspace', fixture.sender)).toEqual({
            _tag: 'Authorized',
          });
          at(io, 24 * HOUR);
          expect(yield* gate.authorizeRead('workspace', fixture.sender)).toEqual({
            _tag: 'Denied',
            reason: 'unavailable',
          });
        })
      ));

    it('keeps owner session reads for 24 hours, including after execution expires', () =>
      withOutage(({ fixture, gate, io }) =>
        Effect.gen(function* () {
          for (const time of [5 * HOUR, 24 * HOUR - 1]) {
            at(io, time);
            expect(
              yield* gate.authorizeSessionRead('workspace', fixture.sender, 'session')
            ).toMatchObject({ _tag: 'Authorized' });
          }
          at(io, 24 * HOUR);
          expect(yield* gate.authorizeSessionRead('workspace', fixture.sender, 'session')).toEqual({
            _tag: 'Denied',
            reason: 'unavailable',
          });
        })
      ));

    it('ends a window on any other read failure until a read succeeds', () =>
      withOutage(({ fixture, gate, io }) =>
        Effect.gen(function* () {
          at(io, FIFTEEN_MINUTES);
          io.respond = async () => {
            throw new Error('e2ee_device_unauthorized');
          };
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Denied',
          });
          at(io, FIFTEEN_MINUTES + 120_000);
          io.respond = async () => {
            throw new CloudE2eeLedgerOutage();
          };
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Denied',
          });
          io.respond = async () => page(fixture.records);
          at(io, FIFTEEN_MINUTES + 240_000);
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
        })
      ));

    it('does not relax when no read has succeeded', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'execution-outage-cold-'));
      try {
        await execute(
          Effect.gen(function* () {
            const { fixture, gate, io } = yield* executionFixture(directory);
            io.respond = async () => {
              throw new CloudE2eeLedgerOutage();
            };
            expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toEqual({
              _tag: 'Denied',
              reason: 'unavailable',
            });
          })
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('keeps execution and reads after a 30-minute suspend, then expires on wall time', () =>
      withOutage(({ fixture, gate, io }) =>
        Effect.gen(function* () {
          io.wall = 30 * 60_000;
          io.monotonic = 5_000;
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
          expect(yield* gate.authorizeRead('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
          io.wall = 4 * HOUR - 1;
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
          io.wall++;
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Denied',
          });
          io.wall = 24 * HOUR - 1;
          expect(yield* gate.authorizeRead('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
          io.wall++;
          expect(yield* gate.authorizeRead('workspace', fixture.sender)).toMatchObject({
            _tag: 'Denied',
          });
        })
      ));

    it('uses monotonic elapsed time through a three-minute NTP rollback', () =>
      withOutage(({ fixture, gate, io }) =>
        Effect.gen(function* () {
          io.wall = -3 * 60_000;
          io.monotonic = 5_000;
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
          io.monotonic = 4 * HOUR - 1;
          io.wall = io.monotonic - 3 * 60_000;
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
          io.monotonic++;
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Denied',
          });
          io.monotonic = 24 * HOUR - 1;
          io.wall = io.monotonic - 3 * 60_000;
          expect(yield* gate.authorizeRead('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
          io.monotonic++;
          expect(yield* gate.authorizeRead('workspace', fixture.sender)).toMatchObject({
            _tag: 'Denied',
          });
        })
      ));

    it('does not wait on the backend for every request during an outage', () =>
      withOutage(({ fixture, gate, io }) =>
        Effect.gen(function* () {
          at(io, FIFTEEN_MINUTES);
          yield* gate.authorizeExecution('workspace', fixture.sender);
          const reads = io.reads;
          at(io, FIFTEEN_MINUTES + 1_000);
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
          expect(io.reads).toBe(reads);
          at(io, FIFTEEN_MINUTES + 61_000);
          yield* gate.authorizeExecution('workspace', fixture.sender);
          yield* Effect.yieldNow;
          expect(io.reads).toBe(reads + 1);
        })
      ));

    it('counts a background ledger read as the last successful read', () =>
      withOutage(({ fixture, gate, io }) =>
        Effect.gen(function* () {
          at(io, 3 * HOUR);
          gate.beginLatestRead()();
          at(io, 6 * HOUR);
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
        })
      ));

    it('reports the window while it is in use', () =>
      withOutage(({ fixture, io, makeGate }) =>
        Effect.gen(function* () {
          const notices: boolean[] = [];
          const windows: unknown[] = [];
          const noticed = yield* makeGate(undefined, (notice, window) => {
            notices.push(notice);
            windows.push(window);
          });
          io.respond = async () => page(fixture.records);
          // The window is measured from this last successful read, not from the outage.
          const lastRead = io.wall;
          yield* noticed.authorizeExecution('workspace', fixture.sender);
          io.respond = async () => {
            throw new CloudE2eeLedgerOutage();
          };
          at(io, FIFTEEN_MINUTES);
          yield* noticed.authorizeExecution('workspace', fixture.sender);
          expect(notices).toEqual([true]);
          expect(windows).toEqual([
            { executionUntilMs: lastRead + 4 * HOUR, readUntilMs: lastRead + 24 * HOUR },
          ]);
          io.respond = async () => page(fixture.records);
          at(io, FIFTEEN_MINUTES + 120_000);
          yield* noticed.authorizeExecution('workspace', fixture.sender);
          expect(notices).toEqual([true, false]);
        })
      ));

    it('invalidates an outage authorization when the window ends', () =>
      withOutage(({ fixture, gate, io }) =>
        Effect.gen(function* () {
          at(io, FIFTEEN_MINUTES);
          const granted = yield* gate.authorizeExecution('workspace', fixture.sender);
          if (granted._tag !== 'Authorized') throw new Error('expected an outage authorization');
          expect(granted.isCurrent?.()).toBe(true);
          io.respond = async () => {
            throw new Error('e2ee_device_unauthorized');
          };
          at(io, FIFTEEN_MINUTES + 120_000);
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Denied',
          });
          expect(granted.isCurrent?.()).toBe(false);
        })
      ));

    it('keeps a held authorization through suspend and clock correction', () =>
      withOutage(({ fixture, gate, io }) =>
        Effect.gen(function* () {
          at(io, FIFTEEN_MINUTES);
          const granted = yield* gate.authorizeExecution('workspace', fixture.sender);
          if (granted._tag !== 'Authorized') throw new Error('expected an outage authorization');
          io.wall += 30 * 60_000;
          expect(granted.isCurrent?.()).toBe(true);
          io.wall -= 3 * 60_000;
          expect(granted.isCurrent?.()).toBe(true);
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
          io.monotonic = 4 * HOUR;
          expect(granted.isCurrent?.()).toBe(false);
        })
      ));

    it('keeps the read window after a held execution authorization expires', () =>
      withOutage(({ fixture, gate, io }) =>
        Effect.gen(function* () {
          at(io, FIFTEEN_MINUTES);
          const granted = yield* gate.authorizeExecution('workspace', fixture.sender);
          if (granted._tag !== 'Authorized') throw new Error('expected an outage authorization');
          at(io, 5 * HOUR);
          expect(granted.isCurrent?.()).toBe(false);
          expect(yield* gate.authorizeRead('workspace', fixture.sender)).toEqual({
            _tag: 'Authorized',
          });
        })
      ));

    it('keeps the longer read window after execution expires', () =>
      withOutage(({ fixture, gate, io }) =>
        Effect.gen(function* () {
          at(io, 5 * HOUR);
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Denied',
          });
          expect(yield* gate.authorizeRead('workspace', fixture.sender)).toEqual({
            _tag: 'Authorized',
          });
        })
      ));

    it('keeps shared execution and session reads within 15 minutes without an extended-window notice', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'execution-outage-shared-'));
      try {
        await execute(
          Effect.gen(function* () {
            const { fixture, makeGate, io } = yield* executionFixture(directory, 3);
            const state = fixture.current.inspectState();
            const member = [...state.devices].find(
              ([, device]) =>
                state.members.get(hex(device.membershipId.toBytes()))?.role === 'member'
            );
            if (!member) throw new Error('missing member device');
            const [requester] = member;
            let shared = true;
            const notices: boolean[] = [];
            const gate = yield* makeGate(
              () => Effect.succeed({ allowed: shared, isCurrent: () => shared }),
              (active) => notices.push(active),
              (_device, session) =>
                Effect.succeed({ allowed: shared && session === 'shared', isCurrent: () => shared })
            );
            yield* gate.refreshLedger;
            io.respond = async () => {
              throw new CloudE2eeLedgerOutage();
            };
            at(io, 60_000);
            const execution = yield* gate.authorizeExecution('workspace', requester);
            const read = yield* gate.authorizeSessionRead('workspace', requester, 'shared');
            expect(execution).toMatchObject({ _tag: 'Authorized', principal: 'member' });
            expect(read).toMatchObject({ _tag: 'Authorized' });
            if (execution._tag !== 'Authorized' || read._tag !== 'Authorized')
              throw new Error('missing shared grants');
            expect(execution.isCurrent?.()).toBe(true);
            expect(read.isCurrent?.()).toBe(true);
            expect(
              yield* gate.authorizeSessionRead('workspace', requester, 'private')
            ).toMatchObject({ _tag: 'Denied' });
            shared = false;
            expect(execution.isCurrent?.()).toBe(false);
            expect(read.isCurrent?.()).toBe(false);
            expect(yield* gate.authorizeExecution('workspace', requester)).toMatchObject({
              _tag: 'Denied',
            });
            expect(
              yield* gate.authorizeSessionRead('workspace', requester, 'shared')
            ).toMatchObject({ _tag: 'Denied' });
            shared = true;
            at(io, FIFTEEN_MINUTES - 1);
            expect(yield* gate.authorizeExecution('workspace', requester)).toMatchObject({
              _tag: 'Authorized',
            });
            expect(
              yield* gate.authorizeSessionRead('workspace', requester, 'shared')
            ).toMatchObject({ _tag: 'Authorized' });
            at(io, FIFTEEN_MINUTES);
            expect(execution.isCurrent?.()).toBe(false);
            expect(read.isCurrent?.()).toBe(false);
            expect(yield* gate.authorizeExecution('workspace', requester)).toEqual({
              _tag: 'Denied',
              reason: 'unavailable',
            });
            expect(yield* gate.authorizeSessionRead('workspace', requester, 'shared')).toEqual({
              _tag: 'Denied',
              reason: 'unavailable',
            });
            expect(notices).toEqual([]);
          })
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('keeps another member at 15 minutes', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'execution-outage-member-'));
      try {
        await execute(
          Effect.gen(function* () {
            const { gate, io, member } = yield* queuedInputHarness(directory, true);
            const memberDevice = hex(member.publicKey.toBytes());
            expect(yield* gate.authorizeExecution('workspace', memberDevice)).toMatchObject({
              _tag: 'Authorized',
              principal: 'member',
            });
            io.respond = async () => {
              throw new CloudE2eeLedgerOutage();
            };
            at(io, FIFTEEN_MINUTES);
            expect(yield* gate.authorizeExecution('workspace', memberDevice)).toEqual({
              _tag: 'Denied',
              reason: 'unavailable',
            });
            expect(yield* gate.authorizeRead('workspace', memberDevice)).toEqual({
              _tag: 'Denied',
              reason: 'unavailable',
            });
          })
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
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
            signIntent: () => Effect.die('Guest dispatch must never reach signing'),
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
          const { fixture, runtime, gate, io, readObservedAuthority } = yield* executionFixture(
            directory,
            3
          );
          const observed = createDaemonLossRegistry(true);
          observed.register(
            { workspaceId: 'workspace', machineId: 'machine', accountId: 'account' },
            () => ({
              intakeClosed: false,
              pending: {
                processorActive: 0,
                processorQueued: 0,
                watcherChecks: 0,
                executionTurns: 0,
                executionBookkeeping: 0,
              },
            }),
            readObservedAuthority
          );
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
          const removedMemberBaseline = observed.inspect('workspace', key)!;
          expect(removedMemberBaseline.code).toBeNull();
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
          const revokedBaseline = observed.inspect('workspace', extraKey)!;
          expect(revokedBaseline.code).toBeNull();
          // Historical author records remain, but known revocation rejects the cached grant immediately.
          yield* append({ _tag: 'RevokeDevice', target: extra.publicKey });
          expect(observed.inspect('workspace', extraKey)).toMatchObject({
            code: 'e2ee_device_revoked',
            fence: 'verified-ledger',
            drained: true,
            retired: false,
            requesterInstance: revokedBaseline.requesterInstance,
          });
          expect(
            readObservedAuthority(extraKey, hex(fixture.membershipId.toBytes()))
          ).toMatchObject({ devicePresent: false, memberPresent: true });
          const revokedRpc = makeE2eeRpcNative({
            workspaceId: 'workspace',
            requesterDevice: extraKey,
            originals: new E2eeRpcOriginals(join(directory, 'revoked-rpc.sqlite')),
            ledger: runtime.executionLedger,
            signIntent: () => Effect.die('revoked writer must not sign'),
            binding: () => Effect.die('revoked writer must not sign'),
          });
          const revokedPrepare = yield* revokedRpc
            .prepareDispatch('synthetic-machine', {
              sessionId: 'synthetic-session',
              userTurnId: 'synthetic-turn',
              userId: 'display-only',
              timestamp: new Date(0).toISOString(),
              inputConfig: { prompt: 'synthetic' },
            })
            .pipe(Effect.result);
          expect(revokedPrepare._tag).toBe('Failure');
          if (revokedPrepare._tag === 'Failure')
            expect(revokedPrepare.failure.message).toBe('e2ee_device_revoked');
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
          expect(observed.inspect('workspace', key)).toMatchObject({
            code: 'e2ee_member_removed',
            fence: 'verified-ledger',
            drained: true,
            requesterInstance: removedMemberBaseline.requesterInstance,
          });
          expect(readObservedAuthority(key, memberId)).toMatchObject({
            devicePresent: false,
            memberPresent: false,
          });
          const removedRpc = makeE2eeRpcNative({
            workspaceId: 'workspace',
            requesterDevice: key,
            originals: new E2eeRpcOriginals(join(directory, 'removed-rpc.sqlite')),
            ledger: runtime.executionLedger,
            signIntent: () => Effect.die('removed writer must not sign'),
            binding: () => Effect.die('removed writer must not sign'),
          });
          const removedPrepare = yield* removedRpc
            .prepareDispatch('synthetic-machine', {
              sessionId: 'synthetic-session',
              userTurnId: 'synthetic-turn',
              userId: 'display-only',
              timestamp: new Date(0).toISOString(),
              inputConfig: { prompt: 'synthetic' },
            })
            .pipe(Effect.result);
          expect(removedPrepare._tag).toBe('Failure');
          if (removedPrepare._tag === 'Failure')
            expect(removedPrepare.failure.message).toBe('e2ee_member_removed');
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
          // This machine's own device is gone: a different refusal than a sender without rights.
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toEqual({
            _tag: 'Denied',
            reason: 'e2ee_machine_not_member',
          });
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fences source-side personal context reads when the actual human is removed while policy I/O yields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'source-history-removal-'));
    try {
      await execute(
        Effect.gen(function* () {
          const { fixture, runtime } = yield* executionFixture(directory, 3, true);
          const member = [...fixture.current.inspectState().members.entries()].find(
            ([, row]) => row.role === 'member'
          );
          if (!member) throw new Error('missing member');
          const memberDevice = [...fixture.current.inspectState().devices.values()].find(
            (row) => hex(row.membershipId.toBytes()) === member[0]
          );
          if (!memberDevice) throw new Error('missing reader');
          let current = fixture.current;
          const append = Effect.fnUntraced(function* (
            command: Parameters<typeof prepareLedgerCommand>[2]
          ) {
            const original = yield* signLedgerRecord(
              Result.getOrThrow(prepareLedgerCommand(current, fixture.owner.publicKey, command)),
              fixture.owner
            );
            fixture.records.push(original);
            current = Result.getOrThrow(
              extendLedger(current, [original], {
                length: fixture.records.length,
                head: hashRecordBytes(original),
              })
            );
            yield* runtime.ingest(page(fixture.records));
          });
          yield* append({ _tag: 'DeclareCapabilities', capabilities: [1] });
          let remove = false;
          let teamRead = false;
          let individualRead = true;
          const options = {
            runtime,
            sourceDevice: hex(fixture.owner.publicKey.toBytes()),
            readPolicy: () =>
              Effect.gen(function* () {
                if (remove) {
                  yield* append({ _tag: 'RemoveMember', membershipId: memberDevice.membershipId });
                }
                return {
                  machineId: 'machine',
                  sharedWithTeam: teamRead,
                  projects: [],
                  sessions: individualRead
                    ? [{ sessionId: 'shared-root', audience: { userId: 'reader' }, level: 'read' }]
                    : [],
                  canManage: false,
                } as import('@lody/platform').E2eeMachineSharingView;
              }),
          };
          const target = {
            machineId: 'machine',
            rootSessionId: 'shared-root',
            requesterUserId: 'reader',
          };
          expect(yield* authorizeCliE2eeSessionTarget(options, target)).toBe(true);
          expect(
            yield* authorizeCliE2eeSessionTarget(options, { ...target, requesterUserId: 'other' })
          ).toBe(false);
          expect(
            yield* authorizeCliE2eeSessionTarget(options, {
              ...target,
              rootSessionId: 'unshared-root',
            })
          ).toBe(false);
          yield* append({
            _tag: 'SetRole',
            membershipId: memberDevice.membershipId,
            role: 'guest',
          });
          teamRead = true;
          individualRead = false;
          expect(yield* authorizeCliE2eeSessionTarget(options, target)).toBe(false);
          individualRead = true;
          expect(yield* authorizeCliE2eeSessionTarget(options, target)).toBe(true);
          remove = true;
          expect(yield* authorizeCliE2eeSessionTarget(options, target)).toBe(false);
          expect(yield* authorizeCliE2eeSessionTarget(options, target)).toBe(false);
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('limits an admitted encrypted reader to one shared history and honors revocation without enabling other machine methods', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'history-only-authority-'));
    try {
      await execute(
        Effect.gen(function* () {
          const { fixture, runtime, makeGate } = yield* executionFixture(directory, 3);
          const member = [...fixture.current.inspectState().members].find(
            ([, entry]) => entry.role === 'member'
          );
          if (!member) throw new Error('missing member');
          const requester = [...fixture.current.inspectState().devices].find(
            ([, device]) => hex(device.membershipId.toBytes()) === member[0]
          );
          if (!requester) throw new Error('missing device');
          const [device] = requester;
          let shared = true;
          const gate = yield* makeGate(undefined, undefined, (reader, session) =>
            Effect.succeed({
              allowed: shared && reader === device && session === 'shared-root',
              isCurrent: () => shared,
            })
          );
          const admittedRead = yield* gate.authorizeSessionRead('workspace', device, 'shared-root');
          expect(admittedRead).toMatchObject({ _tag: 'Authorized' });
          if (admittedRead._tag !== 'Authorized' || !admittedRead.isCurrent)
            throw new Error('missing read fence');
          expect(admittedRead.isCurrent()).toBe(true);
          expect(yield* gate.authorizeSessionRead('workspace', device, 'other-root')).toMatchObject(
            { _tag: 'Denied' }
          );
          expect(yield* gate.authorizeRead('workspace', device)).toMatchObject({ _tag: 'Denied' });
          expect(yield* gate.authorizeOwnedExecution('workspace', device)).toMatchObject({
            _tag: 'Denied',
          });
          expect(yield* gate.authorizeExecution('workspace', device)).toMatchObject({
            _tag: 'Denied',
          });
          const capability = yield* signLedgerRecord(
            Result.getOrThrow(
              prepareLedgerCommand(fixture.current, fixture.owner.publicKey, {
                _tag: 'DeclareCapabilities',
                capabilities: [1],
              })
            ),
            fixture.owner
          );
          fixture.records.push(capability);
          const declared = Result.getOrThrow(
            extendLedger(fixture.current, [capability], {
              length: fixture.records.length,
              head: hashRecordBytes(capability),
            })
          );
          const record = yield* signLedgerRecord(
            Result.getOrThrow(
              prepareLedgerCommand(declared, fixture.owner.publicKey, {
                _tag: 'RemoveMember',
                membershipId: Result.getOrThrow(Bytes.membershipId(Buffer.from(member[0], 'hex'))),
              })
            ),
            fixture.owner
          );
          fixture.records.push(record);
          yield* runtime.ingest(page(fixture.records));
          expect(admittedRead.isCurrent()).toBe(false);
          shared = false;
          expect(admittedRead.isCurrent()).toBe(false);
          expect(
            yield* gate.authorizeSessionRead('workspace', device, 'shared-root')
          ).toMatchObject({ _tag: 'Denied' });
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
          expect(yield* gate.authorizeOwnedExecution('workspace', key)).toEqual({
            _tag: 'Denied',
            reason: 'e2ee_machine_not_owned',
          });
          const owned = yield* gate.authorizeOwnedExecution('workspace', fixture.sender);
          expect(owned).toMatchObject({ _tag: 'Authorized', principal: 'owner' });
          const generationSignal = runtime.executionAuthoritySignal();
          expect(generationSignal.aborted).toBe(false);
          if (owned._tag !== 'Authorized' || !owned.isCurrent) throw new Error('missing authority');
          const isCurrent = owned.isCurrent;
          const { createAcpInteractionOwner } = yield* Effect.promise(
            () => import('../src/lib/e2ee/acp-interaction-owner')
          );
          const { createRpcSecretRecipient, encryptRpcSecret } = yield* Effect.promise(
            () => import('@lody/loro-streams-rpc')
          );
          const recipient = yield* Effect.promise(createRpcSecretRecipient);
          let taskAborted = false;
          const owner = createAcpInteractionOwner({
            workspaceId: 'workspace',
            machineId: 'machine',
            createRecipient: createRpcSecretRecipient,
            encrypt: encryptRpcSecret,
            submit: async () => {},
            start: ({ signal }) => ({
              result: new Promise((resolve) => {
                signal.addEventListener(
                  'abort',
                  () => {
                    taskAborted = true;
                    resolve(undefined);
                  },
                  { once: true }
                );
              }),
              cancel: () => {},
            }),
          });
          yield* Effect.promise(() =>
            owner.handle(
              {
                action: 'start',
                kind: 'authenticate',
                configId: 'config' as never,
                responseKey: recipient.publicKey,
              },
              {
                requestId: 'a'.repeat(32),
                requesterDevice: fixture.sender,
                expiresAt: Date.now() + 60_000,
                authority: { isCurrent, signal: generationSignal },
              }
            )
          );
          yield* Effect.promise(() =>
            owner.handle(
              { action: 'activate', interactionRequestId: 'a'.repeat(32) },
              {
                requestId: 'b'.repeat(32),
                requesterDevice: fixture.sender,
                expiresAt: Date.now() + 60_000,
                authority: { isCurrent, signal: generationSignal },
              }
            )
          );
          // A genuine authorization refresh can replay the full retained page,
          // while another receiver concurrently delivers the empty tail.
          yield* Effect.all(
            [gate.refreshLedger, runtime.ingest(page(fixture.records, fixture.records.length))],
            { concurrency: 'unbounded' }
          );
          expect(generationSignal.aborted).toBe(false);
          expect(isCurrent()).toBe(true);
          expect(taskAborted).toBe(false);
          removeDuringCheck = true;
          const raced = yield* gate.authorizeExecution('workspace', key);
          expect(raced).toMatchObject({ _tag: 'Denied', reason: 'not-authorized' });
          // The grant from before the removal can no longer admit a start either.
          expect(shared._tag === 'Authorized' && shared.isCurrent?.()).toBe(false);
          expect(owned._tag === 'Authorized' && owned.isCurrent?.()).toBe(false);
          expect(generationSignal.aborted).toBe(true);
          expect(taskAborted).toBe(true);
          yield* Effect.promise(() => owner.close());
          expect(yield* gate.authorizeExecution('workspace', fixture.sender)).toMatchObject({
            _tag: 'Authorized',
          });
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects ledger rollback, corrupted pages and exhausted reads; tolerates wall-clock correction', async () => {
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
          // A wall-clock correction keeps the fresh grant, but cannot extend its monotonic limit.
          first.io.wall -= 3 * 60_000;
          first.io.offline = true;
          expect(
            yield* first.gate.authorizeExecution('workspace', first.fixture.sender)
          ).toMatchObject({ _tag: 'Authorized' });
          first.io.monotonic += 900_000;
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

  it('avoids duplicate getHistory when sharing calls refreshLedger inside the same authorize turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'execution-dedup-'));
    try {
      await execute(
        Effect.gen(function* () {
          const { fixture, runtime, makeGate, io } = yield* executionFixture(directory, 3);
          const current = fixture.current;
          const memberEntry = [...current.inspectState().members].find(
            ([, member]) => member.role === 'member'
          );
          if (!memberEntry) throw new Error('missing synthetic member');
          const [memberId] = memberEntry;
          const requester = [...current.inspectState().devices].find(
            ([, device]) => hex(device.membershipId.toBytes()) === memberId
          );
          if (!requester) throw new Error('missing synthetic requester');
          const [requesterKey] = requester;
          const capRecord = yield* signLedgerRecord(
            Result.getOrThrow(
              prepareLedgerCommand(current, fixture.owner.publicKey, {
                _tag: 'DeclareCapabilities',
                capabilities: [1],
              })
            ),
            fixture.owner
          );
          fixture.records.push(capRecord);
          yield* runtime.ingest(page(fixture.records));

          let gate!: Effect.Success<ReturnType<typeof makeGate>>;
          let sharingCalls = 0;
          gate = yield* makeGate(() =>
            Effect.gen(function* () {
              sharingCalls++;
              // First refreshLedger inside sharing reuses authorize's fresh ledger read.
              yield* gate.refreshLedger;
              expect(io.reads).toBe(1);
              // Second refreshLedger in the same sharing invocation still hits getHistory if retried.
              if (sharingCalls === 2) {
                yield* gate.refreshLedger;
              }
              return { allowed: true, isCurrent: () => true };
            })
          );

          expect(yield* gate.authorizeExecution('workspace', requesterKey)).toMatchObject({
            _tag: 'Authorized',
          });
          expect(io.reads).toBe(1);

          // Direct refreshLedger outside authorize always calls getHistory.
          yield* gate.refreshLedger;
          expect(io.reads).toBe(2);

          // Next authorizeExecution: first refreshLedger skipped (total 3 reads), second retried (4 reads).
          io.reads = 0;
          expect(yield* gate.authorizeExecution('workspace', requesterKey)).toMatchObject({
            _tag: 'Authorized',
          });
          expect(io.reads).toBe(2);
        })
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it('revokes a real encrypted ACP owner when the verified runtime ledger changes', async () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const directory = await mkdtemp(join(tmpdir(), 'acp-owner-authority-'));
  try {
    await execute(
      Effect.gen(function* () {
        const { fixture, runtime, gate, makeGate, device } = yield* executionFixture(directory, 3);
        const member = [...fixture.current.inspectState().members].find(
          ([, value]) => value.role === 'member'
        );
        if (!member) throw new Error('missing shared member');
        const sharedDevice = [...fixture.current.inspectState().devices].find(
          ([, value]) => hex(value.membershipId.toBytes()) === member[0]
        );
        if (!sharedDevice) throw new Error('missing shared member device');
        const sharedGate = yield* makeGate(() =>
          Effect.succeed({ allowed: true, isCurrent: () => true })
        );
        expect(yield* sharedGate.authorizeExecution('workspace', sharedDevice[0])).toMatchObject({
          _tag: 'Authorized',
          principal: 'member',
        });
        expect(yield* sharedGate.authorizeOwnedExecution('workspace', sharedDevice[0])).toEqual({
          _tag: 'Denied',
          reason: 'e2ee_machine_not_owned',
        });
        const extraCustody = yield* makeNodeE2eeCustody({
          directory: join(directory, 'requester'),
          wrapper,
        });
        const requester = yield* extraCustody.prepareDevice();
        const admission = yield* prepareDeviceAdmission({
          genesis: fixture.genesis,
          membershipId: fixture.membershipId,
          signer: requester,
          encryptionPublicKey: requester.enc,
          kind: 'personal',
        });
        const admitted = yield* signLedgerRecord(
          Result.getOrThrow(
            prepareLedgerCommand(fixture.current, fixture.owner.publicKey, admission)
          ),
          fixture.owner
        );
        fixture.records.push(admitted);
        fixture.current = Result.getOrThrow(
          extendLedger(fixture.current, [admitted], {
            length: fixture.records.length,
            head: hashRecordBytes(admitted),
          })
        );
        yield* runtime.ingest(page(fixture.records));
        const requesterKey = hex(requester.publicKey.toBytes());
        const { MessageHandler } = yield* Effect.promise(
          () => import('../src/lib/message-handler')
        );
        const { MachineRuntime } = yield* Effect.promise(
          () => import('../src/lib/machine-runtime')
        );
        const { createRpcSecretRecipient } = yield* Effect.promise(
          () => import('@lody/loro-streams-rpc')
        );
        const recipient = yield* Effect.promise(() => createRpcSecretRecipient());
        const started = deferred<void>();
        const stopped = deferred<void>();
        let cancelled = false;
        const handler = Object.create(MessageHandler.prototype) as InstanceType<
          typeof MessageHandler
        >;
        Object.assign(handler, {
          encryptedAttachments: true,
          workspaceId: 'workspace',
          machineId: 'machine',
          acpInteractionStopping: false,
          executionService: {
            authenticateMachineAcp: async (
              request: { action: string },
              options?: { signal?: AbortSignal }
            ) => {
              if (request.action === 'cancel') {
                cancelled = true;
                stopped.resolve();
                return { success: true };
              }
              started.resolve();
              await new Promise<void>((resolve) => {
                if (options?.signal?.aborted) resolve();
                else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              return { success: false };
            },
          },
        });
        const machine = Object.create(MachineRuntime.prototype) as InstanceType<
          typeof MachineRuntime
        >;
        Object.assign(machine, {
          handler,
          options: {
            handlerConfig: {
              encryptedWorkspace: true,
              workspaceId: 'workspace',
              machineId: 'machine',
              userId: 'owner',
            },
          },
        });
        const grant = yield* gate.authorizeOwnedExecution('workspace', requesterKey);
        if (grant._tag !== 'Authorized' || !grant.isCurrent) throw new Error('missing owner grant');
        const signal = AbortSignal.any([runtime.executionAuthoritySignal(), gate.authoritySignal]);
        const { makeRealtimeContentBinding } = yield* Effect.promise(
          () => import('@lody/e2ee-core/adapters/loro-streams')
        );
        const { makeEncryptedFeatureReceiver } = yield* Effect.promise(
          () => import('../src/lib/e2ee/feature-rpc')
        );
        const { RealtimeJournal } = yield* Effect.promise(
          () => import('../src/lib/e2ee/realtime-journal')
        );
        const binding = (signer: typeof requester) => (resource: string) =>
          makeRealtimeContentBinding({
            genesis: fixture.genesis,
            resource,
            signer,
            ledger: runtime.executionLedger,
            readEpochKey: () => Effect.fromResult(Bytes.epochKey(new Uint8Array(32).fill(20))),
          });
        const sender = makeE2eeRpcNative({
          workspaceId: 'workspace',
          requesterDevice: requesterKey,
          originals: new E2eeRpcOriginals(join(directory, 'sender-acp.sqlite')),
          ledger: runtime.executionLedger,
          signIntent: testIntentSigner(fixture.genesis, requester),
          binding: binding(requester),
        });
        const receiver = makeE2eeRpcNative({
          workspaceId: 'workspace',
          requesterDevice: hex(device.publicKey.toBytes()),
          originals: new E2eeRpcOriginals(join(directory, 'receiver-acp.sqlite')),
          ledger: runtime.executionLedger,
          signIntent: testIntentSigner(fixture.genesis, device),
          binding: binding(device),
        });
        let delivered = deferred<{ id: string; frame: string }>();
        const journal = RealtimeJournal.create(join(directory, 'acp-feature.sqlite'), Date.now);
        const feature = yield* makeEncryptedFeatureReceiver({
          workspaceId: 'workspace',
          machineId: 'machine',
          genesis: hex(fixture.genesis.toBytes()),
          native: receiver,
          journal: () => journal,
          authorize: gate.authorizeOwnedExecution,
          authorizeRead: gate.authorizeRead,
          authoritySignal: () =>
            AbortSignal.any([runtime.executionAuthoritySignal(), gate.authoritySignal]),
          isOpen: () => true,
          client: {
            ensureJsonStream: async () => {},
            appendJson: async (_stream, frame) => {
              delivered.resolve(frame as { id: string; frame: string });
              return '1';
            },
            readJsonLive: async () => {
              throw new Error('unused');
            },
          },
          handle: (request, context) => {
            if (request.method !== 'machine/acp-interaction') throw new Error('unexpected feature');
            return machine.handleEncryptedFeatureRpc(request, context);
          },
        });
        const input = {
          requestId: '1'.repeat(32),
          request: {
            workspaceId: 'workspace',
            machineId: 'machine',
            method: 'machine/acp-interaction' as const,
            params: {
              action: 'start' as const,
              kind: 'authenticate' as const,
              configId: 'config',
              responseKey: recipient.publicKey,
            },
          },
        };
        const prepared = yield* sender.prepareFeature(input);
        yield* feature({ id: prepared.requestId, frame: prepared.frameHex });
        const envelope = yield* Effect.promise(() => delivered.promise);
        const response = yield* sender.acceptFeatureResponse(input, envelope.frame);
        expect(response).toMatchObject({ ok: true, result: { state: 'running' } });
        delivered = deferred<{ id: string; frame: string }>();
        const activation = {
          requestId: '3'.repeat(32),
          request: {
            workspaceId: 'workspace',
            machineId: 'machine',
            method: 'machine/acp-interaction' as const,
            params: { action: 'activate' as const, interactionRequestId: input.requestId },
          },
        };
        const activationFrame = yield* sender.prepareFeature(activation);
        yield* feature({ id: activationFrame.requestId, frame: activationFrame.frameHex });
        const activationEnvelope = yield* Effect.promise(() => delivered.promise);
        expect(
          yield* sender.acceptFeatureResponse(activation, activationEnvelope.frame)
        ).toMatchObject({ ok: true });
        yield* Effect.promise(() => started.promise);
        // A signed removal enters through the real runtime and aborts the captured watcher.
        const revocation = yield* signLedgerRecord(
          Result.getOrThrow(
            prepareLedgerCommand(fixture.current, fixture.owner.publicKey, {
              _tag: 'RevokeDevice',
              target: requester.publicKey,
            })
          ),
          fixture.owner
        );
        fixture.records.push(revocation);
        yield* runtime.ingest(page(fixture.records));
        yield* Effect.promise(() => stopped.promise);
        expect(signal.aborted).toBe(true);
        expect(cancelled).toBe(true);
        const hidden = yield* Effect.promise(() =>
          handler
            .handleEncryptedAcpInteraction(
              {
                workspaceId: 'workspace',
                machineId: 'machine',
                method: 'machine/acp-interaction',
                params: { action: 'poll', interactionRequestId: '1'.repeat(32) },
              },
              {
                requestId: '2'.repeat(32),
                requesterDevice: requesterKey,
                expiresAt: Date.now() + 60_000,
                signal: new AbortController().signal,
                authority: { isCurrent: grant.isCurrent, signal },
              }
            )
            .catch((error: Error) => error.message)
        );
        expect(hidden).toBe('e2ee_feature_unavailable');
        const internals = handler as unknown as {
          acpInteractionOwner?: Promise<{ close(): Promise<void> }>;
        };
        yield* Effect.promise(async () => {
          await (await internals.acpInteractionOwner)?.close();
        });
      })
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// The response stream can yield after the body has been sealed. No earlier
// authorization, including a cached response, may bypass the final actual-target check.
it.each([false, true])(
  'drops a history reply when assigned access changes during stream creation (cached=%s)',
  async (cached) => {
    const { makeEncryptedFeatureReceiver } = await import('../src/lib/e2ee/feature-rpc');
    const created = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const refused = Promise.withResolvers<void>();
    let owner = 'reader';
    const sent: unknown[] = [];
    await execute(
      Effect.gen(function* () {
        const opened = {
          requestId: 'history-proof',
          requesterDevice: 'reader-device',
          expiresAt: Date.now() + 60_000,
          input: {
            request: {
              method: 'session/history-read',
              workspaceId: 'workspace',
              machineId: 'machine',
              params: { sessionId: 'root', query: { kind: 'count' } },
            },
          },
        };
        const native = {
          openFeature: () => Effect.succeed(opened),
          retainFeatureRequest: () => Effect.void,
          readFeatureResponse: () => Effect.succeed(cached ? [Uint8Array.of(1)] : []),
          sealFeatureResult: () => Effect.succeed([Uint8Array.of(1)]),
          verifyFeatureRequest: () => Effect.void,
          responseStream: () => 'response',
        } as unknown as ReturnType<typeof makeE2eeRpcNative>;
        const feature = yield* makeEncryptedFeatureReceiver({
          workspaceId: 'workspace',
          machineId: 'machine',
          genesis: 'genesis',
          native,
          journal: () => {
            throw new Error('history must not open the execution journal');
          },
          authorize: () => Effect.succeed({ _tag: 'Denied', reason: 'not-authorized' }),
          authorizeRead: () => Effect.succeed({ _tag: 'Denied', reason: 'not-authorized' }),
          authorizeHistoryRead: () =>
            Effect.sync(() => {
              if (owner !== 'reader') {
                refused.resolve();
                return { _tag: 'Denied' as const, reason: 'not-authorized' as const };
              }
              return { _tag: 'Authorized' as const, isCurrent: () => true };
            }),
          authoritySignal: () => new AbortController().signal,
          isOpen: () => true,
          handle: async () => ({ ok: true, result: { count: 123 } }),
          client: {
            ensureJsonStream: async () => {
              created.resolve();
              await resume.promise;
            },
            appendJson: async (_stream, value) => {
              sent.push(value);
              return '1';
            },
            readJsonLive: async () => {
              throw new Error('unused');
            },
          },
        });
        yield* feature({ id: opened.requestId, frame: 'synthetic' });
        yield* Effect.promise(() => created.promise);
        owner = 'other-owner';
        resume.resolve();
        yield* Effect.promise(() => refused.promise);
      })
    );
    expect(sent).toEqual([]);
  }
);

it.each(
  (['streams', 'iroh'] as const).flatMap((route) =>
    (['team', 'individual', 'private'] as const).map((audience) => ({ route, audience }))
  )
)(
  'uses the same expiring session-read admission for history ($route, $audience)',
  async ({ route, audience }) => {
    const { makeEncryptedFeatureReceiver, makeEncryptedFeatureAuthorization } =
      await import('../src/lib/e2ee/feature-rpc');
    const { E2eeFeatureInputSchema } = await import('@lody/shared/e2ee-rpc');
    const directory = await mkdtemp(join(tmpdir(), 'backend-neutral-history-'));
    const outcome = Promise.withResolvers<'published' | 'denied'>();
    const replies: unknown[] = [];
    const bodies: unknown[] = [];
    try {
      await execute(
        Effect.gen(function* () {
          const { fixture, runtime, makeGate } = yield* executionFixture(directory, 3, true);
          const member = [...fixture.current.inspectState().members].find(
            ([, entry]) => entry.role === 'member'
          );
          if (!member) throw new Error('missing member');
          const requester = [...fixture.current.inspectState().devices].find(
            ([, device]) => hex(device.membershipId.toBytes()) === member[0]
          );
          if (!requester) throw new Error('missing requester');
          const sessions = [
            {
              sessionId: 'roost-root',
              audience:
                audience === 'team'
                  ? ('team' as const)
                  : { userId: audience === 'private' ? 'acct' : 'reader' },
              level: 'read' as const,
            },
          ];
          const gate = yield* makeGate(undefined, undefined, (reader, session) =>
            authorizeCliE2eeSessionTarget(
              {
                runtime,
                sourceDevice: hex(fixture.owner.publicKey.toBytes()),
                readPolicy: () =>
                  Effect.succeed({
                    machineId: 'machine',
                    sharedWithTeam: false,
                    projects: [],
                    sessions,
                    canManage: false,
                  } as import('@lody/platform').E2eeMachineSharingView),
              },
              {
                machineId: 'machine',
                rootSessionId: session,
                requesterUserId: reader === requester[0] ? 'reader' : 'other',
              }
            ).pipe(Effect.map((allowed) => ({ allowed, isCurrent: () => true })))
          );
          // This is the same wire method the Roost adapter uses, without a storage-kind flag.
          const input = E2eeFeatureInputSchema.parse({
            requestId: 'a'.repeat(32),
            request: {
              workspaceId: 'workspace',
              machineId: 'machine',
              method: 'session/history-read',
              params: { sessionId: 'roost-root', query: { kind: 'count' } },
            },
          });
          const opened = {
            requestId: input.requestId,
            requesterDevice: requester[0],
            expiresAt: Date.now() + 60_000,
            input,
          };
          const native = {
            openFeature: () => Effect.succeed(opened),
            retainFeatureRequest: () => Effect.void,
            readFeatureResponse: () => Effect.succeed([]),
            sealFeatureResult: (_machine: unknown, _opened: unknown, result: unknown) =>
              Effect.sync(() => {
                replies.push(result);
                return [new Uint8Array(143).fill(1)];
              }),
            verifyFeatureRequest: () => Effect.void,
            responseStream: () => 'history-response',
          } as unknown as ReturnType<typeof makeE2eeRpcNative>;
          const feature = yield* makeEncryptedFeatureReceiver({
            workspaceId: 'workspace',
            machineId: 'machine',
            genesis: 'genesis',
            native,
            journal: () => {
              throw new Error('history must not enter the execution journal');
            },
            ...makeEncryptedFeatureAuthorization({
              authorization: {
                ...gate,
                authorizeSessionRead: (workspace, device, session, owner) =>
                  gate.authorizeSessionRead(workspace, device, session, owner).pipe(
                    Effect.tap((verdict) =>
                      Effect.sync(() => {
                        if (verdict._tag === 'Denied') outcome.resolve('denied');
                      })
                    )
                  ),
              },
              executionAuthoritySignal: () => new AbortController().signal,
              resolveHistoryTarget: async () => ({ rootSessionId: 'roost-root' }),
            }),
            isOpen: () => true,
            handle: async (request, context) => {
              if (request.method !== 'session/history-read' || !context.authority?.isCurrent())
                throw new Error('missing exact-session authority');
              const result = { backend: 'roost', count: 7 };
              bodies.push(result);
              return { ok: true, result };
            },
            client:
              route === 'streams'
                ? {
                    ensureJsonStream: async () => {},
                    appendJson: async () => {
                      outcome.resolve('published');
                      return '1';
                    },
                    readJsonLive: async () => {
                      throw new Error('unused');
                    },
                  }
                : undefined,
          });
          const delivered: Uint8Array[] = [];
          yield* feature(
            { id: input.requestId, frame: 'synthetic' },
            route === 'iroh'
              ? {
                  deliver: async (_id, frame) => {
                    delivered.push(frame);
                    outcome.resolve('published');
                  },
                  end: async () => {
                    outcome.resolve('denied');
                  },
                }
              : undefined
          );
          expect(yield* Effect.promise(() => outcome.promise)).toBe(
            audience === 'private' ? 'denied' : 'published'
          );
          if (route === 'iroh')
            expect(delivered).toEqual(audience === 'private' ? [] : [new Uint8Array(143).fill(1)]);
        })
      );
      if (audience === 'private') expect(bodies).toEqual([]);
      else expect(bodies).toEqual([{ backend: 'roost', count: 7 }]);
      if (audience === 'team' || audience === 'individual')
        expect(replies).toEqual([{ ok: true, result: { backend: 'roost', count: 7 } }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);
