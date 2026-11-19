import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  connectEngine,
  connectSocketTransport,
  readEngineEndpoint,
} from '@loro-dev/loro-repo-client/node';
import type {
  FlockChangesUpdate,
  FlockKey,
  FlockStateEntry,
  RepoClient,
  RoomKey,
} from '@loro-dev/loro-repo-client';
import { startProcessLegacy } from './process';
import { getLodyDataDir } from './installation-profile';

/** One engine directory per installation; namespaces are workspace ids. */
export const nativeRepoDataDir = () => join(getLodyDataDir('local'), 'native-repo', 'v1');

/** Explicit opt-in. Both daemon and desktop read the same variable. */
export const isNativeWorkspaceMetaEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.LODY_NATIVE_WORKSPACE_META === '1';

/** How this process starts the separate host when none is running. */
export interface NativeRepoHostLauncher {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

const RECONNECT_MAX_DELAY_MS = 2_000;
const START_WAIT_MS = 10_000;

async function openTransport(dataDir: string) {
  const endpoint = await readEngineEndpoint(dataDir);
  return connectSocketTransport(endpoint.socket);
}

/** The host owns its own lifetime (files.lock + idle exit); this process never stops it. */
function launchHost(dataDir: string, resolveLauncher: () => NativeRepoHostLauncher) {
  const launcher = resolveLauncher();
  const handle = startProcessLegacy({
    command: launcher.command,
    args: [...launcher.args, dataDir],
    options: { stdio: 'ignore', env: launcher.env ?? process.env },
    processGroup: true,
    windowsDetached: true,
  });
  handle.child.unref();
  // A losing duplicate host exits on ENGINE_BUSY; nothing waits for its exit.
  handle.child.once('error', () => {});
}

async function connectOrLaunch(dataDir: string, launcher: () => NativeRepoHostLauncher) {
  try {
    return await openTransport(dataDir);
  } catch {
    // Missing or stale endpoint: start a host and wait for its publication.
    launchHost(dataDir, launcher);
    const deadline = Date.now() + START_WAIT_MS;
    for (let delay = 25; ; delay = Math.min(delay * 2, 500)) {
      try {
        return await openTransport(dataDir);
      } catch (error) {
        if (String(error).includes('ENGINE_PROTOCOL_MISMATCH') || Date.now() > deadline)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}

/**
 * The process-wide connection. Every observation and command shares it. A lost
 * host is relaunched by whichever process reconnects first; reconnection never
 * gives up while the connection is open, so callers see only connected and
 * reconnecting states.
 */
export interface NativeRepoConnection {
  readonly client: RepoClient;
  readonly dataDir: string;
  close(): Promise<void>;
}

const connections = new Map<string, Promise<NativeRepoConnection>>();

export function connectNativeRepo(options: {
  /** Resolved only when a host must be started. */
  launcher: () => NativeRepoHostLauncher;
  dataDir?: string;
}): Promise<NativeRepoConnection> {
  const dataDir = options.dataDir ?? nativeRepoDataDir();
  const existing = connections.get(dataDir);
  if (existing) return existing;
  const opening = (async () => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    let closed = false;
    const reconnect = async () => {
      for (let delay = 25; ; delay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS)) {
        try {
          return await connectOrLaunch(dataDir, options.launcher);
        } catch (error) {
          if (closed || String(error).includes('ENGINE_PROTOCOL_MISMATCH')) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    };
    const clientOptions = { reconnect, queueWhileReconnecting: false };
    const client = await connectEngine(dataDir, clientOptions).catch(() => {
      launchHost(dataDir, options.launcher);
      return connectEngine(dataDir, { ...clientOptions, waitForEndpointMs: START_WAIT_MS });
    });
    const connection: NativeRepoConnection = {
      client,
      dataDir,
      async close() {
        closed = true;
        if (connections.get(dataDir) === opening) connections.delete(dataDir);
        await client.close();
      },
    };
    return connection;
  })();
  connections.set(dataDir, opening);
  // A failed attempt is never cached.
  opening.catch(() => {
    if (connections.get(dataDir) === opening) connections.delete(dataDir);
  });
  return opening;
}

export type FlockObservationEvent =
  | { kind: 'snapshot' | 'changes'; entries: FlockStateEntry[]; txId: number }
  | { kind: 'invalidated' };

export interface FlockObservation {
  /** Resolves after the first snapshot was delivered. */
  readonly ready: Promise<void>;
  /** Waits until this observation has delivered `txId` from a local commit. */
  whenVisible(txId: number): Promise<void>;
  /** Stops callbacks at once, then confirms the engine-side release. */
  release(): Promise<void>;
}

const PAGE_BUDGET = { maxRows: 4096, maxBytes: 1024 * 1024 };

/**
 * The single observation lifecycle. The engine subscription starts at the head
 * without a snapshot, so no frame grows with the room; initial state is read in
 * bounded pages, each a fresh query at its own head. A change buffered during
 * the load is kept only if it is newer than the page that returned its key.
 * The view then receives one `snapshot`, followed by `changes`. Disconnect or a
 * gap emits `invalidated`; the SDK resubscribes after reconnect (and a gap is
 * resubscribed here), and both reload. Domains own no retry or release state.
 */
export function observeFlock(
  client: RepoClient,
  namespace: string,
  room: RoomKey,
  prefix: FlockKey,
  listener: (event: FlockObservationEvent) => void
): FlockObservation {
  let active = true;
  let current: ReturnType<RepoClient['beginFlockChangesSubscription']> | undefined;
  let loading: { buffered: { entries: FlockStateEntry[]; txId: number }[] } | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});

  const load = async (opening: NonNullable<typeof current>) => {
    const load = { buffered: [] as { entries: FlockStateEntry[]; txId: number }[] };
    loading = load;
    // A resubscription snapshot arrives during the SDK's reconnect resync,
    // before ordinary reads are admitted.
    if (client.connectionState !== 'connected') await client.whenConnected();
    const pageHead = new Map<string, number>();
    const rows: FlockStateEntry[] = [];
    let start: FlockKey | undefined;
    let head = 0;
    for (;;) {
      const page = await client.flockScanPage(
        namespace,
        room,
        { prefix, ...(start ? { start: { bound: 'exclusive', key: start } } : {}) },
        PAGE_BUDGET
      );
      if (!active || current !== opening || loading !== load) return;
      for (const entry of page.entries) {
        pageHead.set(JSON.stringify(entry.key), page.roomTxId);
        rows.push(entry);
      }
      head = Math.max(head, page.roomTxId);
      if (page.eof) break;
      const last = page.entries.at(-1);
      if (!last) throw new Error('native_repo_page_without_progress');
      start = last.key;
    }
    loading = undefined;
    const byKey = new Map(rows.map((row) => [JSON.stringify(row.key), row]));
    for (const change of load.buffered) {
      head = Math.max(head, change.txId);
      for (const entry of change.entries) {
        const key = JSON.stringify(entry.key);
        const seen = pageHead.get(key);
        if (seen === undefined || change.txId > seen) byKey.set(key, entry);
      }
    }
    listener({ kind: 'snapshot', entries: [...byKey.values()], txId: head });
    resolveReady();
  };

  const stopState = client.onConnectionStateChange((state) => {
    if (active && state !== 'connected') listener({ kind: 'invalidated' });
  });
  const begin = () => {
    const opening = client.beginFlockChangesSubscription(
      namespace,
      room,
      prefix,
      (update: FlockChangesUpdate) => {
        if (!active || current !== opening) return;
        if (update.kind === 'gap') {
          listener({ kind: 'invalidated' });
          void opening.handle.release().catch(() => {});
          begin();
        } else if (update.kind === 'snapshot') {
          // Initial subscribe or SDK resubscription after reconnect: reload.
          load(opening).catch((error: unknown) => {
            if (!active || current !== opening) return;
            rejectReady(error);
            listener({ kind: 'invalidated' });
          });
        } else if (loading) {
          loading.buffered.push({ entries: update.entries, txId: update.roomTxId });
        } else {
          listener({ kind: 'changes', entries: update.entries, txId: update.txId });
        }
      },
      { snapshot: false }
    );
    current = opening;
    opening.ready.catch((error: unknown) => {
      if (current === opening) rejectReady(error);
    });
  };
  begin();
  return {
    ready,
    whenVisible: (txId) => {
      if (!current) return Promise.reject(new Error('observation released'));
      return current.handle.whenVisible(txId);
    },
    async release() {
      active = false;
      stopState();
      const opening = current;
      if (!opening) return;
      const result = await opening.handle.release();
      if (result.status !== 'acknowledged' && client.connectionState === 'connected')
        throw new Error('native_repo_release_unconfirmed');
      current = undefined;
    },
  };
}
