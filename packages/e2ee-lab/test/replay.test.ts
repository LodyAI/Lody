import { describe, expect, it } from 'vitest';
import { Effect, Result } from 'effect';
import {
  fingerprintOf,
  fingerprintsEqual,
  compareFingerprints,
  isSecurityFingerprint,
  preserveSecurityFailure,
  type FailureFingerprint,
} from '../src/pure/fingerprint';
import { minimizeCounterexample } from '../src/pure/minimize';
import { firstReplayDivergence, type ReplayMaterial } from '../src/pure/replay';

function material() {
  return {
    events: [
      {
        eventId: 'e1',
        step: 0,
        time: 100,
        actor: 'alice',
        operation: 'pull',
        phase: 'fetch',
        status: 'completed' as const,
      },
    ],
    entropy: [{ label: 'synthetic-peer', bytes: new Uint8Array([1, 2]) }],
    frames: [
      {
        eventId: 'e1',
        actor: 'alice',
        operation: 'pull',
        phase: 'fetch',
        url: '/ds/synthetic-A/loro',
        requestHex: '0102',
        responseHex: '0304',
        responseStatus: 200,
      },
    ],
  } satisfies ReplayMaterial;
}
describe('recorded fixture replay comparison without resealing', () => {
  it('locates changed resource, actor, event identity, payload, status and entropy rather than treating a final verdict as replay evidence', () => {
    const expected = material();
    expect(firstReplayDivergence(expected, material())).toBeNull();
    for (const [field, value] of [
      ['url', '/ds/synthetic-B/loro'],
      ['actor', 'bob'],
      ['eventId', 'e2'],
      ['requestHex', '0103'],
      ['responseHex', '0305'],
      ['responseStatus', 403],
    ] as const) {
      const actual = material();
      actual.frames[0] = { ...actual.frames[0]!, [field]: value };
      const divergent = firstReplayDivergence(expected, actual)!;
      expect(divergent.index).toBe(0);
      expect(divergent.field).toBe(
        `frame.${field === 'requestHex' ? 'request' : field === 'responseHex' ? 'response' : field === 'responseStatus' ? 'status' : field}`
      );
      expect(divergent.expected).not.toBe(divergent.actual);
    }
    for (const [field, value] of [
      ['eventId', 'e2'],
      ['step', 1],
      ['time', 101],
      ['actor', 'bob'],
      ['operation', 'push'],
      ['phase', 'persist'],
      ['status', 'requested'],
      ['parent', 'none'],
    ] as const) {
      const event = material();
      event.events[0] = { ...event.events[0]!, [field]: value };
      const divergent = firstReplayDivergence(expected, event)!;
      expect(divergent.index).toBe(0);
      expect(divergent.field).toBe(field);
      expect(divergent.expected).not.toBe(divergent.actual);
    }
    const missing = material();
    missing.entropy.length = 0;
    expect(firstReplayDivergence(expected, missing)?.field).toBe('entropy');
    const bytes = material();
    bytes.entropy[0]!.bytes[1] = 3;
    expect(firstReplayDivergence(expected, bytes)?.field).toBe('entropy.bytes');
  });
});

function failure(count = 1, length = 3, durability: 'pass' | 'harness-error' = 'pass') {
  return fingerprintOf(
    { confidentiality: 'pass', integrity: 'violation', durability, detectability: 'pass' },
    {
      unverifiedAccepted: count,
      verifiedRecords: length,
      cursorAhead: false,
      durableLoss: false,
      wrongContextAccepted: false,
    }
  );
}
describe('measured fingerprint equality and separate finite shrink policy', () => {
  it('compares every original field, including detectability and durable ledger count, instead of certifying a different replay', () => {
    const expected = failure();
    expect(fingerprintsEqual(expected, failure())).toBe(true);
    for (const actual of [
      { ...failure(), detectability: 'violation' as const },
      failure(1, 4),
      failure(2),
      { ...failure(), related: { ...failure().related, cursorAhead: true } },
      { ...failure(), rules: [...failure().rules, 'integrity.wrong-context'] },
    ])
      expect(fingerprintsEqual(expected, actual)).toBe(false);
    expect(compareFingerprints(expected, failure(1, 4)).differences).toEqual([
      { field: 'related.ledgerRecords', expected: '3', actual: '4' },
    ]);
    const changedRules = compareFingerprints(expected, {
      ...failure(),
      rules: [...failure().rules, 'integrity.wrong-context'],
    });
    expect(changedRules.unmeasured).toEqual([]);
    expect(changedRules.differences).toEqual([
      { field: 'rules.1', expected: 'absent-rule', actual: 'integrity.wrong-context' },
    ]);
  });
  it('reports missing and JSON-dropped measurements as gaps, never treats two absent values as proven equal', () => {
    const missing = {
      ...failure(),
      detectability: undefined,
      related: { ...failure().related, ledgerRecords: undefined },
    };
    const parsed = JSON.parse(JSON.stringify(missing)) as FailureFingerprint;
    const compared = compareFingerprints(missing, parsed);
    expect(compared.equal).toBe(false);
    expect(compared.differences).toEqual([]);
    expect(compared.unmeasured).toEqual(['detectability', 'related.ledgerRecords']);
    expect(
      fingerprintsEqual(
        { ...failure(), integrity: 'unavailable' },
        { ...failure(), integrity: 'unavailable' }
      )
    ).toBe(false);
    expect(
      fingerprintsEqual(
        { ...failure(), related: { ...failure().related, ledgerRecords: null } },
        { ...failure(), related: { ...failure().related, ledgerRecords: null } }
      )
    ).toBe(false);
  });
  it('retains measured violations alongside an unrelated harness error and reports partial coverage without relaxing their trigger facts', () => {
    const expected = failure();
    const partial = failure(1, 2, 'harness-error');
    expect(isSecurityFingerprint(partial)).toBe(true);
    expect(fingerprintsEqual(expected, partial)).toBe(false);
    const kept = preserveSecurityFailure(expected, partial);
    expect(kept.preserved).toBe(true);
    expect(kept.coverage).toBe('partial');
    expect(kept.uncertain).toContain('durability');
    expect(preserveSecurityFailure(expected, failure(2, 2, 'harness-error'))).toMatchObject({
      preserved: false,
      reason: 'trigger-changed',
    });
    expect(
      preserveSecurityFailure(expected, { ...partial, integrity: 'harness-error' })
    ).toMatchObject({ preserved: false, reason: 'violation-lost' });
    expect(
      preserveSecurityFailure(expected, {
        ...partial,
        related: { ...partial.related, unverifiedAccepted: undefined },
      })
    ).toMatchObject({ preserved: false, reason: 'trigger-changed' });
  });
  it('owns measured primitive fields and rules, with unknown facts staying unknown rather than defaulting to zero', () => {
    const facts = {
      unverifiedAccepted: 1,
      verifiedRecords: 3,
      cursorAhead: false,
      durableLoss: false,
      wrongContextAccepted: false,
    };
    const snapshot = fingerprintOf(
      {
        confidentiality: 'pass',
        integrity: 'violation',
        durability: 'pass',
        detectability: 'pass',
      },
      facts
    );
    facts.unverifiedAccepted = 2;
    expect(snapshot.related.unverifiedAccepted).toBe(1);
    expect(Object.isFrozen(snapshot.rules)).toBe(true);
    expect(Object.isFrozen(snapshot.related)).toBe(true);
    const unknown = fingerprintOf(
      { confidentiality: 'unavailable', integrity: 'violation', durability: 'unavailable' },
      { acceptedUnauthorized: true }
    );
    expect(unknown.related.unverifiedAccepted).toBeUndefined();
    expect(unknown.rules).toContain('integrity.violation');
    expect(fingerprintsEqual(unknown, unknown)).toBe(false);
    expect(preserveSecurityFailure(unknown, unknown)).toMatchObject({
      preserved: false,
      coverage: 'partial',
      reason: 'trigger-unmeasured',
    });
  });
  it('shrinks executed synthetic scalar candidates while retaining a required anchor, original violation and explicit partial observations', async () => {
    const result = await Effect.runPromise(
      minimizeCounterexample({
        items: ['noise', 'violation', 'anchor', 'more-noise'],
        fingerprint: failure(),
        keep: (item) => item === 'anchor',
        run: (candidate) =>
          Effect.succeed({
            fingerprint: candidate.includes('violation')
              ? failure(1, candidate.length, 'harness-error')
              : null,
          }),
      })
    );
    expect(result.items).toEqual(['violation', 'anchor']);
    expect(result.originalSize).toBe(4);
    expect(result.finalSize).toBe(2);
    expect(result.coverage).toBe('partial');
    expect(result.uncertain).toContain('durability');
  });
  it('enforces a finite trial budget before running another candidate and rejects invalid configuration without executing it', async () => {
    const items = ['violation', 'extra', 'noise', 'more-noise'];
    const run = (candidate: readonly string[]) =>
      Effect.succeed({
        fingerprint: candidate.includes('violation') ? failure(1, candidate.length) : null,
      });
    const result = await Effect.runPromise(
      minimizeCounterexample({ items, fingerprint: failure(), run, maxTrials: 1 })
    );
    expect(result.items).toEqual(items);
    expect(result.trials).toBe(1);
    const zero = await Effect.runPromise(
      minimizeCounterexample({
        items,
        fingerprint: failure(),
        maxTrials: 0,
        run: () => Effect.die('zero budget must not execute'),
      })
    );
    expect(zero.items).toEqual(items);
    for (const maxTrials of [-1, 0.5, NaN, Infinity]) {
      const refused = await Effect.runPromise(
        Effect.result(
          minimizeCounterexample({
            items,
            fingerprint: failure(),
            maxTrials,
            run: () => Effect.die('invalid budget must not execute'),
          })
        )
      );
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure.code).toBe('invalid-budget');
    }
  });
  it('refuses shrink without a measured original trigger while retaining the separately reported violation', async () => {
    const generic = fingerprintOf({
      confidentiality: 'pass',
      integrity: 'violation',
      durability: 'pass',
      detectability: 'pass',
    });
    expect(isSecurityFingerprint(generic)).toBe(true);
    const result = await Effect.runPromise(
      Effect.result(
        minimizeCounterexample({
          items: ['violation', 'noise'],
          fingerprint: generic,
          run: () => Effect.die('unmeasured trigger must not execute'),
        })
      )
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.code).toBe('unmeasured-trigger');
    const honest = { ...failure(), integrity: 'pass' as const, rules: [] };
    const refused = await Effect.runPromise(
      Effect.result(
        minimizeCounterexample({
          items: ['violation', 'noise'],
          fingerprint: honest,
          run: () => Effect.die('non-security baseline must not execute'),
        })
      )
    );
    expect(Result.isFailure(refused)).toBe(true);
    if (Result.isFailure(refused)) expect(refused.failure.code).toBe('not-security');
  });
  it('pins the independent original fingerprint before an executed candidate mutates caller facts', async () => {
    const initial = failure();
    const mutable = { ...initial, rules: [...initial.rules], related: { ...initial.related } };
    const result = await Effect.runPromise(
      minimizeCounterexample({
        items: ['violation', 'noise'],
        fingerprint: mutable,
        run: (candidate) =>
          Effect.sync(() => {
            mutable.related.unverifiedAccepted = 2;
            return { fingerprint: candidate.includes('violation') ? failure(2) : null };
          }),
      })
    );
    expect(result.items).toEqual(['violation', 'noise']);
    expect(mutable.related.unverifiedAccepted).toBe(2);
    expect(initial.related.unverifiedAccepted).toBe(1);
  });
  it('propagates a candidate failure instead of accepting it or silently returning a reduced result', async () => {
    const result = await Effect.runPromise(
      Effect.result(
        minimizeCounterexample({
          items: ['violation', 'noise'],
          fingerprint: failure(),
          run: () => Effect.fail('synthetic-observation-failed'),
        })
      )
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toBe('synthetic-observation-failed');
  });
});
