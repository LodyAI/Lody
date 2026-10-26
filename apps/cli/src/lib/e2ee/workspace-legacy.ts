import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, Exit, Scope } from 'effect';
import { z } from 'zod';
import type { PayloadProtectionProvider } from '@loro-dev/streams-crdt';
import type { CloudE2eePort, CloudStreamsTokenPort } from '@lody/platform';
import { BackendError, KeyMailbox } from '@lody/e2ee-core/services';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  encryptedWorkspaceNamespace,
  encryptedWorkspaceResolver,
  encryptedWorkspaceRoom,
  type WorkspaceStreamsContent,
} from '@lody/shared/workspace-streams-content';
import { makeCliE2eeCustody, type MachineKeyring } from './custody';
import { makeCliE2eeRuntime } from './runtime';

const Binding = z
  .object({
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    genesisHash: z.string().regex(/^[0-9a-f]{64}$/),
    genesisRecordHex: z.string().regex(/^(?:[0-9a-f]{2}){1,8192}$/),
  })
  .strict();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
const directoryFor = (accountId: string, workspaceId: string) => {
  if (!accountId || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId))
    throw new Error('e2ee_invalid_input');
  return join(
    getLodyDataDir(),
    'e2ee',
    createHash('sha256').update(accountId).digest('hex'),
    workspaceId
  );
};

/** Public pairing evidence is retained only through the trusted local approval
 * path. This operation neither admits a device nor obtains cloud credentials. */
export async function retainCliE2eeWorkspaceBinding(
  accountId: string,
  input: z.input<typeof Binding>
) {
  const binding = Binding.parse(input);
  const directory = directoryFor(accountId, binding.workspaceId);
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

/** Build the retained machine identity, possession proof and fixed credential
 * binding for the desktop-generated pairing session. No admission or cloud I/O. */
export async function prepareCliE2eeMachineLegacy(
  options: z.input<typeof Binding> & {
    accountId: string;
    membershipId: string;
    pairingSessionId: string;
    keyring?: MachineKeyring;
  }
) {
  const {
    Bytes,
    hashRecordBytes,
    prepareDeviceAdmission,
    signDeviceCredentialBinding,
    verifyLedgerEffect,
  } = await import('@lody/e2ee-core/protocol');
  if (!/^[0-9a-f]{32}$/.test(options.pairingSessionId)) throw new Error('e2ee_invalid_input');
  const binding = Binding.parse({
    workspaceId: options.workspaceId,
    genesisHash: options.genesisHash,
    genesisRecordHex: options.genesisRecordHex,
  });
  if (hex(hashRecordBytes(bytes(binding.genesisRecordHex)).toBytes()) !== binding.genesisHash)
    throw new Error('e2ee_binding_conflict');
  const genesis = Effect.runSync(Effect.fromResult(Bytes.genesisHash(bytes(binding.genesisHash))));
  const membershipId = Effect.runSync(
    Effect.fromResult(Bytes.membershipId(bytes(options.membershipId)))
  );
  // Pin comes from the already authenticated local desktop; the server cannot choose it.
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
        const custody = yield* makeCliE2eeCustody({
          directory: join(directoryFor(options.accountId, options.workspaceId), 'custody'),
          keyring: options.keyring,
        });
        const device = yield* custody.createDevice(genesis);
        const credential = yield* custody.prepareDeviceCredential(genesis, device.publicKey);
        const admission = yield* prepareDeviceAdmission({
          genesis,
          membershipId,
          encryptionPublicKey: device.enc,
          kind: 'machine',
          signer: device,
        });
        const bindingSignature = yield* signDeviceCredentialBinding({
          genesis,
          pairingSessionId: bytes(options.pairingSessionId),
          signingPublicKey: device.publicKey,
          credentialHash: bytes(credential.credentialHash),
          signer: device,
        });
        return {
          pairingSessionId: options.pairingSessionId,
          bindingSignature: hex(bindingSignature.toBytes()),
          signingPublicKey: hex(device.publicKey.toBytes()),
          encryptionPublicKey: hex(device.enc.toBytes()),
          possessionSignature: hex(admission.possessionSignature.toBytes()),
          credentialHash: credential.credentialHash,
          protection: custody.protection,
        };
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

/** A pending pairing may verify its ledger and receive keys, but exposes no content transport. */
export async function openCliE2eePairingRuntimeLegacy(options: CliE2eeWorkspaceOptions) {
  const pending = await openWorkspace(options, false);
  return { status: pending.status, refresh: pending.refresh, close: pending.close };
}

/** Verify actual admission and install the current key before allowing Fleet to attach rooms.
 * The marker is only a startup hint: subsequent authorization still comes from core's verified ledger. */
export async function activateCliE2eeWorkspaceLegacy(options: CliE2eeWorkspaceOptions) {
  const pending = await openCliE2eePairingRuntimeLegacy(options);
  let marker: z.infer<typeof Activation>;
  try {
    await pending.refresh();
    const status = await pending.status();
    if (
      options.expectedSigningPublicKey &&
      options.expectedSigningPublicKey !== status.devicePublicKey
    )
      throw new Error('e2ee_binding_conflict');
    if (!status.hasCurrentKey) throw new Error('e2ee_waiting_for_key');
    marker = { genesisHash: options.genesisHash, signingPublicKey: status.devicePublicKey };
  } finally {
    // Publish the Fleet startup hint only after the temporary native owner has
    // actually released its SQLite/custody resources.
    await pending.close();
  }
  const directory = directoryFor(options.accountId, options.workspaceId);
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
}

async function openWorkspace(options: CliE2eeWorkspaceOptions, requireActivation: boolean) {
  const directory = directoryFor(options.accountId, options.workspaceId);
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
  const scope = Effect.runSync(Scope.make());
  const run = <A, E>(work: Effect.Effect<A, E, Scope.Scope>) =>
    Effect.runPromise(work.pipe(Scope.provide(scope)));
  const opened = await run(
    Effect.gen(function* () {
      const custody = yield* makeCliE2eeCustody({
        directory: join(directory, 'custody'),
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
      const runtime = yield* makeCliE2eeRuntime({
        directory: join(directory, 'runtime', hex(device.publicKey.toBytes())),
        workspaceId: options.workspaceId,
        custody,
        device,
        genesisRecord: bytes(binding.genesisRecordHex),
        mailbox: mailbox(options.cloud, options.workspaceId, credential),
      });
      return { runtime, credential };
    })
  ).catch(async (error) => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  });
  const initialStatus = await run(opened.runtime.status());
  const writeEpoch = initialStatus.epoch;
  let latestEpoch = writeEpoch;
  let keyUpdateRequired = initialStatus.rotationRequired;
  let ledgerBlocked = false;
  let retryLedgerOnSeal = false;
  let closed = false;
  let refresh: Promise<void> | undefined;
  let pending = false;
  let closeReceipt: Promise<void> | undefined;
  let bucket: (() => string | undefined) | undefined;
  const bindings = new Map<
    string,
    Promise<Effect.Success<ReturnType<typeof opened.runtime.binding>>>
  >();
  const content: WorkspaceStreamsContent = {
    mode: 'protected',
    namespace: encryptedWorkspaceNamespace(binding.genesisHash),
    snapshotUpload: { canUpload: async () => false },
    resolve: encryptedWorkspaceResolver(options.workspaceId, (room) => {
      const descriptor = encryptedWorkspaceRoom(options.workspaceId, room);
      const get = () => {
        if (closed) return Promise.reject(new Error('e2ee_closed'));
        let existing = bindings.get(descriptor.resource);
        if (!existing) {
          existing = run(opened.runtime.binding(descriptor.resource, descriptor.model, writeEpoch));
          bindings.set(descriptor.resource, existing);
          existing.catch(() => {
            if (bindings.get(descriptor.resource) === existing)
              bindings.delete(descriptor.resource);
          });
        }
        return existing;
      };
      return {
        maxSealOverheadBytes: 4096,
        seal: async (input) => {
          // Streams retries failed writes without reconnecting its healthy read
          // stream. A temporary local storage failure must therefore use that
          // next write attempt to refresh the ledger again. Security/validation
          // failures remain fenced until an explicit normal refresh succeeds.
          if (ledgerBlocked && retryLedgerOnSeal) await refreshInBackground();
          if (ledgerBlocked) throw new Error('e2ee_invalid_ledger');
          if (keyUpdateRequired || latestEpoch !== writeEpoch)
            throw new Error('e2ee_key_update_required');
          return run((await get()).seal(input));
        },
        open: async (input) => run((await get()).open(input)),
      } satisfies PayloadProtectionProvider;
    }),
  };
  const tokens: CloudStreamsTokenPort = {
    createTokenProvider: () =>
      Effect.gen(function* () {
        if (closed) throw new Error('e2ee_closed');
        if (!options.cloud.createContentTokenProvider) throw new Error('e2ee_content_unavailable');
        const provider = yield* options.cloud.createContentTokenProvider({
          workspaceId: options.workspaceId,
          credential: opened.credential,
        });
        bucket = provider.getBucketId;
        return provider;
      }),
    // E2EE never attaches the old Machine RPC or presence token consumers.
    createTokenProviderLegacy: () => {
      throw new Error('e2ee_plaintext_channel_disabled');
    },
  };
  const isClosed = () => closed;
  const refreshInBackground = () => {
    if (closed) return Promise.resolve();
    pending = true;
    if (refresh) return refresh;
    refresh = (async () => {
      while (pending && !isClosed()) {
        pending = false;
        let status = await run(opened.runtime.status());
        let cursor: string | undefined;
        let checkpoint: Parameters<CloudE2eePort['getHistory']>[0]['checkpoint'];
        do {
          const page = await options.cloud.getHistory({
            workspaceId: options.workspaceId,
            credential: opened.credential,
            ...(cursor
              ? { cursor, checkpoint }
              : status.position
                ? { after: status.position }
                : {}),
          });
          if (closed) return;
          checkpoint ??= { ...page.checkpoint };
          retryLedgerOnSeal = false;
          status = await run(
            opened.runtime.ingest(page).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  ledgerBlocked = true;
                  retryLedgerOnSeal = 'code' in error && error.code === 'storage';
                })
              )
            )
          ).catch((error) => {
            // Unexpected defects are fenced too, without classifying them as
            // transient storage or weakening the verification boundary.
            ledgerBlocked = true;
            throw error;
          });
          ledgerBlocked = false;
          retryLedgerOnSeal = false;
          latestEpoch = status.epoch;
          keyUpdateRequired ||= status.rotationRequired || latestEpoch !== writeEpoch;
          cursor = page.nextCursor ?? undefined;
        } while (cursor && !isClosed());
        if (!closed) await run(opened.runtime.receiveKeys());
      }
    })()
      .catch(() => {
        try {
          options.onUnavailable();
        } catch {
          /* Diagnostic sinks cannot turn a background retry into an unhandled rejection. */
        }
      })
      .finally(() => {
        refresh = undefined;
      });
    return refresh;
  };
  // Startup is one of the three refresh triggers; no network request is awaited by open.
  void refreshInBackground();
  return {
    content,
    tokens,
    bucketId: () => bucket?.(),
    status: () =>
      closed ? Promise.reject(new Error('e2ee_closed')) : run(opened.runtime.status()),
    refresh: refreshInBackground,
    close: () => {
      closed = true;
      return (closeReceipt ??= (async () => {
        await refresh;
        await Effect.runPromise(Scope.close(scope, Exit.void));
      })());
    },
  };
}
export type CliE2eeWorkspaceLegacy = Awaited<ReturnType<typeof openCliE2eeWorkspaceLegacy>>;
