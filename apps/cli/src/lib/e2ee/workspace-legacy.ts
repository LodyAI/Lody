import { makeLazyMachineSharingHost, sharingRemoteFromTransport } from '@lody/e2ee-machine-sharing';
import { authorizeEncryptedSchedule } from './schedule-execution-authorization';
import {
  getScheduleRoomId,
  getScheduleIdFromRoomId,
  type ScheduleAuthorizationRequest,
} from '@lody/shared';
import { makeExecutionOriginRecovery } from './execution-origin-recovery';
import { makeEncryptedFeatureReceiver, type EncryptedFeatureHandler } from './feature-rpc';
import { makeEncryptedRpcReceiver } from './realtime-rpc';
import { makeLedgerCatchUp } from './rpc-ledger-catch-up';
import { e2eeRpcResource } from '@lody/loro-streams-rpc/e2ee-resource';
import { getLogger } from '../../utils/logger';
import { lazyExecutionJournal } from './agent-execution';
import { makeE2eeRpcNative, E2eeRpcOriginals } from '@lody/loro-streams-rpc/e2ee-native';
import { createLoroStreamsJsonStreamClient } from '@lody/loro-streams-rpc';
import { makeEncryptedRpcListener, type E2eeRpcTiming } from '@lody/loro-streams-rpc/e2ee-streams';
import type { E2eeDispatchInput, E2eeDispatchAck } from '@lody/shared/e2ee-rpc';
import { isDeepStrictEqual } from 'node:util';
import { ExecutionOrigins } from './execution-origins';
import type { EncryptedExecutionIntent } from './agent-execution';
import type { LoroDoc } from 'loro-crdt';
import { isCloudE2eeMemberRemoved, isCloudE2eeDeviceRevoked } from '../cloud-e2ee-errors';
import {
  getSessionRoomId,
  isSessionDocRoomId,
  type SessionId,
  type LoroStreamsTokenAuth,
} from '@lody/shared';
import { leaseE2eeIdentity } from '@lody/shared/node/e2ee-identity';
import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { link, mkdir, open, readFile, rename, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, Exit, Scope, Result, Fiber, Schedule } from 'effect';
import { z } from 'zod';
import type { PayloadProtectionProvider } from '@loro-dev/streams-crdt';
import type { CloudE2eePort, CloudStreamsTokenPort } from '@lody/platform';
import { BackendError, KeyMailbox } from '@lody/e2ee-core/services';
import { decodeEpochStagedGroup } from '@lody/e2ee-core/host';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  encryptedWorkspaceNamespace,
  encryptedWorkspaceResolver,
  encryptedWorkspaceRoom,
  createWorkspaceEpochTransitionLegacy,
  type WorkspaceStreamsContent,
} from '@lody/shared/workspace-streams-content';
import { makeCliE2eeCustody, type MachineKeyring } from './custody';
import { makeCliE2eeRuntime } from './runtime';
import { makeCliE2eeExecutionAuthorization } from './execution-authorization';
import { openMachinePairingJournal, MachinePairingJournalError } from './pairing-journal';

const Binding = z
  .object({
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    genesisHash: z.string().regex(/^[0-9a-f]{64}$/),
    genesisRecordHex: z.string().regex(/^(?:[0-9a-f]{2}){1,8192}$/),
  })
  .strict();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
export const cliE2eeIdentityDirectory = (accountId: string, workspaceId: string) => {
  if (!accountId || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId))
    throw new Error('e2ee_invalid_input');
  return join(
    getLodyDataDir(),
    'e2ee',
    createHash('sha256').update(accountId).digest('hex'),
    workspaceId
  );
};

// This repo belongs to the same account/workspace lease as custody, and to
// this exact retained device. Removal never touches a workspace-global repo.
const repositoryDirectory = (directory: string, genesisHash: string, signingPublicKey: string) =>
  join(directory, 'content', genesisHash, signingPublicKey);

const Removed = z
  .object({
    genesisHash: z.string().regex(/^[0-9a-f]{64}$/),
    signingPublicKey: z.string().regex(/^[0-9a-f]{64}$/),
    membershipId: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();
async function readRemoval(directory: string) {
  try {
    return Removed.parse(JSON.parse(await readFile(join(directory, 'removed.json'), 'utf8')));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
}
/** Only after the caller's workspace owners drain. The pairing mutex excludes a
 * replacement identity during the exact-key check and deletion. Keep a public
 * terminal receipt so interrupted erasure retries before any later attachment. */
async function eraseRemovedWorkspace(
  options: Pick<
    CliE2eeWorkspaceOptions,
    'accountId' | 'workspaceId' | 'keyring' | 'expectedSigningPublicKey'
  >
) {
  const directory = cliE2eeIdentityDirectory(options.accountId, options.workspaceId);
  const removed = await readRemoval(directory);
  if (
    !removed ||
    (options.expectedSigningPublicKey &&
      options.expectedSigningPublicKey !== removed.signingPublicKey)
  )
    return false;
  const removal = removed;
  return executeRemoval();
  async function executeRemoval() {
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* leaseE2eeIdentity(directory, true);
          const journal = yield* openMachinePairingJournal(directory);
          const original = join(directory, 'custody', `${removal.genesisHash}.machine.device`);
          const exists = yield* Effect.tryPromise({
            try: async () => {
              try {
                await readFile(original);
                return true;
              } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
                throw cause;
              }
            },
            catch: (cause) => cause,
          });
          if (exists) {
            const same = yield* Effect.scoped(
              Effect.gen(function* () {
                const custody = yield* makeCliE2eeCustody({
                  directory: join(directory, 'custody'),
                  keyring: options.keyring,
                });
                const { Bytes } = yield* Effect.promise(() => import('@lody/e2ee-core/protocol'));
                const genesis = yield* Effect.fromResult(
                  Bytes.genesisHash(bytes(removal.genesisHash))
                );
                const device = yield* custody.openDevice(genesis);
                return hex(device.publicKey.toBytes()) === removal.signingPublicKey;
              })
            );
            if (!same) return false;
          }
          // The mutex and empty journal remain; user project/worktree directories are outside this scope.
          yield* Effect.promise(async () => {
            for (const name of ['custody', 'runtime', 'binding.json', 'activation.json'])
              await rm(join(directory, name), { recursive: true, force: true });
            await rm(
              repositoryDirectory(directory, removal.genesisHash, removal.signingPublicKey),
              {
                recursive: true,
                force: true,
              }
            );
          });
          yield* journal.eraseRemovedMember();
          return true;
        })
      )
    );
  }
}

/** Public pairing evidence is retained only through the trusted local approval
 * path. This operation neither admits a device nor obtains cloud credentials. */
export async function retainCliE2eeWorkspaceBinding(
  accountId: string,
  input: z.input<typeof Binding>
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* leaseE2eeIdentity(cliE2eeIdentityDirectory(accountId, input.workspaceId));
        return yield* Effect.tryPromise({
          try: () => retainBinding(accountId, input),
          catch: (error) => error,
        });
      })
    )
  );
}

/** Public pairing evidence is retained only through the trusted local approval
 * path. This operation neither admits a device nor obtains cloud credentials. */
async function retainBinding(accountId: string, input: z.input<typeof Binding>) {
  const binding = Binding.parse(input);
  const directory = cliE2eeIdentityDirectory(accountId, binding.workspaceId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, 'binding.json');
  const temporary = join(directory, `binding-${randomBytes(16).toString('hex')}.pending`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(binding));
    await handle.sync();
    await handle.close();
    await link(temporary, destination).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const actual = Binding.parse(
      JSON.parse(await (await import('node:fs/promises')).readFile(destination, 'utf8'))
    );
    if (JSON.stringify(actual) !== JSON.stringify(binding))
      throw new Error('e2ee_binding_conflict');
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function mailbox(
  port: CloudE2eePort,
  workspaceId: string,
  credential: string
): KeyMailbox['Service'] {
  const call = <A>(work: () => Promise<A>) =>
    Effect.tryPromise({
      try: work,
      catch: () => new BackendError({ service: 'KeyMailbox', reason: 'unavailable' }),
    });
  const access = { workspaceId, credential };
  return {
    put: (id, frame) =>
      call(async () => {
        await port.mailboxCall('put', { ...access, id, frameHex: hex(frame) });
      }),
    read: (id) =>
      call(async () => {
        const value = await port.mailboxCall('read', { ...access, id });
        return value === null ? null : bytes(value);
      }),
    report: (report, publication) =>
      call(async () => {
        await port.mailboxCall('report', {
          ...access,
          reportHex: hex(report),
          ...(publication ? { publicationHex: hex(publication) } : {}),
        });
      }),
    fetch: (epoch, cursor, limit) =>
      call(async () => {
        const page = await port.mailboxCall('fetch', { ...access, epoch, cursor, limit });
        return {
          ...page,
          items: page.items.map((item) => ({ sender: item.sender, frame: bytes(item.frameHex) })),
        };
      }),
    status: (slot) => call(() => port.mailboxCall('status', { ...access, slot })),
    repair: (slot, id, rejectedDigest) =>
      call(async () => {
        await port.mailboxCall('repair', {
          ...access,
          slot,
          id,
          ...(rejectedDigest ? { rejectedDigest } : {}),
        });
      }),
  };
}

/** @deprecated Promise entry for the existing same-user control consumer. */
export async function prepareCliE2eeMachineLegacy(options: Parameters<typeof prepareMachine>[0]) {
  const priorRemoval = await readRemoval(
    cliE2eeIdentityDirectory(options.accountId, options.workspaceId)
  );
  if (priorRemoval) {
    if (priorRemoval.membershipId === options.membershipId) throw new Error('e2ee_member_removed');
    if (await eraseRemovedWorkspace(options))
      await unlink(
        join(cliE2eeIdentityDirectory(options.accountId, options.workspaceId), 'removed.json')
      );
  }
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* leaseE2eeIdentity(cliE2eeIdentityDirectory(options.accountId, options.workspaceId));
        return yield* Effect.tryPromise({
          try: () => prepareMachine(options),
          catch: (error) => error,
        });
      })
    )
  );
}

/** Build the retained machine identity, possession proof and fixed credential
 * binding for the desktop-generated pairing session. No admission or cloud I/O. */
async function prepareMachine(
  options: z.input<typeof Binding> & {
    accountId: string;
    machineId: string;
    frontendSigningPublicKey: string;
    membershipId: string;
    pairingSessionId: string;
    keyring?: MachineKeyring;
  }
) {
  const { Bytes, hashRecordBytes, verifyLedgerEffect } = await import('@lody/e2ee-core/protocol');
  const binding = Binding.parse({
    workspaceId: options.workspaceId,
    genesisHash: options.genesisHash,
    genesisRecordHex: options.genesisRecordHex,
  });
  if (hex(hashRecordBytes(bytes(binding.genesisRecordHex)).toBytes()) !== binding.genesisHash)
    throw new Error('e2ee_binding_conflict');
  const genesis = Result.getOrThrow(Bytes.genesisHash(bytes(binding.genesisHash)));
  await Effect.runPromise(
    verifyLedgerEffect({
      anchor: genesis,
      records: [bytes(binding.genesisRecordHex)],
      checkpoint: { length: 1, head: hashRecordBytes(bytes(binding.genesisRecordHex)) },
    })
  );
  await retainCliE2eeWorkspaceBinding(options.accountId, binding);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = cliE2eeIdentityDirectory(options.accountId, options.workspaceId);
        const journal = yield* openMachinePairingJournal(directory);
        const custody = makeCliE2eeCustody({
          directory: join(directory, 'custody'),
          requireOsProtection: existsSync(`${directory}.require-os`),
          keyring: options.keyring,
        });
        return yield* journal
          .prepare(
            {
              machineId: options.machineId,
              accountId: options.accountId,
              ...binding,
              membershipId: options.membershipId,
              pairingSessionId: options.pairingSessionId,
              frontendSigningPublicKey: options.frontendSigningPublicKey,
            },
            custody
          )
          .pipe(
            Effect.catchIf(
              (error) => error instanceof MachinePairingJournalError && error.code === 'superseded',
              () =>
                Effect.succeed({
                  superseded: true as const,
                  pairingSessionId: options.pairingSessionId,
                })
            )
          );
      })
    )
  );
}

/** Registered execution facade: daemon Lody.create and isolated command managers
 * borrow one scoped native workspace. The native owner itself does no network
 * work on open. Delete this facade when those application owners compose Effects.
 */
type CliE2eeWorkspaceOptions = {
  accountId: string;
  workspaceId: string;
  genesisHash: string;
  expectedSigningPublicKey?: string;
  cloud: CloudE2eePort;
  onUnavailable: () => void;
  /** Stop and drain the document/execution owner. Invoked outside the refresh flight. */
  onRemoved?: (reason: 'member-removed' | 'device-revoked') => Promise<void>;
  keyring?: MachineKeyring;
};
const Activation = z
  .object({
    genesisHash: z.string().regex(/^[0-9a-f]{64}$/),
    signingPublicKey: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export function openCliE2eeWorkspaceLegacy(options: CliE2eeWorkspaceOptions) {
  return openWorkspace(options, true);
}

/** A pending pairing verifies ledger bytes only; it cannot receive keys or attach content. */
export async function openCliE2eePairingRuntimeLegacy(options: CliE2eeWorkspaceOptions) {
  const pending = await openWorkspace(options, false);
  return { status: pending.status, refresh: pending.refresh, close: pending.close };
}

/** Validate only locally retained pairing intent before a Fleet ownership transition. */
export async function validateCliE2eePairingIntentLegacy(options: {
  accountId: string;
  workspaceId: string;
  genesisHash: string;
  machineId: string;
  pairingSessionId: string;
  frontendSigningPublicKey: string;
  signingPublicKey: string;
}) {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* leaseE2eeIdentity(cliE2eeIdentityDirectory(options.accountId, options.workspaceId));
        const journal = yield* openMachinePairingJournal(
          cliE2eeIdentityDirectory(options.accountId, options.workspaceId)
        );
        const retained = yield* journal.retained(options.pairingSessionId);
        if (
          retained.expected.accountId !== options.accountId ||
          retained.expected.machineId !== options.machineId ||
          retained.expected.workspaceId !== options.workspaceId ||
          retained.expected.genesisHash !== options.genesisHash ||
          retained.expected.frontendSigningPublicKey !== options.frontendSigningPublicKey ||
          retained.material.signingPublicKey !== options.signingPublicKey
        )
          return yield* Effect.fail(new Error('e2ee_binding_conflict'));
        return undefined;
      })
    )
  );
}

/** @deprecated Promise entry; retain the identity lease through activation publication. */
export async function activateCliE2eeWorkspaceLegacy(
  options: Parameters<typeof activateWorkspace>[0]
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* leaseE2eeIdentity(cliE2eeIdentityDirectory(options.accountId, options.workspaceId));
        return yield* Effect.tryPromise({
          try: () => activateWorkspace(options),
          catch: (error) => error,
        });
      })
    )
  );
}

/** Verify actual admission and install the current key before allowing Fleet to attach rooms.
 * The marker is only a startup hint: subsequent authorization still comes from core's verified ledger. */
async function activateWorkspace(
  options: CliE2eeWorkspaceOptions & {
    pairingSessionId: string;
    frontendSigningPublicKey: string;
    expectedSigningPublicKey: string;
  }
) {
  const pending = await openWorkspace(options, false, {
    pairingSessionId: options.pairingSessionId,
    frontendSigningPublicKey: options.frontendSigningPublicKey,
    signingPublicKey: options.expectedSigningPublicKey,
  });
  let marker: z.infer<typeof Activation>;
  try {
    await pending.refresh();
    const status = await pending.status();
    if (
      options.expectedSigningPublicKey &&
      options.expectedSigningPublicKey !== status.devicePublicKey
    )
      throw new Error('e2ee_binding_conflict');
    pending.assertPairingConfirmed();
    if (!status.hasCurrentKey) throw new Error('e2ee_waiting_for_key');
    marker = { genesisHash: options.genesisHash, signingPublicKey: status.devicePublicKey };
  } finally {
    // Publish the Fleet startup hint only after the temporary native owner has
    // actually released its SQLite/custody resources.
    await pending.close();
  }
  const directory = cliE2eeIdentityDirectory(options.accountId, options.workspaceId);
  const destination = join(directory, 'activation.json');
  const temporary = join(directory, `activation-${randomBytes(16).toString('hex')}.pending`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(marker));
    await handle.sync();
    await handle.close();
    await link(temporary, destination).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const actual = Activation.parse(JSON.parse(await readFile(destination, 'utf8')));
    if (actual.genesisHash !== marker.genesisHash) throw new Error('e2ee_binding_conflict');
    // This startup hint may follow a newly approved device after custody loss.
    // Admission and key installation above, not the old hint, grant authority.
    if (actual.signingPublicKey !== marker.signingPublicKey) await rename(temporary, destination);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  await pending.completeRemotePairing(options.pairingSessionId);
}

async function openWorkspace(
  options: CliE2eeWorkspaceOptions,
  requireActivation: boolean,
  pairing?: { pairingSessionId: string; frontendSigningPublicKey: string; signingPublicKey: string }
) {
  if (await eraseRemovedWorkspace(options)) throw new Error('e2ee_member_removed');
  const scope = Effect.runSync(Scope.make());
  try {
    await Effect.runPromise(
      leaseE2eeIdentity(cliE2eeIdentityDirectory(options.accountId, options.workspaceId)).pipe(
        Scope.provide(scope)
      )
    );
    return await openWorkspaceOwned(scope, options, requireActivation, pairing);
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}

async function openWorkspaceOwned(
  scope: Scope.Closeable,
  options: CliE2eeWorkspaceOptions,
  requireActivation: boolean,
  pairing?: { pairingSessionId: string; frontendSigningPublicKey: string; signingPublicKey: string }
) {
  let credentialFailureHandler: (cause: unknown) => void = () => {};
  const directory = cliE2eeIdentityDirectory(options.accountId, options.workspaceId);
  let activation: z.infer<typeof Activation> | undefined;
  if (requireActivation) {
    const marker = await open(
      join(directory, 'activation.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW
    ).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new Error('e2ee_pairing_required', { cause: error });
    });
    try {
      const info = await marker.stat();
      if (!info.isFile() || info.size > 256) throw new Error('e2ee_binding_conflict');
      activation = Activation.parse(JSON.parse(await marker.readFile('utf8')));
      if (activation.genesisHash !== options.genesisHash) throw new Error('e2ee_binding_conflict');
    } finally {
      await marker.close();
    }
  }
  const bindingFile = await open(
    join(directory, 'binding.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error('e2ee_pairing_required', { cause: error });
  });
  let binding: z.infer<typeof Binding>;
  try {
    const info = await bindingFile.stat();
    if (!info.isFile() || info.size > 18000) throw new Error('e2ee_binding_conflict');
    binding = Binding.parse(JSON.parse(await bindingFile.readFile('utf8')));
  } finally {
    await bindingFile.close();
  }
  if (binding.workspaceId !== options.workspaceId || binding.genesisHash !== options.genesisHash)
    throw new Error('e2ee_binding_conflict');
  // A stale activation hint survives custody loss. Check the actual device
  // original before opening custody (which could otherwise initialize a new
  // empty store and probe the keyring). Only a missing original needs pairing;
  // permission, descriptor and corrupt-file failures keep their normal errors.
  const original = await open(
    join(directory, 'custody', `${binding.genesisHash}.machine.device`),
    constants.O_RDONLY | constants.O_NOFOLLOW
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error('e2ee_pairing_required', { cause: error });
  });
  await original.close();
  const run = <A, E>(work: Effect.Effect<A, E, Scope.Scope>) =>
    Effect.runPromise(work.pipe(Scope.provide(scope)));
  const opened = await run(
    Effect.gen(function* () {
      const custody = yield* makeCliE2eeCustody({
        directory: join(directory, 'custody'),
        requireOsProtection: existsSync(`${directory}.require-os`),
        keyring: options.keyring,
      });
      const { Bytes, hashRecordBytes } = yield* Effect.promise(
        () => import('@lody/e2ee-core/protocol')
      );
      const genesis = yield* Effect.fromResult(Bytes.genesisHash(bytes(binding.genesisHash)));
      if (hex(hashRecordBytes(bytes(binding.genesisRecordHex)).toBytes()) !== binding.genesisHash)
        throw new Error('e2ee_binding_conflict');
      // Existing workspace opens never generate an identity or a replacement credential.
      const device = yield* custody.openDevice(genesis);
      if (activation && activation.signingPublicKey !== hex(device.publicKey.toBytes()))
        throw new Error('e2ee_binding_conflict');
      const credential = yield* custody.deviceCredential(genesis, device.publicKey);
      const readEpochGroup = options.cloud.readEpochGroup?.bind(options.cloud);
      const runtime = yield* makeCliE2eeRuntime({
        directory: join(directory, 'runtime', hex(device.publicKey.toBytes())),
        workspaceId: options.workspaceId,
        custody,
        device,
        genesisRecord: bytes(binding.genesisRecordHex),
        mailbox: mailbox(options.cloud, options.workspaceId, credential),
        staging: readEpochGroup
          ? {
              readGroup: (key) =>
                Effect.tryPromise({
                  try: () => readEpochGroup({ workspaceId: options.workspaceId, credential, key }),
                  catch: () =>
                    new BackendError({ service: 'EpochStagingStore', reason: 'unavailable' }),
                }).pipe(
                  Effect.flatMap((group) =>
                    group === null
                      ? Effect.succeed(null)
                      : Effect.fromResult(decodeEpochStagedGroup(group)).pipe(
                          Effect.mapError(
                            () =>
                              new BackendError({
                                service: 'EpochStagingStore',
                                reason: 'invalid-response',
                              })
                          )
                        )
                  )
                ),
            }
          : undefined,
      });
      let sharing: Effect.Success<ReturnType<typeof makeLazyMachineSharingHost>> | undefined;
      const sharingRemote = options.cloud.machineSharing
        ? sharingRemoteFromTransport(options.cloud.machineSharing)
        : undefined;
      const executionAuthorization = yield* makeCliE2eeExecutionAuthorization({
        workspaceId: options.workspaceId,
        credential,
        cloud: options.cloud,
        onCredentialFailure: (cause) => credentialFailureHandler(cause),
        runtime,
        sharing: sharingRemote
          ? (requester, localProjectId) =>
              Effect.gen(function* () {
                const state = (yield* runtime.executionLedger()).inspectState();
                const machine = state.devices.get(hex(device.publicKey.toBytes()));
                if (!sharing || machine?.kind !== 'machine' || !machine.machineId)
                  return { allowed: false };
                return yield* sharing.authorize(
                  machine.machineId,
                  requester,
                  localProjectId,
                  sharingRemote
                );
              })
          : undefined,
      });
      sharing = yield* makeLazyMachineSharingHost({
        filename: join(
          directory,
          'runtime',
          hex(device.publicKey.toBytes()),
          'machine-sharing.sqlite'
        ),
        workspaceId: options.workspaceId,
        genesisHash: binding.genesisHash,
        signer: device,
        ledger: () => runtime.executionLedger(),
        admissionHistory: runtime.sharingAdmissionHistory,
        readEpochKey: runtime.readSharingEpochKey,
        credential,
        refreshLedger: () => executionAuthorization.refreshLedger,
      });
      return {
        sharing,
        sharingRemote,
        runtime,
        executionAuthorization,
        credential,
        custody,
        signingPublicKey: hex(device.publicKey.toBytes()),
      };
    })
  ).catch(async (error) => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  });
  const initialStatus = await run(opened.runtime.status());
  const tokensInUse = new Set<
    Awaited<Effect.Success<ReturnType<NonNullable<CloudE2eePort['createContentTokenProvider']>>>>
  >();
  const epochTransition = createWorkspaceEpochTransitionLegacy({
    ...initialStatus,
    epoch: initialStatus.writeEpoch ?? initialStatus.epoch,
  });
  epochTransition.observe(initialStatus);
  let ledgerBlocked = false;
  let pairingConfirmed = false;
  let pairingFailure: unknown;
  let ledgerRetryAttempts = 0;
  let ledgerRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let refresh: Promise<void> | undefined;
  let pending = false;
  let closeReceipt: Promise<void> | undefined;
  let bucket: (() => string | undefined) | undefined;
  const bindings = new Map<
    string,
    Promise<Effect.Success<ReturnType<typeof opened.runtime.binding>>>
  >();
  const snapshotRequests = new Map<string, number>();
  const snapshotFlights = new Set<Promise<unknown>>();
  const requestSnapshot = (stream: string) => {
    if (closed) return;
    const now = Date.now();
    if (now - (snapshotRequests.get(stream) ?? -Infinity) < 30_000) return;
    snapshotRequests.set(stream, now);
    const flight = options.cloud.getContentToken({
      workspaceId: options.workspaceId,
      credential: opened.credential,
      requestSnapshotFor: stream,
    });
    snapshotFlights.add(flight);
    void flight.then(
      () => snapshotFlights.delete(flight),
      (cause) => {
        snapshotFlights.delete(flight);
        if (isCloudE2eeMemberRemoved(cause) || isCloudE2eeDeviceRevoked(cause)) {
          credentialFailureHandler(cause);
          return;
        }
        console.warn('[e2ee] snapshot repair request failed; will retry');
      }
    );
  };
  let originWriteFailed = false;
  const executionOrigins = new ExecutionOrigins(
    join(
      repositoryDirectory(directory, binding.genesisHash, opened.signingPublicKey),
      'execution-origins.sqlite'
    )
  );
  const rpc = makeE2eeRpcNative({
    workspaceId: options.workspaceId,
    requesterDevice: opened.signingPublicKey,
    authorizeTarget: (machineId) =>
      opened.sharingRemote
        ? opened.sharing
            .authorize(machineId, opened.signingPublicKey, undefined, opened.sharingRemote)
            .pipe(Effect.map((result) => result.allowed))
        : Effect.succeed(false),
    originals: new E2eeRpcOriginals(
      join(
        repositoryDirectory(directory, binding.genesisHash, opened.signingPublicKey),
        'rpc-originals.sqlite'
      )
    ),
    ledger: () => opened.runtime.executionLedger(),
    binding: (resource) => opened.runtime.realtimeBinding(resource),
  });
  const rpcJournal = lazyExecutionJournal(
    join(
      repositoryDirectory(directory, binding.genesisHash, opened.signingPublicKey),
      'rpc-receipts.sqlite'
    ),
    Date.now
  );
  await run(Effect.addFinalizer(() => rpc.close().pipe(Effect.orDie)));
  // Both the realtime offer and the durable execution origin reopen dispatch frames.
  const catchUpLedger = makeLedgerCatchUp({
    genesis: binding.genesisHash,
    resource: e2eeRpcResource,
    ledger: () => opened.runtime.executionLedger(),
    // Join an in-flight refresh as is; otherwise start one round without resetting retries.
    catchUp: () => refresh ?? refreshInBackground(false),
    // Two epoch integers and an outcome only; never the frame or its plaintext.
    observe: (event) => getLogger('e2ee').warn('[e2ee] rpc request epoch rejected', event),
  });
  const dispatchNative = { ...rpc, openDispatch: catchUpLedger(rpc.openDispatch) };
  let rpcFiber: Fiber.Fiber<never, unknown> | undefined;
  const stopRpc = () =>
    rpcFiber ? run(Fiber.interrupt(rpcFiber)).then(() => undefined) : Promise.resolve();
  const readExecutionOriginPage = options.cloud.readExecutionOriginPage?.bind(options.cloud);
  const originRecovery = readExecutionOriginPage
    ? makeExecutionOriginRecovery(
        executionOrigins,
        (input, signal) =>
          readExecutionOriginPage(input, signal).catch((cause: unknown) => {
            credentialFailureHandler(cause);
            throw cause;
          }),
        { workspaceId: options.workspaceId, credential: opened.credential },
        encryptedWorkspaceNamespace(binding.genesisHash)
      )
    : undefined;
  const content: WorkspaceStreamsContent = {
    mode: 'protected',
    namespace: encryptedWorkspaceNamespace(binding.genesisHash),
    snapshotUpload: {
      onSnapshotRecovery: (streamUrl, needsSnapshot) => {
        if (needsSnapshot)
          requestSnapshot(decodeURIComponent(new URL(streamUrl).pathname.split('/').at(-1)!));
      },
      // SDK schedules only after local writes, suppresses a competing writer,
      // and checks the remote snapshot before exporting a new one.
      canUpload: () => !closed && !ledgerBlocked,
      debounceMs: 30_000,
      minBytesSinceRemoteSnapshot: 1024 * 1024,
    },
    resolve: encryptedWorkspaceResolver(options.workspaceId, (room) => {
      const descriptor = encryptedWorkspaceRoom(options.workspaceId, room);
      const protectedProvider = epochTransition.provider((writeEpoch) => {
        const getForEpoch = () => {
          const key = `${descriptor.resource}:${writeEpoch}`;
          let value = bindings.get(key);
          if (!value) {
            value = run(opened.runtime.binding(descriptor.resource, descriptor.model, writeEpoch));
            bindings.set(key, value);
            value.catch(() => {
              if (bindings.get(key) === value) bindings.delete(key);
            });
          }
          return value;
        };
        return {
          maxSealOverheadBytes: 4096,
          seal: async (input) => run((await getForEpoch()).seal(input)),
          open: async (input) => {
            const originalFrame = {
              ...input,
              context: { ...input.context },
              sealed: Uint8Array.from(input.sealed),
              header: Uint8Array.from(input.header),
              additionalData: Uint8Array.from(input.additionalData),
            };
            const result = await run((await getForEpoch()).openAuthenticated(originalFrame));
            if (
              descriptor.model === 'loro' &&
              descriptor.resource.startsWith('doc:') &&
              (isSessionDocRoomId(descriptor.resource.slice(4)) ||
                getScheduleIdFromRoomId(descriptor.resource.slice(4))) &&
              originalFrame.context.kind === 'update_batch'
            ) {
              try {
                executionOrigins.retain(descriptor.resource, originalFrame, result.plaintext);
                originWriteFailed = false;
              } catch {
                if (!originWriteFailed)
                  console.warn('[e2ee] execution origin unavailable; affected turns cannot start');
                originWriteFailed = true;
              }
            }
            return result.plaintext;
          },
        } satisfies PayloadProtectionProvider;
      });
      return {
        ...protectedProvider,
        seal: async (input) => {
          // A seal runs inside the SDK save queue. Request recovery without
          // awaiting it here: the queue must exit before any refresh can finish.
          if (ledgerBlocked) {
            retryLedger();
            throw new Error('e2ee_invalid_ledger');
          }
          return protectedProvider.seal(input);
        },
      };
    }),
  };
  const createTokenProvider = (rpcOnly?: true) =>
    Effect.gen(function* () {
      if (closed) throw new Error('e2ee_closed');
      if (!options.cloud.createContentTokenProvider) throw new Error('e2ee_content_unavailable');
      const provider = yield* options.cloud.createContentTokenProvider({
        workspaceId: options.workspaceId,
        credential: opened.credential,
        ...(rpcOnly ? { rpcOnly } : {}),
      });
      bucket = provider.getBucketId;
      const observe =
        (auth: LoroStreamsTokenAuth): LoroStreamsTokenAuth =>
        (context) =>
          auth(context).pipe(
            Effect.tapCause((cause) =>
              Effect.sync(() => {
                for (const reason of cause.reasons) {
                  if (reason._tag === 'Fail') credentialFailureHandler(reason.error);
                  if (reason._tag === 'Die') credentialFailureHandler(reason.defect);
                }
              })
            )
          );
      const observed = {
        ...provider,
        getToken: observe(provider.getToken),
        createAuthCallback: () => observe(provider.createAuthCallback()),
      };
      tokensInUse.add(observed);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          tokensInUse.delete(observed);
        })
      );
      return observed;
    });
  const tokens: CloudStreamsTokenPort = {
    createTokenProvider: () => createTokenProvider(),
    // E2EE never attaches the old Machine RPC or presence token consumers.
    createTokenProviderLegacy: () => {
      throw new Error('e2ee_plaintext_channel_disabled');
    },
  };
  let memberRemoved = false;
  let deviceRevoked = false;
  let removalReceipt: Promise<void> | undefined;
  let removalRecorded: Promise<void> | undefined;
  const isClosed = () => closed;
  const confirmPairing = async (intent: {
    pairingSessionId: string;
    frontendSigningPublicKey: string;
    signingPublicKey: string;
  }) => {
    const evidence = await run(opened.runtime.pairingEvidence());
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const journal = yield* openMachinePairingJournal(directory);
          const retained = yield* journal.retained(intent.pairingSessionId);
          if (
            retained.expected.accountId !== options.accountId ||
            retained.expected.workspaceId !== options.workspaceId ||
            retained.expected.genesisHash !== options.genesisHash ||
            retained.expected.frontendSigningPublicKey !== intent.frontendSigningPublicKey ||
            retained.material.signingPublicKey !== intent.signingPublicKey
          )
            return yield* Effect.fail(new Error('e2ee_binding_conflict'));
          yield* journal.confirm(retained.expected, evidence.view, evidence.records);
          return undefined;
        })
      )
    );
  };
  const clearLedgerRetry = () => {
    if (ledgerRetryTimer !== undefined) clearTimeout(ledgerRetryTimer);
    ledgerRetryTimer = undefined;
  };
  const retryLedger = (): void => {
    if (closed || !ledgerBlocked || refresh || ledgerRetryAttempts >= 3) return;
    clearLedgerRetry();
    ledgerRetryAttempts++;
    void refreshInBackground(false);
  };
  const scheduleLedgerRetry = () => {
    if (closed || !ledgerBlocked || ledgerRetryTimer !== undefined || ledgerRetryAttempts >= 3)
      return;
    ledgerRetryTimer = setTimeout(() => {
      ledgerRetryTimer = undefined;
      retryLedger();
    }, [250, 1_000, 4_000][ledgerRetryAttempts]);
    ledgerRetryTimer.unref?.();
  };
  const startMemberRemoval = (reason: 'member-removed' | 'device-revoked' = 'member-removed') => {
    if (removalReceipt) return;
    memberRemoved = reason === 'member-removed';
    deviceRevoked = reason === 'device-revoked';
    closed = true;
    opened.executionAuthorization.invalidate();
    opened.sharing.stop();
    ledgerBlocked = true;
    clearLedgerRetry();
    removalRecorded = (async () => {
      if (!memberRemoved) return;
      const removedStatus = await run(opened.runtime.status());
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* openMachinePairingJournal(directory);
            const { Bytes } = yield* Effect.promise(() => import('@lody/e2ee-core/protocol'));
            const genesis = yield* Effect.fromResult(Bytes.genesisHash(bytes(options.genesisHash)));
            const current = yield* opened.custody.openDevice(genesis);
            if (
              hex(current.publicKey.toBytes()) !== opened.signingPublicKey ||
              (yield* opened.custody.deviceCredential(genesis, current.publicKey)) !==
                opened.credential
            )
              return;
            const receipt = Removed.parse({
              genesisHash: options.genesisHash,
              signingPublicKey: opened.signingPublicKey,
              membershipId: removedStatus.membershipId,
            });
            yield* Effect.promise(async () => {
              const temporary = join(
                directory,
                `removed-${randomBytes(16).toString('hex')}.pending`
              );
              const file = await open(temporary, 'wx', 0o600);
              try {
                await file.writeFile(JSON.stringify(receipt));
                await file.sync();
                await file.close();
                await rename(temporary, join(directory, 'removed.json'));
              } finally {
                await file.close().catch(() => undefined);
                await unlink(temporary).catch(() => undefined);
              }
            });
          })
        )
      );
    })();
    removalReceipt = (async () => {
      const failures: unknown[] = [];
      try {
        await removalRecorded;
      } catch (cause) {
        failures.push(cause);
      }
      try {
        // Even a local persistence failure must stop the execution owner.
        await options.onRemoved?.(reason);
      } catch (cause) {
        if (!failures.includes(cause)) failures.push(cause);
      }
      try {
        await close();
      } catch (cause) {
        if (!failures.includes(cause)) failures.push(cause);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'e2ee_removal_failed');
      if (memberRemoved)
        await eraseRemovedWorkspace({
          ...options,
          expectedSigningPublicKey: opened.signingPublicKey,
        });
    })();
    void removalReceipt.catch(() => {
      try {
        options.onUnavailable();
      } catch {}
    });
  };
  credentialFailureHandler = (cause) => {
    if (isCloudE2eeMemberRemoved(cause)) startMemberRemoval('member-removed');
    else if (isCloudE2eeDeviceRevoked(cause)) startMemberRemoval('device-revoked');
  };
  const refreshInBackground = (resetRetries = true) => {
    if (closed) return Promise.resolve();
    if (resetRetries) {
      clearLedgerRetry();
      ledgerRetryAttempts = 0;
    }
    pending = true;
    if (refresh) return refresh;
    if (pairing) pairingConfirmed = false;
    refresh = (async () => {
      while (pending && !isClosed()) {
        pending = false;
        let status = await run(opened.runtime.status());
        let cursor: string | undefined;
        let checkpoint: Parameters<CloudE2eePort['getHistory']>[0]['checkpoint'];
        do {
          const page = await options.cloud
            .getHistory({
              workspaceId: options.workspaceId,
              credential: opened.credential,
              ...(cursor
                ? { cursor, checkpoint }
                : status.position
                  ? { after: status.position }
                  : {}),
            })
            .catch(async (historyError: unknown) => {
              try {
                await options.cloud.getContentToken({
                  workspaceId: options.workspaceId,
                  credential: opened.credential,
                });
              } catch (cause) {
                if (isCloudE2eeMemberRemoved(cause) || isCloudE2eeDeviceRevoked(cause)) throw cause;
              }
              throw historyError;
            });
          if (closed) return;
          checkpoint ??= { ...page.checkpoint };
          status = await run(opened.runtime.ingest(page)).catch((error) => {
            // Unexpected defects are fenced too, without classifying them as
            // transient storage or weakening the verification boundary.
            ledgerBlocked = true;
            throw error;
          });
          ledgerBlocked = false;
          ledgerRetryAttempts = 0;
          epochTransition.observe(status);
          cursor = page.nextCursor ?? undefined;
        } while (cursor && !isClosed());
        if (!closed) {
          if (pairing) {
            await confirmPairing(pairing);
            pairingConfirmed = true;
          }
          if (epochTransition.needsUpdate()) {
            await epochTransition.transition({
              install: async () => {
                await run(opened.runtime.receiveKeys());
                const installed = await run(opened.runtime.status());
                if (installed.hasCurrentKey && installed.epoch > epochTransition.epoch()) {
                  for (const token of tokensInUse) await run(token.invalidate());
                }
                return installed;
              },
            });
          } else if (requireActivation || pairing) {
            await run(opened.runtime.receiveKeys());
          }
        }
      }
    })()
      .catch(async (error: unknown) => {
        if (pairing) pairingFailure = error;
        credentialFailureHandler(error);
        try {
          options.onUnavailable();
        } catch {
          /* Diagnostic sinks cannot turn a background retry into an unhandled rejection. */
        }
      })
      .finally(() => {
        refresh = undefined;
        scheduleLedgerRetry();
      });
    return refresh;
  };
  const close = () => {
    closed = true;
    opened.executionAuthorization.invalidate();
    opened.sharing.stop();
    clearLedgerRetry();
    return (closeReceipt ??= (async () => {
      await stopRpc();
      await epochTransition.close();
      await refresh;
      await Promise.allSettled([...snapshotFlights]);
      originRecovery?.clear();
      // History/snapshot diagnosis may start while close drains those flights.
      // Keep custody alive through identity verification and the durable receipt,
      // never await the parent drain/full erasure that calls back into close.
      const failures: unknown[] = [];
      try {
        await removalRecorded;
      } catch (cause) {
        failures.push(cause);
      }
      try {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      } catch (cause) {
        failures.push(cause);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'e2ee_close_failed');
    })());
  };
  // Startup is one of the three refresh triggers; no network request is awaited by open.
  void refreshInBackground();
  const authorizeScheduleExecution = (
    request: ScheduleAuthorizationRequest,
    doc: LoroDoc,
    executionTarget?: { localProjectId?: string }
  ) =>
    Effect.scoped(
      authorizeEncryptedSchedule({
        workspaceId: options.workspaceId,
        request,
        doc,
        executionTarget,
        origins: executionOrigins,
        open: (input) =>
          Effect.gen(function* () {
            const native = yield* opened.runtime.binding(
              `doc:${getScheduleRoomId(request.scheduleId)}`,
              'loro',
              'current'
            );
            return yield* native.openAuthenticated(input);
          }),
        recover: originRecovery?.recover,
        authorizeExecution: opened.executionAuthorization.authorizeExecution,
        isExecutionOpen: () => !closed,
      })
    );
  return {
    attachmentToken: async () => {
      if (closed) throw new Error('e2ee_closed');
      const result = await options.cloud.getContentToken({
        workspaceId: options.workspaceId,
        credential: opened.credential,
      });
      if (closed || !result.attachmentToken) throw new Error('e2ee_attachment_unavailable');
      return result.attachmentToken;
    },
    repositoryDirectory: repositoryDirectory(
      directory,
      binding.genesisHash,
      opened.signingPublicKey
    ),
    authorizeScheduleExecution,
    authorizeScheduleExecutionLegacy: (request: ScheduleAuthorizationRequest, doc: LoroDoc) =>
      run(authorizeScheduleExecution(request, doc)),
    resolveVerifiedExecutionOriginal: (intent: EncryptedExecutionIntent, doc?: LoroDoc) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (closed || intent.workspaceId !== options.workspaceId) return undefined;
          const fromDoc = doc?.getMap('rpcDispatchOriginals').get(intent.userTurnId);
          // This original cache is an accelerator, never the actual-start journal.
          // Its local I/O fault cannot block the independently signed durable origin.
          const cached = yield* rpc
            .readIncoming(intent)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          const rpcOriginal =
            typeof fromDoc === 'string' ? fromDoc : cached ? hex(cached.frame) : undefined;
          if (rpcOriginal !== undefined) {
            if (cached && hex(cached.frame) !== rpcOriginal) return undefined;
            const view = yield* opened.runtime.executionLedger();
            const state = view.inspectState();
            const machineId = state.devices.get(opened.signingPublicKey)?.machineId;
            if (!machineId) return undefined;
            const verified = yield* dispatchNative.openDispatch(machineId, rpcOriginal);
            if (
              verified.args.sessionId !== intent.sessionId ||
              verified.args.userTurnId !== intent.userTurnId ||
              !isDeepStrictEqual(verified.args.inputConfig ?? {}, intent.inputConfig ?? {})
            )
              return undefined;
            const device = state.devices.get(verified.requesterDevice);
            const member = device && state.members.get(hex(device.membershipId.toBytes()));
            if (!member) return undefined;
            return {
              requesterDevice: verified.requesterDevice,
              requesterCryptoUserId: hex(member.userId.toBytes()),
              expiresAt: verified.expiresAt,
            };
          }
          if (!doc) return undefined;
          return yield* executionOrigins.resolve(
            intent,
            doc,
            (request) =>
              Effect.gen(function* () {
                if (closed || intent.workspaceId !== options.workspaceId)
                  return yield* Effect.fail(new Error('e2ee_execution_origin_unavailable'));
                const contentBinding = yield* opened.runtime.binding(
                  `doc:${getSessionRoomId(intent.sessionId as SessionId)}`,
                  'loro',
                  'current'
                );
                return yield* contentBinding.openAuthenticated(request);
              }),
            originRecovery?.recover
          );
        })
      ),
    startRpc: (
      machineId: string,
      offer: (input: E2eeDispatchInput) => Promise<E2eeDispatchAck>,
      trace?: (event: E2eeRpcTiming) => void,
      handleFeature?: EncryptedFeatureHandler
    ) =>
      run(
        Effect.gen(function* () {
          if (rpcFiber || closed) return;
          rpcFiber = yield* Effect.forkIn(
            Effect.scoped(
              Effect.gen(function* () {
                const provider = yield* createTokenProvider(true);
                yield* provider.getToken();
                const bucketId = provider.getBucketId();
                if (!bucketId || bucketId === 'lody' || !provider.getGatewayBaseUrl())
                  return yield* Effect.fail(new Error('e2ee_content_configuration'));
                const controller = new AbortController();
                yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
                const client = createLoroStreamsJsonStreamClient({
                  bucketId,
                  getBaseUrl: provider.getGatewayBaseUrl,
                  getToken: () => Effect.runPromise(provider.getToken()),
                  fetchImpl: (url, init) =>
                    fetch(url, {
                      ...init,
                      signal: init?.signal
                        ? AbortSignal.any([controller.signal, init.signal])
                        : controller.signal,
                    }),
                });
                const receive = makeEncryptedRpcReceiver({
                  workspaceId: options.workspaceId,
                  genesis: binding.genesisHash,
                  machineId,
                  native: dispatchNative,
                  journal: rpcJournal,
                  authorize: opened.executionAuthorization.authorizeExecution,
                  isOpen: () => !closed,
                  offer,
                  client,
                  trace,
                });
                const receiveFeature = handleFeature
                  ? yield* makeEncryptedFeatureReceiver({
                      workspaceId: options.workspaceId,
                      genesis: binding.genesisHash,
                      machineId,
                      native: rpc,
                      journal: rpcJournal,
                      authorize: opened.executionAuthorization.authorizeOwnedExecution,
                      authorizeRead: opened.executionAuthorization.authorizeRead,
                      isOpen: () => !closed,
                      handle: handleFeature,
                      client,
                    })
                  : undefined;
                let failureReported = false;
                yield* makeEncryptedRpcListener({
                  workspaceId: options.workspaceId,
                  machineId,
                  client,
                  trace,
                  receive: (envelope) =>
                    Effect.gen(function* () {
                      if (receiveFeature && (yield* receiveFeature(envelope))) return;
                      yield* receive(envelope);
                    }).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          failureReported = false;
                        })
                      )
                    ),
                  onFailure: () => {
                    if (!failureReported) {
                      failureReported = true;
                      console.debug(
                        '[e2ee] encrypted RPC request unavailable; durable dispatch remains active'
                      );
                    }
                  },
                });
                return yield* Effect.never;
              })
            ).pipe(Effect.retry(Schedule.spaced('1 second'))),
            scope
          );
        })
      ),
    stopRpc,
    isExecutionOpen: () => !closed,
    readMachineSharing: (machineId: string) =>
      opened.sharingRemote
        ? run(opened.sharing.read(machineId, opened.sharingRemote))
        : Promise.reject(new Error('e2ee_sharing_unavailable')),
    updateMachineSharing: (
      machineId: string,
      generation: string,
      requestId: string,
      change: import('@lody/platform').E2eeMachineSharingChange
    ) =>
      opened.sharingRemote
        ? run(opened.sharing.write(machineId, generation, requestId, change, opened.sharingRemote))
        : Promise.reject(new Error('e2ee_sharing_unavailable')),
    authorizeExecution: (workspaceId: string, requesterDevice: string, localProjectId?: string) =>
      Effect.suspend(() =>
        closed
          ? Effect.succeed({ _tag: 'Denied' as const, reason: 'closed' as const })
          : opened.executionAuthorization.authorizeExecution(
              workspaceId,
              requesterDevice,
              localProjectId
            )
      ),
    assertPairingConfirmed: () => {
      if (!pairing || !pairingConfirmed)
        throw new Error('e2ee_pairing_unconfirmed', { cause: pairingFailure });
    },
    confirmPairing,
    completeRemotePairing: (pairingSessionId: string) =>
      options.cloud.completeMachinePairing?.({
        workspaceId: options.workspaceId,
        credential: opened.credential,
        pairingSessionId,
      }) ?? Promise.resolve(),
    content,
    tokens,
    bucketId: () => bucket?.(),
    status: () =>
      closed
        ? Promise.reject(
            new Error(
              memberRemoved
                ? 'e2ee_member_removed'
                : deviceRevoked
                  ? 'e2ee_device_revoked'
                  : 'e2ee_closed'
            )
          )
        : run(opened.runtime.status()).then((status) => ({
            ...status,
            epochPhase: epochTransition.phase(),
          })),
    refresh: () => refreshInBackground(),
    /** Actual terminal cleanup receipt; owner close itself never waits for its caller. */
    removalCleanup: () => removalReceipt ?? Promise.resolve(),
    close,
  };
}
export type CliE2eeWorkspaceLegacy = Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>>;

const RemoteBootstrapData = z
  .object({
    accountId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    genesisHash: z.string().regex(/^[0-9a-f]{64}$/),
    signingPublicKey: z.string().regex(/^[0-9a-f]{64}$/),
    machineId: z.string().min(1).max(128),
    deploymentUrl: z.string().url(),
  })
  .strict();
const RemoteBootstrap = RemoteBootstrapData.extend({
  signature: z.string().regex(/^[0-9a-f]{128}$/),
}).strict();
const remoteBootstrapBytes = (value: z.infer<typeof RemoteBootstrapData>) =>
  new TextEncoder().encode(
    JSON.stringify([
      'lody-e2ee-machine-bootstrap-v1',
      value.accountId,
      value.workspaceId,
      value.genesisHash,
      value.signingPublicKey,
      value.machineId,
      value.deploymentUrl,
    ])
  );
function withMachineBootstrapLease<A>(
  accountId: string,
  workspaceId: string,
  work: () => Promise<A>
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* leaseE2eeIdentity(cliE2eeIdentityDirectory(accountId, workspaceId));
        return yield* Effect.tryPromise({ try: work, catch: (error) => error });
      })
    )
  );
}
/** Device-authenticated routing metadata, written only after verified current-key installation. */
export async function retainCliE2eeMachineBootstrapLegacy(
  input: z.infer<typeof RemoteBootstrapData>,
  keyring?: MachineKeyring
) {
  const value = RemoteBootstrapData.parse(input);
  return withMachineBootstrapLease(value.accountId, value.workspaceId, () =>
    retainMachineBootstrap(value, keyring)
  );
}
async function retainMachineBootstrap(
  input: z.infer<typeof RemoteBootstrapData>,
  keyring?: MachineKeyring
) {
  const unsigned = RemoteBootstrapData.parse(input);
  const signature = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const custody = yield* makeCliE2eeCustody({
          directory: join(
            cliE2eeIdentityDirectory(unsigned.accountId, unsigned.workspaceId),
            'custody'
          ),
          requireOsProtection: existsSync(
            `${cliE2eeIdentityDirectory(unsigned.accountId, unsigned.workspaceId)}.require-os`
          ),
          keyring,
        });
        const { Bytes, signVerified } = yield* Effect.promise(
          () => import('@lody/e2ee-core/protocol')
        );
        const device = yield* custody.openDevice(
          Result.getOrThrow(Bytes.genesisHash(bytes(unsigned.genesisHash)))
        );
        if (hex(device.publicKey.toBytes()) !== unsigned.signingPublicKey)
          return yield* Effect.fail(new Error('e2ee_binding_conflict'));
        return hex((yield* signVerified(device, remoteBootstrapBytes(unsigned))).toBytes());
      })
    )
  );
  const value = { ...unsigned, signature };
  const directory = cliE2eeIdentityDirectory(value.accountId, value.workspaceId);
  const temporary = join(directory, `remote-bootstrap-${randomBytes(16).toString('hex')}.pending`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
    await file.close();
    await rename(temporary, join(directory, 'remote-bootstrap.json'));
  } finally {
    await file.close();
    await unlink(temporary).catch(() => undefined);
  }
}
/** Reopen existing protected credentials only. The leased temporary owner closes before Fleet opens. */
export async function loadCliE2eeMachineBootstrapLegacy(
  reference: string,
  machineId: string,
  keyring?: MachineKeyring
) {
  const [accountId, workspaceId, extra] = reference.split('/');
  if (!accountId || !workspaceId || extra !== undefined) throw new Error('e2ee_pairing_required');
  return withMachineBootstrapLease(accountId, workspaceId, () =>
    loadMachineBootstrap(reference, machineId, keyring)
  );
}
async function loadMachineBootstrap(
  reference: string,
  machineId: string,
  keyring?: MachineKeyring
) {
  const [accountId, workspaceId, extra] = reference.split('/');
  if (!accountId || !workspaceId || extra !== undefined) throw new Error('e2ee_pairing_required');
  const directory = cliE2eeIdentityDirectory(accountId, workspaceId);
  const file = await open(
    join(directory, 'remote-bootstrap.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  let bootstrap: z.infer<typeof RemoteBootstrap>;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 2048) throw new Error('e2ee_pairing_required');
    bootstrap = RemoteBootstrap.parse(JSON.parse(await file.readFile('utf8')));
  } finally {
    await file.close();
  }
  if (
    bootstrap.accountId !== accountId ||
    bootstrap.workspaceId !== workspaceId ||
    bootstrap.machineId !== machineId
  )
    throw new Error('e2ee_binding_conflict');
  const marker = Activation.parse(
    JSON.parse(await readFile(join(directory, 'activation.json'), 'utf8'))
  );
  if (
    marker.genesisHash !== bootstrap.genesisHash ||
    marker.signingPublicKey !== bootstrap.signingPublicKey
  )
    throw new Error('e2ee_pairing_required');
  const original = await open(
    join(directory, 'custody', `${bootstrap.genesisHash}.machine.device`),
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  await original.close();
  const credential = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const custody = yield* makeCliE2eeCustody({
          directory: join(directory, 'custody'),
          requireOsProtection: existsSync(`${directory}.require-os`),
          keyring,
        });
        const { Bytes, verifySignature } = yield* Effect.promise(
          () => import('@lody/e2ee-core/protocol')
        );
        const genesis = Result.getOrThrow(Bytes.genesisHash(bytes(bootstrap.genesisHash)));
        const device = yield* custody.openDevice(genesis);
        if (hex(device.publicKey.toBytes()) !== bootstrap.signingPublicKey)
          return yield* Effect.fail(new Error('e2ee_binding_conflict'));
        if (
          Result.isFailure(
            verifySignature(
              device.publicKey.toBytes(),
              remoteBootstrapBytes(bootstrap),
              bytes(bootstrap.signature)
            )
          )
        )
          return yield* Effect.fail(new Error('e2ee_binding_conflict'));
        return yield* custody.deviceCredential(genesis, device.publicKey);
      })
    )
  );
  return { bootstrap, credential };
}
