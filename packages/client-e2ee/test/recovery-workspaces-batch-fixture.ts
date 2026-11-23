// Real controller, vault, crypto, registry and IndexedDB; synthetic service I/O.
import { Clock, Deferred, Duration, Effect, Exit, Result, Scope } from 'effect';
import { ConvexHttpClient } from 'convex/browser';
import { makeWorkspaceRecovery, memoryRecoveryEpochKeys } from '@lody/e2ee-core';
import { importBrowserDevice, type BrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import { browserPasskeyPort } from '@lody/e2ee-client/passkey-browser';
import {
  accountUserId,
  Bytes,
  signGenesisRecord,
  hashRecordBytes,
  verifyLedger,
  prepareEpochEnvelope,
  encodeCbor,
  prepareLedgerRecord,
  prepareLedgerCommand,
  signLedgerRecord,
  commitEpochKey,
  sealHistoryPacket,
  getCommittedEpochStagingKey,
  authenticateEpochStagedGroup,
  type EpochStagedGroup,
} from '@lody/e2ee-core/protocol';
import { encodeEpochStagedGroup, ownEpochStagedGroupKey } from '@lody/e2ee-core/host';
import { personalEntryRecovery } from '@lody/client-e2ee';
import { hex, raw } from '@lody/client-e2ee/network';
import {
  makeRecoveryWorkspaces,
  type RecoveryWorkspaceProgress,
} from '@lody/client-e2ee/recovery-workspaces';
import { recoveryWorkspacesPort } from '@lody/client-e2ee/recovery-port';
import { createStore, type PlatformSessionState } from '@lody/platform';
import {
  personalEntry,
  personalEntryPins,
  personalCloudHostPorts,
  personalCloudDatabases,
} from '../src/index';
import { browserClientCustody } from '@lody/e2ee-core/adapters/browser-custody';
import { WorkspaceScope } from '@lody/e2ee-core/services';
import { Context, Layer } from 'effect';
import { LedgerFeedStore } from '@lody/e2ee-core/services';
import { indexedDbClientStores } from '@lody/e2ee-core/adapters/indexeddb';
import { verifyPersonalOffer } from '@lody/e2ee-client';
import type { RecoveryVaultCiphertextDto } from '@lody/cloud-api';

type Workspace = {
  id: string;
  owner: BrowserDevice;
  records: Uint8Array[];
  credentials: Map<string, string>;
  genesisHash: string;
};
const workspaces = new Map<string, Workspace>();
const entries = new Map<string, RecoveryVaultCiphertextDto>();
const entryWorkspaces = new Map<string, string>();
let index: RecoveryVaultCiphertextDto | null = null,
  vaultId: string | null = null;
let file: Uint8Array, engine: ReturnType<typeof makeRecoveryWorkspaces>;
let run: <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Promise<A>;
let gate: { path: string; released: Deferred.Deferred<void> } | undefined;
let sourceScope: Scope.Closeable;
let entry: ReturnType<typeof personalEntry>;
let runtime: NonNullable<ReturnType<ReturnType<typeof personalEntry>['createRuntime']>>;
let stage = 'new';
let blocked = false;
let historyMetadata = true;
let loseAppendReply = false;
let emptyMailbox = false;
let historyReads = 0;
let stagingReads = 0;
const stagedGroups = new Map<string, EpochStagedGroup>();
/** Committed epochs whose envelopes have not reached staging yet. */
const heldGroups = new Map<string, EpochStagedGroup>();
/** Epoch 0 envelopes signed before a newer epoch, by `workspace:recipient`. */
const epochZero = new Map<string, Uint8Array>();
const failures: string[] = [];
let actual: Promise<unknown>[] = [];
let now = 0;
const sleepers = new Set<{ deadline: number; finish: () => void }>();
let snapshots: RecoveryWorkspaceProgress[] = [];
const key = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(42)));
const view = (w: Workspace) =>
  Result.getOrThrow(
    verifyLedger({
      anchor: Result.getOrThrow(Bytes.genesisHash(raw(w.genesisHash))),
      records: w.records,
      checkpoint: { head: hashRecordBytes(w.records.at(-1)!), length: w.records.length },
    })
  );
const append = (w: Workspace, record: Uint8Array, credentialHash?: string) => {
  if (!w.records.some((old) => hex(old) === hex(record))) {
    const before = new Set(view(w).inspectState().devices.keys());
    w.records.push(record.slice());
    for (const id of view(w).inspectState().devices.keys())
      if (!before.has(id) && credentialHash) w.credentials.set(credentialHash, id);
  }
};
async function server(path: string, args: Record<string, unknown>) {
  const w = workspaces.get(String(args.workspaceId ?? entryWorkspaces.get(String(args.entryId))));
  const wait = async () => {
    if (w?.id === 'A' && gate?.path === path) {
      blocked = true;
      await run(Deferred.await(gate.released));
    }
  };
  if (path === 'e2eeWorkspaces:appendRecord') {
    append(w!, raw(String(args.recordHex)), args.credentialHash as string | undefined);
    if (loseAppendReply) {
      loseAppendReply = false;
      throw new Error('synthetic lost append reply');
    }
    await wait(); // Commit happened; acknowledgement is deliberately unknown.
    return { status: 'committed', recordHash: args.requestId };
  }
  await wait();
  if (path === 'e2eeMembers:workspaces')
    return [...workspaces.values()].map((w) => ({
      id: w.id,
      name: w.id,
      genesisHash: w.genesisHash,
    }));
  if (path === 'e2eeRecoveryVault:hasAccountVault') return { exists: vaultId !== null };
  if (path === 'e2eeRecoveryVault:replacementState') return { current: vaultId, replacing: null };
  if (path === 'e2eeRecoveryVault:putImmutable') {
    const entry = args.entry as RecoveryVaultCiphertextDto;
    vaultId = String(args.vaultId);
    entries.set(entry.entryId, entry);
    return { ok: true };
  }
  if (path === 'e2eeRecoveryVault:readEntry') return entries.get(String(args.entryId)) ?? null;
  if (path === 'e2eeRecoveryVault:readIndex') return index;
  if (path === 'e2eeRecoveryVault:compareAndSwapIndex') {
    index = args.next as RecoveryVaultCiphertextDto;
    return { outcome: 'Committed' };
  }
  if (path === 'e2eeWorkspaces:history') {
    historyReads++;
    const at = args.after ? Number(String(args.after).split(':')[2]) : 0;
    return {
      workspaceId: w!.id,
      genesisHash: w!.genesisHash,
      checkpoint: { headHash: hex(view(w!).head.toBytes()), length: w!.records.length },
      startIndex: at,
      recordsHex: w!.records.slice(at).map(hex),
      position: `p1:${w!.id}:${w!.records.length}:opaque:0`,
      nextCursor: null,
      ...(historyMetadata
        ? {
            ledgerCapacity: {
              limitBytes: 33554432,
              observedBytes: 1,
              observedLength: w!.records.length,
              nearLimit: false,
            },
          }
        : {}),
    };
  }
  if (path === 'e2eeMailbox:fetch') {
    if (emptyMailbox || (epochZero.size > 0 && Number(args.epoch) !== 0))
      return { items: [], next: null };
    const hash = hex(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new Uint8Array(raw(String(args.credential))))
      )
    );
    const recipient = w!.credentials.get(hash);
    if (!recipient) throw new Error('synthetic credential missing');
    const retained = epochZero.get(`${w!.id}:${recipient}`);
    const frame =
      retained ??
      (await run(
        prepareEpochEnvelope({
          context: {
            genesis: view(w!).genesis,
            epoch: Result.getOrThrow(Bytes.epochNumber(0)),
            sender: w!.owner.publicKey,
            recipient: Result.getOrThrow(Bytes.signingPublicKey(raw(recipient))),
          },
          key,
          signer: w!.owner,
          ledger: () => Effect.succeed(view(w!)),
        })
      ));
    return {
      items: [{ sender: hex(w!.owner.publicKey.toBytes()), frameHex: hex(frame) }],
      next: null,
    };
  }
  if (path === 'e2eeMailbox:report' || path === 'e2eeMailbox:repair') return null;
  if (path === 'e2eeMailbox:status')
    return { ...(args.slot as object), revision: 1, status: 'InstallationReported' };
  if (path === 'e2eeEpochStaging:readGroup') {
    stagingReads++;
    const group = stagedGroups.get(w!.id);
    if (!group) return null;
    const requested = args.key as Record<string, unknown>;
    if (Object.keys(requested).sort().join(',') !== 'commitment,epoch,genesis,recordHash')
      throw new Error('synthetic staging request must contain only wire locator fields');
    if (
      ['genesis', 'epoch', 'commitment', 'recordHash'].some(
        (field) => requested[field] !== group[field as keyof EpochStagedGroup]
      )
    )
      throw new Error('synthetic staging locator mismatch');
    return encodeEpochStagedGroup(group);
  }
  throw new Error('unexpected synthetic operation: ' + path);
}
export async function boot() {
  sourceScope = await Effect.runPromise(Scope.make());
  const live = await Effect.runPromise(Clock.clockWith(Effect.succeed));
  const clock: Clock.Clock = Object.assign(Object.create(live), {
    sleep: (duration: Duration.Input) =>
      Effect.callback<void>((resume) => {
        const entry = {
          deadline: now + Duration.toMillis(duration),
          finish: () => resume(Effect.void),
        };
        sleepers.add(entry);
        return Effect.sync(() => {
          sleepers.delete(entry);
        });
      }),
  });
  run = (effect) =>
    Effect.runPromise(
      Scope.provide(Effect.provideService(effect, Clock.Clock, clock), sourceScope)
    );
  const client = new ConvexHttpClient('https://synthetic.convex.cloud', {
    fetch: (async (_url, init) => {
      const {
        path,
        args: [args],
      } = JSON.parse(String(init?.body));
      const value = await server(path, args);
      return new Response(JSON.stringify({ status: 'success', value }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
  for (let i = 0; i < 3; i++) {
    const owner = await run(
      importBrowserDevice({
        signingPrivate: new Uint8Array(32).fill(10 + i),
        encryptionPrivate: new Uint8Array(32).fill(20 + i),
      })
    );
    const genesis = await run(
      signGenesisRecord({
        signer: owner,
        encryptionPublicKey: owner.enc,
        initialKey: key,
        membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10 + i))),
        userId: Result.getOrThrow(accountUserId('abc')),
      })
    );
    workspaces.set('ABC'[i], {
      id: 'ABC'[i],
      owner,
      records: [genesis.record],
      genesisHash: hex(genesis.genesis.toBytes()),
      credentials: new Map(),
    });
  }
  entry = personalEntry({
    run,
    pins: personalEntryPins('lody-e2ee:web:v1:entry-pins'),
    ledgerRecords: (accountId, offer) => (view) =>
      Effect.scoped(
        Effect.gen(function* () {
          const verified = yield* Effect.fromResult(verifyPersonalOffer(offer));
          const scope = { accountId, workspaceId: offer.workspaceId, genesis: verified.genesis };
          const storage = yield* Layer.build(
            indexedDbClientStores({
              databaseName: personalCloudDatabases(scope, 'web').ledger,
              accountId,
              workspaceId: offer.workspaceId,
              mode: 'open-existing',
            }).pipe(Layer.provide(Layer.succeed(WorkspaceScope, { genesis: scope.genesis })))
          );
          const contents = yield* Context.get(storage, LedgerFeedStore).load(16384);
          return (
            contents?.records
              .map((record, index) => ({ record, position: contents.originCount + index }))
              .filter((row) => row.position < view.length) ?? []
          );
        })
      ),

    ports: (input) =>
      personalCloudHostPorts(
        { ...input, client, platformNamespace: 'web' },
        {
          protection: 'web-crypto',
          custody: (binding, candidateRequest) =>
            browserClientCustody({
              databaseName: personalCloudDatabases(binding, 'web').custody,
              binding,
              candidateRequest,
              mode: input.mode,
            }).pipe(Layer.provide(Layer.succeed(WorkspaceScope, { genesis: binding.genesis }))),
        }
      ),
  });
  runtime = entry.createRuntime({
    session: createStore<PlatformSessionState>({
      status: 'authenticated',
      user: { id: 'abc', name: 'A', email: 'a@example.test', image: null },
    }),
  })!;
  engine = makeRecoveryWorkspaces({
    platform: 'web',
    serviceLocator: 'https://lody.ai',
    passkey: browserPasskeyPort(),
    accountId: 'abc',
    sessionId: 'login',
    currentSession: () => ({ accountId: 'abc', sessionId: 'login' }),
    enabled: () => true,
    client,
    commands: {
      restore: async (...args) => {
        try {
          return await personalEntryRecovery(runtime)!.restore(...args);
        } catch (error) {
          failures.push(JSON.stringify(error));
          throw error;
        }
      },
      setup: async (...args) => {
        try {
          return await personalEntryRecovery(runtime)!.setup(...args);
        } catch (error) {
          failures.push(JSON.stringify(error));
          throw error;
        }
      },
    },
  });
  stage = 'create';
  await run(
    engine.create(async (bytes) => {
      file = bytes.slice();
      return bytes.slice();
    })
  );
  await run(
    engine.withVault({ file }, true, (vault, _passkey, local) =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const w of workspaces.values()) {
            stage = 'backup ' + w.id;
            const installed = memoryRecoveryEpochKeys();
            yield* installed.saveAndReload(0, key);
            const recovery = yield* makeWorkspaceRecovery({
              vault,
              local,
              genesis: view(w).genesis,
              membershipId: Result.getOrThrow(
                Bytes.membershipId(new Uint8Array(16).fill(10 + 'ABC'.indexOf(w.id)))
              ),
              personalSigner: w.owner,
              ledger: () => Effect.succeed(view(w)),
              installed,
              trust: {
                source: 'synthetic-owner',
                genesisRecord: w.records[0],
                head: hex(view(w).head.toBytes()),
                length: view(w).length,
              },
              fetchCurrentEnvelope: (recipient, epoch, _identity, credential) =>
                prepareEpochEnvelope({
                  context: {
                    genesis: view(w).genesis,
                    epoch: Result.getOrThrow(Bytes.epochNumber(epoch)),
                    sender: w.owner.publicKey,
                    recipient,
                  },
                  key,
                  signer: w.owner,
                  ledger: () => Effect.succeed(view(w)),
                }).pipe(
                  Effect.map((frame) => ({ sender: w.owner.publicKey, frame })),
                  Effect.ensuring(Effect.sync(() => credential.fill(0)))
                ),
              submitOriginal: (record, registration) =>
                Effect.sync(() => {
                  append(
                    w,
                    record,
                    registration ? hex(registration.recoveryCredentialHash) : undefined
                  );
                  return { outcome: 'Committed' as const, record: record.slice() };
                }),
            });
            yield* recovery.setup();
            for (const ref of (yield* vault.readIndex()).value.entries)
              if (ref.genesis === w.genesisHash) entryWorkspaces.set(ref.entryId, w.id);
            installed.dispose();
          }
        })
      )
    )
  );
  stage = 'ready';
}
export function start(path: string, kind: 'restore' | 'setup' = 'restore', ids = ['A', 'B']) {
  arm(path);
  launch(kind, ids);
}
export function arm(path: string) {
  gate = { path, released: Deferred.makeUnsafe<void>() };
}
export function launch(kind: 'restore' | 'setup', ids: string[]) {
  const promise = run(
    engine[kind]({ file }, ids, (progress) => {
      snapshots.push(progress);
    })
  );
  actual.push(promise);
  // Observe fixture failures without hiding them from finish().
  void promise.catch((error) => failures.push(JSON.stringify(error)));
}
export async function admitted() {
  launch('restore', ['A', 'B', 'C']);
  await Promise.all(actual);
  actual = [];
  snapshots = [];
  file.fill(0);
  vaultId = null;
  index = null;
  entries.clear();
  await run(
    engine.create(async (bytes) => {
      file = bytes.slice();
      return bytes.slice();
    })
  );
}
export function state() {
  return {
    stage,
    blocked,
    historyReads,
    stagingReads,
    failures,
    progress: snapshots.at(-1),
    snapshots,
    records: [...workspaces].map(([id, w]) => ({
      id,
      records: w.records.map(hex),
      devices: [...view(w).inspectState().devices].map(([id, row]) => ({ id, kind: row.kind })),
    })),
  };
}
/** The console's recovery port over this engine. Each file prompt hands out a copy of
 * the recovery file; `prompts` counts how often the person was asked to unlock. */
let prompts = 0;
const consolePort = () =>
  recoveryWorkspacesPort({
    engine: async () => engine,
    // Track every command so close() waits for producers that outlive a port answer.
    run: (effect) => {
      const promise = run(effect);
      actual.push(promise);
      return promise;
    },
    chooseFile: async () => {
      prompts++;
      return file.slice();
    },
    defaultLabel: async () => 'Browser',
  });
export const portPlan = () => consolePort().plan();
export const portSetup = async (ids: string[]) => ({
  settled: await consolePort().setupWorkspaces(ids, 'file'),
  prompts,
});
/** Setup through the port while A's original submission is held at the relay. */
let portAnswer: unknown = null;
export function portSetupHeld(ids: string[]) {
  portAnswer = null;
  arm('e2eeWorkspaces:appendRecord');
  void consolePort()
    .setupWorkspaces(ids, 'file')
    .then((value) => {
      portAnswer = value;
    });
}
export const portAnswered = () => portAnswer;
export const controller = () => engine;
export const execute = () => run;
export const advance = (ms: number) =>
  run(
    Effect.sync(() => {
      now += ms;
      for (const sleeper of sleepers)
        if (sleeper.deadline <= now) {
          sleepers.delete(sleeper);
          sleeper.finish();
        }
    })
  );
export const release = () => run(Deferred.succeed(gate!.released, undefined));
export async function finish() {
  await Promise.all(actual);
}
export async function close() {
  gate && (await release());
  await finish();
  engine.dispose();
  await entry.close();
  await Effect.runPromise(Scope.close(sourceScope, Exit.void));
  file.fill(0);
}

export const fileBytes = () => Array.from(file);

/** Synthetic transport controls; never alter signed ledger originals. */
export function historyTransport(options: { metadata: boolean; emptyMailbox?: boolean }) {
  historyMetadata = options.metadata;
  emptyMailbox = options.emptyMailbox ?? false;
}

/** Commit a genuine publication and its complete staged envelopes after the vault
 * backup. The recovery device therefore has to open the newer epoch from staging. */
export async function commitStagedEpoch(options: { publish?: boolean } = {}) {
  await run(
    Effect.gen(function* () {
      const next = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(43)));
      for (const w of workspaces.values()) {
        const before = view(w);
        if (options.publish === false)
          for (const device of before.inspectState().devices.keys())
            epochZero.set(
              `${w.id}:${device}`,
              yield* prepareEpochEnvelope({
                context: {
                  genesis: before.genesis,
                  epoch: Result.getOrThrow(Bytes.epochNumber(0)),
                  sender: w.owner.publicKey,
                  recipient: Result.getOrThrow(Bytes.signingPublicKey(raw(device))),
                },
                key,
                signer: w.owner,
                ledger: () => Effect.succeed(before),
              })
            );
        const body = Result.getOrThrow(
          encodeCbor([
            before.head.toBytes(),
            w.owner.publicKey.toBytes(),
            [
              7,
              1,
              Result.getOrThrow(commitEpochKey(before.genesis, 1, next)).toBytes(),
              Result.getOrThrow(
                sealHistoryPacket({
                  genesis: before.genesis,
                  epoch: 1,
                  currentKey: next,
                  previousKey: key,
                })
              ),
            ],
          ])
        );
        const record = yield* signLedgerRecord(
          Result.getOrThrow(prepareLedgerRecord(before, body)),
          w.owner
        );
        append(w, record);
        const committed = view(w);
        const locator = Result.getOrThrow(getCommittedEpochStagingKey(committed, 1));
        const group: EpochStagedGroup = {
          ...Result.getOrThrow(ownEpochStagedGroupKey(locator)),
          record,
          envelopes: yield* Effect.forEach([...committed.inspectState().devices.keys()], (device) =>
            Effect.map(
              prepareEpochEnvelope({
                context: {
                  genesis: committed.genesis,
                  epoch: Result.getOrThrow(Bytes.epochNumber(1)),
                  sender: w.owner.publicKey,
                  recipient: Result.getOrThrow(Bytes.signingPublicKey(raw(device))),
                },
                key: next,
                signer: w.owner,
                ledger: () => Effect.succeed(view(w)),
              }),
              (frame) => ({ recipient: device, frame })
            )
          ),
        };
        // Check publication, every recipient and every envelope signature before serving it.
        Result.getOrThrow(authenticateEpochStagedGroup(committed, group, true));
        (options.publish === false ? heldGroups : stagedGroups).set(w.id, group);
      }
    })
  );
  if (options.publish !== false) emptyMailbox = true;
}

/** Inspect installed key readiness through real runtime acquisition, releasing only
 * this check's reader after the status has been captured. */
export async function restoredKeys(ids: string[]) {
  return Promise.all(
    ids.map(async (workspaceId) => {
      const status = await runtime.open(workspaceId, undefined, 'abc');
      try {
        return { workspaceId, epoch: status.epoch, hasCurrentKey: status.hasCurrentKey };
      } finally {
        await runtime.close(workspaceId, 'abc', status.readerOwner);
      }
    })
  );
}

/** Serve the envelopes `commitStagedEpoch({ publish: false })` held back. */
export function publishStagedEpoch() {
  for (const [id, group] of heldGroups) stagedGroups.set(id, group);
  heldGroups.clear();
}

/** The routing phase of this account's entry pin for a workspace. */
export const pinPhase = async (workspaceId: string) =>
  (await run(personalEntryPins('lody-e2ee:web:v1:entry-pins').read('abc', workspaceId)))?.phase ??
  null;

/** The owner revokes every personal device but its own; returns the revoked keys. */
export async function revokePersonalDevices(workspaceId: string) {
  const w = workspaces.get(workspaceId)!;
  const owner = hex(w.owner.publicKey.toBytes());
  const targets = [...view(w).inspectState().devices]
    .filter(([id, row]) => row.kind === 'personal' && id !== owner)
    .map(([id]) => id);
  for (const target of targets) {
    const proposal = Result.getOrThrow(
      prepareLedgerCommand(view(w), w.owner.publicKey, {
        _tag: 'RevokeDevice',
        target: Result.getOrThrow(Bytes.signingPublicKey(raw(target))),
      })
    );
    append(w, await run(signLedgerRecord(proposal, w.owner)));
  }
  return targets;
}

/** Open a workspace through the real runtime; refusals are returned as their message. */
export async function openStatus(workspaceId: string) {
  let reader: string | undefined;
  try {
    reader = (await runtime.open(workspaceId, undefined, 'abc')).readerOwner;
    const status = await runtime.refresh(workspaceId);
    return { signingPublicKey: status.signingPublicKey, hasCurrentKey: status.hasCurrentKey };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  } finally {
    if (reader) await runtime.close(workspaceId, 'abc', reader).catch(() => undefined);
  }
}

/** Restore through the console's port, recording every streamed row. */
export async function portRestore() {
  const observed: unknown[] = [];
  const restored = await consolePort().restore('file', undefined, (row) => observed.push(row));
  return { restored, observed };
}

/** The next ledger append commits, but its reply never reaches the client. */
export function loseNextAppendReply() {
  loseAppendReply = true;
}
