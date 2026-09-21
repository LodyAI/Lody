import type { JudgeVerdict } from './judge';
import type { PublicReport } from './attack-lab';

/** Rule ids plus related state. A lone pass/violation bit is not a fingerprint. */
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

export function fingerprintOf(
  report: PublicReport,
  facts: FingerprintFacts = {}
): FailureFingerprint {
  const rules: string[] = [];
  if (report.integrity === 'violation') {
    if ((facts.unverifiedAccepted ?? 0) > 0) rules.push('integrity.unverified-accepted');
    if (facts.wrongContextAccepted) rules.push('integrity.wrong-context');
    if (facts.acceptedUnauthorized && (facts.unverifiedAccepted ?? 0) === 0) {
      rules.push('integrity.unauthorized');
    }
    if (rules.every((rule) => !rule.startsWith('integrity.'))) rules.push('integrity.violation');
  }
  if (report.durability === 'violation') {
    if (facts.cursorAhead) rules.push('durability.cursor-ahead');
    if (facts.durableLoss) rules.push('durability.lost-document');
    if (!facts.cursorAhead && !facts.durableLoss) rules.push('durability.violation');
  }
  if (report.confidentiality === 'violation') rules.push('confidentiality.plaintext');
  if (report.integrity === 'outside-model' || report.detectability === 'outside-model') {
    rules.push('model.unauthorized-content');
  }
  if (report.integrity === 'harness-error' || report.durability === 'harness-error') {
    rules.push('harness.missing-observation');
  }
  return {
    rules,
    confidentiality: report.confidentiality,
    integrity: report.integrity,
    durability: report.durability,
    detectability: report.detectability,
    related: {
      ledgerRecords: facts.verifiedRecords,
      unverifiedAccepted: facts.unverifiedAccepted,
      cursorAhead: facts.cursorAhead,
      durableLoss: facts.durableLoss,
      wrongContext: facts.wrongContextAccepted,
    },
  };
}

export function fingerprintsEqual(left: FailureFingerprint, right: FailureFingerprint): boolean {
  if (left.confidentiality !== right.confidentiality) return false;
  if (left.integrity !== right.integrity) return false;
  if (left.durability !== right.durability) return false;
  if (left.rules.length !== right.rules.length) return false;
  for (let i = 0; i < left.rules.length; i++) {
    if (left.rules[i] !== right.rules[i]) return false;
  }
  return (
    left.related.unverifiedAccepted === right.related.unverifiedAccepted &&
    left.related.cursorAhead === right.related.cursorAhead &&
    left.related.durableLoss === right.related.durableLoss &&
    left.related.wrongContext === right.related.wrongContext
  );
}

export function isSecurityFingerprint(fingerprint: FailureFingerprint): boolean {
  if (fingerprint.integrity === 'harness-error' || fingerprint.durability === 'harness-error') {
    return false;
  }
  return fingerprint.rules.some(
    (rule) =>
      rule.startsWith('integrity.') ||
      rule.startsWith('durability.') ||
      rule.startsWith('confidentiality.')
  );
}
