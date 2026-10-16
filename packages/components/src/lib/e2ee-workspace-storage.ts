import type { WorkspaceAdmissionDescriptor, WorkspaceModeDescriptor } from '@lody/cloud-api';
import type { ObservedLedgerCheckpoint, VerifiedLedgerHistory } from './e2ee-ledger-history';

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
  const value: unknown = JSON.parse(raw);
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
    throw new Error('Invalid pending encrypted workspace');
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
      throw new Error('Conflicting creation intent');
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
      throw new Error('Creation intent changed');
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
  if (value !== null && !/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid genesis pin');
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
  if (previous !== null && previous !== hash) throw new Error('Genesis pin changed');
  storage.setItem(pinKey(accountId, workspaceId), hash);
}

const modeKey = (accountId: string, workspaceId: string) =>
  `lody-workspace-mode-proof:${encodeURIComponent(accountId)}:${encodeURIComponent(workspaceId)}`;
const knownEncryptedKey = (accountId: string, workspaceId: string) =>
  `lody-e2ee-known-mode:${encodeURIComponent(accountId)}:${encodeURIComponent(workspaceId)}`;

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
    if (
      hash !== null &&
      (!/^[0-9a-f]{64}$/.test(hash) ||
        !('contentMode' in descriptor) ||
        descriptor.contentMode !== 'e2ee' ||
        descriptor.genesisHash !== hash)
    )
      throw new Error('Workspace mode conflicts with encrypted evidence');
  }
}

function validateDescriptor(descriptor: WorkspaceAdmissionDescriptor): void {
  if (!descriptor || typeof descriptor.workspaceId !== 'string' || !descriptor.workspaceId)
    throw new Error('Invalid workspace admission proof');
  if ('admission' in descriptor) {
    if (
      descriptor.admission !== 'legacy-unclassified' ||
      'contentMode' in descriptor ||
      'genesisHash' in descriptor ||
      'cryptoOrgId' in descriptor ||
      'contentModeVersion' in descriptor
    )
      throw new Error('Invalid legacy workspace admission');
    return;
  }
  if (
    descriptor.contentModeVersion !== 1 ||
    (descriptor.contentMode !== 'plaintext' && descriptor.contentMode !== 'e2ee')
  )
    throw new Error('Invalid workspace mode proof');
  if (
    descriptor.contentMode === 'e2ee' &&
    (!/^[0-9a-f]{64}$/.test(descriptor.genesisHash) ||
      descriptor.cryptoOrgId !== descriptor.genesisHash ||
      descriptor.activation !== 'control-only')
  )
    throw new Error('Invalid encrypted workspace mode proof');
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
  const saved = JSON.parse(raw) as {
    accountId?: unknown;
    workspaceSlug?: unknown;
    descriptor?: WorkspaceAdmissionDescriptor;
  };
  const descriptor = saved?.descriptor;
  if (
    saved?.accountId !== accountId ||
    !descriptor ||
    descriptor.workspaceId !== workspaceId ||
    typeof saved.workspaceSlug !== 'string'
  )
    throw new Error('Invalid workspace mode proof');
  validateDescriptor(descriptor);
  assertEncryptedEvidence(storage, accountId, descriptor);
  return saved.workspaceSlug === workspaceSlug ? descriptor : null;
}

/** Never accept a plaintext downgrade or a different genesis after learning E2EE. */
export function retainWorkspaceModeProof(
  storage: Storage,
  accountId: string,
  workspaceSlug: string,
  descriptor: WorkspaceAdmissionDescriptor
): void {
  validateDescriptor(descriptor);
  assertEncryptedEvidence(storage, accountId, descriptor);
  const raw = storage.getItem(modeKey(accountId, descriptor.workspaceId));
  if (raw !== null) {
    const saved = JSON.parse(raw) as { workspaceSlug: string };
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
      throw new Error('Immutable workspace mode changed');
    if (
      previous &&
      'admission' in previous &&
      'contentMode' in descriptor &&
      descriptor.contentMode === 'e2ee'
    )
      throw new Error('Legacy workspace cannot become encrypted');
  }
  if ('contentMode' in descriptor && descriptor.contentMode === 'e2ee')
    storage.setItem(knownEncryptedKey(accountId, descriptor.workspaceId), descriptor.genesisHash);
  storage.setItem(
    modeKey(accountId, descriptor.workspaceId),
    JSON.stringify({ accountId, workspaceSlug, descriptor })
  );
  readWorkspaceModeProof(storage, accountId, descriptor.workspaceId, workspaceSlug);
}

/** History-only entry learns that a workspace is encrypted without assigning a slug. */
export function retainEncryptedWorkspaceMode(
  storage: Storage,
  accountId: string,
  descriptor: Extract<WorkspaceModeDescriptor, { contentMode: 'e2ee' }>
): void {
  const raw = storage.getItem(modeKey(accountId, descriptor.workspaceId));
  const slug = raw === null ? '' : (JSON.parse(raw) as { workspaceSlug: string }).workspaceSlug;
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
    const value = JSON.parse(raw) as ObservedLedgerCheckpoint;
    if (
      !value ||
      !/^[0-9a-f]{64}$/.test(value.genesisHash) ||
      !/^[0-9a-f]{64}$/.test(value.headHash) ||
      !Number.isSafeInteger(value.length) ||
      value.length < 1
    )
      throw new Error('Invalid observed ledger checkpoint');
    const previous = points.get(value.length);
    if (
      previous &&
      (previous.genesisHash !== value.genesisHash || previous.headHash !== value.headHash)
    )
      throw new Error('Conflicting observed ledger checkpoints');
    points.set(value.length, value);
  }
  const result = [...points.values()].sort((a, b) => a.length - b.length);
  if (result.some((point) => point.genesisHash !== result[0]!.genesisHash))
    throw new Error('Conflicting observed genesis');
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
      throw new Error('Ledger history rolled back');
    if (history.view.length < previous.length) {
      pending = true;
      continue;
    }
    if (history.records[previous.length - 1]?.hash !== previous.headHash)
      throw new Error('Ledger history changed');
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
