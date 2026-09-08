import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  journeyFingerprint,
  ownerPathMatches,
  renderCoverage,
  scoreJourney,
  selectJourneyCandidate,
  validateRegistry,
} from './journey-registry.mjs';

const scoring = {
  criticality: 100,
  boundaryRisk: 20,
  changeFrequency: 5,
  freshness: 5,
  escapedDefect: 40,
  scoutSignal: 35,
  changedPath: 50,
  estimatedMinutePenalty: 2,
};

function journey(overrides = {}) {
  const value = {
    id: 'LODY-TEST-001',
    state: 'backlog',
    priority: 'P1',
    runtime: 'none',
    title: 'Test journey',
    owner: 'example-owner',
    fixture: 'synthetic-fixture',
    ownerPaths: ['packages/components/src/example/'],
    actions: [{ id: 'example.open' }, { id: 'example.close' }],
    checkpoints: ['observable result'],
    cleanup: ['resource released'],
    coverage: {
      renderer: 'Example UI',
      electronIpc: 'Real IPC',
      bundledCli: 'Real CLI',
      durableState: 'Synthetic state',
      externalWire: 'None',
    },
    gap: 'No desktop coverage.',
    evidence: ['packages/components/src/example/view.tsx'],
    signals: { criticality: 3, boundaryRisk: 2, changeFrequency: 1, escapedDefect: false },
    freshness: 3,
    scoutJourneys: [],
    blockedReason: null,
    estimatedMinutes: 4,
    ...overrides,
  };
  value.fingerprint = journeyFingerprint(value);
  return value;
}

void describe('journey registry', () => {
  void it('rejects duplicate ids and semantic contracts', () => {
    const first = journey();
    const duplicate = journey({ id: first.id });
    const failures = validateRegistry({ schemaVersion: 1, scoring, journeys: [first, duplicate] });
    assert.ok(failures.some((failure) => failure.includes('.id duplicates')));
    assert.ok(failures.some((failure) => failure.includes('duplicates the semantic contract')));
  });

  void it('fingerprints only executable semantics', () => {
    const first = journey();
    const renamed = journey({ id: 'LODY-OTHER-002', title: 'Renamed proposal' });
    const changed = journey({
      id: 'LODY-OTHER-003',
      actions: [{ id: 'example.open' }, { id: 'example.save' }],
    });
    assert.equal(journeyFingerprint(first), journeyFingerprint(renamed));
    assert.notEqual(journeyFingerprint(first), journeyFingerprint(changed));
  });

  void it('matches exact files and owned directory prefixes', () => {
    assert.equal(ownerPathMatches('apps/cli/src/mcp/', 'apps/cli/src/mcp/server.ts'), true);
    assert.equal(ownerPathMatches('apps/cli/src/mcp/', 'apps/cli/src/agent/server.ts'), false);
    assert.equal(ownerPathMatches('./package.json', 'package.json'), true);
    assert.equal(ownerPathMatches('package.json', 'package.json.backup'), false);
  });

  void it('scores changed ownership without depending on changed-file order', () => {
    const candidate = journey();
    const plain = scoreJourney(candidate, scoring, []);
    const changed = scoreJourney(candidate, scoring, [
      'unrelated/file.ts',
      'packages/components/src/example/view.tsx',
    ]);
    const reversed = scoreJourney(candidate, scoring, [
      'packages/components/src/example/view.tsx',
      'unrelated/file.ts',
    ]);
    assert.equal(changed.score - plain.score, scoring.changedPath);
    assert.deepEqual(changed, reversed);
  });

  void it('scores normalized escaped-defect and Scout inputs', () => {
    const candidate = journey({ scoutJourneys: ['session'] });
    const plain = scoreJourney(candidate, scoring);
    const signaled = scoreJourney(candidate, scoring, {
      escapedDefectIds: [candidate.id],
      scoutJourneys: ['session'],
    });
    assert.equal(signaled.score - plain.score, scoring.escapedDefect + scoring.scoutSignal);
    assert.equal(signaled.escapedDefectMatch, true);
    assert.equal(signaled.scoutSignalMatch, true);
  });

  void it('selects exactly one highest score with an id tie-break', () => {
    const lower = journey({
      id: 'LODY-TEST-003',
      signals: { ...journey().signals, criticality: 2 },
    });
    const tiedLast = journey({
      id: 'LODY-TEST-002',
      actions: [{ id: 'second.open' }],
    });
    const tiedFirst = journey({
      id: 'LODY-TEST-001',
      actions: [{ id: 'first.open' }],
    });
    const result = selectJourneyCandidate(
      { schemaVersion: 1, scoring, journeys: [lower, tiedLast, tiedFirst] },
      []
    );
    assert.equal(result.selected?.id, 'LODY-TEST-001');
    assert.equal(result.considered, 3);
  });

  void it('deduplicates backlog contracts and contracts already active', () => {
    const active = journey({ id: 'LODY-ACTIVE-001', state: 'active', feature: 'active.feature' });
    const covered = journey({ id: 'LODY-COVERED-001' });
    const unique = journey({ id: 'LODY-UNIQUE-001', actions: [{ id: 'unique.open' }] });
    const repeated = journey({ id: 'LODY-UNIQUE-002', actions: [{ id: 'unique.open' }] });
    const result = selectJourneyCandidate(
      { schemaVersion: 1, scoring, journeys: [active, covered, repeated, unique] },
      []
    );
    assert.equal(result.considered, 1);
    assert.equal(result.selected?.id, 'LODY-UNIQUE-001');
    assert.deepEqual(
      result.skippedDuplicates.map(({ id }) => id),
      ['LODY-COVERED-001', 'LODY-UNIQUE-002']
    );
  });

  void it('skips a blocked leader so it cannot stop the queue', () => {
    const blocked = journey({
      id: 'LODY-BLOCKED-001',
      signals: { ...journey().signals, criticality: 5 },
      blockedReason: 'Missing deterministic fixture.',
    });
    const eligible = journey({
      id: 'LODY-ELIGIBLE-001',
      actions: [{ id: 'eligible.open' }],
      signals: { ...journey().signals, criticality: 2 },
    });
    const result = selectJourneyCandidate(
      { schemaVersion: 1, scoring, journeys: [blocked, eligible] },
      []
    );
    assert.equal(result.selected?.id, 'LODY-ELIGIBLE-001');
    assert.deepEqual(result.skippedBlocked, [
      { id: 'LODY-BLOCKED-001', reason: 'Missing deterministic fixture.' },
    ]);
  });

  void it('renders active and backlog rows in deterministic id order', () => {
    const active = journey({
      id: 'LODY-ACTIVE-002',
      state: 'active',
      priority: 'P0',
      feature: 'active.feature',
    });
    const backlogB = journey({ id: 'LODY-BACKLOG-002', actions: [{ id: 'b.open' }] });
    const backlogA = journey({ id: 'LODY-BACKLOG-001', actions: [{ id: 'a.open' }] });
    const markdown = renderCoverage({
      schemaVersion: 1,
      scoring,
      journeys: [backlogB, active, backlogA],
    });
    assert.ok(markdown.indexOf('LODY-BACKLOG-001') < markdown.indexOf('LODY-BACKLOG-002'));
    assert.match(markdown, /This file is generated from/u);
  });
});
