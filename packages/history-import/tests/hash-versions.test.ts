import { describe, expect, it } from 'vitest';
import {
  parseSessionNotification,
  type AcpSessionNotification,
  type ACPSessionId,
  type ExternalAcpHistorySyncMeta,
  type MessageContent,
  type SessionHistoryInput,
} from '@lody/shared';

import {
  buildExternalHistoryMeta,
  decideHistoryConflictResolution,
  decideHistoryRefresh,
  HASH_VERSION,
  HASH_VERSION_V1,
  HASH_VERSION_V2,
  hashHistoryEntry,
  hashHistoryEntryForVersion,
  hashHistoryEntryV2,
  hashText,
  materializeReplay,
} from '../src';

const provider = { cliType: 'builtin', agentType: 'codex' } as const;
const acpSessionId = 'codex-session-1' as ACPSessionId;
const NOW = '2026-05-14T00:00:00.000Z';

function makeNotification(update: unknown): AcpSessionNotification {
  return parseSessionNotification({ sessionId: acpSessionId, update });
}

function historyEntry(overrides: Partial<SessionHistoryInput> = {}): SessionHistoryInput {
  return {
    id: 'turn-1',
    role: 'assistant',
    items: [] as unknown as SessionHistoryInput['items'],
    timestamp: NOW,
    status: 'handled',
    read: true,
    finished: true,
    fileDiff: [],
    ...overrides,
  };
}

/** Two turns: a user prompt and an assistant turn with a tool call. */
function replayNotificationsPrefix(): AcpSessionNotification[] {
  return [
    makeNotification({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'inspect repo' },
    }),
    makeNotification({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      kind: 'read',
      title: 'Read package.json',
      status: 'completed',
      rawInput: { path: 'package.json' },
      rawOutput: { output: '{ "name": "lody" }' },
    }),
    makeNotification({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Done.' },
    }),
  ];
}

/** The prefix plus one more user turn. */
function replayNotificationsFull(): AcpSessionNotification[] {
  return [
    ...replayNotificationsPrefix(),
    makeNotification({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'continue' },
    }),
  ];
}

function materialize(notifications: AcpSessionNotification[]) {
  return materializeReplay({
    provider,
    acpSessionId,
    replayNotifications: notifications,
    userId: 'user-1',
    nowIso: NOW,
  });
}

/** The cursor an old (pre-skeleton) CLI would have written for a transcript. */
function v1Cursor(history: readonly SessionHistoryInput[]) {
  const importedTurnHashes = history.map(hashHistoryEntry);
  return {
    importedTurnHashes,
    replayDigest: hashText(importedTurnHashes.join('\n')),
  };
}

function externalHistory(
  overrides: Partial<ExternalAcpHistorySyncMeta> = {}
): ExternalAcpHistorySyncMeta {
  return {
    provider,
    source: 'local-acp-history',
    sourceAcpSessionId: acpSessionId,
    importedTurnCount: 0,
    lastSyncAt: 1,
    status: 'synced',
    ...overrides,
  };
}

describe('v2 canonical hashing', () => {
  it('hashes full and skeleton tool_call shapes identically', () => {
    const fullToolCall = {
      type: 'tool_call',
      toolCallId: 'call-1',
      title: 'Read package.json',
      status: 'completed',
      kind: 'read',
      content: [{ type: 'content', content: { type: 'text', text: '{}' } }],
      locations: [{ path: 'package.json' }],
      rawInput: { path: 'package.json' },
      rawOutput: { output: '{}' },
      toolName: 'Read',
      schedulingTimeZone: 'America/Los_Angeles',
      activityKind: 'context_compaction',
      permissionRequest: { requestId: 'req-1', options: [] },
    } as unknown as MessageContent;
    const skeletonToolCall = {
      type: 'tool_call',
      kind: 'read',
      status: 'completed',
      title: 'Read package.json',
      locations: [{ path: 'package.json' }],
      ref: { machineId: 'machine-1', turnId: 'turn-1', index: 0 },
    } as unknown as MessageContent;

    const full = historyEntry({ items: [fullToolCall] as unknown as SessionHistoryInput['items'] });
    const skeleton = historyEntry({
      items: [skeletonToolCall] as unknown as SessionHistoryInput['items'],
    });

    expect(hashHistoryEntryV2(full)).toBe(hashHistoryEntryV2(skeleton));
    // v1 hashed the items verbatim: the whole point of v2 is that these differ.
    expect(hashHistoryEntry(full)).not.toBe(hashHistoryEntry(skeleton));
  });

  it('treats tool_call title null, undefined, and missing identically', () => {
    const withNull = historyEntry({
      items: [
        { type: 'tool_call', title: null, status: 'completed', kind: 'read' },
      ] as unknown as SessionHistoryInput['items'],
    });
    const withUndefined = historyEntry({
      items: [
        { type: 'tool_call', title: undefined, status: 'completed', kind: 'read' },
      ] as unknown as SessionHistoryInput['items'],
    });
    const without = historyEntry({
      items: [
        { type: 'tool_call', status: 'completed', kind: 'read' },
      ] as unknown as SessionHistoryInput['items'],
    });

    expect(hashHistoryEntryV2(withNull)).toBe(hashHistoryEntryV2(without));
    expect(hashHistoryEntryV2(withUndefined)).toBe(hashHistoryEntryV2(without));
  });

  it('still hashes the transcript content that survives sealing', () => {
    const base = {
      type: 'tool_call',
      toolCallId: 'call-1',
      status: 'completed',
      kind: 'read',
      rawInput: { path: 'a' },
    } as unknown as MessageContent;
    const otherStatus = {
      type: 'tool_call',
      toolCallId: 'call-2',
      status: 'failed',
      kind: 'read',
      rawInput: { path: 'a' },
    } as unknown as MessageContent;

    expect(
      hashHistoryEntryV2(historyEntry({ items: [base] as unknown as SessionHistoryInput['items'] }))
    ).not.toBe(
      hashHistoryEntryV2(
        historyEntry({ items: [otherStatus] as unknown as SessionHistoryInput['items'] })
      )
    );
  });

  it('dispatches per version and rejects unknown versions', () => {
    const entry = historyEntry({
      items: [{ type: 'text', text: 'hello' }] as unknown as SessionHistoryInput['items'],
    });
    expect(hashHistoryEntryForVersion(entry, HASH_VERSION_V1)).toBe(hashHistoryEntry(entry));
    expect(hashHistoryEntryForVersion(entry, HASH_VERSION_V2)).toBe(hashHistoryEntryV2(entry));
    expect(() => hashHistoryEntryForVersion(entry, 3)).toThrow(/Unsupported history hash version/);
  });
});

describe('materializeReplay hash version', () => {
  it('emits v2 hashes and records the version', () => {
    const materialized = materialize(replayNotificationsPrefix());
    expect(materialized.hashVersion).toBe(HASH_VERSION);
    expect(materialized.hashVersion).toBe(HASH_VERSION_V2);
    expect(materialized.turnHashes).toEqual(materialized.history.map(hashHistoryEntryV2));
    // Entry ids stay content-addressed, now from v2 hashes.
    for (const [index, entry] of materialized.history.entries()) {
      expect(entry.id).toBe(
        `builtin:codex:${acpSessionId}:turn:${index}:${materialized.turnHashes[index]!.slice(0, 16)}`
      );
    }
  });

  it('records hashVersion in external-history meta', () => {
    const materialized = materialize(replayNotificationsPrefix());
    const meta = buildExternalHistoryMeta({
      provider,
      sourceAcpSessionId: acpSessionId,
      materialized,
      lastSyncAt: 42,
    });
    expect(meta.hashVersion).toBe(HASH_VERSION_V2);
    expect(meta.replayDigest).toBe(materialized.replayDigest);
  });

  it('re-imports an unchanged transcript to identical hashes and ids', () => {
    const first = materialize(replayNotificationsFull());
    const second = materialize(replayNotificationsFull());

    expect(second.turnHashes).toEqual(first.turnHashes);
    expect(second.replayDigest).toBe(first.replayDigest);
    expect(second.history.map((entry) => entry.id)).toEqual(first.history.map((entry) => entry.id));

    // A refresh against the v2 cursor the first import wrote is a no-op.
    const meta = buildExternalHistoryMeta({
      provider,
      sourceAcpSessionId: acpSessionId,
      materialized: first,
      lastSyncAt: 1,
    });
    expect(
      decideHistoryRefresh({
        externalHistory: meta,
        replayDigest: second.replayDigest,
        turnHashes: second.turnHashes,
        materialized: second,
      })
    ).toEqual({ status: 'skipped', reason: 'digest_match' });
  });
});

describe('mixed-version comparison', () => {
  it('matches a v1 cursor written by an old CLI after upgrade (digest match, no conflict)', () => {
    const materialized = materialize(replayNotificationsPrefix());
    const stored = v1Cursor(materialized.history);
    const meta = externalHistory({
      replayDigest: stored.replayDigest,
      importedTurnCount: materialized.turnHashes.length,
      importedTurnHashes: stored.importedTurnHashes,
    });

    expect(
      decideHistoryRefresh({
        externalHistory: meta,
        replayDigest: materialized.replayDigest,
        turnHashes: materialized.turnHashes,
        materialized,
      })
    ).toEqual({ status: 'skipped', reason: 'digest_match' });
  });

  it('recomputes a v1 stored prefix against a v2 replay as prefix_append, not conflict', () => {
    const prefixReplay = materialize(replayNotificationsPrefix());
    const fullReplay = materialize(replayNotificationsFull());
    const stored = v1Cursor(prefixReplay.history);
    const meta = externalHistory({
      replayDigest: stored.replayDigest,
      importedTurnCount: prefixReplay.turnHashes.length,
      importedTurnHashes: stored.importedTurnHashes,
    });

    expect(fullReplay.turnHashes.length).toBe(prefixReplay.turnHashes.length + 1);
    expect(
      decideHistoryRefresh({
        externalHistory: meta,
        replayDigest: fullReplay.replayDigest,
        turnHashes: fullReplay.turnHashes,
        materialized: fullReplay,
        currentHistoryHashes: stored.importedTurnHashes,
      })
    ).toEqual({
      status: 'refreshed',
      reason: 'prefix_append',
      appendFromIndex: prefixReplay.turnHashes.length,
    });
  });

  it('resolves a v1 sync_conflict against a v2 replay without a false behind-cursor block', () => {
    const prefixReplay = materialize(replayNotificationsPrefix());
    const fullReplay = materialize(replayNotificationsFull());
    const stored = v1Cursor(prefixReplay.history);
    const meta = externalHistory({
      status: 'sync_conflict',
      replayDigest: stored.replayDigest,
      importedTurnCount: prefixReplay.turnHashes.length,
      importedTurnHashes: stored.importedTurnHashes,
    });

    expect(
      decideHistoryConflictResolution({
        externalHistory: meta,
        materialized: fullReplay,
        currentHistoryHashes: [...stored.importedTurnHashes, 'local-only'],
        currentHistoryHasPendingDispatch: false,
      })
    ).toEqual({ status: 'replace' });
  });

  it('treats an already-synced v1 session as already_resolved against the v2 replay', () => {
    const materialized = materialize(replayNotificationsPrefix());
    const stored = v1Cursor(materialized.history);
    const meta = externalHistory({
      status: 'synced',
      replayDigest: stored.replayDigest,
      importedTurnCount: materialized.turnHashes.length,
      importedTurnHashes: stored.importedTurnHashes,
    });

    expect(
      decideHistoryConflictResolution({
        externalHistory: meta,
        materialized,
        currentHistoryHashes: stored.importedTurnHashes,
        currentHistoryHasPendingDispatch: false,
      })
    ).toEqual({ status: 'already_resolved' });
  });

  it('requires the replay history when versions differ and no materialized replay is passed', () => {
    const materialized = materialize(replayNotificationsPrefix());
    const meta = externalHistory({
      replayDigest: 'v1-digest',
      importedTurnCount: materialized.turnHashes.length,
    });

    expect(() =>
      decideHistoryRefresh({
        externalHistory: meta,
        replayDigest: materialized.replayDigest,
        turnHashes: materialized.turnHashes,
        replayHashVersion: HASH_VERSION_V2,
      })
    ).toThrow(/materialized replay history/);
  });
});
