import { createHash, randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyMessageContentsBatch,
  applyNotificationOnHistory,
  type AcpSessionNotification,
  type MessageContent,
  type ModelInfo,
  type SessionPlanEntry,
  type SessionHistoryInput,
} from '@lody/shared';
import {
  applyHistoryAction as applyDomainHistoryAction,
  applyMarkTurnSeen,
  applyOpenAssistantTurn,
  createAssistantTurn,
  markTurnSeenBlocked,
  type RoostHistoryChange,
  type RoostHistorySegment,
  type RoostSessionData,
  type SessionDataChangeListener,
  type SessionDirectoryRow,
  type SessionEntry,
  type SessionHistoryReader,
  type SessionHistoryDirectoryPage,
  type SessionEditableTailResult,
  type SessionHistoryCommands,
  type SessionObservation,
  type SessionSnapshotService,
  type SessionSnapshot,
  type SessionTurn,
  type SessionTurnRead,
  createRoostDirectoryRow,
  projectRoostSegments,
  selectTurnOutput,
  ROOST_CLEAR_FIELDS_KEY,
} from '@lody/shared/session-data';
import {
  createImportCursor,
  hashHistoryEntryForVersion,
  planEditableTailReplacement,
  planHistoryImport,
  resolveImportHashVersion,
} from '@lody/shared/session-data';
import { isSessionHistoryPendingForDispatch } from '@lody/shared';
import {
  fromApplicationJson,
  applicationJsonText,
  NodeLodyHistory,
  type ActiveBranchPageCursor,
  type ActiveBranchPageRead,
  toApplicationJson,
  type HistoryProjectedMessage,
  type LodyNodeHost,
} from '@loro-dev/roost/lody-history';
import { Identity } from '@loro-dev/roost';
import type { SessionDocument } from '@/lib/loro/doc';
import type { SessionAgentWrites } from '@/lib/loro/session-agent-writes';
import { latestSessionModel } from '@/lib/loro/session-model-summary';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  createRoostSessionBackendFactory,
  type RoostSessionBackendServices,
} from './roost-session-backend';
import { adaptRoostProjectedMessage, adaptRoostProjectedMessages } from './roost-history-port';
import { registerSessionBackendFactory } from './session-backend';

type NodeClient = {
  readonly ready: Promise<unknown>;
  readonly capabilities?: readonly string[];
  stream(id: string): LodyNodeHost;
  close(): Promise<void>;
};

type NodeClientConstructor = new (options: {
  binaryPath: string;
  dbPath: string;
  seed: Uint8Array;
  allowedOwners: Uint8Array[];
  maxQueuedRequests: number;
  maxQueuedBytes: number;
}) => NodeClient;

type NodeClientModule = { RoostNodeClient: NodeClientConstructor };

type RoostOwnerOptions = {
  readonly binaryPath?: string;
  readonly dbPath?: string;
  readonly nodeClientModule?: string;
  readonly seed?: Uint8Array;
  readonly maxQueuedRequests?: number;
  readonly maxQueuedBytes?: number;
};

type OwnerLease = {
  readonly client: NodeClient;
  readonly owner: Uint8Array;
  release(): Promise<void>;
};

const bytesHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const parseSeed = (raw: string | undefined): Uint8Array | undefined => {
  if (!raw?.trim()) return undefined;
  const value = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('LODY_ROOST_SEED_HEX must contain exactly 32 bytes (64 hex characters)');
  }
  return Uint8Array.from(Buffer.from(value, 'hex'));
};

const runtimeResourcesPath = (): string | undefined => {
  const value = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const existingPath = (candidates: readonly string[]): string | undefined =>
  candidates
    .filter((candidate) => candidate.trim().length > 0)
    .map((candidate) => resolve(candidate))
    .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());

const packageClientPath = (): string | undefined => {
  try {
    return createRequire(import.meta.url).resolve('@loro-dev/roost/node/client.mjs');
  } catch {
    return undefined;
  }
};

const siblingRoostRoot = (start: string): string | undefined => {
  let current = resolve(start);
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(current, 'roost');
    if (
      existsSync(join(candidate, 'node', 'client.mjs')) ||
      existsSync(join(candidate, 'target', 'release', 'roost-node-owner')) ||
      existsSync(join(candidate, 'target', 'release', 'roost-node-owner.exe')) ||
      existsSync(join(candidate, 'target', 'debug', 'roost-node-owner')) ||
      existsSync(join(candidate, 'target', 'debug', 'roost-node-owner.exe'))
    ) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
};

const defaultNodeClientModule = (): string => {
  const configured = process.env.LODY_ROOST_NODE_CLIENT?.trim();
  if (configured) return configured;
  const resources = runtimeResourcesPath();
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const sibling = siblingRoostRoot(moduleDir);
  const resolved = existingPath([
    ...(resources
      ? [
          join(resources, 'roost', 'client.mjs'),
          join(resources, 'roost', 'node', 'client.mjs'),
          join(resources, 'app.asar.unpacked', 'resources', 'roost', 'client.mjs'),
          join(resources, 'app.asar.unpacked', 'resources', 'roost', 'node', 'client.mjs'),
          join(resources, 'app.asar.unpacked', 'roost', 'client.mjs'),
        ]
      : []),
    packageClientPath() ?? '',
    ...(sibling ? [join(sibling, 'node', 'client.mjs')] : []),
  ]);
  return resolved ?? 'roost-node-client-unavailable';
};

const defaultOwnerBinary = (): string => {
  const configured = process.env.LODY_ROOST_NODE_OWNER?.trim();
  if (configured) return configured;
  const resources = runtimeResourcesPath();
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const sibling = siblingRoostRoot(moduleDir);
  const development = process.env.NODE_ENV !== 'production';
  const resolved = existingPath([
    ...(resources
      ? [
          join(resources, 'roost', 'roost-node-owner'),
          join(resources, 'roost', 'roost-node-owner.exe'),
          join(resources, 'app.asar.unpacked', 'resources', 'roost', 'roost-node-owner'),
          join(resources, 'app.asar.unpacked', 'resources', 'roost', 'roost-node-owner.exe'),
          join(resources, 'app.asar.unpacked', 'roost', 'roost-node-owner'),
          join(resources, 'app.asar.unpacked', 'roost', 'roost-node-owner.exe'),
        ]
      : []),
    ...(sibling
      ? [
          join(sibling, 'target', 'release', 'roost-node-owner'),
          join(sibling, 'target', 'release', 'roost-node-owner.exe'),
        ]
      : []),
    ...(development
      ? [
          ...(sibling
            ? [
                join(sibling, 'target', 'debug', 'roost-node-owner'),
                join(sibling, 'target', 'debug', 'roost-node-owner.exe'),
              ]
            : []),
        ]
      : []),
  ]);
  return resolved ?? 'roost-node-owner-unavailable';
};

const loadRoostOwnerSeed = async (): Promise<Uint8Array> => {
  const configured = parseSeed(process.env.LODY_ROOST_SEED_HEX);
  if (configured) return configured;
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const entry = new AsyncEntry('Lody Roost History', 'owner-seed-v1', {
      linux: { store: 'secret-service' },
    });
    const existing = await entry.getPassword(AbortSignal.timeout(30_000));
    const restored = parseSeed(existing ?? undefined);
    if (existing && !restored) {
      throw new Error('stored Roost owner identity is invalid');
    }
    if (restored) return restored;
    const generated = randomBytes(32);
    await entry.setPassword(generated.toString('hex'), AbortSignal.timeout(30_000));
    return generated;
  } catch (error) {
    throw new Error(
      `Roost history owner identity is unavailable; configure LODY_ROOST_SEED_HEX or unlock the system credential store (${error instanceof Error ? error.message : String(error)})`,
      { cause: error }
    );
  }
};

const defaultDatabase = (): string =>
  process.env.LODY_ROOST_DB_PATH?.trim() ||
  join(getLodyDataDir(undefined, homedir()), 'roost-history.sqlite3');

let nodeClientModulePromise: Promise<NodeClientModule> | undefined;
const loadNodeClientModule = async (modulePath: string): Promise<NodeClientModule> => {
  if (modulePath === 'roost-node-client-unavailable') {
    throw new Error(
      'Roost Node client is unavailable. The packaged app must contain ' +
        'resources/roost/client.mjs; rebuild the product with the Roost runtime artifact.'
    );
  }
  const absolute = resolve(modulePath);
  if (!existsSync(absolute)) {
    throw new Error(
      `Roost Node client was not found at ${absolute}; set LODY_ROOST_NODE_CLIENT to the published host client`
    );
  }
  nodeClientModulePromise ??= import(/* @vite-ignore */ pathToFileURL(absolute).href).then(
    (module) => module as unknown as NodeClientModule
  );
  return nodeClientModulePromise;
};

let ownerPool:
  | {
      key: string;
      client: NodeClient;
      owner: Uint8Array;
      refs: number;
      closePromise?: Promise<void>;
    }
  | undefined;

const acquireOwnerUnlocked = async (options: RoostOwnerOptions): Promise<OwnerLease> => {
  const seed = options.seed ?? (await loadRoostOwnerSeed());
  const configuredBinary = options.binaryPath ?? defaultOwnerBinary();
  if (configuredBinary === 'roost-node-owner-unavailable') {
    throw new Error(
      'Roost owner binary is unavailable. The packaged app must contain ' +
        'resources/roost/roost-node-owner; rebuild the product with the target Roost artifact.'
    );
  }
  const binaryPath = resolve(configuredBinary);
  const dbPath = resolve(options.dbPath ?? defaultDatabase());
  const key = `${dbPath}:${binaryPath}:${bytesHex(seed)}`;
  if (ownerPool?.key === key && !ownerPool.closePromise) {
    ownerPool.refs += 1;
    return {
      client: ownerPool.client,
      owner: ownerPool.owner.slice(),
      release: async () => releaseOwner(key),
    };
  }
  if (ownerPool) await releaseOwnerUnlocked(ownerPool.key, true);
  await mkdir(dirname(dbPath), { recursive: true });
  const module = await loadNodeClientModule(options.nodeClientModule ?? defaultNodeClientModule());
  const owner = Identity.fromSeed(seed).owner();
  const client = new module.RoostNodeClient({
    binaryPath,
    dbPath,
    seed,
    allowedOwners: [owner],
    maxQueuedRequests: options.maxQueuedRequests ?? 32,
    maxQueuedBytes: options.maxQueuedBytes ?? 8 * 1024 * 1024,
  });
  await client.ready;
  ownerPool = { key, client, owner, refs: 1 };
  return {
    client,
    owner: owner.slice(),
    release: async () => releaseOwner(key),
  };
};

let ownerTransitionSerial: Promise<void> = Promise.resolve();
const serializeOwnerTransition = <T>(operation: () => Promise<T>): Promise<T> => {
  const next = ownerTransitionSerial.then(operation);
  ownerTransitionSerial = next.then(
    () => undefined,
    () => undefined
  );
  return next;
};

const acquireOwner = (options: RoostOwnerOptions): Promise<OwnerLease> => {
  return serializeOwnerTransition(() => acquireOwnerUnlocked(options));
};

const releaseOwnerUnlocked = async (key: string, force = false): Promise<void> => {
  if (!ownerPool || ownerPool.key !== key) return;
  if (!force) ownerPool.refs = Math.max(0, ownerPool.refs - 1);
  if (!force && ownerPool.refs > 0) return;
  const current = ownerPool;
  ownerPool = undefined;
  current.closePromise ??= current.client.close();
  await current.closePromise;
};

const releaseOwner = (key: string, force = false): Promise<void> =>
  serializeOwnerTransition(() => releaseOwnerUnlocked(key, force));

const clone = <T>(value: T): T => structuredClone(value);

const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left === 'bigint' || typeof right === 'bigint') return left === right;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  return [...keys].every((key) => equal(leftRecord[key], rightRecord[key]));
};

const operationDigest = (value: unknown): string =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        typeof item === 'bigint' ? `${item.toString()}n` : item
      )
    )
    .digest('hex');

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const arrayFields = new Set(['items', 'plan', 'fileDiff']);

const appendOnlyDelta = (
  before: SessionHistoryInput,
  after: SessionHistoryInput
): Record<string, unknown> => {
  const delta: Record<string, unknown> = {};
  const clearFields: string[] = [];
  const keys = new Set([...Object.keys(after), ...Object.keys(before)]);
  for (const key of keys) {
    if (key === 'id') continue;
    if (key === ROOST_CLEAR_FIELDS_KEY) {
      throw new Error(`Roost history field ${ROOST_CLEAR_FIELDS_KEY} is reserved`);
    }
    const next = (after as Record<string, unknown>)[key];
    const prior = (before as Record<string, unknown>)[key];
    if (arrayFields.has(key)) {
      if (next === undefined) {
        if (prior !== undefined) clearFields.push(key);
        continue;
      }
      if (!Array.isArray(next) || !Array.isArray(prior)) {
        if (!equal(next, prior)) throw new Error(`Roost cannot rewrite sealed array field ${key}`);
        continue;
      }
      if (prior.length > next.length || prior.some((item, index) => !equal(item, next[index]))) {
        throw new Error(`Roost sealed successor requires append-only ${key}`);
      }
      if (next.length > prior.length) delta[key] = clone(next.slice(prior.length));
      continue;
    }
    if (!equal(next, prior)) {
      if (next === undefined) {
        clearFields.push(key);
        continue;
      }
      delta[key] = clone(next);
    }
  }
  if (clearFields.length) delta[ROOST_CLEAR_FIELDS_KEY] = clearFields;
  return delta;
};

const toEntry = (row: HistoryProjectedMessage): SessionHistoryInput =>
  toApplicationJson(row.content) as SessionHistoryInput;

const identityKey = (identity: { businessId: string; segmentId: string }): string =>
  `${identity.businessId}\u0000${identity.segmentId}`;

const createNodeServices = async (
  sessionDoc: SessionDocument,
  ownerOptions: RoostOwnerOptions = {}
): Promise<RoostSessionBackendServices> => {
  const lease = await acquireOwner(ownerOptions);
  const historyHost = lease.client.stream(`lody-session:${sessionDoc.sessionId}`);
  const roostHistory = new NodeLodyHistory(historyHost, lease.owner);
  try {
    await roostHistory.catchUpIndex();
    await roostHistory.recoverPendingBatches();
  } catch (error) {
    await lease.release().catch(() => {});
    throw error;
  }

  const viewId = sessionDoc.sessionId;
  let disposed = false;
  let rows: RoostHistorySegment[] = [];
  let entries: SessionEntry[] = [];
  let directory: SessionDirectoryRow[] = [];
  let activeBranch: ActiveBranchPageRead | undefined;
  let loadedStartPosition = 0;
  let totalHistoryCount = 0;
  const branchCursors = new Map<string, ActiveBranchPageCursor>();
  let pageSequence = 0;
  const branchPageSize = 40;
  const projectedByIdentity = new Map<string, HistoryProjectedMessage>();
  const latestProjectedByBusinessId = new Map<string, HistoryProjectedMessage>();
  const positionById = new Map<string, number>();
  const listeners = new Set<SessionDataChangeListener>();
  let pendingChange: RoostHistoryChange | undefined;
  let pendingModelSummary = false;
  let latestAssistantId: string | undefined;
  let latestModelTurnId: string | undefined;
  let syncModelSummary: (() => Promise<void>) | undefined;
  let fullEntriesCache: SessionEntry[] | undefined;
  let readGeneration = 0;
  let writeSerial: Promise<void> = Promise.resolve();
  // Directory pages already carry bodies; retain a bounded cache for hydration.
  const pageEntries = new Map<string, { position: number; turn: SessionEntry }>();
  const pageIdsByPosition = new Map<number, string>();
  const pageBodyLimit = 500;

  const readFullBranch = () => roostHistory.readActiveBranch(viewId);
  const storeBranchCursor = (cursor: ActiveBranchPageCursor | null): string | null => {
    if (!cursor) return null;
    const token = `${cursor.revision}:${cursor.position}:${pageSequence++}:${randomBytes(6).toString('hex')}`;
    branchCursors.set(token, cursor);
    while (branchCursors.size > 128) {
      const oldest = branchCursors.keys().next().value;
      if (oldest === undefined) break;
      branchCursors.delete(oldest);
    }
    return token;
  };
  const currentBranch = (): ActiveBranchPageRead => {
    if (!activeBranch) throw new Error(`Roost active branch for ${viewId} is not initialized`);
    return activeBranch;
  };

  const recordChange = (change: RoostHistoryChange): void => {
    if (!pendingChange) {
      pendingChange = change;
      return;
    }
    if (pendingChange.kind === 'structure' && change.kind === 'structure') {
      pendingChange = {
        kind: 'structure',
        from: Math.min(pendingChange.from, change.from),
        to: Math.max(pendingChange.to, change.to),
      };
      return;
    }
    if (pendingChange.kind === 'changed' && change.kind === 'changed') {
      pendingChange = {
        kind: 'changed',
        businessIds: [...new Set([...pendingChange.businessIds, ...change.businessIds])],
      };
      return;
    }
    pendingChange = { kind: 'structure', from: 0, to: totalHistoryCount };
  };

  const updateLatestSummaryTargets = (): void => {
    latestAssistantId = undefined;
    latestModelTurnId = undefined;
    for (let position = directory.length - 1; position >= 0; position -= 1) {
      const row = directory[position];
      if (!row?.turnId || row.state !== 'ready') continue;
      if (!latestAssistantId && row.scalars?.role === 'assistant') latestAssistantId = row.turnId;
      if (
        !latestModelTurnId &&
        row.scalars?.role === 'assistant' &&
        ((row.itemCount ?? 0) > 0 || (row.planCount ?? 0) > 0)
      ) {
        latestModelTurnId = row.turnId;
      }
    }
  };

  const rebuildLogicalProjection = (): void => {
    entries = projectRoostSegments(rows).map((entry) => clone(entry)) as SessionEntry[];
    directory = entries.map((entry, position) =>
      createRoostDirectoryRow(loadedStartPosition + position, entry)
    );
    positionById.clear();
    entries.forEach((entry, position) => positionById.set(entry.id, position));
    updateLatestSummaryTargets();
  };

  const rebuildSegmentIndexes = (messages: readonly HistoryProjectedMessage[]): void => {
    projectedByIdentity.clear();
    latestProjectedByBusinessId.clear();
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      const segment = adaptRoostProjectedMessage(message);
      const key = identityKey(segment);
      projectedByIdentity.set(key, message);
      latestProjectedByBusinessId.set(segment.businessId, message);
    }
  };

  const changeBetween = (
    previous: readonly RoostHistorySegment[],
    next: readonly RoostHistorySegment[]
  ): RoostHistoryChange | undefined => {
    const previousIds = [...new Set(previous.map((row) => row.businessId))];
    const nextIds = [...new Set(next.map((row) => row.businessId))];
    if (
      previousIds.length !== nextIds.length ||
      previousIds.some((businessId, index) => businessId !== nextIds[index])
    ) {
      let from = 0;
      while (
        from < previousIds.length &&
        from < nextIds.length &&
        previousIds[from] === nextIds[from]
      )
        from += 1;
      return { kind: 'structure', from, to: Math.max(previousIds.length, nextIds.length) };
    }
    const oldByKey = new Map(previous.map((row) => [identityKey(row), row]));
    const changed = new Set<string>();
    for (const row of next) {
      const old = oldByKey.get(identityKey(row));
      if (
        !old ||
        old.nextSeq !== row.nextSeq ||
        old.sealed !== row.sealed ||
        !equal(old.content, row.content)
      )
        changed.add(row.businessId);
    }
    return changed.size ? { kind: 'changed', businessIds: [...changed] } : undefined;
  };

  const notifyHistoryChange = (change: RoostHistoryChange): void => {
    const logicalChange =
      change.kind === 'changed'
        ? { kind: 'changed' as const, ids: [...change.businessIds] }
        : change;
    for (const listener of listeners) {
      try {
        listener(logicalChange);
      } catch (error) {
        console.error(`Roost session history observer failed for ${viewId}`, error);
      }
    }
  };

  const projectBranchPage = (branch: ActiveBranchPageRead): SessionEntry[] => {
    if (!branch.complete) {
      throw new Error(`Roost active branch for ${viewId} is incomplete`);
    }
    const projected = projectRoostSegments(
      adaptRoostProjectedMessages(branch.messages)
    ) as SessionEntry[];
    const primaryIds = branch.messages
      .filter((message) => message.segmentId === 'primary')
      .map((message) => message.businessId);
    if (
      projected.length !== primaryIds.length ||
      new Set(primaryIds).size !== primaryIds.length ||
      !Number.isSafeInteger(branch.totalCount) ||
      !Number.isSafeInteger(branch.startPosition) ||
      branch.startPosition < 0 ||
      branch.startPosition + projected.length > branch.totalCount ||
      (projected.length === 0 && branch.totalCount !== 0) ||
      branch.hasMoreOlder !== branch.startPosition > 0 ||
      branch.hasMoreOlder !== (branch.cursor !== null) ||
      (branch.cursor && branch.cursor.position !== branch.startPosition - 1)
    ) {
      throw new Error(`Roost active branch page for ${viewId} has incomplete logical projection`);
    }
    return projected;
  };

  const directoryPageFromBranch = (branch: ActiveBranchPageRead): SessionHistoryDirectoryPage => {
    const projected = projectBranchPage(branch);
    return {
      startPosition: branch.startPosition,
      totalCount: branch.totalCount,
      rows: projected.map((entry, index) =>
        createRoostDirectoryRow(branch.startPosition + index, entry)
      ),
      hasMoreOlder: branch.hasMoreOlder,
      cursor: storeBranchCursor(branch.cursor),
    };
  };

  const installBranchWindow = (branch: ActiveBranchPageRead, notify = false): void => {
    const previous = rows;
    const previousStart = loadedStartPosition;
    activeBranch = branch;
    loadedStartPosition = branch.startPosition;
    totalHistoryCount = branch.totalCount;
    rows = adaptRoostProjectedMessages(branch.messages).map((row) => ({ ...row }));
    rebuildSegmentIndexes(branch.messages);
    rebuildLogicalProjection();
    readGeneration += 1;
    pageEntries.clear();
    pageIdsByPosition.clear();
    fullEntriesCache = undefined;
    if (notify && previous.length > 0) {
      const change = changeBetween(previous, rows);
      if (change) {
        const adjusted =
          change.kind === 'structure'
            ? {
                kind: 'structure' as const,
                from:
                  previousStart === loadedStartPosition
                    ? loadedStartPosition + change.from
                    : Math.min(previousStart, loadedStartPosition),
                to: loadedStartPosition + change.to,
              }
            : change;
        recordChange(adjusted);
        notifyHistoryChange(adjusted);
      }
    }
  };

  const reloadBranch = async (
    options: { readonly publish?: boolean } = {}
  ): Promise<RoostHistoryChange | undefined> => {
    readGeneration += 1;
    pageEntries.clear();
    pageIdsByPosition.clear();
    fullEntriesCache = undefined;
    const previous = rows;
    const previousStart = loadedStartPosition;
    const nextBranch = await roostHistory.readActiveBranchPage(viewId, {
      latest: true,
      limit: branchPageSize,
    });
    if (disposed) throw new Error('Roost session backend is disposed');
    projectBranchPage(nextBranch);
    const nextRows = adaptRoostProjectedMessages(nextBranch.messages);
    let change =
      previous.length === 0 && nextRows.length === 0
        ? undefined
        : changeBetween(previous, nextRows);
    installBranchWindow(nextBranch);
    if (change?.kind === 'structure') {
      const movedStart = previousStart !== loadedStartPosition;
      const from = movedStart
        ? Math.min(previousStart, loadedStartPosition)
        : loadedStartPosition + change.from;
      change = {
        kind: 'structure',
        from,
        to: loadedStartPosition + change.to,
      };
    }
    if (change) {
      if (options.publish) recordChange(change);
      notifyHistoryChange(change);
      pendingModelSummary = true;
      if (!options.publish) {
        void syncModelSummary?.().catch((error) => {
          console.error(`Roost model summary update failed for ${viewId}`, error);
        });
      }
    }
    return change;
  };

  const refreshProjectedMessage = async (
    turnId: Uint8Array,
    mutation?: Awaited<ReturnType<typeof roostHistory.acceptToView>>
  ): Promise<void> => {
    const generation = readGeneration;
    const branch = currentBranch();
    const known = branch.messages.find((row) =>
      Buffer.from(row.turnId).equals(Buffer.from(turnId))
    );
    const position = known ? positionById.get(known.businessId) : undefined;
    // This identity already belongs to the active window. Editing its unsealed
    // primary cannot change membership; hydrate just that physical message.
    if (!mutation && known?.segmentId === 'primary' && !known.sealed && position !== undefined) {
      const [fresh] = await roostHistory.readProjectedMessagesById([turnId]);
      if (disposed) throw new Error('Roost session backend is disposed');
      if (!fresh || identityKey(fresh) !== identityKey(known)) {
        throw new Error(`Roost changed message ${known.businessId} is unavailable`);
      }
      if (generation === readGeneration && activeBranch === branch && !fresh.sealed) {
        const segment = adaptRoostProjectedMessage(fresh);
        const [entry] = projectRoostSegments([segment]);
        if (!entry) throw new Error(`Roost changed message ${known.businessId} has no projection`);
        activeBranch = {
          ...branch,
          messages: branch.messages.map((row) => (row === known ? fresh : row)),
        };
        rows = rows.map((row) => (identityKey(row) === identityKey(fresh) ? segment : row));
        projectedByIdentity.set(identityKey(fresh), fresh);
        latestProjectedByBusinessId.set(fresh.businessId, fresh);
        entries[position] = clone(entry);
        directory[position] = createRoostDirectoryRow(loadedStartPosition + position, entry);
        const cached = pageEntries.get(fresh.businessId);
        if (cached) pageIdsByPosition.delete(cached.position);
        pageEntries.delete(fresh.businessId);
        fullEntriesCache = undefined;
        readGeneration += 1;
        updateLatestSummaryTargets();
        pendingModelSummary = true;
        recordChange({ kind: 'changed', businessIds: [fresh.businessId] });
        return;
      }
    }
    const businessId =
      mutation?.newHead.businessId ??
      [...projectedByIdentity.values()].find((row) =>
        Buffer.from(row.turnId).equals(Buffer.from(turnId))
      )?.businessId;
    // Re-read the bounded latest window after membership/seal changes. This keeps a
    // sealed successor for an older business id from being appended to the
    // current renderer window as if it were a new logical turn, and keeps the
    // owner window bounded when new turns are appended.
    const change = await reloadBranch({ publish: true });
    if (businessId && !positionById.has(businessId) && change?.kind !== 'structure') {
      const contentChange = { kind: 'changed' as const, businessIds: [businessId] };
      recordChange(contentChange);
      notifyHistoryChange(contentChange);
    }
  };

  await reloadBranch();

  const storedCursor = await sessionDoc.getRoostHistoryCursor();
  if (!Number.isSafeInteger(storedCursor?.historyRevision)) {
    const observedCursor = await roostHistory.observedEventCursor();
    await sessionDoc.setRoostHistoryCursor({
      cursor: storedCursor?.cursor ?? observedCursor.toString(),
      ...(storedCursor?.operationId ? { operationId: storedCursor.operationId } : {}),
      historyRevision: 0,
      historyCount: totalHistoryCount,
      historyChangeJson: 'null',
    });
  }
  let observedHistoryRevision = Number.isSafeInteger(storedCursor?.historyRevision)
    ? storedCursor!.historyRevision!
    : 0;

  // Ignore unrelated control writes and refresh only for another history owner.
  // Queue refreshes with writes so a pending branch read cannot install an old
  // window after a newer local mutation has published its projection.
  const unsubscribeControl = sessionDoc.subscribeRoostHistoryCursor(() => {
    if (disposed) return;
    const next = writeSerial.then(async () => {
      if (disposed) return;
      const cursor = await sessionDoc.getRoostHistoryCursor();
      if (
        disposed ||
        cursor?.historyRevision === undefined ||
        cursor.historyRevision <= observedHistoryRevision
      ) {
        return;
      }
      await reloadBranch();
      observedHistoryRevision = cursor.historyRevision;
      if (pendingModelSummary) {
        pendingModelSummary = false;
        await syncModelSummary?.();
      }
    });
    writeSerial = next.catch((error) => {
      console.error(`Roost session history refresh failed for ${viewId}`, error);
    });
  });

  const readyTurn = (turn: SessionEntry): SessionTurnRead => ({
    state: 'ready',
    turn: clone(turn) as SessionTurn,
  });
  const staleRead = () =>
    Object.assign(new Error(`Roost active branch for ${viewId} changed during a read`), {
      code: 'stale',
    });
  const readStable = async <T>(read: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      const generation = readGeneration;
      try {
        const result = await read();
        if (disposed) throw new Error('Roost session backend is disposed');
        if (generation !== readGeneration) throw staleRead();
        return result;
      } catch (error) {
        const stale =
          generation !== readGeneration ||
          (error instanceof Error && 'code' in error && error.code === 'stale');
        if (disposed || !stale || attempt >= 2) throw error;
      }
    }
  };
  const readCompleteEntries = (): Promise<SessionEntry[]> =>
    readStable(async () => {
      if (fullEntriesCache) return fullEntriesCache.map((entry) => clone(entry));
      const generation = readGeneration;
      const full = await readFullBranch();
      if (!full.complete) throw new Error(`Roost active branch for ${viewId} is incomplete`);
      const projected = projectRoostSegments(
        adaptRoostProjectedMessages(full.messages)
      ) as SessionEntry[];
      if (generation === readGeneration) fullEntriesCache = projected.map((entry) => clone(entry));
      return projected.map((entry) => clone(entry));
    });
  const readPage = async (input: Parameters<typeof roostHistory.readActiveBranchPage>[1]) => {
    const generation = readGeneration;
    const branch = await roostHistory.readActiveBranchPage(viewId, input);
    if (generation !== readGeneration || disposed) throw staleRead();
    const projected = projectBranchPage(branch);
    if (input?.latest && branch.startPosition + projected.length !== branch.totalCount) {
      throw new Error(`Roost latest page for ${viewId} does not reach the active head`);
    }
    if (branch.state.revision === currentBranch().state.revision) {
      for (const [index, turn] of projected.entries()) {
        const position = branch.startPosition + index;
        const prior = pageEntries.get(turn.id);
        if (prior) pageIdsByPosition.delete(prior.position);
        pageEntries.delete(turn.id);
        pageEntries.set(turn.id, { position, turn });
        pageIdsByPosition.set(position, turn.id);
      }
      while (pageEntries.size > pageBodyLimit) {
        const oldest = pageEntries.keys().next().value;
        if (oldest === undefined) break;
        const prior = pageEntries.get(oldest);
        if (prior) pageIdsByPosition.delete(prior.position);
        pageEntries.delete(oldest);
      }
    }
    return { branch, projected };
  };
  const cachedEntryAt = (position: number): SessionEntry | undefined => {
    if (position >= loadedStartPosition && position < loadedStartPosition + entries.length) {
      return entries[position - loadedStartPosition];
    }
    const id = pageIdsByPosition.get(position);
    return id ? pageEntries.get(id)?.turn : undefined;
  };
  const scanPages = async (
    visit: (page: Awaited<ReturnType<typeof readPage>>) => boolean
  ): Promise<void> => {
    let page = await readPage({ latest: true, limit: branchPageSize });
    const revision = page.branch.state.revision;
    const totalCount = page.branch.totalCount;
    while (!visit(page) && page.branch.cursor) {
      const newerStart = page.branch.startPosition;
      page = await readPage({ before: page.branch.cursor, limit: branchPageSize });
      if (page.branch.state.revision !== revision || page.branch.totalCount !== totalCount) {
        throw staleRead();
      }
      if (page.branch.startPosition + page.projected.length !== newerStart) {
        throw new Error(`Roost active branch pages for ${viewId} are not contiguous`);
      }
    }
  };
  const readRangeEntries = (from: number, to: number): Promise<SessionEntry[]> =>
    readStable(async () => {
      const start = Math.max(0, Math.min(from, totalHistoryCount));
      const end = Math.max(start, Math.min(to, totalHistoryCount));
      const cached: SessionEntry[] = [];
      for (let position = start; position < end; position += 1) {
        const entry = cachedEntryAt(position);
        if (!entry) break;
        cached.push(entry);
      }
      if (cached.length === end - start) return cached;
      const selected = new Map<number, SessionEntry>();
      await scanPages(({ branch, projected }) => {
        for (const [offset, entry] of projected.entries()) {
          const position = branch.startPosition + offset;
          if (position >= start && position < end) selected.set(position, entry);
        }
        return branch.startPosition <= start;
      });
      return [...selected].sort(([left], [right]) => left - right).map(([, entry]) => entry);
    });
  const readLatestDirectoryPage = (limit: number): Promise<SessionHistoryDirectoryPage> =>
    readStable(async () =>
      directoryPageFromBranch(
        limit === branchPageSize
          ? currentBranch()
          : (await readPage({ latest: true, limit })).branch
      )
    );
  const history: SessionHistoryReader = {
    count: () => totalHistoryCount,
    readAt: async (position) => {
      if (position < 0 || position >= totalHistoryCount) return { state: 'missing' };
      const [turn] = await readRangeEntries(position, position + 1);
      return turn ? readyTurn(turn) : { state: 'missing' };
    },
    readTurn: (turnId) =>
      readStable(async () => {
        const position = positionById.get(turnId);
        const turn = position === undefined ? pageEntries.get(turnId)?.turn : entries[position];
        if (turn) return readyTurn(turn);
        if (
          !(await roostHistory.lookup({
            kind: 'message',
            businessId: turnId,
            segmentId: 'primary',
          }))
        ) {
          return { state: 'missing' };
        }
        let found: SessionEntry | undefined;
        await scanPages(({ projected }) => {
          found = projected.find((entry) => entry.id === turnId);
          return found !== undefined;
        });
        return found ? readyTurn(found) : { state: 'missing' };
      }),
    readRange: async (from, to) => (await readRangeEntries(from, to)).map(readyTurn),
    readDirectory: async (from, to) => {
      const start = Math.max(0, Math.min(from, totalHistoryCount));
      return (await readRangeEntries(from, to)).map((entry, index) =>
        createRoostDirectoryRow(start + index, entry)
      );
    },
    readLatestDirectoryPage,
    readOlderDirectoryPage: (cursor, limit) =>
      readStable(async () => {
        const decoded = branchCursors.get(cursor);
        if (!decoded) throw new Error('Roost history page cursor is stale or unknown');
        return directoryPageFromBranch((await readPage({ before: decoded, limit })).branch);
      }),
    readAll: async () => (await readCompleteEntries()).map((entry) => clone(entry)),
    readTurnOutput: async (userTurnId) => {
      const complete = await readCompleteEntries();
      const completeDirectory = complete.map((entry, position) =>
        createRoostDirectoryRow(position, entry)
      );
      return selectTurnOutput(
        complete.length,
        userTurnId,
        (position) => completeDirectory[position]?.scalars,
        (position) => {
          const entry = complete[position];
          return entry ? clone(entry) : undefined;
        }
      );
    },
    observe(listener): SessionObservation {
      if (disposed) {
        return {
          initial: Promise.reject(new Error('Roost session backend is disposed')),
          unsubscribe: () => {},
        };
      }
      listeners.add(listener);
      const initialPage = readLatestDirectoryPage(branchPageSize);
      let active = true;
      return {
        initial: initialPage.then((page) => page.rows.map((row) => clone(row))),
        initialPage,
        unsubscribe: () => {
          if (!active) return;
          active = false;
          listeners.delete(listener);
        },
      };
    },
  };

  const { createRoostSessionData } = await import('@lody/shared/session-data');
  syncModelSummary = async () => {
    const read = latestModelTurnId
      ? await history.readTurn(latestModelTurnId)
      : { state: 'missing' as const };
    const turn = read.state === 'ready' ? [read.turn] : [];
    await sessionDoc.setLastModel(latestSessionModel(turn));
  };
  await syncModelSummary();

  const pendingSeen = new Map<string, Promise<void>>();

  const publishCursor = async (operationId: string): Promise<void> => {
    const cursor = await roostHistory.observedEventCursor();
    const change = pendingChange;
    const previous = await sessionDoc.getRoostHistoryCursor();
    const historyRevision = (previous?.historyRevision ?? 0) + 1;
    if (!Number.isSafeInteger(historyRevision)) {
      throw new Error(`Roost history revision overflow for ${viewId}`);
    }
    observedHistoryRevision = Math.max(observedHistoryRevision, historyRevision);
    await sessionDoc.setRoostHistoryCursor({
      cursor: cursor.toString(),
      operationId,
      historyRevision,
      historyCount: totalHistoryCount,
      historyChangeJson: JSON.stringify(
        change
          ? change.kind === 'changed'
            ? { kind: 'changed', ids: change.businessIds }
            : change
          : null
      ),
    });
    if (pendingChange === change) pendingChange = undefined;
    if (change) notifyHistoryChange(change);
    if (pendingModelSummary) {
      pendingModelSummary = false;
      await syncModelSummary?.();
    }
  };

  const withWrites = async (
    operationId: string,
    operation: () => Promise<boolean | void>
  ): Promise<void> => {
    const next = writeSerial.then(async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const changed = await operation();
          if (changed !== false) await publishCursor(operationId);
          return;
        } catch (error) {
          const stale = error instanceof Error && 'code' in error && error.code === 'stale';
          if (!stale || attempt >= 2) throw error;
          const cursor = await sessionDoc.getRoostHistoryCursor();
          if (Number.isSafeInteger(cursor?.historyRevision)) {
            observedHistoryRevision = Math.max(observedHistoryRevision, cursor!.historyRevision!);
          }
          await reloadBranch({ publish: true });
        }
      }
    });
    writeSerial = next.catch(() => {});
    await next;
  };

  const headRow = async (branch: ActiveBranchPageRead) => {
    const head = branch.state.head;
    if (!head) return undefined;
    const cached = projectedByIdentity.get(identityKey(head));
    if (cached) return cached;
    // A late successor may be the physical head of an older logical turn
    // outside the display window. It is still the next append's sealed parent.
    const read = await roostHistory.lookup(head);
    if (read?.kind !== 'found') throw new Error(`Roost active head for ${viewId} is incomplete`);
    return {
      ...head,
      turnId: read.turn.turnId,
      nextSeq: read.turn.nextSeq,
      sealed: read.turn.sealed !== null,
      sealedHash: read.turn.sealed,
    };
  };

  const ensureHeadSealed = async (): Promise<ActiveBranchPageRead> => {
    let branch = currentBranch();
    const row = await headRow(branch);
    if (row && !row.sealed) {
      await roostHistory.finish(row.turnId, row.nextSeq);
      await refreshProjectedMessage(row.turnId);
      branch = currentBranch();
    }
    return branch;
  };

  const parentForHead = async (
    branch: ActiveBranchPageRead
  ): Promise<{ id: Uint8Array; hash: Uint8Array }[]> => {
    const row = await headRow(branch);
    if (!row) return [];
    if (!row.sealedHash)
      throw new Error(`Roost active head ${row.businessId}/${row.segmentId} is not sealed`);
    return [{ id: row.turnId.slice(), hash: row.sealedHash.slice() }];
  };

  const latestSegmentFor = (businessId: string): HistoryProjectedMessage | undefined =>
    latestProjectedByBusinessId.get(businessId);

  const finishIfNeeded = async (turnId: Uint8Array): Promise<void> => {
    const result = await historyHost.readTurnHeader(turnId);
    const turn =
      result.kind === 'found'
        ? result.turn
        : result.kind === 'incomplete'
          ? result.prefix
          : undefined;
    if (turn && !turn.sealed) {
      await roostHistory.finish(turnId, turn.nextSeq);
      await refreshProjectedMessage(turnId);
    }
  };

  const updateTurn = async (
    before: SessionHistoryInput | undefined,
    after: SessionHistoryInput,
    operationId: string
  ): Promise<void> => {
    if (Object.prototype.hasOwnProperty.call(after, ROOST_CLEAR_FIELDS_KEY)) {
      throw new Error(`Roost history field ${ROOST_CLEAR_FIELDS_KEY} is reserved`);
    }
    let branch = currentBranch();
    let current = latestSegmentFor(after.id);
    if (
      !current &&
      (await roostHistory.lookup({
        kind: 'message',
        businessId: after.id,
        segmentId: 'primary',
      }))
    ) {
      // A bounded window may not contain an older turn being updated by a
      // replay/import path. Resolve it from the complete active branch before
      // deciding that this is a new primary message.
      const full = await readFullBranch();
      if (!full.complete) throw new Error(`Roost active branch for ${viewId} is incomplete`);
      const existing = full.messages.filter((message) => message.businessId === after.id).at(-1);
      if (existing) {
        current = existing;
        const segment = adaptRoostProjectedMessage(existing);
        const key = identityKey(segment);
        projectedByIdentity.set(key, existing);
        latestProjectedByBusinessId.set(after.id, existing);
      }
    }
    if (!current) {
      branch = await ensureHeadSealed();
      const accepted = await roostHistory.acceptToView({
        viewId,
        expectedRevision: branch.state.revision,
        expectedHead: branch.state.head,
        operationId,
        input: {
          kind: 'message',
          businessId: after.id,
          segmentId: 'primary',
          parents: await parentForHead(branch),
          content: fromApplicationJson(after),
        },
      });
      await refreshProjectedMessage(accepted.turnId, accepted);
      if (after.finished === true) await finishIfNeeded(accepted.turnId);
      return;
    }
    const prior = before ?? toEntry(current);
    if (equal(prior, after)) return;
    if (!current.sealed) {
      if (current.nextSeq === undefined)
        throw new Error(`Roost segment ${after.id}/${current.segmentId} has no sequence`);
      await roostHistory.append(current.turnId, current.nextSeq, [
        { kind: 'set', path: [], contentJson: applicationJsonText(after) },
      ]);
      await refreshProjectedMessage(current.turnId);
      if (after.finished === true) await roostHistory.finish(current.turnId, current.nextSeq + 1n);
      if (after.finished === true) await refreshProjectedMessage(current.turnId);
      return;
    }
    const delta = appendOnlyDelta(prior, after);
    if (Object.keys(delta).length === 0) return;
    branch = await ensureHeadSealed();
    const accepted = await roostHistory.acceptToView({
      viewId,
      expectedRevision: branch.state.revision,
      expectedHead: branch.state.head,
      operationId,
      input: {
        kind: 'message',
        businessId: after.id,
        segmentId: `late:${operationId}`,
        parents: await parentForHead(branch),
        content: fromApplicationJson(delta),
      },
    });
    await refreshProjectedMessage(accepted.turnId, accepted);
    if (after.finished === true) await finishIfNeeded(accepted.turnId);
  };

  const readAll = async (): Promise<SessionHistoryInput[]> =>
    (await history.readAll()) as SessionHistoryInput[];

  const replaceActiveHistory = async (
    next: readonly SessionHistoryInput[],
    operationId: string
  ): Promise<void> => {
    const current = await readAll();
    const same =
      current.length === next.length && current.every((entry, index) => equal(entry, next[index]));
    if (same) return;
    let branch = currentBranch();
    const prefix = next.every(
      (entry, index) => current[index]?.id === entry.id && equal(current[index], entry)
    );
    if (!prefix || next.length < current.length) {
      if (branch.state.head) {
        await roostHistory.restoreActiveBranch({
          viewId,
          expectedRevision: branch.state.revision,
          expectedHead: branch.state.head,
          restoreHead: null,
          operationId: `${operationId}:reset`,
        });
        await reloadBranch({ publish: true });
      }
    }
    const afterReset = await readAll();
    for (const entry of next.slice(afterReset.length)) {
      await updateTurn(undefined, entry, `${operationId}:${entry.id}`);
    }
  };

  const commands: SessionHistoryCommands = {
    async applyHistoryAction(action) {
      let matched = false;
      await withWrites(`action:${operationDigest(action)}`, async () => {
        const before = await readAll();
        const result = applyDomainHistoryAction(before as never, action);
        matched = result.matched;
        await replaceActiveHistory(
          result.turns as unknown as SessionHistoryInput[],
          `action:${operationDigest(action)}`
        );
      });
      return { matched };
    },
    async appendTurn(turn) {
      await withWrites(`append:${turn.id}`, () =>
        updateTurn(undefined, turn as SessionHistoryInput, `append:${turn.id}`)
      );
    },
    async replaceTurn(turnId, turn) {
      if (turn.id !== turnId) throw new Error(`Cannot change Roost turn id ${turnId}`);
      await withWrites(`replace:${turnId}`, async () => {
        const read = await history.readTurn(turnId);
        const before = read.state === 'ready' ? (read.turn as SessionHistoryInput) : undefined;
        if (!before) throw new Error(`Roost turn ${turnId} not found`);
        await updateTurn(before, turn as SessionHistoryInput, `replace:${turnId}`);
      });
    },
    async respondPermission(requestId, outcome, options) {
      let matched = false;
      await withWrites(`permission:${requestId}`, async () => {
        const targetId = options?.turnId ?? latestAssistantId;
        const read = targetId ? await history.readTurn(targetId) : { state: 'missing' as const };
        const target =
          read.state === 'ready' && read.turn.role === 'assistant'
            ? (read.turn as SessionHistoryInput)
            : undefined;
        if (!target) return;
        const items = Array.isArray(target.items) ? target.items : [];
        const found = items.some(
          (item) =>
            record(item) &&
            item.type === 'tool_call' &&
            record(item.permissionRequest) &&
            item.permissionRequest.requestId === requestId
        );
        if (!found) return;
        const nextItems = items.map((item) => {
          if (!record(item) || item.type !== 'tool_call' || !record(item.permissionRequest))
            return item;
          if (
            item.permissionRequest.requestId !== requestId ||
            item.permissionRequest.outcome !== undefined
          )
            return item;
          return { ...item, permissionRequest: { ...item.permissionRequest, outcome } };
        });
        const next = { ...target, items: nextItems } as SessionHistoryInput;
        matched = !equal(target, next);
        if (!matched) return;
        const branch = await ensureHeadSealed();
        await roostHistory.respondPermission({
          requestId,
          assistantBusinessId: target.id,
          outcome: fromApplicationJson(outcome),
          parents: await parentForHead(branch),
        });
        await updateTurn(target, next, `permission:${requestId}`);
      });
      return matched;
    },
    async replaceEditableTail(input): Promise<SessionEditableTailResult> {
      const operationId = `fork:${input.expectedUserTurnId}:${operationDigest(input.replacement)}`;
      let outcome: SessionEditableTailResult | undefined;
      let restoreHead: ActiveBranchPageRead['state']['head'] = null;
      await withWrites(operationId, async () => {
        let oldBranch = currentBranch();
        const before = await readAll();
        let plan: ReturnType<typeof planEditableTailReplacement>;
        try {
          plan = planEditableTailReplacement(before as never, input);
        } catch (error) {
          outcome =
            error instanceof Error && 'code' in error && typeof error.code === 'string'
              ? { status: 'rejected', reason: { code: error.code as never } }
              : { status: 'indeterminate', cause: error };
          return false;
        }
        const prefixIds = new Set(plan.turns.map((entry) => entry.id));
        const completeBranch = await readFullBranch();
        if (!completeBranch.complete)
          throw new Error(`Roost active branch for ${viewId} is incomplete`);
        const removed = completeBranch.messages.filter((row) => !prefixIds.has(row.businessId));
        const baseEntry = [...plan.turns]
          .reverse()
          .find(
            (entry) => entry.role === 'assistant' && entry.acpTurnId === input.expectedForkTurnId
          );
        let baseTurn: Uint8Array | null = null;
        let baseHash: Uint8Array | null = null;
        if (baseEntry) {
          const baseRow = completeBranch.messages
            .filter((row) => row.businessId === baseEntry.id)
            .at(-1);
          if (!baseRow) {
            outcome = { status: 'rejected', reason: { code: 'stale_boundary' } };
            return false;
          }
          if (!baseRow.sealed) {
            await roostHistory.finish(baseRow.turnId, baseRow.nextSeq);
            await refreshProjectedMessage(baseRow.turnId);
            oldBranch = currentBranch();
          }
          const sealedBase = await historyHost.readTurnHeader(baseRow.turnId);
          const sealedHash = sealedBase.kind === 'found' ? sealedBase.turn?.sealed : undefined;
          if (!sealedHash) {
            outcome = {
              status: 'indeterminate',
              cause: new Error('Roost fork base is not sealed'),
            };
            return false;
          }
          baseTurn = baseRow.turnId.slice();
          baseHash = sealedHash.slice();
        }
        restoreHead = oldBranch.state.head;
        if (Object.prototype.hasOwnProperty.call(input.replacement, ROOST_CLEAR_FIELDS_KEY)) {
          throw new Error(`Roost history field ${ROOST_CLEAR_FIELDS_KEY} is reserved`);
        }
        const result = await roostHistory.forkAndActivate({
          viewId,
          expectedRevision: oldBranch.state.revision,
          expectedHead: oldBranch.state.head,
          operationId,
          baseTurn,
          supersedes: removed.map((row) => ({
            kind: 'message' as const,
            businessId: row.businessId,
            segmentId: row.segmentId,
          })),
          input: {
            kind: 'message',
            businessId: input.replacement.id,
            segmentId: 'primary',
            parents: baseTurn && baseHash ? [{ id: baseTurn, hash: baseHash }] : [],
            content: fromApplicationJson(input.replacement),
          },
        });
        await reloadBranch({ publish: true });
        if (input.replacement.finished === true) await finishIfNeeded(result.turnId);
        let rolledBack = false;
        outcome = {
          status: 'accepted',
          ...(plan.previousUserTurnId ? { previousUserTurnId: plan.previousUserTurnId } : {}),
          rollback: async () => {
            if (rolledBack) return;
            rolledBack = true;
            await withWrites(`${operationId}:rollback`, async () => {
              const current = currentBranch();
              await roostHistory.restoreActiveBranch({
                viewId,
                expectedRevision: current.state.revision,
                expectedHead: current.state.head,
                restoreHead,
                operationId: `${operationId}:rollback`,
              });
              await reloadBranch({ publish: true });
            });
          },
        };
        return true;
      });
      if (!outcome)
        throw new Error(`Roost editable-tail operation ${operationId} produced no result`);
      return outcome;
    },
    async applyHistoryImport(input) {
      const external = 'externalHistory' in input ? input.externalHistory : undefined;
      const cursor = await sessionDoc.getExternalHistoryCursor();
      const current = await readAll();
      const hashVersion = external
        ? resolveImportHashVersion(external, cursor)
        : input.replay.hashVersion;
      const projectedHashes = current.map((entry) =>
        hashHistoryEntryForVersion(entry, hashVersion)
      );
      try {
        const plan = planHistoryImport(
          input,
          current,
          cursor,
          projectedHashes,
          current.some(isSessionHistoryPendingForDispatch)
        );
        await withWrites(`history-import:${input.replay.replayDigest}`, async () => {
          await replaceActiveHistory(
            plan.turns as readonly SessionHistoryInput[],
            `history-import:${input.replay.replayDigest}`
          );
          await sessionDoc.setExternalHistoryCursor(
            createImportCursor(input.replay.turnHashes, await readAll(), input.replay.hashVersion)
          );
        });
        return { status: 'accepted', appended: plan.appended };
      } catch (error) {
        if (error instanceof Error && 'code' in error && typeof error.code === 'string')
          return { status: 'rejected', reason: { code: error.code } };
        return { status: 'indeterminate', cause: error };
      }
    },
  };

  const snapshots: SessionSnapshotService = {
    async capture() {
      const capturedHistory = await readAll();
      const snapshot = Object.freeze({
        history: clone(capturedHistory),
      }) as unknown as SessionSnapshot;
      snapshotsSeen.add(snapshot);
      return snapshot;
    },
    async copyFrom(snapshot, selection) {
      if (!snapshotsSeen.has(snapshot)) throw new Error('Invalid Roost fork snapshot provenance');
      const source = snapshot.history as readonly SessionHistoryInput[];
      const sourceIds = new Set(source.map((entry) => entry.id));
      if (selection.some((entry) => !sourceIds.has(entry.id)))
        throw new Error('Fork selection is not from the captured snapshot');
      const operationId = `copy:${operationDigest(selection)}`;
      await withWrites(operationId, async () => {
        const current = await readAll();
        const currentIds = new Set(current.map((entry) => entry.id));
        for (const entry of selection) {
          if (currentIds.has(entry.id))
            throw new Error(`Fork target already contains turn ${entry.id}`);
          await updateTurn(undefined, entry as SessionHistoryInput, `${operationId}:${entry.id}`);
          currentIds.add(entry.id);
        }
      });
    },
  };
  const snapshotsSeen = new WeakSet<object>();

  const agentWrites: SessionAgentWrites = {
    async setTurnField(turnId, key, change) {
      await withWrites(`field:${turnId}:${String(key)}`, async () => {
        const read = await history.readTurn(turnId);
        const before = read.state === 'ready' ? (read.turn as SessionHistoryInput) : undefined;
        if (!before) throw new Error(`Roost turn ${turnId} not found`);
        const next = { ...before } as Record<string, unknown>;
        if (change.kind === 'clear') delete next[key];
        else next[key] = clone(change.value);
        await updateTurn(before, next as SessionHistoryInput, `field:${turnId}:${String(key)}`);
      });
    },
    markTurnSeen(turnId) {
      const promise = withWrites(`seen:${turnId}`, async () => {
        const read = await history.readTurn(turnId);
        const before = read.state === 'ready' ? (read.turn as SessionHistoryInput) : undefined;
        if (!before || markTurnSeenBlocked(before as never)) return;
        const next = { ...before } as Record<string, unknown>;
        applyMarkTurnSeen(next);
        await updateTurn(before, next as SessionHistoryInput, `seen:${turnId}`);
      });
      pendingSeen.set(turnId, promise);
      void promise.finally(() => pendingSeen.delete(turnId));
      return true;
    },
    async openAssistantTurn(input) {
      await withWrites(`open:${input.turnId}`, async () => {
        const read = await history.readTurn(input.turnId);
        const before = read.state === 'ready' ? (read.turn as SessionHistoryInput) : undefined;
        if (!before) {
          await updateTurn(
            undefined,
            createAssistantTurn(input) as SessionHistoryInput,
            `open:${input.turnId}`
          );
          return;
        }
        if (before.role !== 'assistant')
          throw new Error(`Roost turn ${input.turnId} is not assistant`);
        const next = { ...before } as Record<string, unknown>;
        applyOpenAssistantTurn(next, input);
        await updateTurn(before, next as SessionHistoryInput, `open:${input.turnId}`);
      });
    },
    async applyAgentBatch(input) {
      const notifications = input.notifications ?? [];
      const contents = input.contents ?? [];
      if (!notifications.length && !contents.length) return;
      const digest = operationDigest(input.operationIds ?? [...notifications, ...contents]);
      await withWrites(`agent:${digest}`, async () => {
        let before: SessionHistoryInput[];
        if (input.targetAssistantEntryId) {
          const read = await history.readTurn(input.targetAssistantEntryId);
          before =
            read.state === 'ready' && read.turn.role === 'assistant'
              ? [read.turn as SessionHistoryInput]
              : [];
        } else {
          before = await readAll();
        }
        // The shared ACP appliers may edit item arrays in place. Preserve the
        // before-image so changed output cannot compare equal and skip storage.
        let next = clone(before);
        if (notifications.length) {
          next = applyNotificationOnHistory(
            next,
            notifications as AcpSessionNotification[],
            input.model,
            {
              ...(input.createId ? { createId: input.createId } : {}),
              ...(input.now ? { now: input.now } : {}),
              ...(input.targetAssistantEntryId
                ? { targetAssistantEntryId: input.targetAssistantEntryId }
                : {}),
            }
          );
        }
        if (contents.length) {
          next = applyMessageContentsBatch(next, contents as MessageContent[], {
            ...(input.createId ? { createId: input.createId } : {}),
            ...(input.now ? { now: input.now } : {}),
            ...(input.targetAssistantEntryId
              ? { targetAssistantEntryId: input.targetAssistantEntryId }
              : {}),
            ...(input.model ? { model: input.model as ModelInfo } : {}),
          });
        }
        const oldById = new Map(before.map((entry) => [entry.id, entry]));
        for (const entry of next) {
          const old = oldById.get(entry.id);
          if (!old || !equal(old, entry))
            await updateTurn(old, entry, `agent:${digest}:${entry.id}`);
        }
      });
    },
  };

  const sessionData: RoostSessionData = createRoostSessionData({
    sessionId: sessionDoc.sessionId,
    history,
    commands,
    snapshots,
    dispose: () => undefined,
  });

  return {
    sessionData,
    agentWrites,
    setPlan: async (planEntries: readonly SessionPlanEntry[]) => {
      if (!latestAssistantId) return;
      await agentWrites.setTurnField(latestAssistantId, 'plan', {
        kind: 'set',
        value: planEntries,
      });
    },
    initialize: async () => undefined,
    flushLocalWrites: async () => {
      await writeSerial;
      await Promise.all([...pendingSeen.values()]);
    },
    // This owner is local SQLite today. The backend-level barrier combines
    // this local durability with the Loro control-plane sync barrier; it does
    // not claim that Roost history has reached a remote service.
    waitUntilSynced: async () => {
      await writeSerial;
      return true;
    },
    dispose: async () => {
      disposed = true;
      unsubscribeControl();
      await Promise.all([...pendingSeen.values()]);
      await writeSerial;
      branchCursors.clear();
      pageEntries.clear();
      pageIdsByPosition.clear();
      await lease.release();
    },
  } satisfies RoostSessionBackendServices;
};

let installed = false;

/** Install the local Node owner adapter once for the daemon process. */
export function installRoostNodeSessionBackend(options: RoostOwnerOptions = {}): void {
  if (installed) return;
  registerSessionBackendFactory(
    'roost',
    createRoostSessionBackendFactory((sessionDoc) => createNodeServices(sessionDoc, options))
  );
  installed = true;
}

export type { RoostOwnerOptions };
