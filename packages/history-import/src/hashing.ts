import { createHash } from 'node:crypto';

import type { MessageContent, SessionHistoryInput } from '@lody/shared';

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
 * Only the parts of an entry that come from the source transcript take part in
 * the hash. Ids, timestamps and read state are assigned at import time and
 * would otherwise make every re-import look like a conflict.
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
