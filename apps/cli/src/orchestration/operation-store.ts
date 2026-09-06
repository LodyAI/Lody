import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

import {
  LODY_OPERATION_COMMAND_MAX_BYTES,
  LODY_OPERATION_COMPLETION_MAX_BYTES,
  LodyErrorSchema,
  LodyOperationIdSchema,
  type FrozenOperationContinuationConfig,
  type LodyError,
  type LodyOperationCompletion,
  type LodyOperationItemResult,
  type LodyOperationKind,
  type LodyOperationSnapshot,
  type MachineId,
  type SessionId,
  type StoredLodyDelivery,
  type StoredLodyOperation,
  type WorkspaceId,
} from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

const DAY_MS = 24 * 60 * 60 * 1_000;
const TERMINAL_RETENTION_MS = 7 * DAY_MS;
export const MATERIALIZATION_CLAIM_MS = 60_000;

const OperationKindSchema = z.enum([
  'session_create',
  'session_create_many',
  'session_chat',
  'session_chat_many',
]);

const OperationTargetSchema = z.object({ sessionId: z.string(), userTurnId: z.string() }).strict();
const OperationOutputPreviewSchema = z
  .object({
    text: z.string(),
    truncated: z.literal(true).optional(),
    omittedBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

const OperationItemSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('active'),
      label: z.string().optional(),
      target: OperationTargetSchema,
      inputDurable: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal('succeeded'),
      label: z.string().optional(),
      target: OperationTargetSchema,
      assistantTurnId: z.string(),
      output: OperationOutputPreviewSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      label: z.string().optional(),
      target: OperationTargetSchema.optional(),
      error: LodyErrorSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('cancelled'),
      label: z.string().optional(),
      target: OperationTargetSchema.optional(),
    })
    .strict(),
]);

const OperationResultSchema = z.object({ items: z.array(OperationItemSchema) }).strict();
const CompletionTruncationSchema = z
  .object({ truncated: z.literal(true), omittedBytes: z.number().int().nonnegative() })
  .strict();
const OperationCompletionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('result'),
      value: OperationResultSchema,
      truncation: CompletionTruncationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('error'),
      error: LodyErrorSchema,
      truncation: CompletionTruncationSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('cancelled'),
      partial: OperationResultSchema.optional(),
      truncation: CompletionTruncationSchema.optional(),
    })
    .strict(),
]);

const FrozenConfigSchema = z
  .object({
    agentConfigId: z.string().optional(),
    inputConfig: z.record(z.string(), z.unknown()),
    sourceTurnId: z.string().trim().min(1).optional(),
    targetDispatchConfigs: z
      .array(
        z
          .object({
            modeId: z.string().optional(),
            modelId: z.string().optional(),
            configOptionValues: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
            taskToolsEnabled: z.boolean().optional(),
            inheritSessionDefaults: z.literal(false).optional(),
          })
          .strict()
          .nullable()
      )
      .optional(),
  })
  .strict();

const OperationRowSchema = z
  .object({
    workspace_id: z.string(),
    owner_machine_id: z.string(),
    requester_session_id: z.string(),
    requester_user_id: z.string(),
    operation_id: LodyOperationIdSchema,
    kind: OperationKindSchema,
    fingerprint: z.string(),
    canonical_command_json: z.string(),
    frozen_config_json: z.string(),
    initiator_chain_depth: z.number().int().nonnegative(),
    created_at: z.string(),
    deadline_at: z.string(),
    state: z.enum(['active', 'finished']),
    items_json: z.string(),
    completion_json: z.string().nullable(),
    finished_at: z.string().nullable(),
  })
  .strict();

const DeliveryRowSchema = z
  .object({
    sequence: z.number().int().positive(),
    workspace_id: z.string(),
    requester_session_id: z.string(),
    operation_id: LodyOperationIdSchema,
    delivery_id: z.string(),
    system_turn_id: z.string(),
    state: z.enum(['pending', 'consumed']),
    initiator_chain_depth: z.number().int().nonnegative(),
    completion_json: z.string(),
    consumed_at: z.string().nullable(),
  })
  .strict();

export class LodyOperationStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'LodyOperationStoreError';
  }

  toLodyError(): LodyError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/** SQLITE_BUSY-family write-lock contention; inherently retryable. */
export const isOperationStoreBusyError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT';
};

const BUSY_RETRY_DELAYS_MS = [100, 300, 900];

/**
 * Run a synchronous store interaction, retrying SQLITE_BUSY contention with a
 * short backoff. Store operations are idempotent by design, and a busy
 * transaction commits nothing, so a wholesale retry is safe. Exhausted retries
 * surface as a retryable STORE_BUSY error instead of a raw driver error.
 * Only use this from subprocess boundaries (MCP tools); daemon paths must not
 * add blocking waits on top of the driver's busy_timeout.
 */
export const runWithOperationStoreBusyRetry = async <T>(
  run: () => T,
  options: { delaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {}
): Promise<T> => {
  const delays = options.delaysMs ?? BUSY_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return run();
    } catch (error) {
      if (!isOperationStoreBusyError(error)) throw error;
      const delayMs = delays[attempt];
      if (delayMs === undefined) {
        throw new LodyOperationStoreError(
          'STORE_BUSY',
          'The local Operation store is busy; retry the command.',
          true
        );
      }
      await sleep(delayMs);
    }
  }
};

const parseJson = <T>(text: string, schema: z.ZodType<T>, label: string): T => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${label} JSON`, { cause: error });
  }
  return schema.parse(parsed);
};

const normalizeCanonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeCanonicalValue);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, normalizeCanonicalValue(record[key])])
    );
  }
  return value;
};

const truncateUtf8 = (value: string, maxBytes: number) => {
  const originalBytes = Buffer.byteLength(value, 'utf8');
  if (originalBytes <= maxBytes) return { value, omittedBytes: 0 };
  const marker = maxBytes >= 5 ? '\n…\n' : '';
  const chars = Array.from(value);
  const render = (keptCharacters: number) => {
    const headCount = Math.ceil(keptCharacters / 2);
    const tailCount = keptCharacters - headCount;
    return `${chars.slice(0, headCount).join('')}${marker}${chars
      .slice(chars.length - tailCount)
      .join('')}`;
  };
  let low = 0;
  let high = chars.length;
  let keptCharacters = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(render(middle), 'utf8') <= maxBytes) {
      keptCharacters = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const headCount = Math.ceil(keptCharacters / 2);
  const tailCount = keptCharacters - headCount;
  const kept = `${chars.slice(0, headCount).join('')}${chars.slice(chars.length - tailCount).join('')}`;
  return {
    value: render(keptCharacters),
    omittedBytes: originalBytes - Buffer.byteLength(kept, 'utf8'),
  };
};

const boundCompletionFreeText = (
  completion: LodyOperationCompletion,
  maxBytesPerText: number
): LodyOperationCompletion => {
  let omittedBytes = 0;
  const boundError = (error: LodyError): LodyError => {
    const bounded = truncateUtf8(error.message, maxBytesPerText);
    omittedBytes += bounded.omittedBytes;
    return { ...error, message: bounded.value };
  };
  const boundResult = (result: { items: LodyOperationItemResult[] }) => ({
    items: result.items.map((item): LodyOperationItemResult => {
      const boundedLabel = item.label ? truncateUtf8(item.label, maxBytesPerText) : undefined;
      if (boundedLabel) omittedBytes += boundedLabel.omittedBytes;
      const label = boundedLabel?.value;
      if (item.status === 'failed') {
        return {
          ...item,
          ...(label !== undefined ? { label } : {}),
          error: boundError(item.error),
        };
      }
      if (item.status === 'succeeded' && item.output) {
        const boundedOutput = truncateUtf8(item.output.text, maxBytesPerText);
        omittedBytes += boundedOutput.omittedBytes;
        const outputOmittedBytes = (item.output.omittedBytes ?? 0) + boundedOutput.omittedBytes;
        return {
          ...item,
          ...(label !== undefined ? { label } : {}),
          output: {
            text: boundedOutput.value,
            ...(outputOmittedBytes > 0
              ? { truncated: true as const, omittedBytes: outputOmittedBytes }
              : {}),
          },
        };
      }
      return { ...item, ...(label !== undefined ? { label } : {}) };
    }),
  });
  let bounded: LodyOperationCompletion;
  if (completion.type === 'result') {
    bounded = { type: 'result', value: boundResult(completion.value) };
  } else if (completion.type === 'error') {
    bounded = { type: 'error', error: boundError(completion.error) };
  } else {
    bounded = {
      type: 'cancelled',
      ...(completion.partial ? { partial: boundResult(completion.partial) } : {}),
    };
  }
  return omittedBytes > 0 ? { ...bounded, truncation: { truncated: true, omittedBytes } } : bounded;
};

export const canonicalizeLodyCommand = (value: unknown): string => {
  const serialized = JSON.stringify(normalizeCanonicalValue(value));
  if (serialized === undefined) {
    throw new LodyOperationStoreError('REQUEST_TOO_LARGE', 'Command is not serializable.', false);
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > LODY_OPERATION_COMMAND_MAX_BYTES) {
    throw new LodyOperationStoreError(
      'REQUEST_TOO_LARGE',
      `Canonical Command exceeds ${LODY_OPERATION_COMMAND_MAX_BYTES} bytes.`,
      false
    );
  }
  return serialized;
};

export const fingerprintLodyCommand = (kind: LodyOperationKind, canonical: string): string =>
  createHash('sha256').update(kind).update('\0').update(canonical).digest('hex');

// machineId is deliberately required: an env-derived default here once made the
// daemon-hosted HTTP MCP transport (whose process has no LODY_MCP_MACHINE_ID)
// silently fall back to a 'local'-keyed store that no coordinator reconciles,
// so accepted Operations were never finalized or delivered. Callers must pass
// the machine id they authenticated (session context, coordinator options).
export const getLodyOperationStorePath = (machineId: string, homeDir = os.homedir()): string => {
  const machineKey = createHash('sha256').update(machineId).digest('hex').slice(0, 24);
  return path.join(
    getLodyDataDir(undefined, homeDir),
    'orchestration',
    machineKey,
    'operations.sqlite3'
  );
};

export type AcceptOperationInput = Omit<
  StoredLodyOperation,
  'fingerprint' | 'state' | 'completion' | 'finishedAt'
>;

export type AcceptOperationOptions = {
  materializationClaimToken?: string;
};

export const getOperationDeliveryId = (
  requesterSessionId: SessionId,
  operationId: string
): string => `operation:${requesterSessionId}:${operationId}:completion`;

export const getOperationCompletionTurnId = (
  requesterSessionId: SessionId,
  operationId: string
): string => `operation-completion:${requesterSessionId}:${operationId}`;

export class LodyOperationStore {
  private readonly db: Database.Database;

  /**
   * `maintenance: false` skips the open-time repair/cleanup write transactions.
   * Non-owner processes (MCP subprocesses) open with it so that opening the
   * shared machine-level store is not itself a write-lock contender; the
   * daemon-side coordinator keeps the default and owns maintenance.
   */
  constructor(
    dbPath: string,
    private readonly now: () => number = Date.now,
    options: { maintenance?: boolean } = {}
  ) {
    const storeDirectory = path.dirname(dbPath);
    mkdirSync(storeDirectory, { recursive: true, mode: 0o700 });
    chmodSync(storeDirectory, 0o700);
    this.db = new Database(dbPath);
    // Operations contain canonical prompts and bounded assistant output. Keep
    // both the database and SQLite sidecars private to the local account.
    chmodSync(dbPath, 0o600);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    if (options.maintenance !== false) {
      this.repairTerminalDeliveries();
      this.cleanupExpired(false);
    }
  }

  close(): void {
    this.db.close();
  }

  accept(
    input: AcceptOperationInput,
    options: AcceptOperationOptions = {}
  ): { created: boolean; operation: StoredLodyOperation; claimedItemIndexes: number[] } {
    LodyOperationIdSchema.parse(input.operationId);
    const canonical = canonicalizeLodyCommand(input.canonicalCommand);
    const fingerprint = fingerprintLodyCommand(input.kind, canonical);
    const frozenConfig = FrozenConfigSchema.parse(input.frozenContinuationConfig);
    const items = z.array(OperationItemSchema).parse(input.items);
    const transaction = this.db.transaction(
      (): { created: boolean; operation: StoredLodyOperation; claimedItemIndexes: number[] } => {
        const existing = this.getStored(input.requesterSessionId, input.operationId);
        if (existing)
          return {
            created: false,
            operation: this.assertMatching(
              existing,
              input.kind,
              fingerprint,
              input.requesterUserId,
              frozenConfig.sourceTurnId
            ),
            claimedItemIndexes: [],
          };
        const inserted = this.db
          .prepare(
            `INSERT OR IGNORE INTO operations (
            workspace_id, owner_machine_id, requester_session_id, requester_user_id,
            operation_id, kind, fingerprint, canonical_command_json, frozen_config_json,
            initiator_chain_depth, created_at, deadline_at, state, items_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
          )
          .run(
            input.workspaceId,
            input.ownerMachineId,
            input.requesterSessionId,
            input.requesterUserId,
            input.operationId,
            input.kind,
            fingerprint,
            canonical,
            JSON.stringify(frozenConfig),
            input.initiatorChainDepth,
            input.createdAt,
            input.deadlineAt,
            JSON.stringify(items)
          );
        const operation = this.getStored(input.requesterSessionId, input.operationId);
        if (!operation) throw new Error('Accepted Operation was not readable after insert.');
        const claimedItemIndexes: number[] = [];
        if (inserted.changes === 1 && options.materializationClaimToken) {
          for (const [index, item] of operation.items.entries()) {
            if (item.status !== 'active' || item.inputDurable) continue;
            this.db
              .prepare(
                `INSERT INTO operation_item_materializations (
                   requester_session_id, operation_id, item_index, claim_token, claimed_at_ms
                 ) VALUES (?, ?, ?, ?, ?)`
              )
              .run(
                input.requesterSessionId,
                input.operationId,
                index,
                options.materializationClaimToken,
                this.now()
              );
            claimedItemIndexes.push(index);
          }
        }
        return {
          created: inserted.changes === 1,
          operation: this.assertMatching(
            operation,
            input.kind,
            fingerprint,
            input.requesterUserId,
            frozenConfig.sourceTurnId
          ),
          claimedItemIndexes,
        };
      }
    );
    // All writing transactions run BEGIN IMMEDIATE: a deferred transaction that
    // reads first and upgrades to a write can fail with SQLITE_BUSY_SNAPSHOT,
    // which busy_timeout cannot wait out. Taking the write lock up front turns
    // that into an ordinary BUSY wait.
    const accepted = transaction.immediate();
    this.cleanupExpired(false);
    return accepted;
  }

  get(requesterSessionId: SessionId, operationId: string): StoredLodyOperation {
    this.cleanupExpired(false);
    const operation = this.getStored(requesterSessionId, operationId);
    if (!operation) {
      throw new LodyOperationStoreError(
        'OPERATION_NOT_FOUND',
        `Operation not found: ${operationId}`,
        false
      );
    }
    return operation;
  }

  findMatchingRetry(
    requesterSessionId: SessionId,
    operationId: string,
    kind: LodyOperationKind,
    canonicalCommand: unknown,
    requesterUserId: string,
    sourceTurnId?: string
  ): StoredLodyOperation | undefined {
    const existing = this.getStored(requesterSessionId, operationId);
    if (!existing) return undefined;
    const fingerprint = fingerprintLodyCommand(kind, canonicalizeLodyCommand(canonicalCommand));
    return this.assertMatching(existing, kind, fingerprint, requesterUserId, sourceTurnId);
  }

  listActive(workspaceId: WorkspaceId, ownerMachineId: MachineId): StoredLodyOperation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM operations
         WHERE workspace_id = ? AND owner_machine_id = ? AND state = 'active'
         ORDER BY created_at ASC, requester_session_id ASC, operation_id ASC`
      )
      .all(workspaceId, ownerMachineId);
    return rows.map((row) => this.decodeOperation(row));
  }

  updateItems(
    requesterSessionId: SessionId,
    operationId: string,
    items: LodyOperationItemResult[]
  ): StoredLodyOperation {
    z.array(OperationItemSchema).parse(items);
    const result = this.db
      .prepare(
        `UPDATE operations SET items_json = ?
         WHERE requester_session_id = ? AND operation_id = ? AND state = 'active'`
      )
      .run(JSON.stringify(items), requesterSessionId, operationId);
    if (result.changes === 0) {
      return this.get(requesterSessionId, operationId);
    }
    return this.get(requesterSessionId, operationId);
  }

  claimItemMaterialization(
    requesterSessionId: SessionId,
    operationId: string,
    itemIndex: number,
    claimToken: string,
    claimDurationMs = MATERIALIZATION_CLAIM_MS
  ): { claimed: boolean; retryAtMs?: number } {
    return this.db
      .transaction(() => {
        const operation = this.get(requesterSessionId, operationId);
        const item = operation.items[itemIndex];
        if (!item || item.status !== 'active' || item.inputDurable) return { claimed: false };
        const row = this.db
          .prepare(
            `SELECT claim_token, claimed_at_ms FROM operation_item_materializations
           WHERE requester_session_id = ? AND operation_id = ? AND item_index = ?`
          )
          .get(requesterSessionId, operationId, itemIndex) as
          | { claim_token: string; claimed_at_ms: number }
          | undefined;
        const nowMs = this.now();
        if (row && row.claim_token !== claimToken && row.claimed_at_ms + claimDurationMs > nowMs) {
          return { claimed: false, retryAtMs: row.claimed_at_ms + claimDurationMs };
        }
        this.db
          .prepare(
            `INSERT INTO operation_item_materializations (
             requester_session_id, operation_id, item_index, claim_token, claimed_at_ms
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(requester_session_id, operation_id, item_index)
           DO UPDATE SET claim_token = excluded.claim_token, claimed_at_ms = excluded.claimed_at_ms`
          )
          .run(requesterSessionId, operationId, itemIndex, claimToken, nowMs);
        return { claimed: true };
      })
      .immediate();
  }

  markItemInputDurable(
    requesterSessionId: SessionId,
    operationId: string,
    itemIndex: number,
    claimToken?: string
  ): StoredLodyOperation {
    return this.db
      .transaction(() => {
        const operation = this.get(requesterSessionId, operationId);
        const item = operation.items[itemIndex];
        if (!item || item.status !== 'active' || item.inputDurable) return operation;
        if (claimToken) {
          const claim = this.db
            .prepare(
              `SELECT claim_token FROM operation_item_materializations
             WHERE requester_session_id = ? AND operation_id = ? AND item_index = ?`
            )
            .get(requesterSessionId, operationId, itemIndex) as { claim_token: string } | undefined;
          if (claim?.claim_token !== claimToken) return operation;
        }
        const items = operation.items.map((candidate, index) =>
          index === itemIndex && candidate.status === 'active'
            ? { ...candidate, inputDurable: true }
            : candidate
        );
        this.db
          .prepare(
            `UPDATE operations SET items_json = ?
           WHERE requester_session_id = ? AND operation_id = ? AND state = 'active'`
          )
          .run(JSON.stringify(items), requesterSessionId, operationId);
        this.db
          .prepare(
            `DELETE FROM operation_item_materializations
           WHERE requester_session_id = ? AND operation_id = ? AND item_index = ?`
          )
          .run(requesterSessionId, operationId, itemIndex);
        return this.get(requesterSessionId, operationId);
      })
      .immediate();
  }

  finish(
    requesterSessionId: SessionId,
    operationId: string,
    completion: LodyOperationCompletion,
    finishedAt = new Date(this.now()).toISOString()
  ): StoredLodyOperation {
    const bounded = this.assertCompletionBound(completion);
    const transaction = this.db.transaction(() => {
      const current = this.getStored(requesterSessionId, operationId);
      if (!current) {
        throw new LodyOperationStoreError(
          'OPERATION_NOT_FOUND',
          `Operation not found: ${operationId}`,
          false
        );
      }
      const durableCompletion = current.state === 'finished' ? current.completion : bounded;
      if (!durableCompletion) throw new Error('Finished Operation is missing its completion.');
      if (current.state === 'active') {
        this.db
          .prepare(
            `UPDATE operations
             SET state = 'finished', completion_json = ?, finished_at = ?
             WHERE requester_session_id = ? AND operation_id = ? AND state = 'active'`
          )
          .run(JSON.stringify(bounded), finishedAt, requesterSessionId, operationId);
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO deliveries (
             workspace_id, requester_session_id, operation_id, delivery_id,
             system_turn_id, state, initiator_chain_depth, completion_json
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(
          current.workspaceId,
          current.requesterSessionId,
          current.operationId,
          getOperationDeliveryId(current.requesterSessionId, current.operationId),
          getOperationCompletionTurnId(current.requesterSessionId, current.operationId),
          current.initiatorChainDepth,
          JSON.stringify(durableCompletion)
        );
      const updated = this.getStored(requesterSessionId, operationId);
      if (!updated) {
        throw new Error('Finished Operation disappeared during transaction.');
      }
      return updated;
    });
    return transaction.immediate();
  }

  cancel(
    requesterSessionId: SessionId,
    operationId: string
  ): { operation: StoredLodyOperation; didCancel: boolean } {
    const transaction = this.db.transaction(() => {
      const current = this.get(requesterSessionId, operationId);
      if (current.state === 'finished') {
        return { operation: current, didCancel: false };
      }
      const partial = { items: current.items };
      return {
        operation: this.finish(requesterSessionId, operationId, {
          type: 'cancelled',
          ...(partial.items.length > 0 ? { partial } : {}),
        }),
        didCancel: true,
      };
    });
    return transaction.immediate();
  }

  listPendingDeliveries(
    workspaceId: WorkspaceId,
    requesterSessionId?: SessionId
  ): StoredLodyDelivery[] {
    const rows = requesterSessionId
      ? this.db
          .prepare(
            `SELECT * FROM deliveries
             WHERE workspace_id = ? AND requester_session_id = ? AND state = 'pending'
             ORDER BY sequence ASC`
          )
          .all(workspaceId, requesterSessionId)
      : this.db
          .prepare(
            `SELECT * FROM deliveries
             WHERE workspace_id = ? AND state = 'pending'
             ORDER BY sequence ASC`
          )
          .all(workspaceId);
    return rows.map((row) => this.decodeDelivery(row));
  }

  consumeDelivery(
    requesterSessionId: SessionId,
    operationId: string,
    consumedAt = new Date(this.now()).toISOString()
  ): void {
    this.db
      .prepare(
        `UPDATE deliveries SET state = 'consumed', consumed_at = ?
         WHERE requester_session_id = ? AND operation_id = ? AND state = 'pending'`
      )
      .run(consumedAt, requesterSessionId, operationId);
  }

  deleteRequesterSession(requesterSessionId: SessionId): void {
    this.db
      .prepare('DELETE FROM operations WHERE requester_session_id = ?')
      .run(requesterSessionId);
  }

  snapshot(operation: StoredLodyOperation): LodyOperationSnapshot {
    if (operation.state === 'finished') {
      if (!operation.completion || !operation.finishedAt) {
        throw new Error('Finished Operation is missing completion fields.');
      }
      return {
        id: operation.operationId,
        kind: operation.kind,
        state: 'finished',
        createdAt: operation.createdAt,
        deadlineAt: operation.deadlineAt,
        finishedAt: operation.finishedAt,
        completion: operation.completion,
      };
    }
    const totalItems = operation.items.length;
    const terminalItems = operation.items.filter((item) => item.status !== 'active').length;
    return {
      id: operation.operationId,
      kind: operation.kind,
      state: 'active',
      createdAt: operation.createdAt,
      deadlineAt: operation.deadlineAt,
      ...(totalItems > 1 ? { progress: { totalItems, terminalItems } } : {}),
      items: operation.items,
    };
  }

  private getStored(
    requesterSessionId: SessionId,
    operationId: string
  ): StoredLodyOperation | undefined {
    const row = this.db
      .prepare('SELECT * FROM operations WHERE requester_session_id = ? AND operation_id = ?')
      .get(requesterSessionId, operationId);
    return row === undefined ? undefined : this.decodeOperation(row);
  }

  private assertMatching(
    operation: StoredLodyOperation,
    kind: LodyOperationKind,
    fingerprint: string,
    requesterUserId: string,
    sourceTurnId?: string
  ): StoredLodyOperation {
    if (
      operation.kind !== kind ||
      operation.fingerprint !== fingerprint ||
      operation.requesterUserId !== requesterUserId ||
      operation.frozenContinuationConfig.sourceTurnId !== sourceTurnId
    ) {
      throw new LodyOperationStoreError(
        'OPERATION_ID_REUSED',
        `Operation id ${operation.operationId} is already bound to different input.`,
        false
      );
    }
    return operation;
  }

  private decodeOperation(row: unknown): StoredLodyOperation {
    const parsed = OperationRowSchema.parse(row);
    const command = parseJson(parsed.canonical_command_json, z.unknown(), 'canonical Command');
    const frozen = parseJson(
      parsed.frozen_config_json,
      FrozenConfigSchema,
      'frozen continuation configuration'
    ) as FrozenOperationContinuationConfig;
    const items = parseJson(
      parsed.items_json,
      z.array(OperationItemSchema),
      'Operation items'
    ) as LodyOperationItemResult[];
    const completion = parsed.completion_json
      ? (parseJson(
          parsed.completion_json,
          OperationCompletionSchema,
          'Operation completion'
        ) as LodyOperationCompletion)
      : undefined;
    return {
      workspaceId: parsed.workspace_id as WorkspaceId,
      ownerMachineId: parsed.owner_machine_id as MachineId,
      requesterSessionId: parsed.requester_session_id as SessionId,
      requesterUserId: parsed.requester_user_id,
      operationId: parsed.operation_id,
      kind: parsed.kind,
      fingerprint: parsed.fingerprint,
      canonicalCommand: command,
      frozenContinuationConfig: frozen,
      initiatorChainDepth: parsed.initiator_chain_depth,
      createdAt: parsed.created_at,
      deadlineAt: parsed.deadline_at,
      state: parsed.state,
      items,
      ...(completion ? { completion } : {}),
      ...(parsed.finished_at ? { finishedAt: parsed.finished_at } : {}),
    };
  }

  private decodeDelivery(row: unknown): StoredLodyDelivery {
    const parsed = DeliveryRowSchema.parse(row);
    return {
      sequence: parsed.sequence,
      workspaceId: parsed.workspace_id as WorkspaceId,
      requesterSessionId: parsed.requester_session_id as SessionId,
      operationId: parsed.operation_id,
      deliveryId: parsed.delivery_id,
      systemTurnId: parsed.system_turn_id,
      state: parsed.state,
      initiatorChainDepth: parsed.initiator_chain_depth,
      completion: parseJson(
        parsed.completion_json,
        OperationCompletionSchema,
        'Delivery completion'
      ) as LodyOperationCompletion,
      ...(parsed.consumed_at ? { consumedAt: parsed.consumed_at } : {}),
    };
  }

  private assertCompletionBound(completion: LodyOperationCompletion): LodyOperationCompletion {
    const parsed = OperationCompletionSchema.parse(completion) as LodyOperationCompletion;
    if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') <= LODY_OPERATION_COMPLETION_MAX_BYTES) {
      return parsed;
    }
    let low = 0;
    let high = LODY_OPERATION_COMPLETION_MAX_BYTES;
    let best = boundCompletionFreeText(parsed, 0);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = boundCompletionFreeText(parsed, middle);
      if (
        Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= LODY_OPERATION_COMPLETION_MAX_BYTES
      ) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (Buffer.byteLength(JSON.stringify(best), 'utf8') > LODY_OPERATION_COMPLETION_MAX_BYTES) {
      throw new Error('Operation completion structural envelope exceeds the 64 KiB bound.');
    }
    return best;
  }

  private cleanupExpired(force: boolean): void {
    const nowMs = this.now();
    const prior = this.db
      .prepare(`SELECT value FROM orchestration_meta WHERE key = 'last_cleanup_at_ms'`)
      .get() as { value?: string } | undefined;
    const priorMs = Number(prior?.value ?? 0);
    if (!force && Number.isFinite(priorMs) && nowMs - priorMs < DAY_MS) {
      return;
    }
    const cutoff = new Date(nowMs - TERMINAL_RETENTION_MS).toISOString();
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `DELETE FROM operations
           WHERE state = 'finished'
             AND EXISTS (
               SELECT 1 FROM deliveries
               WHERE deliveries.requester_session_id = operations.requester_session_id
                 AND deliveries.operation_id = operations.operation_id
                 AND deliveries.state = 'consumed'
                 AND deliveries.consumed_at < ?
             )`
          )
          .run(cutoff);
        this.db
          .prepare(
            `INSERT INTO orchestration_meta (key, value) VALUES ('last_cleanup_at_ms', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
          )
          .run(String(nowMs));
      })
      .immediate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        workspace_id TEXT NOT NULL,
        owner_machine_id TEXT NOT NULL,
        requester_session_id TEXT NOT NULL,
        requester_user_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        canonical_command_json TEXT NOT NULL,
        frozen_config_json TEXT NOT NULL,
        initiator_chain_depth INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'finished')),
        items_json TEXT NOT NULL,
        completion_json TEXT,
        finished_at TEXT,
        PRIMARY KEY (requester_session_id, operation_id)
      );

      CREATE INDEX IF NOT EXISTS operations_active_owner
      ON operations (workspace_id, owner_machine_id, state, deadline_at);

      CREATE TABLE IF NOT EXISTS deliveries (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        requester_session_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL UNIQUE,
        system_turn_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('pending', 'consumed')),
        initiator_chain_depth INTEGER NOT NULL,
        completion_json TEXT NOT NULL,
        consumed_at TEXT,
        FOREIGN KEY (requester_session_id, operation_id)
          REFERENCES operations (requester_session_id, operation_id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS deliveries_pending_session
      ON deliveries (workspace_id, requester_session_id, state, sequence);

      CREATE TABLE IF NOT EXISTS operation_item_materializations (
        requester_session_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        item_index INTEGER NOT NULL,
        claim_token TEXT NOT NULL,
        claimed_at_ms INTEGER NOT NULL,
        PRIMARY KEY (requester_session_id, operation_id, item_index),
        FOREIGN KEY (requester_session_id, operation_id)
          REFERENCES operations (requester_session_id, operation_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS orchestration_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private repairTerminalDeliveries(): void {
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `UPDATE deliveries
           SET delivery_id = 'operation:' || requester_session_id || ':' || operation_id || ':completion',
               system_turn_id = 'operation-completion:' || requester_session_id || ':' || operation_id`
          )
          .run();
        this.db
          .prepare(
            `INSERT OR IGNORE INTO deliveries (
             workspace_id, requester_session_id, operation_id, delivery_id,
             system_turn_id, state, initiator_chain_depth, completion_json
           )
           SELECT workspace_id, requester_session_id, operation_id,
             'operation:' || requester_session_id || ':' || operation_id || ':completion',
             'operation-completion:' || requester_session_id || ':' || operation_id,
             'pending', initiator_chain_depth, completion_json
           FROM operations
           WHERE state = 'finished' AND completion_json IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM deliveries
               WHERE deliveries.requester_session_id = operations.requester_session_id
                 AND deliveries.operation_id = operations.operation_id
             )`
          )
          .run();
      })
      .immediate();
  }
}
