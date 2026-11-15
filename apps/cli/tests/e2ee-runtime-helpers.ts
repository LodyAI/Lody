import { accountUserId } from '@lody/e2ee-core/protocol';
import { readDaemonLossAuthority } from '../src/lib/e2ee/client-loss-observer';
import {
  E2EE_INTENT_KIND,
  encodeE2eeIntentRecord,
  scheduleDeclarationSubject,
  turnExecutionDigest,
} from '@lody/shared';
import { SessionDocument } from '../src/lib/loro/doc';
import {
  extractPromptPreviewFromInputBlocks,
  getSessionRoomId,
  normalizeSessionTurnInputConfig,
  resolveSessionExecutionInputBlocks,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { E2eeRpcOriginals, makeE2eeRpcNative } from '@lody/loro-streams-rpc/e2ee-native';
import { makeVerifiedExecutionIntent } from '../src/lib/e2ee/execution-intent-verification';
import { makeEncryptedAgentExecution } from '../src/lib/e2ee/agent-execution';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { developmentNativePath, loadIrohNative } from '@lody/iroh-native';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Clock, Effect, Result } from 'effect';
import { LoroDoc, LoroMap } from 'loro-crdt';
import { expect } from 'vitest';
import {
  Bytes,
  commitEpochKey,
  encodeCbor,
  extendLedger,
  getCommittedEpochStagingKey,
  hashRecordBytes,
  prepareDeviceAdmission,
  prepareEpochEnvelope,
  prepareJoinRequest,
  prepareLedgerCommand,
  prepareLedgerRecord,
  sealHistoryPacket,
  signExecutionIntent,
  signGenesisRecord,
  signLedgerRecord,
  verifyLedger,
} from '@lody/e2ee-core/protocol';
import { makeNodeE2eeCustody, type KekWrapper } from '@lody/e2ee-core/adapters/node-custody';
import { makeCliE2eeCustody } from '../src/lib/e2ee/custody';
import { makeCliE2eeRuntime } from '../src/lib/e2ee/runtime';
import { makeCliE2eeExecutionAuthorization } from '../src/lib/e2ee/execution-authorization';
import type { CloudE2eePort } from '@lody/platform';
import type { EpochStagedGroup } from '@lody/e2ee-core';

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
  includeGuestMachine = false,
  accountIds = false
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
      userId: Result.getOrThrow(
        accountIds ? accountUserId('acct') : Bytes.userId(new Uint8Array(32).fill(30))
      ),
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
        userId: Result.getOrThrow(
          accountIds ? accountUserId('reader') : Bytes.userId(new Uint8Array(32).fill(60))
        ),
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

const executionFixture = Effect.fnUntraced(function* (
  directory: string,
  count = 2,
  accountIds = false
) {
  let observedAuthority: Parameters<typeof readDaemonLossAuthority>[0];
  const fixture = yield* setup(
    directory,
    count,
    join(directory, 'machine'),
    false,
    false,
    false,
    accountIds
  );
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
    onVerifiedLedger: (view, generation) => {
      observedAuthority = { view, generation };
    },
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
  const makeGate = (
    sharing?: Parameters<typeof makeCliE2eeExecutionAuthorization>[0]['sharing'],
    onWindowNotice?: Parameters<typeof makeCliE2eeExecutionAuthorization>[0]['onWindowNotice'],
    sessionSharing?: Parameters<typeof makeCliE2eeExecutionAuthorization>[0]['sessionSharing']
  ) =>
    makeCliE2eeExecutionAuthorization({
      sharing,
      sessionSharing,
      onWindowNotice,
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
  return {
    fixture,
    runtime,
    gate,
    makeGate,
    io,
    device,
    readObservedAuthority: (key: string, membershipId?: string) =>
      readDaemonLossAuthority(
        observedAuthority,
        hex(device.publicKey.toBytes()),
        key,
        membershipId
      ),
  };
});

const testIntentSigner =
  (
    genesis: Parameters<typeof signExecutionIntent>[0]['genesis'],
    signer: Parameters<typeof signExecutionIntent>[0]['signer']
  ) =>
  (request: Omit<Parameters<typeof signExecutionIntent>[0], 'genesis' | 'signer'>) =>
    signExecutionIntent({ ...request, genesis, signer }).pipe(
      Effect.map((signature) => signature.toBytes())
    );

/** A setter's device signs a schedule declaration over the fingerprint it computes. */
const testDeclarationSigner =
  (
    genesis: Parameters<typeof signExecutionIntent>[0]['genesis'],
    workspaceId: string,
    signer: Parameters<typeof signExecutionIntent>[0]['signer']
  ) =>
  async (declared: Parameters<typeof scheduleDeclarationSubject>[0], manualRunKey?: string) => {
    const subject = scheduleDeclarationSubject(declared, manualRunKey);
    const signature = await Effect.runPromise(
      signExecutionIntent({
        ...subject,
        genesis,
        workspaceId,
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

/** This machine signs an input it writes itself, as the workspace host does. */
const testMachineInputSigner =
  (
    genesis: Parameters<typeof signExecutionIntent>[0]['genesis'],
    workspaceId: string,
    signer: Parameters<typeof signExecutionIntent>[0]['signer']
  ) =>
  async (input: {
    sessionId: string;
    targetMachineId: string;
    userTurnId: string;
    inputConfig: unknown;
    derivedFrom?: unknown;
    scheduleRun?: unknown;
  }) => {
    const signature = await Effect.runPromise(
      signExecutionIntent({
        kind: E2EE_INTENT_KIND.machineInput,
        genesis,
        workspaceId,
        targetMachineId: input.targetMachineId,
        scope: input.sessionId,
        messageId: input.userTurnId,
        contentDigest: Buffer.from(turnExecutionDigest(input)!, 'hex'),
        signer,
      })
    );
    return encodeE2eeIntentRecord({
      kind: E2EE_INTENT_KIND.machineInput,
      signer: signer.publicKey.toBytes(),
      signature: signature.toBytes(),
    });
  };

const queuedTimestamp = '2026-10-30T20:00:00.000Z';

const queuedSessionId = 'queued-session' as SessionId;

const queuedConfig = (prompt: string) => ({
  prompt,
  inputBlocks: [{ type: 'text' as const, text: prompt }],
  cliType: 'builtin' as const,
  agentType: 'codex',
  // A composer's cached value; promotion replaces it from the Session's metadata.
  resume: 'composer-acp-session',
});

const ownerAccount = 'owner-account';

const memberAccount = 'member-account';

const automationOrigin = {
  invocationId: 'invocation',
  ruleId: 'rule',
  ruleRevision: 1,
  eventRef: 'event',
  authorizationUserId: ownerAccount,
};

/** Real ledger, signed dispatch originals, watcher promotion and start claim. */
const queuedInputHarness = Effect.fnUntraced(function* (directory: string, shared: boolean) {
  const { fixture, runtime, makeGate, device, io } = yield* executionFixture(directory);
  const custody = yield* makeNodeE2eeCustody({ directory: join(directory, 'member'), wrapper });
  const member = yield* custody.prepareDevice();
  const membershipId = Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(71)));
  let current = fixture.current;
  const append = Effect.fnUntraced(function* (
    command: Parameters<typeof prepareLedgerCommand>[2],
    signer: Parameters<typeof signLedgerRecord>[1] = fixture.owner
  ) {
    const record = yield* signLedgerRecord(
      Result.getOrThrow(prepareLedgerCommand(current, signer.publicKey, command)),
      signer
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
  yield* append({
    _tag: 'AdmitMember',
    membershipId,
    request: yield* prepareJoinRequest({
      genesis: fixture.genesis,
      requestId: Result.getOrThrow(Bytes.requestId(new Uint8Array(16).fill(72))),
      userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(73))),
      encryptionPublicKey: member.enc,
      expiresAt: null,
      signer: member,
    }),
  });
  const sharing = { allowed: true };
  const gate = yield* makeGate(
    shared
      ? () => Effect.succeed({ allowed: sharing.allowed, isCurrent: () => sharing.allowed })
      : undefined
  );
  const { makeRealtimeContentBinding } = yield* Effect.promise(
    () => import('@lody/e2ee-core/adapters/loro-streams')
  );
  const { RealtimeJournal } = yield* Effect.promise(
    () => import('../src/lib/e2ee/realtime-journal')
  );
  const { SessionDispatchWatcher } = yield* Effect.promise(
    () => import('../src/session/session-dispatch-watcher')
  );
  const { composeTestSessionDoc } = yield* Effect.promise(() => import('./session-doc-fixture'));
  const readEpochKey = () => Effect.fromResult(Bytes.epochKey(new Uint8Array(32).fill(20)));
  const rpcBinding =
    (signer: Parameters<typeof makeRealtimeContentBinding>[0]['signer']) => (resource: string) =>
      makeRealtimeContentBinding({
        genesis: fixture.genesis,
        resource,
        signer,
        ledger: runtime.executionLedger,
        readEpochKey,
      });
  const machineKey = hex(device.publicKey.toBytes());
  const receiver = makeE2eeRpcNative({
    workspaceId: 'workspace',
    requesterDevice: machineKey,
    originals: new E2eeRpcOriginals(join(directory, 'queued-receiver.sqlite')),
    ledger: runtime.executionLedger,
    signIntent: testIntentSigner(fixture.genesis, device),
    binding: rpcBinding(device),
  });
  const sender = (
    name: string,
    signer: Parameters<typeof makeRealtimeContentBinding>[0]['signer']
  ) =>
    makeE2eeRpcNative({
      workspaceId: 'workspace',
      requesterDevice: hex(signer.publicKey.toBytes()),
      authorizeTarget: () => Effect.succeed(true),
      originals: new E2eeRpcOriginals(join(directory, `${name}.sqlite`)),
      ledger: runtime.executionLedger,
      signIntent: testIntentSigner(fixture.genesis, signer),
      binding: rpcBinding(signer),
    });
  const memberRpc = sender('queued-member', member);
  const ownerRpc = sender('queued-owner', fixture.owner);
  const secondCustody = yield* makeNodeE2eeCustody({
    directory: join(directory, 'second'),
    wrapper,
  });
  const secondDevice = yield* secondCustody.prepareDevice();
  yield* append(
    yield* prepareDeviceAdmission({
      genesis: fixture.genesis,
      membershipId: fixture.membershipId,
      signer: secondDevice,
      encryptionPublicKey: secondDevice.enc,
      kind: 'personal',
    })
  );
  const secondRpc = sender('queued-second', secondDevice);

  let meta = {
    id: queuedSessionId,
    machineId: 'machine',
    userId: ownerAccount,
    cliType: 'builtin',
    agentType: 'codex',
    acpSessionId: 'machine-acp-session',
    createdAt: queuedTimestamp,
    status: { type: 'idle' },
  } as SessionMeta;
  const repo = {
    getDocMeta: async () => ({ meta }),
    upsertDocMeta: async (_room: string, patch: Partial<SessionMeta>) => {
      meta = { ...meta, ...patch };
    },
    flush: async () => {},
  };
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  const session = new SessionDocument(
    repo as never,
    queuedSessionId,
    async () => {},
    logger as never
  );
  const doc = new LoroDoc();
  composeTestSessionDoc(session, { doc });
  const watcher = new SessionDispatchWatcher({
    userResolver: { clear: () => {} } as never,
    encryptedWorkspace: true,
    logger,
    machineId: 'machine',
    workspaceId: 'workspace',
    workspaceDocument: { repo },
    executionService: { tryAcquireSessionRewriteConflictLease: () => () => {} },
    canUseMachine: async () => ({ outcome: 'allowed' as const }),
  } as never);
  const docId = getSessionRoomId(queuedSessionId);
  const resolve = makeVerifiedExecutionIntent({
    workspaceId: 'workspace',
    genesis: fixture.genesis,
    selfDevice: machineKey,
    isClosed: () => false,
    readIncoming: (intent) => receiver.readIncoming({ ...intent, inputConfig: intent.inputConfig }),
    openDispatch: receiver.openDispatch,
    ledger: runtime.executionLedger,
    refreshLedger: gate.refreshLedger,
  });
  /** One signed execution intent, as a client or this machine writes it with its content. */
  const signIntent = Effect.fnUntraced(function* (
    signer: typeof device,
    turnId: string,
    inputConfig: unknown,
    extra: { derivedFrom?: unknown; scheduleRun?: unknown } = {},
    targetMachineId = 'machine'
  ) {
    const kind = signer === device ? E2EE_INTENT_KIND.machineInput : E2EE_INTENT_KIND.memberInput;
    const signature = yield* signExecutionIntent({
      kind,
      genesis: fixture.genesis,
      workspaceId: 'workspace',
      targetMachineId,
      scope: queuedSessionId,
      messageId: turnId,
      contentDigest: Buffer.from(turnExecutionDigest({ inputConfig, ...extra })!, 'hex'),
      signer,
    });
    return encodeE2eeIntentRecord({
      kind,
      signer: signer.publicKey.toBytes(),
      signature: signature.toBytes(),
    });
  });
  // The machine's own clock: tests move it to model a machine that was offline.
  const machineClock = { now: Date.parse(queuedTimestamp) + 1_000 };
  let journal = RealtimeJournal.create(
    join(directory, 'queued-journal.sqlite'),
    () => machineClock.now
  );
  const makeExecution = () =>
    makeEncryptedAgentExecution({
      genesis: hex(fixture.genesis.toBytes()),
      workspaceId: 'workspace',
      targetMachineId: 'machine',
      journal: () => journal,
      authorizeExecution: gate.authorizeExecution,
      resolveVerifiedOriginal: (intent, lookup) => resolve(intent, doc, lookup),
      selfDevice: machineKey,
      machineUserId: ownerAccount,
      ledgerIdentity: {
        ownsDevice: (device) =>
          Effect.succeed(
            device === hex(fixture.owner.publicKey.toBytes()) ||
              device === hex(secondDevice.publicKey.toBytes())
          ),
        memberDevice: () => Effect.succeed(hex(member.publicKey.toBytes())),
      },
      authorizeMachineTarget: () => Effect.succeed(true),
    });
  let execution = makeExecution();
  const makeRemoteExecution = Effect.fnUntraced(function* () {
    const custody = yield* makeNodeE2eeCustody({
      directory: join(directory, 'remote-machine'),
      wrapper,
    });
    const remote = yield* custody.prepareDevice();
    yield* append(
      yield* prepareDeviceAdmission({
        genesis: fixture.genesis,
        membershipId: fixture.membershipId,
        signer: remote,
        encryptionPublicKey: remote.enc,
        kind: 'machine',
        machineId: 'machine-B',
      })
    );
    const resolveRemote = makeVerifiedExecutionIntent({
      workspaceId: 'workspace',
      genesis: fixture.genesis,
      selfDevice: hex(remote.publicKey.toBytes()),
      isClosed: () => false,
      readIncoming: () => Effect.succeed(undefined),
      openDispatch: receiver.openDispatch,
      ledger: runtime.executionLedger,
      refreshLedger: gate.refreshLedger,
    });
    const targetJournal = RealtimeJournal.create(
      join(directory, 'remote-journal.sqlite'),
      () => machineClock.now
    );
    return makeEncryptedAgentExecution({
      genesis: hex(fixture.genesis.toBytes()),
      workspaceId: 'workspace',
      targetMachineId: 'machine-B',
      journal: () => targetJournal,
      selfDevice: hex(remote.publicKey.toBytes()),
      machineUserId: ownerAccount,
      resolveVerifiedOriginal: (intent, lookup) => resolveRemote(intent, doc, lookup),
      authorizeExecution: gate.authorizeExecution,
    });
  });
  const clientConfig = (turnId: string, config: object = queuedConfig(turnId)) =>
    normalizeSessionTurnInputConfig({ ...config, mcpServerIds: [] });
  const prepareOriginal = Effect.fnUntraced(function* (
    rpc: typeof memberRpc,
    turnId: string,
    userId: string,
    inputConfig: unknown = clientConfig(turnId)
  ) {
    const prepared = yield* rpc.prepareDispatch('machine', {
      sessionId: queuedSessionId,
      userTurnId: turnId,
      userId,
      timestamp: queuedTimestamp,
      inputConfig,
    });
    return prepared.e2eeIntent;
  });
  const pushRow = (
    turnId: string,
    userId: string,
    config: object = queuedConfig(turnId),
    e2eeIntent?: string
  ) =>
    Effect.promise(() =>
      session.pushMessageQueue({
        userTurnId: turnId,
        task: turnId,
        userId,
        timestamp: queuedTimestamp,
        acpSessionConfig: { ...config, mcpServerIds: [] },
        ...(e2eeIntent ? { e2eeIntent } : {}),
      } as never)
    );
  const machinePeer = doc.peerIdStr;
  /** One client's edit, written from its own Loro peer. */
  const asClient = Effect.fnUntraced(function* <A, E, R>(
    rpc: typeof memberRpc,
    work: Effect.Effect<A, E, R>
  ) {
    doc.commit();
    doc.setPeerId(rpc === ownerRpc ? '101' : '202');
    const result = yield* work;
    doc.commit();
    doc.setPeerId(machinePeer);
    return result;
  });
  /** The composer's order: sign the intent, then write it with the queue row. */
  const send = Effect.fnUntraced(function* (
    turnId: string,
    rpc?: typeof memberRpc,
    userId = rpc === ownerRpc || rpc === secondRpc ? ownerAccount : memberAccount
  ) {
    const e2eeIntent = rpc ? yield* prepareOriginal(rpc, turnId, userId) : undefined;
    const row = pushRow(turnId, userId, queuedConfig(turnId), e2eeIntent);
    if (rpc === memberRpc || rpc === ownerRpc) yield* asClient(rpc, row);
    else yield* row;
  });
  const promote = Effect.fnUntraced(function* () {
    const promoted = yield* Effect.promise(() =>
      (
        watcher as unknown as {
          promoteNextQueuedMessage: (
            sessionDoc: SessionDocument,
            currentMeta: SessionMeta,
            history: never[]
          ) => Promise<{ id: string; inputConfig?: unknown; userId?: string } | null>;
        }
      ).promoteNextQueuedMessage(session, meta, [])
    );
    if (!promoted) throw new Error('queue promotion failed');
    doc.commit();
    return promoted;
  });
  const rawClaim = (turn: { id: string; inputConfig?: unknown; userId?: string }) =>
    execution.claim({
      workspaceId: 'workspace',
      sessionId: queuedSessionId,
      userTurnId: turn.id,
      inputConfig: turn.inputConfig,
      requesterUserId: turn.userId,
      localProjectIds: [],
    });
  /** The production order: resolve who the input runs as, then claim under that identity. */
  const claim = Effect.fnUntraced(function* (turn: {
    id: string;
    inputConfig?: unknown;
    userId?: string;
  }) {
    const requester = yield* execution.resolveRequester({
      workspaceId: 'workspace',
      sessionId: queuedSessionId,
      userTurnId: turn.id,
      inputConfig: turn.inputConfig,
    });
    return yield* rawClaim({
      ...turn,
      userId: 'userId' in requester && requester.userId ? requester.userId : turn.userId,
    });
  });
  const historyRow = (turnId: string) => {
    const list = doc.getList('history');
    for (let index = 0; index < list.length; index += 1) {
      const row = list.get(index) as LoroMap;
      if (row.get('id') === turnId) return row;
    }
    throw new Error('history row missing');
  };
  /** Another writer's update to the live row; the signed row keeps its original bytes. */
  const rewriteRow = (turnId: string, change: (config: Record<string, unknown>) => void) => {
    const row = historyRow(turnId);
    const stored: unknown = row.get('inputConfig');
    const config = (
      stored && typeof stored === 'object' && 'toJSON' in stored
        ? (stored as LoroMap).toJSON()
        : stored
    ) as Record<string, unknown>;
    change(config);
    row.set('inputConfig', config);
    doc.commit();
    return normalizeSessionTurnInputConfig(config);
  };
  /** A history row the member writes and signs directly, never promoted by this machine. */
  const writeMemberRow = Effect.fnUntraced(function* (
    turnId: string,
    userId: string,
    extra: object = {}
  ) {
    const inputConfig = normalizeSessionTurnInputConfig({
      ...queuedConfig(turnId),
      ...extra,
      resume: undefined,
      mcpServerIds: [],
    });
    const e2eeIntent = yield* signIntent(member, turnId, inputConfig);
    yield* Effect.promise(() =>
      session.sessionData.commands.appendTurn({
        id: turnId,
        role: 'user',
        userId,
        timestamp: queuedTimestamp,
        status: 'pending',
        queuedInput: true,
        items: [{ type: 'text', text: turnId }],
        inputConfig,
        e2eeIntent,
        fileDiff: [],
      } as never)
    );
    doc.commit();
    return { id: turnId, inputConfig, userId };
  });
  const writeDerivedRow = Effect.fnUntraced(function* (turnId: string, drivingTurnId: string) {
    const root = yield* execution.resolveDerivationOrigin({
      sessionId: queuedSessionId,
      userTurnId: drivingTurnId,
    });
    if (!root?.origin) return yield* Effect.fail(new Error('e2ee_derivation_denied'));
    const inputConfig = clientConfig(turnId);
    const e2eeIntent = yield* signIntent(device, turnId, inputConfig, { derivedFrom: root.origin });
    yield* Effect.promise(() =>
      session.sessionData.commands.appendTurn({
        id: turnId,
        role: 'user',
        userId: ownerAccount,
        timestamp: queuedTimestamp,
        status: 'pending',
        inputConfig,
        e2eeIntent,
        derivedFrom: root.origin,
        items: [{ type: 'text', text: turnId }],
        fileDiff: [],
      } as never)
    );
    doc.commit();
    return { id: turnId, inputConfig };
  });
  /**
   * The production start: the watcher builds the request from the stored row, the
   * gate claims that request's input, and the agent runs that request's blocks.
   */
  const startFromHistory = Effect.fnUntraced(function* (turnId: string) {
    const entry = historyRow(turnId).toJSON() as SessionHistoryInput;
    const request = yield* Effect.promise(() =>
      (
        watcher as unknown as {
          buildChatRequestFromHistoryEntry: (
            currentMeta: SessionMeta,
            historyEntry: SessionHistoryInput,
            launchConfig: undefined,
            user: { name: string; email: string }
          ) => Promise<{ acpSessionConfig: Record<string, unknown> }>;
        }
      ).buildChatRequestFromHistoryEntry(meta, entry, undefined, { name: 'n', email: 'e' })
    );
    const claimed = yield* claim({ id: turnId, inputConfig: request.acpSessionConfig });
    const runs = extractPromptPreviewFromInputBlocks(
      resolveSessionExecutionInputBlocks(request.acpSessionConfig)
    );
    return { claimed, runs };
  });
  /** Another writer replaces a row's displayed items, outside the signed input. */
  const replaceItems = (turnId: string, text: string) => {
    historyRow(turnId).set('items', [{ type: 'text', text }]);
  };
  return {
    sharing,
    writeDerivedRow,
    makeRemoteExecution,
    restartExecution: () => {
      journal = new RealtimeJournal(
        join(directory, 'queued-journal.sqlite'),
        () => machineClock.now
      );
      execution = makeExecution();
    },
    replaceItems,
    startFromHistory,
    memberCryptoUser: Buffer.from(new Uint8Array(32).fill(73)).toString('hex'),
    memberRequester: `e2ee-member:${Buffer.from(new Uint8Array(32).fill(73)).toString('hex')}`,
    fixture,
    append,
    asClient,
    signIntent,
    device,
    rawClaim,
    secondRpc,
    pushRowAsPeer: (peer: `${number}`, turnId: string, userId: string) =>
      Effect.gen(function* () {
        doc.commit();
        doc.setPeerId(peer);
        yield* pushRow(turnId, userId);
        doc.commit();
        doc.setPeerId(machinePeer);
      }),
    claim,
    doc,
    historyRow,
    prepareOriginal,
    pushRow,
    rewriteRow,
    writeMemberRow,
    get execution() {
      return execution;
    },
    gate,
    io,
    machineClock,
    machineKey,
    member,
    memberRpc,
    membershipId,
    ownerRpc,
    promote,
    send,
    session,
    clientConfig,
    dispose: Effect.sync(() => {
      watcher.stop();
      session.mirror.dispose();
    }),
  };
});

const iroh = loadIrohNative(developmentNativePath());

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

const run = (
  shared: boolean,
  body: (
    harness: Effect.Success<ReturnType<typeof queuedInputHarness>>
  ) => Effect.Effect<void, unknown, Scope.Scope>
) =>
  execute(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), 'queued-input-'))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
      );
      const harness = yield* queuedInputHarness(directory, shared);
      yield* Effect.ensuring(body(harness), harness.dispose);
    })
  );

const threeDays = 3 * 24 * 60 * 60_000;
export {
  admittedBeforeKey,
  automationOrigin,
  execute,
  executionFixture,
  hex,
  iroh,
  memberAccount,
  noKeyring,
  ownerAccount,
  page,
  queuedConfig,
  queuedInputHarness,
  queuedSessionId,
  queuedTimestamp,
  run,
  setup,
  testDeclarationSigner,
  testIntentSigner,
  testMachineInputSigner,
  threeDays,
  wrapper,
  wrappingKey,
};
