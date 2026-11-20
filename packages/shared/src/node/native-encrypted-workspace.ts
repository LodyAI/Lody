import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLodyWorkspaceRoutes, type RepoClient } from '@loro-dev/loro-repo-client';
import { encryptedWorkspaceNamespace } from '../workspace-streams-content';
import { forgetDeclaredDocRooms } from './native-docs';
import { setNativeNamespaceEncryption, setNativeNamespaceWriter } from './native-repo';

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
}

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
    await finishNativeWipe({ client, workspaceId, pendingWipe }).catch(() => {});
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
   * marker; a failure leaves it for the next attach to finish.
   */
  wipe(): Promise<void>;
  /**
   * This process's device was revoked while the member stays: only its writer
   * leaves the keyring (its rows wait unsealed). Another device of the member on
   * this installation keeps using the namespace, so nothing is dropped.
   */
  retireWriter(): Promise<void>;
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
 */
export async function finishNativeWipe(
  options: Pick<NativeEncryptedWorkspaceOptions, 'client' | 'workspaceId' | 'pendingWipe'>
) {
  const { client, workspaceId } = options;
  await client.keyringClear(workspaceId);
  await client.removeRemote(workspaceId, NATIVE_CONTENT_REMOTE_ID).catch(() => {});
  await client.dropNamespace(workspaceId);
  forgetDeclaredDocRooms(client, workspaceId);
  await options.pendingWipe.clear();
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
    // Best effort: offline, a persisted remote keeps its rows queued and the next
    // install (refresh or reconnect) configures it.
    if (!closed && !remoteConfigured) await configureContentRemote().catch(() => {});
  };
  const stopServing = () => {
    closed = true;
    offState();
    if (slot?.source === options.contentToken) slot.source = undefined;
  };
  const run = <A>(work: () => Promise<A>): Promise<A> => {
    const next = serial.then(work, work);
    serial = next.catch(() => {});
    return next;
  };

  // The bucket and gateway come from the token itself; they are fixed per workspace.
  // The engine persists the remote, so opening never waits on the network.
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
      // Legacy session-comment documents and local migration markers stay off this remote.
      routes: createLodyWorkspaceRoutes(workspaceId, {
        excludePrefixes: ['session-comment-'],
        excludeFlockPrefixes: ['lody-migrations'],
      }),
    });
    remoteConfigured = true;
  };
  await run(install);

  // The keyring and snapshot policy live in engine memory: a host restart,
  // reconnect or build handoff starts empty, so reinstall on every reconnect.
  const offState = client.onConnectionStateChange((state) => {
    if (state !== 'connected' || closed) return;
    void run(install).catch(() => {});
  });

  return {
    refresh: () => (closed ? Promise.resolve() : run(install)),
    wipe: () =>
      run(async () => {
        stopServing();
        await options.pendingWipe.write();
        await finishNativeWipe(options);
      }),
    retireWriter: () =>
      run(async () => {
        await client.keyringHoldSealing(workspaceId, options.writer);
        await client.keyringRemoveSigner(workspaceId, options.writer);
      }),
    close: stopServing,
  };
}
