import { describe, expect, it } from 'vitest';
import type {
  AgentConfigId,
  LocalProjectHistoryCatalogResult,
  LocalProjectHistoryProvider,
  LocalProjectHistorySyncSummary,
  LocalProjectId,
  MachineId,
  ACPSessionId,
  SessionId,
  SessionMeta,
} from '@lody/shared';

import {
  getVisibleLocalProjectHistoryFailures,
  reconcileLocalProjectHistoryCatalog,
} from '../src/lib/local-project-history-catalog';

const machineId = 'machine-1' as MachineId;
const localProjectId = 'project-1' as LocalProjectId;
const provider: LocalProjectHistoryProvider = { cliType: 'builtin', agentType: 'codex' };

function catalog(
  status: 'available' | 'imported' | 'sync_conflict'
): LocalProjectHistoryCatalogResult {
  const item = {
    acpSessionId: 'acp-1',
    title: 'ACP session',
    updatedAt: '2026-05-01T00:00:00.000Z',
    status,
  };
  if (status !== 'available') {
    return {
      listed: 1,
      lastListedAt: 100,
      sessions: [{ ...item, importedSessionId: 'deleted-session' }],
    };
  }
  return {
    listed: 1,
    lastListedAt: 100,
    sessions: [item],
  };
}

function importedSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'session-1' as SessionId,
    machineId,
    createdAt: '2026-05-01T00:00:00.000Z',
    userId: 'user-1',
    isArchived: false,
    cliType: provider.cliType,
    agentType: provider.agentType,
    project: { kind: 'local', localProjectId },
    externalHistory: {
      provider,
      source: 'local-acp-history',
      sourceAcpSessionId: 'acp-1' as ACPSessionId,
      importedTurnCount: 0,
      importedTurnHashes: [],
      lastSyncAt: 100,
      status: 'synced',
    },
    ...overrides,
  };
}

describe('reconcileLocalProjectHistoryCatalog', () => {
  it('does not label another account’s matching native ID as already imported', () => {
    const selected = { ...provider, agentConfigId: 'account-a' as AgentConfigId };
    const reconcile = (binding: string) =>
      reconcileLocalProjectHistoryCatalog({
        catalog: catalog('available'),
        machineId,
        localProjectId,
        provider: selected,
        sessionMetas: [importedSession({ agentConfigId: binding as AgentConfigId })],
      });
    expect(reconcile('account-b')?.sessions[0]).toMatchObject({ status: 'available' });
    expect(reconcile('account-b')?.sessions[0].importedSessionId).toBeUndefined();
    expect(reconcile('account-a')?.sessions[0]).toMatchObject({
      status: 'imported',
      importedSessionId: 'session-1',
    });
  });

  it('marks stale imported catalog rows available when the Lody session no longer exists', () => {
    expect(
      reconcileLocalProjectHistoryCatalog({
        catalog: catalog('imported'),
        machineId,
        localProjectId,
        provider,
        sessionMetas: [],
      })?.sessions[0]
    ).toEqual({
      acpSessionId: 'acp-1',
      title: 'ACP session',
      updatedAt: '2026-05-01T00:00:00.000Z',
      status: 'available',
    });
  });

  it('keeps archived imported sessions marked imported', () => {
    expect(
      reconcileLocalProjectHistoryCatalog({
        catalog: catalog('available'),
        machineId,
        localProjectId,
        provider,
        sessionMetas: [importedSession({ isArchived: true })],
      })?.sessions[0]
    ).toMatchObject({
      importedSessionId: 'session-1',
      status: 'imported',
    });
  });

  it('keeps legacy metadata-only imports available for retry', () => {
    expect(
      reconcileLocalProjectHistoryCatalog({
        catalog: catalog('imported'),
        machineId,
        localProjectId,
        provider,
        sessionMetas: [
          importedSession({
            externalHistory: {
              ...importedSession().externalHistory!,
              status: 'metadata_only',
            },
          }),
        ],
      })?.sessions[0]
    ).toMatchObject({
      importedSessionId: 'session-1',
      status: 'available',
    });
  });

  it('ignores imported sessions from a different local project', () => {
    expect(
      reconcileLocalProjectHistoryCatalog({
        catalog: catalog('imported'),
        machineId,
        localProjectId,
        provider,
        sessionMetas: [
          importedSession({
            project: { kind: 'local', localProjectId: 'project-2' as LocalProjectId },
          }),
        ],
      })?.sessions[0]?.status
    ).toBe('available');
  });
});

describe('getVisibleLocalProjectHistoryFailures', () => {
  it('bounds displayed failures and reports the remaining count', () => {
    const summary = {
      listed: 5,
      imported: 0,
      refreshed: 0,
      skipped: 0,
      conflicted: 0,
      failed: 5,
      failures: Array.from({ length: 5 }, (_, index) => ({
        acpSessionId: `acp-${index}` as ACPSessionId,
        message: `failure-${index}`,
      })),
    } satisfies LocalProjectHistorySyncSummary;

    expect(getVisibleLocalProjectHistoryFailures(summary)).toEqual({
      failures: summary.failures.slice(0, 3),
      remaining: 2,
    });
  });
});
