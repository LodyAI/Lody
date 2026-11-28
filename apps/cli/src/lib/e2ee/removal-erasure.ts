import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, Result } from 'effect';
import { z } from 'zod';
import { leaseE2eeIdentity } from '@lody/shared/node/e2ee-identity';
import { clearCachedCliE2eeKeyring, makeCliE2eeCustody, type MachineKeyring } from './custody';
import { cliE2eeIdentityDirectory } from './retained-binding';
import {
  acquirePairingMutex,
  MachinePairingJournalError,
  openMachinePairingJournalLocked,
  resetCorruptPairingJournalLocked,
} from './pairing-journal';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));

export const repositoryDirectory = (
  directory: string,
  genesisHash: string,
  signingPublicKey: string
) => join(directory, 'content', genesisHash, signingPublicKey);

const RemovedDiskSchema = z
  .object({
    genesisHash: z.string().regex(/^[0-9a-f]{64}$/),
    signingPublicKey: z.string().regex(/^[0-9a-f]{64}$/),
    membershipId: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .nullable()
      .optional(),
  })
  .strict();

const RevokedDeviceDiskSchema = RemovedDiskSchema.omit({ membershipId: true });

export type MemberRemovedReceipt = {
  readonly kind: 'member-removed';
  readonly genesisHash: string;
  readonly signingPublicKey: string;
  readonly membership:
    | { readonly kind: 'known'; readonly id: string }
    | { readonly kind: 'unknown' };
};

export type DeviceRevokedReceipt = {
  readonly kind: 'device-revoked';
  readonly genesisHash: string;
  readonly signingPublicKey: string;
};

export type RemovalReceipt = MemberRemovedReceipt | DeviceRevokedReceipt;

export async function readRemoval(directory: string): Promise<MemberRemovedReceipt | null> {
  try {
    const parsed = RemovedDiskSchema.parse(
      JSON.parse(await readFile(join(directory, 'removed.json'), 'utf8'))
    );
    return {
      kind: 'member-removed',
      genesisHash: parsed.genesisHash,
      signingPublicKey: parsed.signingPublicKey,
      membership: parsed.membershipId
        ? { kind: 'known', id: parsed.membershipId }
        : { kind: 'unknown' },
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
}

export async function readRevokedDevice(directory: string): Promise<DeviceRevokedReceipt | null> {
  try {
    const parsed = RevokedDeviceDiskSchema.parse(
      JSON.parse(await readFile(join(directory, 'revoked-device.json'), 'utf8'))
    );
    return {
      kind: 'device-revoked',
      genesisHash: parsed.genesisHash,
      signingPublicKey: parsed.signingPublicKey,
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
}

async function writeReceiptAtomic(directory: string, receipt: RemovalReceipt): Promise<void> {
  const payload =
    receipt.kind === 'member-removed'
      ? RemovedDiskSchema.parse({
          genesisHash: receipt.genesisHash,
          signingPublicKey: receipt.signingPublicKey,
          membershipId: receipt.membership.kind === 'known' ? receipt.membership.id : null,
        })
      : RevokedDeviceDiskSchema.parse({
          genesisHash: receipt.genesisHash,
          signingPublicKey: receipt.signingPublicKey,
        });
  const temporary = join(directory, `removed-${randomBytes(16).toString('hex')}.pending`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(payload));
    await file.sync();
    await file.close();
    await rename(
      temporary,
      join(directory, receipt.kind === 'member-removed' ? 'removed.json' : 'revoked-device.json')
    );
  } finally {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export const recordRemovalReceipt = Effect.fnUntraced(function* (options: {
  directory: string;
  genesisHash: string;
  signingPublicKey: string;
  credential: string;
  custody: Awaited<Effect.Success<ReturnType<typeof makeCliE2eeCustody>>>;
  kind: 'member-removed' | 'device-revoked';
  knownMembershipId?: string | null;
}) {
  yield* acquirePairingMutex(options.directory);
  const { Bytes } = yield* Effect.promise(() => import('@lody/e2ee-core/protocol'));
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(bytes(options.genesisHash)));
  const current = yield* options.custody.openDevice(genesis);
  if (
    hex(current.publicKey.toBytes()) !== options.signingPublicKey ||
    (yield* options.custody.deviceCredential(genesis, current.publicKey)) !== options.credential
  )
    return false;

  let membershipId = options.knownMembershipId ?? null;
  if (options.kind === 'member-removed' && !membershipId) {
    const journalResult = yield* Effect.result(openMachinePairingJournalLocked(options.directory));
    if (Result.isSuccess(journalResult)) {
      const fromJournal = yield* Effect.result(
        journalResult.success.membershipIdForDevice(options.genesisHash, options.signingPublicKey)
      );
      if (Result.isSuccess(fromJournal)) membershipId = fromJournal.success;
    } else if (
      !(
        journalResult.failure instanceof MachinePairingJournalError &&
        (journalResult.failure.code === 'corrupt' || journalResult.failure.code === 'identity-lost')
      )
    ) {
      return yield* Effect.fail(journalResult.failure);
    }
  }

  const receipt: RemovalReceipt =
    options.kind === 'member-removed'
      ? {
          kind: 'member-removed',
          genesisHash: options.genesisHash,
          signingPublicKey: options.signingPublicKey,
          membership: membershipId ? { kind: 'known', id: membershipId } : { kind: 'unknown' },
        }
      : {
          kind: 'device-revoked',
          genesisHash: options.genesisHash,
          signingPublicKey: options.signingPublicKey,
        };
  yield* Effect.tryPromise({
    try: () => writeReceiptAtomic(options.directory, receipt),
    catch: (cause) => cause,
  });
  return true;
});

export async function roostDirectoryExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

export async function wipeRevokedRoost(directory: string, receipt: DeviceRevokedReceipt) {
  const path = join(
    repositoryDirectory(directory, receipt.genesisHash, receipt.signingPublicKey),
    'roost'
  );
  if (!(await roostDirectoryExists(path))) return;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* leaseE2eeIdentity(directory, true);
        yield* Effect.tryPromise(() => rm(path, { recursive: true, force: true }));
      })
    )
  );
}

/** Only after the caller's workspace owners drain. Acquires both the identity lease
 * and pairing mutex (fail-closed on busy), then wipes roost and custody before markers. */
export async function eraseRemovedWorkspace(options: {
  accountId: string;
  workspaceId: string;
  keyring?: MachineKeyring;
  expectedSigningPublicKey?: string;
}): Promise<boolean> {
  const directory = cliE2eeIdentityDirectory(options.accountId, options.workspaceId);
  const removal = await readRemoval(directory);
  if (
    !removal ||
    (options.expectedSigningPublicKey &&
      options.expectedSigningPublicKey !== removal.signingPublicKey)
  )
    return false;
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* leaseE2eeIdentity(directory, true);
        yield* acquirePairingMutex(directory);
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
        yield* Effect.promise(async () => {
          await rm(repositoryDirectory(directory, removal.genesisHash, removal.signingPublicKey), {
            recursive: true,
            force: true,
          });
          for (const name of ['custody', 'runtime'])
            await rm(join(directory, name), { recursive: true, force: true });
          clearCachedCliE2eeKeyring(join(directory, 'custody'));
          for (const name of ['remote-bootstrap.json', 'activation.json', 'binding.json'])
            await rm(join(directory, name), { recursive: true, force: true });
        });
        const journalResult = yield* Effect.result(openMachinePairingJournalLocked(directory));
        if (Result.isSuccess(journalResult)) {
          yield* journalResult.success.eraseRemovedMember();
        } else if (
          journalResult.failure instanceof MachinePairingJournalError &&
          (journalResult.failure.code === 'corrupt' ||
            journalResult.failure.code === 'identity-lost')
        ) {
          yield* resetCorruptPairingJournalLocked(directory);
        } else {
          return yield* Effect.fail(journalResult.failure);
        }
        return true;
      })
    )
  );
}
