import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  AccountProfileIdSchema,
  normalizeSessionTurnInputConfig,
  type SessionHistoryInput,
  type SessionMeta,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { z } from 'zod';

export type SessionAccountScope = { workspaceId: string; machineId: string; sessionId: string };
export type SessionAccountBinding = Pick<
  SessionMeta,
  | 'accountProfileId'
  | 'acpSessionId'
  | 'accountContinuation'
  | 'accountTransitions'
  | 'accountHandoff'
>;
const bindingSchema = z
  .object({
    accountProfileId: AccountProfileIdSchema,
    acpSessionId: z.string().optional(),
    accountContinuation: z.object({ acpSessionId: z.string() }).nullable().optional(),
    accountHandoff: z
      .object({
        requestId: z.string(),
        sourceAccountProfileId: AccountProfileIdSchema,
        sourceAcpSessionId: z.string().optional(),
        targetAccountProfileId: AccountProfileIdSchema,
      })
      .nullable()
      .optional(),
    accountTransitions: z
      .array(
        z.object({
          requestId: z.string(),
          fromAccountProfileId: AccountProfileIdSchema,
          fromAcpSessionId: z.string().optional(),
          toAccountProfileId: AccountProfileIdSchema,
          toAcpSessionId: z.string(),
          continuation: z.boolean(),
          committedAt: z.number(),
        })
      )
      .optional(),
  })
  .strict();
export type SessionAccountEditMeta = Pick<
  SessionMeta,
  | 'acpSessionId'
  | 'status'
  | 'latestUserMsgId'
  | 'lastHandledUserMsgId'
  | 'processingUserMsgId'
  | 'lastCanceledTurn'
  | 'lastMissingHistoryUserMsgId'
  | 'lastMessageAt'
>;
export interface SessionAccountEditRecovery {
  readHistory(): Promise<SessionHistoryInput[]>;
  writeMeta(patch: SessionAccountEditMeta): Promise<void>;
  persist(): Promise<void>;
}
const editMetaSchema = z
  .object({
    acpSessionId: z.string().optional(),
    status: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('idle') }).strict(),
        z
          .object({
            type: z.literal('running'),
            activity: z.literal('image_generation').optional(),
          })
          .strict(),
        z.object({ type: z.literal('requestPermission') }).strict(),
        z
          .object({
            type: z.literal('initializing'),
            stage: z.enum(['git-clone', 'managed-runtime', 'acp', 'resuming']).optional(),
            detail: z.string().optional(),
          })
          .strict(),
      ])
      .optional(),
    latestUserMsgId: z.string().optional(),
    lastHandledUserMsgId: z.string().optional(),
    processingUserMsgId: z.string().optional(),
    lastCanceledTurn: z.string().optional(),
    lastMissingHistoryUserMsgId: z.string().optional(),
    lastMessageAt: z.number().finite().optional(),
  })
  .strict();
const pendingEditSchema = z
  .object({
    operationId: z.string().min(1),
    sourceBinding: bindingSchema,
    targetBinding: bindingSchema,
    sourceMeta: editMetaSchema,
    targetMeta: editMetaSchema,
    sourceHistoryHash: z.string().regex(/^[a-f0-9]{64}$/),
    targetHistoryHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const recordSchema = bindingSchema
  .extend({
    pendingEdit: pendingEditSchema.optional(),
    forkOperationId: z.string().min(1).optional(),
    forkPreparing: z.literal(true).optional(),
  })
  .strict();
type BindingRecord = z.infer<typeof recordSchema>;
const activeEdits = new Map<string, string>();
const locks = new Map<string, Promise<void>>();
async function withBindingLock<T>(
  scope: SessionAccountScope,
  action: () => Promise<T>
): Promise<T> {
  const key = bindingPath(scope);
  const previous = locks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release?.();
    if (locks.get(key) === tail) locks.delete(key);
  }
}
function editMeta(meta: SessionAccountEditMeta): SessionAccountEditMeta {
  // Explicit undefined fields clear target pointers when restoring the source.
  return {
    acpSessionId: meta.acpSessionId,
    status: meta.status,
    latestUserMsgId: meta.latestUserMsgId,
    lastHandledUserMsgId: meta.lastHandledUserMsgId,
    processingUserMsgId: meta.processingUserMsgId,
    lastCanceledTurn: meta.lastCanceledTurn,
    lastMissingHistoryUserMsgId: meta.lastMissingHistoryUserMsgId,
    lastMessageAt: meta.lastMessageAt,
  };
}
export function hashSessionAccountEditHistory(history: SessionHistoryInput[]): string {
  const normalized = history.map((entry) => {
    const { $cid: _cid, read: _read, ...content } = entry;
    return {
      ...content,
      // Opening a document may acknowledge a pending user row as seen.
      // Processing/handled states remain significant checkpoint content.
      status:
        entry.role === 'user' && (entry.status === 'pending' || entry.status === 'seen')
          ? undefined
          : entry.status,
      inputConfig: normalizeSessionTurnInputConfig(entry.inputConfig),
    };
  });
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== '$cid')
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonicalize(item)])
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(normalized)))
    .digest('hex');
}
function bindingPath(scope: SessionAccountScope): string {
  const key = createHash('sha256')
    .update(JSON.stringify([scope.workspaceId, scope.machineId, scope.sessionId]))
    .digest('hex');
  return path.join(getLodyDataDir(), 'session-account-bindings', `${key}.json`);
}
/** Local files are the authority. Synced session metadata is only a display mirror. */
async function readRecord(scope: SessionAccountScope): Promise<BindingRecord | null> {
  let content: string;
  try {
    content = await readFile(bindingPath(scope), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return recordSchema.parse(JSON.parse(content));
}
function requireCommitted(record: BindingRecord | null): SessionAccountBinding | null {
  if (record?.forkPreparing)
    throw new Error('Session fork preparation recovery is required before continuing.');
  if (record?.pendingEdit)
    throw new Error('Session account edit recovery is required before continuing.');
  return record ? (bindingSchema.strip().parse(record) as SessionAccountBinding) : null;
}
export async function getSessionAccountBinding(
  scope: SessionAccountScope
): Promise<SessionAccountBinding | null> {
  return await withBindingLock(scope, async () => requireCommitted(await readRecord(scope)));
}
async function writeRecord(
  scope: SessionAccountScope,
  binding: BindingRecord,
  finishingEdit = false
): Promise<void> {
  const content = recordSchema.parse(binding);
  const destination = bindingPath(scope);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(content)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    published = true;
    if (process.platform !== 'win32') {
      try {
        const directory = await open(path.dirname(destination), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        // Finalization follows durable history. If the directory sync fails,
        // restart sees either this binding or the previous recoverable journal.
        // Reporting a failed commit here would wrongly roll history back after
        // the replacement was already published. Staging still fails closed.
        if (!finishingEdit) throw error;
      }
    }
  } finally {
    // Rename consumed the temporary path; cleanup must not reverse its outcome.
    if (!published) await rm(temporary, { force: true });
  }
}
export async function setSessionAccountBinding(
  scope: SessionAccountScope,
  binding: SessionAccountBinding
): Promise<void> {
  await withBindingLock(scope, async () => {
    requireCommitted(await readRecord(scope));
    await writeRecord(scope, bindingSchema.parse(binding));
  });
}

/** The caller first persists an installation-local fork marker under the target lock. */
export async function createSessionAccountForkBinding(
  scope: SessionAccountScope,
  operationId: string,
  accountProfileId: string
): Promise<void> {
  await withBindingLock(scope, async () => {
    if (await readRecord(scope)) throw new Error('Target local account binding already exists.');
    await writeRecord(scope, {
      accountProfileId: AccountProfileIdSchema.parse(accountProfileId),
      forkOperationId: operationId,
      forkPreparing: true,
    });
  });
}

function requireForkOwner(
  record: BindingRecord | null,
  operationId: string,
  accountProfileId: string
): boolean {
  if (!record) return false;
  if (
    record.forkOperationId !== operationId ||
    record.accountProfileId !== accountProfileId ||
    (record.pendingEdit && record.pendingEdit.operationId !== operationId)
  )
    throw new Error('The fork marker does not own this session account binding.');
  return true;
}

export async function assertSessionAccountForkBindingOwned(
  scope: SessionAccountScope,
  operationId: string,
  accountProfileId: string
): Promise<boolean> {
  return await withBindingLock(scope, async () =>
    requireForkOwner(await readRecord(scope), operationId, accountProfileId)
  );
}

export async function getSessionAccountForkBindingState(
  scope: SessionAccountScope,
  operationId: string,
  accountProfileId: string
): Promise<'missing' | 'preparing' | 'pending' | 'committed'> {
  return await withBindingLock(scope, async () => {
    const record = await readRecord(scope);
    if (!requireForkOwner(record, operationId, accountProfileId) || !record) return 'missing';
    if (record.pendingEdit) return 'pending';
    if (record.forkPreparing) return 'preparing';
    if (!requireCommitted(record)?.acpSessionId)
      throw new Error('Completed fork native identity is unavailable.');
    return 'committed';
  });
}

/** Only after the marker-owned target deletion has been persisted under its fork lock. */
export async function clearSessionAccountBindingForOperation(
  scope: SessionAccountScope,
  operationId: string,
  accountProfileId: string
): Promise<void> {
  await withBindingLock(scope, async () => {
    if (!requireForkOwner(await readRecord(scope), operationId, accountProfileId)) return;
    const active = activeEdits.get(bindingPath(scope));
    if (active && active !== operationId) throw new Error('A different account edit is active.');
    await rm(bindingPath(scope), { force: true });
    activeEdits.delete(bindingPath(scope));
  });
}
function resolveCommittedMeta(
  meta: SessionMeta,
  binding: SessionAccountBinding | null
): SessionMeta {
  if (binding)
    return {
      ...meta,
      accountProfileId: binding.accountProfileId,
      acpSessionId: binding.acpSessionId,
      accountContinuation: binding.accountContinuation,
      accountTransitions: binding.accountTransitions,
      accountHandoff: binding.accountHandoff,
    };
  if (meta.accountProfileId && meta.accountProfileId !== 'system-default')
    throw new Error(
      'The local account binding is unavailable. Restore its local account binding before continuing this session.'
    );
  return {
    ...meta,
    accountProfileId: 'system-default',
    acpSessionId: meta.acpSessionId,
    accountContinuation: null,
    accountTransitions: [],
    accountHandoff: null,
  };
}
export async function beginSessionAccountEdit(
  scope: SessionAccountScope,
  edit: {
    operationId: string;
    sourceMeta: SessionMeta;
    targetMeta: SessionAccountEditMeta;
    sourceHistory: SessionHistoryInput[];
    targetHistory: SessionHistoryInput[];
  }
): Promise<void> {
  await withBindingLock(scope, async () => {
    const record = await readRecord(scope);
    const binding =
      record?.forkPreparing && record.forkOperationId === edit.operationId
        ? (bindingSchema.strip().parse(record) as SessionAccountBinding)
        : requireCommitted(record);
    const source = resolveCommittedMeta(edit.sourceMeta, binding);
    if (
      source.accountProfileId !== (edit.sourceMeta.accountProfileId ?? 'system-default') ||
      source.acpSessionId !== edit.sourceMeta.acpSessionId
    )
      throw new Error('Session account binding changed before the edit was staged.');
    const sourceBinding = bindingSchema.parse({
      accountProfileId: source.accountProfileId,
      acpSessionId: source.acpSessionId,
      accountContinuation: source.accountContinuation,
      accountTransitions: source.accountTransitions,
      accountHandoff: source.accountHandoff,
    });
    const targetBinding = {
      ...sourceBinding,
      acpSessionId: edit.targetMeta.acpSessionId,
      accountContinuation:
        sourceBinding.accountContinuation && edit.targetMeta.acpSessionId
          ? { acpSessionId: edit.targetMeta.acpSessionId }
          : sourceBinding.accountContinuation,
    };
    const sourceHistoryHash = hashSessionAccountEditHistory(edit.sourceHistory);
    const targetHistoryHash = hashSessionAccountEditHistory(edit.targetHistory);
    if (sourceHistoryHash === targetHistoryHash)
      throw new Error('Session account edit requires distinct history checkpoints.');
    await writeRecord(scope, {
      ...sourceBinding,
      ...(record?.forkOperationId === edit.operationId
        ? { forkOperationId: record.forkOperationId }
        : {}),
      pendingEdit: {
        operationId: edit.operationId,
        sourceBinding,
        targetBinding,
        sourceMeta: editMeta(source) as z.infer<typeof editMetaSchema>,
        targetMeta: editMeta(edit.targetMeta) as z.infer<typeof editMetaSchema>,
        sourceHistoryHash,
        targetHistoryHash,
      },
    });
    activeEdits.set(bindingPath(scope), edit.operationId);
  });
}
async function finishSessionAccountEdit(
  scope: SessionAccountScope,
  operationId: string,
  target: boolean
): Promise<void> {
  await withBindingLock(scope, async () => {
    const record = await readRecord(scope);
    const pending = record?.pendingEdit;
    if (
      !pending ||
      pending.operationId !== operationId ||
      activeEdits.get(bindingPath(scope)) !== operationId
    )
      throw new Error('Session account edit operation is no longer active.');
    await writeRecord(
      scope,
      {
        ...(target ? pending.targetBinding : pending.sourceBinding),
        ...(record?.forkOperationId ? { forkOperationId: record.forkOperationId } : {}),
        ...(!target && record?.forkOperationId === pending.operationId
          ? { forkPreparing: true as const }
          : {}),
      },
      true
    );
    activeEdits.delete(bindingPath(scope));
  });
}
export async function commitSessionAccountEdit(
  scope: SessionAccountScope,
  operationId: string
): Promise<void> {
  await finishSessionAccountEdit(scope, operationId, true);
}
export async function rollbackSessionAccountEdit(
  scope: SessionAccountScope,
  operationId: string
): Promise<void> {
  await finishSessionAccountEdit(scope, operationId, false);
}
export function abandonSessionAccountEdit(scope: SessionAccountScope, operationId: string): void {
  if (activeEdits.get(bindingPath(scope)) === operationId) activeEdits.delete(bindingPath(scope));
}
/** Legacy default sessions retain their native history. Untrusted managed mirrors cannot select credentials. */
export async function resolveSessionAccountMeta(
  scope: SessionAccountScope,
  meta: SessionMeta,
  recovery?: SessionAccountEditRecovery
): Promise<SessionMeta> {
  return await withBindingLock(scope, async () => {
    const record = await readRecord(scope);
    const pending = record?.pendingEdit;
    if (!pending) return resolveCommittedMeta(meta, requireCommitted(record));
    if (!recovery || activeEdits.has(bindingPath(scope)))
      throw new Error('Session account edit recovery is required before continuing.');
    const hash = hashSessionAccountEditHistory(await recovery.readHistory());
    const target = hash === pending.targetHistoryHash;
    if (!target && record.forkOperationId === pending.operationId)
      throw new Error('Session fork preparation recovery is required before continuing.');
    if (!target && hash !== pending.sourceHistoryHash)
      throw new Error('Session account edit recovery cannot match the durable history checkpoint.');
    const patch = editMeta(
      (target ? pending.targetMeta : pending.sourceMeta) as SessionAccountEditMeta
    );
    const binding = target ? pending.targetBinding : pending.sourceBinding;
    await recovery.writeMeta(patch);
    await recovery.persist();
    if (hashSessionAccountEditHistory(await recovery.readHistory()) !== hash)
      throw new Error('Session history changed during account edit recovery.');
    await writeRecord(
      scope,
      {
        ...binding,
        ...(record.forkOperationId ? { forkOperationId: record.forkOperationId } : {}),
      },
      true
    );
    return resolveCommittedMeta({ ...meta, ...patch }, binding as SessionAccountBinding);
  });
}

export async function clearSessionAccountBinding(scope: SessionAccountScope): Promise<void> {
  await withBindingLock(scope, async () => {
    requireCommitted(await readRecord(scope));
    await rm(bindingPath(scope), { force: true });
  });
}
export async function updateSessionAccountNativeId(
  scope: SessionAccountScope,
  acpSessionId: SessionMeta['acpSessionId']
): Promise<void> {
  await withBindingLock(scope, async () => {
    const binding = requireCommitted(await readRecord(scope));
    if (binding)
      await writeRecord(
        scope,
        bindingSchema.parse({
          ...binding,
          acpSessionId,
          accountContinuation:
            binding.accountContinuation && acpSessionId
              ? { acpSessionId }
              : binding.accountContinuation,
        })
      );
  });
}
