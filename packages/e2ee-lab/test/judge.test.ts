import { describe, expect, it } from 'vitest';
import {
  honestBaselineReport,
  worstVerdict,
  judgeClaim,
  judgeUnauthorizedContent,
  judgeImport,
  judgeClientIntegrity,
  judgeClientDurability,
  judgeLeak,
  judgeInsiderLeak,
  judgeCursor,
  judgeUnauthorized,
  judgeFork,
  composeIntegrity,
  composeDurability,
  judgeWriteObservation,
} from '../src/pure/judge';

describe('measured Lab verdict contracts, not an attack-executor acceptance', () => {
  it('requires an authorization refusal to confirm an independent deny prediction', () => {
    expect(judgeWriteObservation({ expected: 'deny', accepted: true })).toBe('violation');
    for (const refusal of [
      undefined,
      { tag: 'LabContentError', code: 'transport' },
      { tag: 'LabContentError', code: 'missing_read_key' },
      { tag: 'LabHarnessError', code: 'missing-document' },
    ])
      expect(judgeWriteObservation({ expected: 'deny', accepted: false, refusal })).toBe(
        'harness-error'
      );
    expect(
      judgeWriteObservation({
        expected: 'deny',
        accepted: false,
        refusal: { tag: 'ContentError', code: 'unauthorized' },
      })
    ).toBe('pass');
    expect(
      judgeWriteObservation({
        expected: 'deny',
        accepted: false,
        refusal: { tag: 'LedgerFeedError', code: 'forbidden' },
      })
    ).toBe('pass');
    expect(judgeWriteObservation({ expected: 'unmeasured', accepted: true })).toBe('unavailable');
    expect(judgeWriteObservation({ expected: 'allow', accepted: false })).toBe('harness-error');
  });
  it('keeps unmeasured baseline, partial coverage and missing plaintext measurements distinct from pass', () => {
    expect(honestBaselineReport()).toEqual({
      confidentiality: 'unavailable',
      integrity: 'unavailable',
      durability: 'unavailable',
    });
    expect(honestBaselineReport({ integrity: 'pass' })).toEqual({
      confidentiality: 'unavailable',
      integrity: 'pass',
      durability: 'unavailable',
    });
    expect(worstVerdict(['pass', 'unavailable'])).toBe('unavailable');
    expect(worstVerdict([])).toBe('unavailable');
    expect(worstVerdict(['pass', 'unavailable', 'violation'])).toBe('violation');
    expect(judgeClaim({ kind: 'plaintext' })).toBe('harness-error');
    expect(judgeClaim({ kind: 'plaintext', plaintextRecovered: false })).toBe('pass');
    expect(judgeClaim({ kind: 'plaintext', plaintextRecovered: true })).toBe('violation');
    expect(judgeLeak({})).toBe('unavailable');
    expect(judgeInsiderLeak({ observed: false, leaked: false, freshnessBypassed: false })).toBe(
      'unavailable'
    );
  });

  it('does not treat absent per-property observations as measured false, while retaining a separately measured violation', () => {
    expect(judgeClientIntegrity({ observed: true })).toBe('unavailable');
    expect(judgeClientDurability({ observed: true })).toBe('unavailable');
    expect(judgeClientDurability({ observed: true, lostDurableData: true })).toBe('violation');
    expect(judgeInsiderLeak({ observed: true })).toBe('unavailable');
    expect(judgeInsiderLeak({ observed: true, leaked: true })).toBe('unavailable');
    expect(judgeCursor({})).toBe('unavailable');
    expect(judgeCursor({ cursorAdvancedPastBad: true })).toBe('violation');
    expect(judgeUnauthorized({})).toBe('unavailable');
    expect(judgeFork({})).toBe('unavailable');
    expect(judgeUnauthorizedContent({ observed: true })).toBe('unavailable');
    expect(composeDurability({ observed: true })).toBe('unavailable');
  });

  it('distinguishes current unauthorized acceptance from legitimate historical content and explicit freshness model limits', () => {
    expect(judgeUnauthorizedContent({ observed: true, acceptedUnauthorizedWriter: true })).toBe(
      'violation'
    );
    // Independent content authentication supplies this fact: a formerly authorized
    // author remaining in admitted history is not a newly unauthorized writer.
    expect(judgeUnauthorizedContent({ observed: true, acceptedUnauthorizedWriter: false })).toBe(
      'pass'
    );
    expect(judgeUnauthorizedContent({ observed: false, acceptedUnauthorizedWriter: false })).toBe(
      'harness-error'
    );
    expect(judgeInsiderLeak({ observed: true, leaked: true, freshnessBypassed: true })).toBe(
      'outside-model'
    );
    expect(judgeInsiderLeak({ observed: true, leaked: true, freshnessBypassed: false })).toBe(
      'violation'
    );
    expect(judgeInsiderLeak({ observed: true, leaked: false, freshnessBypassed: false })).toBe(
      'pass'
    );
  });

  it('does not use a record count as authenticated history or an agent claim as measured data', () => {
    expect(judgeImport({ rejected: false, ledgerLength: 100, expectedLength: 1 })).toBe(
      'unavailable'
    );
    expect(
      judgeImport({
        rejected: false,
        ledgerLength: 100,
        expectedLength: 1,
        authenticatedHistory: false,
      })
    ).toBe('violation');
    expect(
      judgeImport({
        rejected: true,
        ledgerLength: 1,
        expectedLength: 1,
        authenticatedHistory: true,
      })
    ).toBe('pass');
    expect(
      judgeImport({
        rejected: false,
        ledgerLength: 2,
        expectedLength: 1,
        authenticatedHistory: true,
      })
    ).toBe('pass');
    expect(
      judgeImport({
        rejected: true,
        ledgerLength: 0,
        expectedLength: 1,
        authenticatedHistory: true,
      })
    ).toBe('harness-error');
    for (const count of [-1, NaN, 0.5])
      expect(judgeClaim({ kind: 'forged-accepted', unverifiedAccepted: count })).toBe(
        'harness-error'
      );
    expect(judgeClaim({ kind: 'forged-accepted' })).toBe('harness-error');
    expect(judgeClaim({ kind: 'cursor-overrun' })).toBe('harness-error');
    expect(judgeClaim({ kind: 'forged-accepted', unverifiedAccepted: 1 })).toBe('violation');
    expect(judgeClaim({ kind: 'cursor-overrun', cursorAhead: true })).toBe('violation');
  });

  it('keeps an actual integrity violation visible even when another observation or scan is missing', () => {
    const measured = {
      observed: true,
      acceptedUnauthorized: false,
      unauthorizedContentAccepted: false,
      wrongContextAccepted: false,
    };
    expect(composeIntegrity(measured)).toBe('pass');
    expect(composeIntegrity({ observed: true, acceptedUnauthorized: false })).toBe('unavailable');
    expect(composeIntegrity({ ...measured, contentScanIncomplete: true })).toBe('harness-error');
    expect(
      composeIntegrity({ ...measured, acceptedUnauthorized: true, contentScanIncomplete: true })
    ).toBe('violation');
    expect(composeIntegrity({ ...measured, unauthorizedContentAccepted: true })).toBe('violation');
    expect(composeIntegrity({ ...measured, wrongContextAccepted: true })).toBe('violation');
    expect(composeIntegrity({ ...measured, claims: [{ kind: 'forged-accepted' }] })).toBe(
      'harness-error'
    );
    expect(
      composeIntegrity({
        ...measured,
        claims: [{ kind: 'forged-accepted', unverifiedAccepted: 1 }],
      })
    ).toBe('violation');
    expect(judgeClientIntegrity({ observed: false, acceptedUnauthorized: false })).toBe(
      'harness-error'
    );
  });

  it('retains cursor/data-loss, claims and fork evidence as separate measured outcomes', () => {
    const durable = { observed: true, cursorAheadOfDocument: false, lostDurableData: false };
    expect(composeDurability(durable)).toBe('pass');
    expect(judgeClientDurability({ ...durable, lostDurableData: true })).toBe('violation');
    expect(
      composeDurability({
        ...durable,
        cursorAheadOfDocument: true,
        claims: [{ kind: 'cursor-overrun', cursorAhead: false }],
      })
    ).toBe('violation');
    expect(
      composeDurability({ ...durable, claims: [{ kind: 'cursor-overrun', cursorAhead: true }] })
    ).toBe('violation');
    expect(judgeCursor({ rejected: true, cursorAdvancedPastBad: false })).toBe('pass');
    expect(judgeCursor({ rejected: true, cursorAdvancedPastBad: true })).toBe('violation');
    expect(judgeUnauthorized({ inAuthenticatedState: true })).toBe('violation');
    expect(judgeFork({ independentEvidence: false, displayedChecked: true })).toBe('violation');
    expect(judgeFork({ independentEvidence: false, displayedChecked: false })).toBe(
      'outside-model'
    );
    expect(judgeFork({ independentEvidence: true, displayedChecked: true })).toBe('pass');
  });
});
