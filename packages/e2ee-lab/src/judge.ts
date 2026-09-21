export type JudgeVerdict = 'pass' | 'violation' | 'unavailable' | 'outside-model' | 'harness-error';

export interface JudgeReport {
  readonly confidentiality: JudgeVerdict;
  readonly integrity: JudgeVerdict;
  readonly durability: JudgeVerdict;
}

export function honestBaselineReport(): JudgeReport {
  return {
    confidentiality: 'pass',
    integrity: 'pass',
    durability: 'pass',
  };
}

export interface ScenarioRecord {
  readonly name: string;
  readonly control: string;
  readonly attack: string;
  readonly expected: JudgeVerdict;
  readonly actual: JudgeVerdict;
}

/**
 * Integrity of an honest import. Backend extra bytes are diagnostic only.
 * `ledgerLength > expectedLength` is not by itself a client integrity loss.
 */
export function judgeImport(input: {
  rejected: boolean;
  ledgerLength: number;
  expectedLength: number;
}): JudgeVerdict {
  if (input.rejected && input.ledgerLength === input.expectedLength) return 'pass';
  if (!input.rejected && input.ledgerLength >= input.expectedLength) return 'pass';
  return 'harness-error';
}

/** Client-verified facts only. Missing observation is not a pass. */
export function judgeClientIntegrity(input: {
  observed: boolean;
  acceptedUnauthorized: boolean;
}): JudgeVerdict {
  if (!input.observed) return 'harness-error';
  return input.acceptedUnauthorized ? 'violation' : 'pass';
}

export function judgeClientDurability(input: {
  observed: boolean;
  cursorAheadOfDocument: boolean;
  lostDurableData: boolean;
}): JudgeVerdict {
  if (!input.observed) return 'harness-error';
  if (input.cursorAheadOfDocument || input.lostDurableData) return 'violation';
  return 'pass';
}

export function judgeLeak(input: { backendContainsPlaintext: boolean }): JudgeVerdict {
  return input.backendContainsPlaintext ? 'violation' : 'pass';
}

export function judgeCursor(input: {
  rejected: boolean;
  cursorAdvancedPastBad: boolean;
}): JudgeVerdict {
  if (input.cursorAdvancedPastBad) return 'violation';
  return input.rejected ? 'pass' : 'harness-error';
}

export function judgeUnauthorized(input: { inAuthenticatedState: boolean }): JudgeVerdict {
  return input.inAuthenticatedState ? 'violation' : 'pass';
}

export function judgeFork(input: {
  independentEvidence: boolean;
  displayedChecked: boolean;
}): JudgeVerdict {
  if (input.displayedChecked && !input.independentEvidence) return 'violation';
  if (!input.independentEvidence) return 'outside-model';
  return 'pass';
}

/**
 * Content sealed by a device that lacks current document-write rights.
 * Under an honest host this should not land; under a malicious Riverrun that
 * colludes with a revoked/guest holder of an epoch key, open still succeeds —
 * that is a stated model limit, not a silent pass.
 */
export function judgeUnauthorizedContent(input: {
  observed: boolean;
  acceptedUnauthorizedWriter: boolean;
}): JudgeVerdict {
  if (!input.observed) return 'harness-error';
  if (input.acceptedUnauthorizedWriter) return 'outside-model';
  return 'pass';
}

/**
 * Wire attack claims to measured facts. Unsupported kinds without matching
 * facts do not invent a violation (Agent claims are not verdicts).
 */
export function judgeClaim(input: {
  kind: 'plaintext' | 'forged-accepted' | 'cursor-overrun';
  plaintextRecovered?: boolean;
  unverifiedAccepted?: number;
  cursorAhead?: boolean;
}): JudgeVerdict {
  if (input.kind === 'plaintext') {
    return input.plaintextRecovered ? 'violation' : 'pass';
  }
  if (input.kind === 'forged-accepted') {
    if (input.unverifiedAccepted === undefined) return 'harness-error';
    return input.unverifiedAccepted > 0 ? 'violation' : 'pass';
  }
  if (input.cursorAhead === undefined) return 'harness-error';
  return input.cursorAhead ? 'violation' : 'pass';
}

/**
 * Compose finish integrity from measured client facts and claims.
 * Priority: harness-error → violation → outside-model → pass.
 * Backend reject of forged control records is not a client integrity loss.
 */
export function composeIntegrity(input: {
  observed: boolean;
  acceptedUnauthorized: boolean;
  unauthorizedContentAccepted?: boolean;
  wrongContextAccepted?: boolean;
  claims?: readonly {
    kind: 'plaintext' | 'forged-accepted' | 'cursor-overrun';
    plaintextRecovered?: boolean;
    unverifiedAccepted?: number;
    cursorAhead?: boolean;
  }[];
}): JudgeVerdict {
  if (!input.observed) return 'harness-error';
  const parts: JudgeVerdict[] = [
    judgeClientIntegrity({
      observed: true,
      acceptedUnauthorized: input.acceptedUnauthorized,
    }),
  ];
  if (input.wrongContextAccepted) parts.push('violation');
  if (input.unauthorizedContentAccepted !== undefined) {
    parts.push(
      judgeUnauthorizedContent({
        observed: true,
        acceptedUnauthorizedWriter: input.unauthorizedContentAccepted,
      })
    );
  }
  for (const claim of input.claims ?? []) {
    if (claim.kind === 'forged-accepted') parts.push(judgeClaim(claim));
  }
  if (parts.includes('harness-error')) return 'harness-error';
  if (parts.includes('violation')) return 'violation';
  if (parts.includes('outside-model')) return 'outside-model';
  return 'pass';
}

export function composeDurability(input: {
  observed: boolean;
  cursorAheadOfDocument: boolean;
  lostDurableData: boolean;
  claims?: readonly { kind: string; cursorAhead?: boolean }[];
}): JudgeVerdict {
  if (!input.observed) return 'harness-error';
  const base = judgeClientDurability({
    observed: true,
    cursorAheadOfDocument: input.cursorAheadOfDocument,
    lostDurableData: input.lostDurableData,
  });
  if (base === 'violation') return 'violation';
  for (const claim of input.claims ?? []) {
    if (claim.kind !== 'cursor-overrun') continue;
    const claimed = judgeClaim({
      kind: 'cursor-overrun',
      cursorAhead: claim.cursorAhead ?? input.cursorAheadOfDocument,
    });
    if (claimed === 'violation') return 'violation';
    if (claimed === 'harness-error') return 'harness-error';
  }
  return base;
}

/** Test-only defective importer: treats unverified bytes as authenticated. */
export function defectiveAcceptInvalid(input: {
  invalidRecord: boolean;
  accepted: boolean;
}): JudgeVerdict {
  if (input.invalidRecord && input.accepted) return 'violation';
  if (input.invalidRecord && !input.accepted) return 'pass';
  return 'harness-error';
}
