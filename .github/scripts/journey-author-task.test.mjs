import assert from 'node:assert/strict';
import { test } from 'node:test';

import { journeyFingerprint } from '../../e2e/scripts/journey-registry.mjs';
import { createJourneyAuthorTask } from './journey-author-task.mjs';

function journey(overrides = {}) {
  const value = {
    id: 'LODY-SESSION-002',
    state: 'backlog',
    priority: 'P1',
    runtime: 'none',
    title: 'Restore an archived Session',
    owner: 'session',
    fixture: 'seeded-session',
    ownerPaths: ['packages/components/src/components/sessions/'],
    actions: [{ id: 'session.restore' }],
    checkpoints: ['Session appears in Archive', 'Session returns to the active list'],
    cleanup: ['Session is deleted'],
    coverage: {
      renderer: 'Archive',
      electronIpc: 'Session RPC',
      bundledCli: 'Local runtime',
      durableState: 'Archive state',
      externalWire: 'None',
    },
    gap: 'No desktop journey covers restore.',
    evidence: ['session.tsx'],
    signals: { criticality: 4, boundaryRisk: 4, changeFrequency: 3, escapedDefect: false },
    estimatedMinutes: 4,
    freshness: 3,
    scoutJourneys: [],
    blockedReason: null,
    ...overrides,
  };
  return { ...value, fingerprint: journeyFingerprint(value) };
}

function create(journeys, overrides = {}) {
  return createJourneyAuthorTask({
    registry: {
      schemaVersion: 1,
      scoring: {
        criticality: 100,
        boundaryRisk: 20,
        changeFrequency: 5,
        freshness: 10,
        escapedDefect: 40,
        scoutSignal: 25,
        changedPath: 50,
        estimatedMinutePenalty: 2,
      },
      journeys,
    },
    excludedCandidateIds: [],
    requestedCandidateId: 'next',
    budgetMinutes: 60,
    repository: 'LodyAI/Lody',
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    runId: '123',
    trigger: 'schedule',
    now: Date.parse('2026-09-04T00:00:00.000Z'),
    signals: { changedFiles: [], escapedDefectIds: [], scoutJourneys: [] },
    ...overrides,
  });
}

void test('claims the risk-ranked candidate with a fixed id and bounded lease', () => {
  const task = create([
    journey(),
    journey({
      id: 'LODY-MCP-001',
      title: 'MCP selection',
      signals: { criticality: 5, boundaryRisk: 5, changeFrequency: 4, escapedDefect: false },
    }),
  ]);
  assert.equal(task.candidate.id, 'LODY-MCP-001');
  assert.equal(task.claim.leaseId, 'LODY-MCP-001-123');
  assert.equal(task.claim.expiresAt, '2026-09-04T01:00:00.000Z');
});

void test('excludes an active claim and advances to the next candidate', () => {
  const task = create([journey(), journey({ id: 'LODY-MCP-001', title: 'MCP selection' })], {
    excludedCandidateIds: ['LODY-MCP-001'],
  });
  assert.equal(task.candidate.id, 'LODY-SESSION-002');
});

void test('returns queue-empty instead of inventing a journey', () => {
  const task = create([journey({ state: 'active', feature: 'src/features/lifecycle.feature' })]);
  assert.equal(task.disposition, 'queue-empty');
  assert.equal(task.candidate, undefined);
});
