import { createHash } from 'node:crypto';

import type { MessageContent, SessionHistoryInput } from '@lody/shared';

/**
 * Canonical-hash versions. v1 hashed `{ role, items, plan }` verbatim. v2
 * hashes a canonical item form so a sealed tool_call skeleton
 * (`{ type, kind, status, title?, locations?, ref }`) and the full tool_call
 * shape it was sealed from produce the same hash. Stored cursors without a
 * `hashVersion` are v1 (written by CLIs that predate skeletons).
 */
export const HASH_VERSION_V1 = 1;
export const HASH_VERSION_V2 = 2;
/** Version new imports write. */
export const HASH_VERSION = HASH_VERSION_V2;

/**
 * Deterministic JSON with sorted keys and dropped `undefined` values. Turn
 * hashes are compared across machines and across CLI versions, so key order
 * from a JS object literal must never leak into the digest.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * v1 (legacy) hash input. Only the parts of an entry that come from the
 * source transcript take part in the hash. Ids, timestamps and read state are
 * assigned at import time and would otherwise make every re-import look like
 * a conflict. Kept intact so cursors written by older CLIs can be recomputed;
 * new imports use `normalizeHistoryEntryForHashV2`.
 */
export function normalizeHistoryEntryForHash(entry: SessionHistoryInput): unknown {
  return {
    role: entry.role,
    items: (entry.items ?? []) as unknown as MessageContent[],
    plan: entry.plan ?? [],
  };
}

export function hashHistoryEntry(entry: SessionHistoryInput): string {
  return hashText(stableJson(normalizeHistoryEntryForHash(entry)));
}

/**
 * Keys stripped from every item in the v2 canonical form. These are either
 * import-time/runtime-only annotations or fields a sealed tool_call skeleton
 * omits, so hashing them would make the same transcript hash differently once
 * its turns are sealed:
 *
 * - `toolCallId`: ACP-assigned call id; skeletons omit it.
 * - `content` / `rawInput` / `rawOutput`: the tool_call execution payload;
 *   skeletons drop it (readers fetch it on demand via `ref`).
 * - `ref`: pointer into the origin machine's local store, assigned at seal
 *   time — not transcript content.
 * - `activityKind` / `permissionRequest`: runtime/transient annotations
 *   (status-row markers, resolved permission prompts).
 * - `toolName` / `schedulingTimeZone`: runtime annotations captured at persist
 *   time. They feed scheduled-task derivation, but that derivation reads the
 *   stored history rows, never the hashes — and skeletons omit them, so
 *   keeping them would break full/skeleton convergence. `schedulingTimeZone`
 *   is also machine-local, so hashing it would make hashes differ across
 *   machines for the same transcript.
 * - `turnId` / `isLatest`: proposed_plan runtime linkage/view state.
 * - `startedAt` / `endedAt` / `startedAtEpochSeconds` / `endedAtEpochSeconds`:
 *   runtime timestamps (worktree_script, subagent_task).
 */
const VOLATILE_ITEM_KEYS_V2: ReadonlySet<string> = new Set([
  'toolCallId',
  'content',
  'rawInput',
  'rawOutput',
  'ref',
  'activityKind',
  'permissionRequest',
  'toolName',
  'schedulingTimeZone',
  'turnId',
  'isLatest',
  'startedAt',
  'endedAt',
  'startedAtEpochSeconds',
  'endedAtEpochSeconds',
]);

/**
 * v2 canonical form of a tool_call item: exactly the fields a sealed skeleton
 * keeps, minus `ref`. `title: null` (ACP "no title") is treated as absent so
 * null, undefined, and missing hash identically (`stableJson` already drops
 * undefined; absent optional keys are never fabricated).
 */
function canonicalizeToolCallItemForHashV2(item: Record<string, unknown>): Record<string, unknown> {
  const canonical: Record<string, unknown> = { type: 'tool_call' };
  if (typeof item.title === 'string') {
    canonical.title = item.title;
  }
  if (item.kind !== undefined) {
    canonical.kind = item.kind;
  }
  if (item.status !== undefined) {
    canonical.status = item.status;
  }
  if (item.locations !== undefined) {
    canonical.locations = item.locations;
  }
  return canonical;
}

function canonicalizeItemForHashV2(item: unknown): unknown {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return item;
  }
  const record = item as Record<string, unknown>;
  if (record.type === 'text' || record.type === 'thought') {
    // `spans` are mention regions derived from `text`; they add no transcript
    // content beyond it.
    return { type: record.type, text: record.text };
  }
  if (record.type === 'tool_call') {
    return canonicalizeToolCallItemForHashV2(record);
  }
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (VOLATILE_ITEM_KEYS_V2.has(key) || record[key] === undefined) {
      continue;
    }
    canonical[key] = record[key];
  }
  return canonical;
}

/**
 * v2 counterpart of `normalizeHistoryEntryForHash`: same entry-level shape
 * (`role`, `items`, `plan`), with each item reduced to its canonical form.
 */
export function normalizeHistoryEntryForHashV2(entry: SessionHistoryInput): unknown {
  return {
    role: entry.role,
    items: ((entry.items ?? []) as unknown as MessageContent[]).map(canonicalizeItemForHashV2),
    plan: entry.plan ?? [],
  };
}

export function hashHistoryEntryV2(entry: SessionHistoryInput): string {
  return hashText(stableJson(normalizeHistoryEntryForHashV2(entry)));
}

/**
 * Hash an entry with an explicit canonical version. Used when comparing a new
 * replay against a stored cursor written by an older CLI: the replay's hashes
 * are recomputed in the stored version so an upgrade never looks like a
 * conflict.
 */
export function hashHistoryEntryForVersion(entry: SessionHistoryInput, version: number): string {
  if (version === HASH_VERSION_V1) {
    return hashHistoryEntry(entry);
  }
  if (version === HASH_VERSION_V2) {
    return hashHistoryEntryV2(entry);
  }
  throw new Error(`Unsupported history hash version: ${version}`);
}
