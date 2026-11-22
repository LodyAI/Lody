import { mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLodyWorkspaceRoutes, type RepoClient } from '@loro-dev/loro-repo-client';
import { encryptedWorkspaceNamespace } from '../workspace-streams-content';
import { forgetDeclaredDocRooms } from './native-docs';
import { setNativeNamespaceEncryption, setNativeNamespaceWriter } from './native-repo';
import { fileLocksLegacy } from './file-lock';

/**
 * Connects one encrypted workspace's native namespace to its encrypted content
 * bucket, with content keys held by the engine's own keyring
 * (specs/native-engine-cloud-e2ee.md, phase 1). The caller (Electron main or the
 * daemon) attaches only after authenticated mode classification and content-open
 * admission; nothing here decides authority.
 */

/** A content token for this device, as the cloud issues it (`E2eeContentToken`). */
export interface NativeContentToken {
  readonly token: string;
  readonly bucketId: string;
  readonly gatewayBaseUrl: string;
  /** Seconds until the token expires. */
  readonly expiresIn: number;
}

/** The durable "pending wipe" marker kept beside the workspace's identity records. */
export interface NativePendingWipe {
  read(): Promise<boolean>;
  write(): Promise<void>;
  clear(): Promise<void>;
}

export interface NativeEncryptedWorkspaceOptions {
  readonly client: RepoClient;
  /** Engine namespace: the workspace id. */
  readonly workspaceId: string;
  /** Pinned genesis hash (hex), which names the content AAD domain. */
  readonly genesisHash: string;
  /** This process's keyring writer (its seed is installed by `syncKeyring`); every local write names it. */
  readonly writer: string;
  /** This device's content token. Called for the first configuration and every refresh. */
  readonly contentToken: (rejectedToken?: string) => Promise<NativeContentToken>;
  /** Runs core's EngineKeyringSync for this device; idempotent. */
  readonly syncKeyring: () => Promise<{ readonly mayWrite: boolean }>;
  readonly pendingWipe: NativePendingWipe;
  /** This installation's identities using the namespace; the attachment records its writer. */
  readonly identities: NativeLocalIdentities;
  /**
   * The engine holds a room it cannot open yet: an unknown key or a writer the
   * installed ledger does not admit (a rotation or admission the Streams data
   * reached first). The caller runs its spaced ledger and key catch-up, after
   * which the notification table reinstalls; forged frames never trigger it.
   */
  readonly onOpenPending?: () => void;
}

/** Open holds a ledger or key catch-up can clear (not `invalid_frame`). */
const OPEN_PENDING_KINDS: ReadonlySet<string> = new Set([
  'unknown_key',
  'unauthorized',
  'missing_provider',
]);

/** The remote every encrypted workspace's native namespace uses. */
export const NATIVE_CONTENT_REMOTE_ID = 'e2ee-content';

/** Today's encrypted snapshot policy: writers only, 30 s quiet, at least 1 MiB, forced at 4 MiB. */
export const NATIVE_ENCRYPTED_SNAPSHOT_POLICY = {
  quietMs: 30_000,
  minUpdateBytes: 1024 * 1024,
  maxUpdateBytes: 4 * 1024 * 1024,
} as const;

/** A device that may write ranks above read-only ones, so appends never use a read-only token. */
const WRITER_TOKEN_PRIORITY = 200;
const READER_TOKEN_PRIORITY = 100;

/**
 * The pending-wipe marker of one workspace, in the engine's data directory. It is
 * machine-wide, beside the namespace it guards: whichever process connects next
 * finishes the wipe, and erasing a member's identity directory cannot lose it.
 */
export function nativePendingWipeMarker(dataDir: string, workspaceId: string): NativePendingWipe {
  const file = join(dataDir, 'pending-wipes', `${Buffer.from(workspaceId).toString('hex')}.json`);
  return {
    read: () =>
      readFile(file).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      ),
    async write() {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.pending`;
      const handle = await open(temporary, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ workspaceId }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    },
    clear: () =>
      unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      }),
  };
}

/**
 * The identities of this installation that use one workspace's namespace: each
 * attaching process records its writer (`personal:<key>` or `machine:<key>`), in
 * the engine's data directory beside the namespace. Entries are only candidates:
 * whether one is still a current device is decided against a verified ledger.
 */
export interface NativeLocalIdentities {
  record(writer: string): Promise<void>;
  /** The recorded writers. */
  list(): Promise<string[]>;
  /**
   * Device revocation, decided under a machine-wide lock: forgets `writer` and
   * returns true (wipe) unless another recorded identity is current. `stillCurrent`
   * answers from the caller's verified ledger. The lock serializes two processes'
   * revocations, so the later one sees the earlier one's entry gone and wipes.
   */
  decideRevocation(
    writer: string,
    stillCurrent: (writers: readonly string[]) => Promise<boolean>
  ): Promise<boolean>;
  /** Forgets every identity (the namespace was dropped). */
  clear(): Promise<void>;
}

/** The signing public key a native writer name carries (`<kind>:<hex key>`). */
export const nativeWriterSigningKey = (writer: string) => writer.slice(writer.indexOf(':') + 1);

export function nativeLocalIdentities(dataDir: string, workspaceId: string): NativeLocalIdentities {
  const root = join(dataDir, 'identities');
  const dir = join(root, Buffer.from(workspaceId).toString('hex'));
  const file = (writer: string) => join(dir, `${Buffer.from(writer).toString('hex')}.json`);
  const forget = (writer: string) =>
    unlink(file(writer)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  const list = async () => {
    const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    });
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => Buffer.from(name.slice(0, -'.json'.length), 'hex').toString())
      .filter(Boolean);
  };
  return {
    async record(writer) {
      if ((await list()).includes(writer)) return;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temporary = `${file(writer)}.${process.pid}.pending`;
      const handle = await open(temporary, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ writer }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file(writer));
    },
    list,
    decideRevocation: (writer, stillCurrent) =>
      fileLocksLegacy.withLock(
        `native-revocation-${Buffer.from(workspaceId).toString('hex')}`,
        async () => {
          const others = (await list()).filter((other) => other !== writer);
          const keep = others.length > 0 && (await stillCurrent(others));
          await forget(writer);
          return !keep;
        },
        { locksDir: join(root, 'locks') }
      ),
    clear: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Removes the namespace now, or, when the host is unreachable (removal while it is
 * down), as soon as the connection is back. The marker is durable first, so a
 * process exit meanwhile leaves it to the next start's sweep.
 */
export async function wipeNativeNamespace(
  options: Pick<
    NativeEncryptedWorkspaceOptions,
    'client' | 'workspaceId' | 'pendingWipe' | 'identities'
  >
) {
  await options.pendingWipe.write();
  try {
    await finishNativeWipe(options);
  } catch (error) {
    let finishing = false;
    const off = options.client.onConnectionStateChange((state) => {
      if (state !== 'connected' || finishing) return;
      finishing = true;
      finishNativeWipe(options).then(off, () => {
        finishing = false;
      });
    });
    throw error;
  }
}

/**
 * Finishes every pending wipe recorded in `dataDir` (a removal while the host was
 * down or the drop failed): the first connection after it finishes the drop.
 */
export async function finishPendingNativeWipes(client: RepoClient, dataDir: string) {
  const names = await readdir(join(dataDir, 'pending-wipes')).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const workspaceId = Buffer.from(name.slice(0, -'.json'.length), 'hex').toString();
    if (!workspaceId) continue;
    const pendingWipe = nativePendingWipeMarker(dataDir, workspaceId);
    const identities = nativeLocalIdentities(dataDir, workspaceId);
    await finishNativeWipe({ client, workspaceId, pendingWipe, identities }).catch(() => {});
  }
}

export interface NativeEncryptedWorkspace {
  /**
   * Re-installs keys and policy after any trigger of the notification table: a
   * new epoch, a ledger advance, a lost permission. Serialized; idempotent.
   */
  refresh(): Promise<void>;
  /**
   * Removes this workspace's content from the device after credential-confirmed
   * member removal: writes the pending-wipe marker, clears the keyring,
   * removes the remote and drops the namespace. Only a successful drop clears the
   * marker; with the host unreachable it finishes once the connection is back.
   */
  wipe(): Promise<void>;
  /**
   * This process's device was revoked while the member stays: only its writer
   * leaves the keyring (its rows wait unsealed). Another device of the member on
   * this installation keeps using the namespace, so nothing is dropped.
   */
  retireWriter(): Promise<void>;
  /**
   * After this device's recorded revocation: whether the namespace must be wiped
   * because no other identity of this installation is current. Owner decision A
   * (2026-11-22); see {@link NativeLocalIdentities.decideRevocation}.
   */
  decideRevocation(
    stillCurrent: (writers: readonly string[]) => Promise<boolean>
  ): Promise<boolean>;
  /** Stops reinstalling on reconnect. Keys stay: another process may share the namespace. */
  close(): void;
}

type TokenSource = NativeEncryptedWorkspaceOptions['contentToken'];
/**
 * The client replays a registration after every reconnect and cannot remove one,
 * so each namespace registers once per client and serves the current attachment's
 * tokens. A closed attachment (account switch, wipe) serves none.
 */
const tokenSlots = new WeakMap<RepoClient, Map<string, { source?: TokenSource }>>();
async function serveTokens(
  client: RepoClient,
  workspaceId: string,
  source: TokenSource,
  mayWrite: boolean
) {
  let slots = tokenSlots.get(client);
  if (!slots) tokenSlots.set(client, (slots = new Map()));
  const known = slots.get(workspaceId);
  if (known) {
    known.source = source;
    return known;
  }
  const slot: { source?: TokenSource } = { source };
  slots.set(workspaceId, slot);
  await client.registerAuthProvider({
    domains: [workspaceId],
    remoteIds: [NATIVE_CONTENT_REMOTE_ID],
    priority: mayWrite ? WRITER_TOKEN_PRIORITY : READER_TOKEN_PRIORITY,
    getToken: async ({ rejectedToken }) => {
      if (!slot.source) throw new Error('native_content_token_unavailable');
      const grant = await slot.source(rejectedToken ?? undefined);
      return { token: grant.token, expiresInMs: grant.expiresIn * 1000 };
    },
  });
  return slot;
}

/**
 * Finishes an interrupted wipe: also for a removed workspace that never attaches
 * again. Every step is idempotent; only a completed drop clears the marker.
 * `dropNamespace` also drops the namespace's keyring, writer bindings and keyring
 * participants, and any connection may send it; `keyringClear` is refused to a
 * connection that never configured the namespace while another process still
 * holds it, so it is not part of the wipe. The remote goes first: removing it after
 * the drop would reopen an empty namespace.
 */
export async function finishNativeWipe(
  options: Pick<
    NativeEncryptedWorkspaceOptions,
    'client' | 'workspaceId' | 'pendingWipe' | 'identities'
  >
) {
  const { client, workspaceId } = options;
  await client.removeRemote(workspaceId, NATIVE_CONTENT_REMOTE_ID).catch(() => {});
  await client.dropNamespace(workspaceId);
  forgetDeclaredDocRooms(client, workspaceId);
  await options.identities.clear();
  await options.pendingWipe.clear();
}

/**
 * Removes one local identity from the namespace after its durable removal receipt.
 * Member removal drops the namespace. Device revocation retires the identity's
 * writer, and drops the namespace only when no other identity of this installation
 * is current (owner decision A, 2026-11-22). The pending-wipe marker is written
 * before the host is reached, so a drop the host cannot take now finishes on the
 * next connection.
 */
export async function removeNativeLocalIdentity(options: {
  readonly workspaceId: string;
  readonly reason: 'member_removed' | 'device_revoked';
  /** This process's attachment, when it has one. */
  readonly handle?: NativeEncryptedWorkspace;
  readonly dataDir: string;
  readonly writer: string;
  /** Whether any of `writers` is a current device in the caller's verified ledger. */
  readonly stillCurrent: (writers: readonly string[]) => Promise<boolean>;
  readonly connect: () => Promise<{ client: RepoClient }>;
}) {
  const { handle, workspaceId } = options;
  const identities = nativeLocalIdentities(options.dataDir, workspaceId);
  if (options.reason === 'device_revoked') {
    const retired = handle?.retireWriter().then(
      () => undefined,
      (cause: unknown) => cause ?? new Error('native_retire_failed')
    );
    const wipe = await identities.decideRevocation(options.writer, options.stillCurrent);
    const failure = await retired;
    if (!wipe) {
      handle?.close();
      if (failure) throw failure;
      return;
    }
  }
  if (handle) return handle.wipe();
  const pendingWipe = nativePendingWipeMarker(options.dataDir, workspaceId);
  await pendingWipe.write();
  const { client } = await options.connect();
  await wipeNativeNamespace({ client, workspaceId, pendingWipe, identities });
}

/**
 * Attaches the namespace. A pending wipe is finished first, before any other
 * request for the namespace: the caller passed content-open admission again (a
 * new pairing), so the workspace then opens from a fresh, empty namespace.
 */
export async function attachNativeEncryptedWorkspace(
  options: NativeEncryptedWorkspaceOptions
): Promise<NativeEncryptedWorkspace> {
  const { client, workspaceId } = options;
  if (await options.pendingWipe.read()) await finishNativeWipe(options);
  setNativeNamespaceEncryption(client, workspaceId, 'encrypted');
  setNativeNamespaceWriter(client, workspaceId, options.writer);
  await options.identities.record(options.writer);

  let serial: Promise<unknown> = Promise.resolve();
  let closed = false;
  let slot: { source?: TokenSource } | undefined;
  const install = async () => {
    const { mayWrite } = await options.syncKeyring();
    await client.setSnapshotPolicy(workspaceId, {
      ...NATIVE_ENCRYPTED_SNAPSHOT_POLICY,
      enabled: mayWrite,
    });
    if (!closed) slot ??= await serveTokens(client, workspaceId, options.contentToken, mayWrite);
    if (!closed && !remoteConfigured) await configureContentRemote().catch(() => {});
  };
  const stopServing = () => {
    closed = true;
    offState();
    void pendingWatch?.unsubscribe().catch(() => {});
    if (slot?.source === options.contentToken) slot.source = undefined;
  };
  const run = <A>(work: () => Promise<A>): Promise<A> => {
    const next = serial.then(work, work);
    serial = next.catch(() => {});
    return next;
  };

  let remoteConfigured = false;
  const configureContentRemote = async () => {
    const grant = await options.contentToken();
    await client.configureRemote(workspaceId, {
      remote_id: NATIVE_CONTENT_REMOTE_ID,
      base_url: grant.gatewayBaseUrl,
      bucket: grant.bucketId,
      encrypted: true,
      snapshot_zstd: true,
      aadDomain: encryptedWorkspaceNamespace(options.genesisHash),
      routes: createLodyWorkspaceRoutes(workspaceId, {
        excludePrefixes: ['session-comment-'],
        excludeFlockPrefixes: ['lody-migrations'],
      }),
    });
    remoteConfigured = true;
  };
  await run(install);

  const pendingWatch = options.onOpenPending
    ? await client
        .subscribeRemoteStatus(
          workspaceId,
          (statuses) => {
            if (closed) return;
            const pending = statuses.some((status) =>
              status.blockedRooms.some(
                (room) => room.direction === 'open' && OPEN_PENDING_KINDS.has(room.kind)
              )
            );
            if (pending) options.onOpenPending?.();
          },
          NATIVE_CONTENT_REMOTE_ID
        )
        .catch(() => undefined)
    : undefined;

  const offState = client.onConnectionStateChange((state) => {
    if (state !== 'connected' || closed) return;
    void run(install).catch(() => {});
  });

  return {
    refresh: () => (closed ? Promise.resolve() : run(install)),
    wipe: () =>
      run(async () => {
        stopServing();
        await wipeNativeNamespace(options);
      }),
    retireWriter: () =>
      run(async () => {
        await client.keyringHoldSealing(workspaceId, options.writer);
        await client.keyringRemoveSigner(workspaceId, options.writer);
      }),
    decideRevocation: (stillCurrent) =>
      options.identities.decideRevocation(options.writer, stillCurrent),
    close: stopServing,
  };
}
