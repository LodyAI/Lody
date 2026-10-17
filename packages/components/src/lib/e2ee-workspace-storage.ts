import type { WorkspaceAdmissionDescriptor, WorkspaceModeDescriptor } from '@lody/cloud-api';
import type { ObservedLedgerCheckpoint, VerifiedLedgerHistory } from './e2ee-ledger-history';

/** Unreadable local evidence. Only optional caches may be repaired by deleting them. */
export class E2eeLocalEvidenceCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2eeLocalEvidenceCorruptError';
  }
}

/** Valid local evidence that disagrees with another record or the server. This can
 * indicate a rollback, fork or downgrade, so it is never resolved automatically. */
export class E2eeLocalEvidenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2eeLocalEvidenceConflictError';
  }
}

const corrupt = (message: string) => new E2eeLocalEvidenceCorruptError(message);
const conflict = (message: string) => new E2eeLocalEvidenceConflictError(message);
function parseJson(raw: string, message: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw corrupt(message);
  }
}

/** Durable creation intent and public trust pins, deliberately outside the cache delete list. */
export interface PendingE2eeWorkspace {
  accountId: string;
  requestId: string;
  name: string;
  slug: string;
}

const pendingPrefix = (accountId: string) =>
  `lody-e2ee-pending-creation:${encodeURIComponent(accountId)}:`;
const pendingKey = (pending: PendingE2eeWorkspace) =>
  `${pendingPrefix(pending.accountId)}${encodeURIComponent(pending.requestId)}`;
const pinKey = (accountId: string, workspaceId: string) =>
  `lody-e2ee-genesis-pin:${encodeURIComponent(accountId)}:${encodeURIComponent(workspaceId)}`;

function parsePending(raw: string, accountId: string): PendingE2eeWorkspace {
  const value = parseJson(raw, 'Invalid pending encrypted workspace');
  if (
    !value ||
    typeof value !== 'object' ||
    !('accountId' in value) ||
    value.accountId !== accountId ||
    !('requestId' in value) ||
    typeof value.requestId !== 'string' ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !('slug' in value) ||
    typeof value.slug !== 'string'
  ) {
    throw corrupt('Invalid pending encrypted workspace');
  }
  return value as PendingE2eeWorkspace;
}

export function listPendingE2eeWorkspaces(
  storage: Storage,
  accountId: string
): PendingE2eeWorkspace[] {
  const prefix = pendingPrefix(accountId);
  const results = new Map<string, PendingE2eeWorkspace>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    const pending = parsePending(raw, accountId);
    const previous = results.get(pending.requestId);
    if (previous && (previous.name !== pending.name || previous.slug !== pending.slug))
      throw corrupt('Conflicting creation intent');
    results.set(pending.requestId, pending);
  }
  return [...results.values()].sort((a, b) => a.requestId.localeCompare(b.requestId));
}

export function readPendingE2eeWorkspace(
  storage: Storage,
  accountId: string
): PendingE2eeWorkspace | null {
  return listPendingE2eeWorkspaces(storage, accountId)[0] ?? null;
}

export function savePendingE2eeWorkspace(storage: Storage, pending: PendingE2eeWorkspace): void {
  const key = pendingKey(pending);
  const raw = storage.getItem(key);
  if (raw !== null) {
    const previous = parsePending(raw, pending.accountId);
    if (
      previous.requestId !== pending.requestId ||
      previous.name !== pending.name ||
      previous.slug !== pending.slug
    )
      throw conflict('Creation intent changed');
  }
  // Each request owns its own key. Concurrent windows cannot replace another
  // request, and reconciling one success never clears another unknown result.
  storage.setItem(key, JSON.stringify(pending));
}

export function clearPendingE2eeWorkspace(storage: Storage, pending: PendingE2eeWorkspace): void {
  const key = pendingKey(pending);
  const raw = storage.getItem(key);
  if (raw === null) return;
  const previous = parsePending(raw, pending.accountId);
  if (
    previous.requestId === pending.requestId &&
    previous.name === pending.name &&
    previous.slug === pending.slug
  )
    storage.removeItem(key);
}

export function readE2eeGenesisPin(
  storage: Storage,
  accountId: string,
  workspaceId: string
): string | null {
  const value = storage.getItem(pinKey(accountId, workspaceId));
  if (value !== null && !/^[0-9a-f]{64}$/.test(value)) throw corrupt('Invalid genesis pin');
  return value;
}

export function saveE2eeGenesisPin(
  storage: Storage,
  accountId: string,
  workspaceId: string,
  hash: string
): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid genesis pin');
  const previous = readE2eeGenesisPin(storage, accountId, workspaceId);
  if (previous !== null && previous !== hash) throw conflict('Genesis pin changed');
  storage.setItem(pinKey(accountId, workspaceId), hash);
}

const modeKey = (accountId: string, workspaceId: string) =>
  `lody-workspace-mode-proof:${encodeURIComponent(accountId)}:${encodeURIComponent(workspaceId)}`;
const knownEncryptedKey = (accountId: string, workspaceId: string) =>
  `lody-e2ee-known-mode:${encodeURIComponent(accountId)}:${encodeURIComponent(workspaceId)}`;

/** Only changes to this workspace's admission evidence can invalidate its runtime. */
export function isWorkspaceModeStorageKey(
  key: string | null,
  accountId: string,
  workspaceId: string
): boolean {
  return (
    key === null ||
    key === modeKey(accountId, workspaceId) ||
    key === pinKey(accountId, workspaceId) ||
    key === knownEncryptedKey(accountId, workspaceId)
  );
}

function assertEncryptedEvidence(
  storage: Storage,
  accountId: string,
  descriptor: WorkspaceAdmissionDescriptor
): void {
  // The learned-mode marker is independent from the creator's trust pin. It
  // prevents a concurrent plaintext write from erasing knowledge of encryption.
  for (const hash of [
    readE2eeGenesisPin(storage, accountId, descriptor.workspaceId),
    storage.getItem(knownEncryptedKey(accountId, descriptor.workspaceId)),
  ]) {
    if (hash !== null && !/^[0-9a-f]{64}$/.test(hash)) throw corrupt('Invalid encrypted evidence');
    if (
      hash !== null &&
      (!('contentMode' in descriptor) ||
        descriptor.contentMode !== 'e2ee' ||
        descriptor.genesisHash !== hash)
    )
      throw conflict('Workspace mode conflicts with encrypted evidence');
  }
}

function validateDescriptor(descriptor: WorkspaceAdmissionDescriptor): void {
  if (!descriptor || typeof descriptor.workspaceId !== 'string' || !descriptor.workspaceId)
    throw corrupt('Invalid workspace admission proof');
  if ('admission' in descriptor) {
    if (
      descriptor.admission !== 'legacy-unclassified' ||
      'contentMode' in descriptor ||
      'genesisHash' in descriptor ||
      'cryptoOrgId' in descriptor ||
      'contentModeVersion' in descriptor
    )
      throw corrupt('Invalid legacy workspace admission');
    return;
  }
  if (
    descriptor.contentModeVersion !== 1 ||
    (descriptor.contentMode !== 'plaintext' && descriptor.contentMode !== 'e2ee')
  )
    throw corrupt('Invalid workspace mode proof');
  if (
    descriptor.contentMode === 'e2ee' &&
    (!/^[0-9a-f]{64}$/.test(descriptor.genesisHash) ||
      descriptor.cryptoOrgId !== descriptor.genesisHash ||
      descriptor.activation !== 'control-only')
  )
    throw corrupt('Invalid encrypted workspace mode proof');
}

/** A previous authenticated response may reopen an immutable mode offline.
 * Unlike workspace-info caches, this evidence is scoped to account, ID and slug.
 */
export function readWorkspaceModeProof(
  storage: Storage,
  accountId: string,
  workspaceId: string,
  workspaceSlug: string
): WorkspaceAdmissionDescriptor | null {
  const raw = storage.getItem(modeKey(accountId, workspaceId));
  if (raw === null) return null;
  const saved = parseJson(raw, 'Invalid workspace mode proof') as {
    accountId?: unknown;
    workspaceSlug?: unknown;
    descriptor?: WorkspaceAdmissionDescriptor;
  } | null;
  const descriptor = saved?.descriptor;
  if (
    saved?.accountId !== accountId ||
    !descriptor ||
    descriptor.workspaceId !== workspaceId ||
    typeof saved.workspaceSlug !== 'string'
  )
    throw corrupt('Invalid workspace mode proof');
  validateDescriptor(descriptor);
  assertEncryptedEvidence(storage, accountId, descriptor);
  return saved.workspaceSlug === workspaceSlug ? descriptor : null;
}

/** Never accept a plaintext downgrade or a different genesis after learning E2EE.
 * Returns false only when a verified ordinary admission could not be cached.
 * Encrypted evidence must be durable; its writes and all validation failures throw.
 */
export function retainWorkspaceModeProof(
  storage: Storage,
  accountId: string,
  workspaceSlug: string,
  descriptor: WorkspaceAdmissionDescriptor
): boolean {
  validateDescriptor(descriptor);
  assertEncryptedEvidence(storage, accountId, descriptor);
  const raw = storage.getItem(modeKey(accountId, descriptor.workspaceId));
  if (raw !== null) {
    const saved = parseJson(raw, 'Invalid workspace mode proof') as { workspaceSlug: string };
    const previous = readWorkspaceModeProof(
      storage,
      accountId,
      descriptor.workspaceId,
      saved.workspaceSlug
    );
    if (
      previous &&
      'contentMode' in previous &&
      (!('contentMode' in descriptor) ||
        previous.contentMode !== descriptor.contentMode ||
        (previous.contentMode === 'e2ee' &&
          descriptor.contentMode === 'e2ee' &&
          previous.genesisHash !== descriptor.genesisHash))
    )
      throw conflict('Immutable workspace mode changed');
    if (
      previous &&
      'admission' in previous &&
      'contentMode' in descriptor &&
      descriptor.contentMode === 'e2ee'
    )
      throw conflict('Legacy workspace cannot become encrypted');
  }
  const encrypted = 'contentMode' in descriptor && descriptor.contentMode === 'e2ee';
  if (encrypted)
    storage.setItem(knownEncryptedKey(accountId, descriptor.workspaceId), descriptor.genesisHash);
  try {
    storage.setItem(
      modeKey(accountId, descriptor.workspaceId),
      JSON.stringify({ accountId, workspaceSlug, descriptor })
    );
  } catch (error) {
    if (encrypted) throw error;
    // Recheck sticky evidence even when the optional offline cache is full.
    assertEncryptedEvidence(storage, accountId, descriptor);
    return false;
  }
  readWorkspaceModeProof(storage, accountId, descriptor.workspaceId, workspaceSlug);
  return true;
}

/** History-only entry learns that a workspace is encrypted without assigning a slug. */
export function retainEncryptedWorkspaceMode(
  storage: Storage,
  accountId: string,
  descriptor: Extract<WorkspaceModeDescriptor, { contentMode: 'e2ee' }>
): void {
  const raw = storage.getItem(modeKey(accountId, descriptor.workspaceId));
  const slug =
    raw === null
      ? ''
      : (parseJson(raw, 'Invalid workspace mode proof') as { workspaceSlug: string }).workspaceSlug;
  retainWorkspaceModeProof(storage, accountId, slug, descriptor);
}

const observedPrefix = (accountId: string, workspaceId: string) =>
  `lody-e2ee-observed-ledger:${encodeURIComponent(accountId)}:${encodeURIComponent(workspaceId)}:`;

function observedCheckpoints(
  storage: Storage,
  accountId: string,
  workspaceId: string
): ObservedLedgerCheckpoint[] {
  const points = new Map<number, ObservedLedgerCheckpoint>();
  const prefix = observedPrefix(accountId, workspaceId);
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    const value = parseJson(raw, 'Invalid observed ledger checkpoint') as ObservedLedgerCheckpoint;
    if (
      !value ||
      !/^[0-9a-f]{64}$/.test(value.genesisHash) ||
      !/^[0-9a-f]{64}$/.test(value.headHash) ||
      !Number.isSafeInteger(value.length) ||
      value.length < 1
    )
      throw corrupt('Invalid observed ledger checkpoint');
    const previous = points.get(value.length);
    if (
      previous &&
      (previous.genesisHash !== value.genesisHash || previous.headHash !== value.headHash)
    )
      throw conflict('Conflicting observed ledger checkpoints');
    points.set(value.length, value);
  }
  const result = [...points.values()].sort((a, b) => a.length - b.length);
  if (result.some((point) => point.genesisHash !== result[0]!.genesisHash))
    throw conflict('Conflicting observed genesis');
  return result;
}

export function readObservedLedgerCheckpoint(
  storage: Storage,
  accountId: string,
  workspaceId: string
): ObservedLedgerCheckpoint | null {
  return observedCheckpoints(storage, accountId, workspaceId).at(-1) ?? null;
}

/** Retain only the locally verified prefix, never an unread server endpoint.
 * Returns false while a paged refresh has not reached the last observed record.
 */
export function retainObservedLedgerCheckpoint(
  storage: Storage,
  accountId: string,
  workspaceId: string,
  history: VerifiedLedgerHistory
): boolean {
  let pending = false;
  for (const previous of observedCheckpoints(storage, accountId, workspaceId)) {
    if (
      previous.genesisHash !== history.page.genesisHash ||
      history.page.checkpoint.length < previous.length
    )
      throw conflict('Ledger history rolled back');
    if (history.view.length < previous.length) {
      pending = true;
      continue;
    }
    if (history.records[previous.length - 1]?.hash !== previous.headHash)
      throw conflict('Ledger history changed');
  }
  if (pending) return false;
  const head = history.records[history.view.length - 1]?.hash;
  if (!head || history.page.workspaceId !== workspaceId)
    throw new Error('Invalid verified history');
  // Immutable per-checkpoint keys keep another window's newer observation even
  // if both windows read the previous maximum before either writes.
  storage.setItem(
    `${observedPrefix(accountId, workspaceId)}${history.view.length}:${head}`,
    JSON.stringify({
      genesisHash: history.page.genesisHash,
      headHash: head,
      length: history.view.length,
    } satisfies ObservedLedgerCheckpoint)
  );
  return true;
}

const keysWithPrefix = (storage: Storage, prefix: string): string[] => {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
};

/** Delete only unreadable optional caches for this account: mode proofs and observed
 * checkpoints. Pins, known-encrypted markers and creation intents are never touched;
 * a valid record that conflicts is evidence and stays. Returns the number removed. */
export function repairUnreadableE2eeCaches(storage: Storage, accountId: string): number {
  let removed = 0;
  const account = encodeURIComponent(accountId);
  for (const key of keysWithPrefix(storage, `lody-workspace-mode-proof:${account}:`)) {
    let workspaceId: string;
    try {
      workspaceId = decodeURIComponent(key.slice(key.lastIndexOf(':') + 1));
    } catch {
      continue; // Not a key this module wrote; leave it untouched.
    }
    const raw = storage.getItem(key);
    if (raw === null) continue;
    let slug: unknown;
    try {
      slug = (JSON.parse(raw) as { workspaceSlug?: unknown } | null)?.workspaceSlug;
    } catch {
      slug = undefined;
    }
    try {
      if (typeof slug !== 'string') throw corrupt('Invalid workspace mode proof');
      readWorkspaceModeProof(storage, accountId, workspaceId, slug);
    } catch (error) {
      if (!(error instanceof E2eeLocalEvidenceCorruptError)) continue;
      // Corrupt sticky evidence is not this cache; keep the proof as a downgrade guard.
      try {
        readE2eeGenesisPin(storage, accountId, workspaceId);
        const known = storage.getItem(knownEncryptedKey(accountId, workspaceId));
        if (known !== null && !/^[0-9a-f]{64}$/.test(known)) continue;
      } catch {
        continue;
      }
      storage.removeItem(key);
      removed += 1;
    }
  }
  for (const key of keysWithPrefix(storage, `lody-e2ee-observed-ledger:${account}:`)) {
    const raw = storage.getItem(key);
    if (raw === null) continue;
    let value: Partial<ObservedLedgerCheckpoint> | null = null;
    try {
      value = JSON.parse(raw) as Partial<ObservedLedgerCheckpoint> | null;
    } catch {
      value = null;
    }
    if (
      !value ||
      typeof value.genesisHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.genesisHash) ||
      typeof value.headHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.headHash) ||
      !Number.isSafeInteger(value.length) ||
      (value.length ?? 0) < 1
    ) {
      storage.removeItem(key);
      removed += 1;
    }
  }
  return removed;
}

/** User-confirmed recovery after support verifies the server ledger: forget the
 * history position this device last observed for one workspace. This also hides a
 * genuine rollback, so it is never automatic. Pins and mode markers stay. */
export function resetObservedLedgerProgress(
  storage: Storage,
  accountId: string,
  workspaceId: string
): number {
  const keys = keysWithPrefix(storage, observedPrefix(accountId, workspaceId));
  for (const key of keys) storage.removeItem(key);
  return keys.length;
}
