import type { JudgeReport, JudgeVerdict } from './judge';

export interface FailureFingerprint {
  readonly rules: readonly string[];
  readonly confidentiality: JudgeVerdict;
  readonly integrity: JudgeVerdict;
  readonly durability: JudgeVerdict;
  readonly detectability?: JudgeVerdict;
  readonly related: {
    readonly ledgerRecords?: number | null;
    readonly unverifiedAccepted?: number;
    readonly cursorAhead?: boolean;
    readonly durableLoss?: boolean;
    readonly wrongContext?: boolean;
  };
}
export interface FingerprintFacts {
  readonly unverifiedAccepted?: number;
  readonly cursorAhead?: boolean;
  readonly durableLoss?: boolean;
  readonly wrongContextAccepted?: boolean;
  readonly acceptedUnauthorized?: boolean;
  readonly verifiedRecords?: number | null;
}
/** Private measured-report projection, not an attacker assertion or wire decoder. */
export interface FingerprintReport extends JudgeReport {
  readonly detectability?: JudgeVerdict;
  readonly properties?: readonly { readonly id: string; readonly verdict: JudgeVerdict }[];
}
export function fingerprintOf(
  report: FingerprintReport,
  facts: FingerprintFacts = {}
): FailureFingerprint {
  const observed: FingerprintFacts = {
    unverifiedAccepted: facts.unverifiedAccepted,
    cursorAhead: facts.cursorAhead,
    durableLoss: facts.durableLoss,
    wrongContextAccepted: facts.wrongContextAccepted,
    acceptedUnauthorized: facts.acceptedUnauthorized,
    verifiedRecords: facts.verifiedRecords,
  };
  const measured: FingerprintReport = {
    confidentiality: report.confidentiality,
    integrity: report.integrity,
    durability: report.durability,
    detectability: report.detectability,
    properties: report.properties?.map((row) => ({ id: row.id, verdict: row.verdict })),
  };
  const rules: string[] = [];
  if (measured.integrity === 'violation') {
    if (observed.unverifiedAccepted !== undefined && observed.unverifiedAccepted > 0)
      rules.push('integrity.unverified-accepted');
    if (observed.wrongContextAccepted === true) rules.push('integrity.wrong-context');
    if (observed.acceptedUnauthorized === true && observed.unverifiedAccepted === 0)
      rules.push('integrity.unauthorized');
    if (rules.length === 0) rules.push('integrity.violation');
  }
  if (measured.durability === 'violation') {
    if (observed.cursorAhead === true) rules.push('durability.cursor-ahead');
    if (observed.durableLoss === true) rules.push('durability.lost-document');
    if (observed.cursorAhead !== true && observed.durableLoss !== true)
      rules.push('durability.violation');
  }
  const insider = measured.properties?.find(
    (row) => row.id === 'confidentiality.insider-post-exclusion'
  )?.verdict;
  if (measured.confidentiality === 'violation')
    rules.push(insider === 'violation' ? 'confidentiality.insider' : 'confidentiality.plaintext');
  if (insider === 'outside-model') rules.push('model.stale-control-view');
  if (
    [
      measured.confidentiality,
      measured.integrity,
      measured.durability,
      measured.detectability,
    ].includes('harness-error')
  )
    rules.push('harness.missing-observation');
  return Object.freeze({
    rules: Object.freeze(rules),
    confidentiality: measured.confidentiality,
    integrity: measured.integrity,
    durability: measured.durability,
    detectability: measured.detectability,
    related: Object.freeze({
      ledgerRecords: observed.verifiedRecords,
      unverifiedAccepted: observed.unverifiedAccepted,
      cursorAhead: observed.cursorAhead,
      durableLoss: observed.durableLoss,
      wrongContext: observed.wrongContextAccepted,
    }),
  });
}
const dimensions = ['confidentiality', 'integrity', 'durability', 'detectability'] as const;
const relatedFields = [
  'ledgerRecords',
  'unverifiedAccepted',
  'cursorAhead',
  'durableLoss',
  'wrongContext',
] as const;
export interface FingerprintComparison {
  readonly equal: boolean;
  readonly differences: readonly {
    readonly field: string;
    readonly expected: string;
    readonly actual: string;
  }[];
  readonly unmeasured: readonly string[];
}
const describe = (value: unknown) =>
  value === undefined ? 'unmeasured' : value === null ? 'unavailable' : String(value);
/** Exact replay comparison. Missing observations (including JSON-dropped undefined)
 * are coverage gaps, never evidence of equality. No new serialization is defined. */
export function compareFingerprints(
  left: FailureFingerprint,
  right: FailureFingerprint
): FingerprintComparison {
  const differences: { field: string; expected: string; actual: string }[] = [];
  const unmeasured: string[] = [];
  const compare = (field: string, expected: unknown, actual: unknown) => {
    if (expected === undefined || actual === undefined || expected === null || actual === null)
      unmeasured.push(field);
    if (expected !== actual)
      differences.push({ field, expected: describe(expected), actual: describe(actual) });
  };
  for (const field of dimensions) {
    compare(field, left[field], right[field]);
    if (
      [left[field], right[field]].some(
        (value) => value === 'unavailable' || value === 'harness-error'
      )
    )
      unmeasured.push(field);
  }
  const length = Math.max(left.rules.length, right.rules.length);
  for (let i = 0; i < length; i++) {
    if (left.rules[i] !== right.rules[i])
      differences.push({
        field: `rules.${i}`,
        expected: left.rules[i] ?? 'absent-rule',
        actual: right.rules[i] ?? 'absent-rule',
      });
  }
  for (const field of relatedFields)
    compare(`related.${field}`, left.related[field], right.related[field]);
  return { equal: differences.length === 0 && unmeasured.length === 0, differences, unmeasured };
}
export function fingerprintsEqual(left: FailureFingerprint, right: FailureFingerprint): boolean {
  return compareFingerprints(left, right).equal;
}
const securityDimension = (rule: string) =>
  ['confidentiality', 'integrity', 'durability'].find((dimension) =>
    rule.startsWith(dimension + '.')
  ) as 'confidentiality' | 'integrity' | 'durability' | undefined;
export function isSecurityFingerprint(value: FailureFingerprint): boolean {
  return value.rules.some((rule) => {
    const dimension = securityDimension(rule);
    return dimension !== undefined && value[dimension] === 'violation';
  });
}
export interface SecurityPreservation {
  readonly preserved: boolean;
  readonly coverage: 'complete' | 'partial';
  readonly uncertain: readonly string[];
  readonly reason?:
    | 'not-security'
    | 'rules-changed'
    | 'violation-lost'
    | 'trigger-changed'
    | 'trigger-unmeasured';
}
/** Separate shrink policy: retain the original measured violation/rules and exact
 * known trigger facts. Ledger length may shrink; exact replay still compares it.
 * Unknown unrelated dimensions are reported, never equated or called complete. */
export function preserveSecurityFailure(
  original: FailureFingerprint,
  candidate: FailureFingerprint
): SecurityPreservation {
  const uncertain = [
    ...new Set([
      ...dimensions.filter((field) =>
        [original[field], candidate[field]].some(
          (value) => value === undefined || value === 'unavailable' || value === 'harness-error'
        )
      ),
      ...compareFingerprints(original, candidate).unmeasured,
    ]),
  ];
  const finish = (
    preserved: boolean,
    reason?: SecurityPreservation['reason']
  ): SecurityPreservation => ({
    preserved,
    coverage: uncertain.length ? 'partial' : 'complete',
    uncertain,
    ...(reason ? { reason } : {}),
  });
  if (!isSecurityFingerprint(original)) return finish(false, 'not-security');
  const rules = (value: FailureFingerprint) =>
    value.rules.filter((rule) => !rule.startsWith('harness.'));
  const expected = rules(original),
    actual = rules(candidate);
  if (expected.length !== actual.length || expected.some((rule, i) => rule !== actual[i]))
    return finish(false, 'rules-changed');
  for (const rule of expected) {
    const trigger =
      rule === 'integrity.unverified-accepted'
        ? 'unverifiedAccepted'
        : rule === 'integrity.wrong-context'
          ? 'wrongContext'
          : rule === 'integrity.unauthorized'
            ? 'unverifiedAccepted'
            : rule === 'durability.cursor-ahead'
              ? 'cursorAhead'
              : rule === 'durability.lost-document'
                ? 'durableLoss'
                : undefined;
    const generic = rule === 'integrity.violation' || rule === 'durability.violation';
    if (generic || (trigger !== undefined && original.related[trigger] === undefined)) {
      uncertain.push(`trigger.${rule}`);
      return finish(false, 'trigger-unmeasured');
    }
  }
  const fields = new Set<keyof FailureFingerprint['related']>();
  for (const rule of original.rules) {
    const dimension = securityDimension(rule);
    if (!dimension || original[dimension] !== 'violation') continue;
    if (candidate[dimension] !== 'violation') return finish(false, 'violation-lost');
    if (dimension === 'integrity') {
      fields.add('unverifiedAccepted');
      fields.add('wrongContext');
    }
    if (dimension === 'durability') {
      fields.add('cursorAhead');
      fields.add('durableLoss');
    }
  }
  for (const field of fields) {
    const known = original.related[field];
    if (known !== undefined && known !== null && candidate.related[field] !== known)
      return finish(false, 'trigger-changed');
  }
  return finish(true);
}
