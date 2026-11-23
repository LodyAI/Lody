export type JudgeVerdict = 'pass' | 'violation' | 'unavailable' | 'outside-model' | 'harness-error';

export interface JudgeReport {
  readonly confidentiality: JudgeVerdict;
  readonly integrity: JudgeVerdict;
  readonly durability: JudgeVerdict;
}

export function honestBaselineReport(measured: Partial<JudgeReport> = {}): JudgeReport {
  return {
    confidentiality: measured.confidentiality ?? 'unavailable',
    integrity: measured.integrity ?? 'unavailable',
    durability: measured.durability ?? 'unavailable',
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
  rejected?: boolean;
  ledgerLength: number;
  expectedLength: number;
  /** Independently authenticated retained history; lengths alone prove nothing. */
  authenticatedHistory?: boolean;
}): JudgeVerdict {
  if (input.authenticatedHistory === undefined) return 'unavailable';
  if (!input.authenticatedHistory) return 'violation';
  if (
    !Number.isSafeInteger(input.ledgerLength) ||
    input.ledgerLength < 0 ||
    !Number.isSafeInteger(input.expectedLength) ||
    input.expectedLength < 0
  )
    return 'harness-error';
  if (input.rejected === undefined) return 'unavailable';
  if (input.rejected && input.ledgerLength === input.expectedLength) return 'pass';
  if (!input.rejected && input.ledgerLength >= input.expectedLength) return 'pass';
  return 'harness-error';
}

/** Client-verified facts only. Missing observation is not a pass. */
export function judgeClientIntegrity(input: {
  observed: boolean;
  acceptedUnauthorized?: boolean;
}): JudgeVerdict {
  if (!input.observed) return 'harness-error';
  if (input.acceptedUnauthorized === undefined) return 'unavailable';
  return input.acceptedUnauthorized ? 'violation' : 'pass';
}

export function judgeClientDurability(input: {
  observed: boolean;
  cursorAheadOfDocument?: boolean;
  lostDurableData?: boolean;
}): JudgeVerdict {
  if (!input.observed) return 'harness-error';
  if (input.cursorAheadOfDocument || input.lostDurableData) return 'violation';
  if (input.cursorAheadOfDocument === undefined || input.lostDurableData === undefined)
    return 'unavailable';
  return 'pass';
}

export function judgeLeak(input: { backendContainsPlaintext?: boolean }): JudgeVerdict {
  if (input.backendContainsPlaintext === undefined) return 'unavailable';
  return input.backendContainsPlaintext ? 'violation' : 'pass';
}

/**
 * Content protected from an excluded insider, measured by decrypting server-visible
 * frames with the insider's retained keys. A leak after the attacker withheld control
 * or key records from an honest client bypasses the stated freshness assumption.
 */
export function judgeInsiderLeak(input: {
  observed: boolean;
  leaked?: boolean;
  freshnessBypassed?: boolean;
}): JudgeVerdict {
  if (!input.observed) return 'unavailable';
  if (input.leaked === undefined) return 'unavailable';
  if (!input.leaked) return 'pass';
  if (input.freshnessBypassed === undefined) return 'unavailable';
  return input.freshnessBypassed ? 'outside-model' : 'violation';
}

const SEVERITY: readonly JudgeVerdict[] = [
  'violation',
  'harness-error',
  'outside-model',
  'unavailable',
  'pass',
];

/** Aggregate coverage: an unmeasured part prevents an all-pass verdict. */
export function worstVerdict(parts: readonly JudgeVerdict[]): JudgeVerdict {
  for (const verdict of SEVERITY) if (parts.includes(verdict)) return verdict;
  return 'unavailable';
}

export function judgeCursor(input: {
  rejected?: boolean;
  cursorAdvancedPastBad?: boolean;
}): JudgeVerdict {
  if (input.cursorAdvancedPastBad) return 'violation';
  if (input.rejected === undefined || input.cursorAdvancedPastBad === undefined)
    return 'unavailable';
  return input.rejected ? 'pass' : 'harness-error';
}

export function judgeUnauthorized(input: { inAuthenticatedState?: boolean }): JudgeVerdict {
  if (input.inAuthenticatedState === undefined) return 'unavailable';
  return input.inAuthenticatedState ? 'violation' : 'pass';
}

export function judgeFork(input: {
  independentEvidence?: boolean;
  displayedChecked?: boolean;
}): JudgeVerdict {
  if (input.displayedChecked === undefined || input.independentEvidence === undefined)
    return 'unavailable';
  if (input.displayedChecked && !input.independentEvidence) return 'violation';
  if (!input.independentEvidence) return 'outside-model';
  return 'pass';
}

/** New unauthorized content acceptance violates the public signature/write contract.
 * Revocation does not invalidate a legitimately admitted historical author. */
export function judgeUnauthorizedContent(input: {
  observed: boolean;
  acceptedUnauthorizedWriter?: boolean;
}): JudgeVerdict {
  if (!input.observed) return 'harness-error';
  if (input.acceptedUnauthorizedWriter === undefined) return 'unavailable';
  if (input.acceptedUnauthorizedWriter) return 'violation';
  return 'pass';
}

/** Independent new-write prediction versus an actual operation. A failure for an
 * unrelated reason is not evidence that authorization rejected the write. */
export function judgeWriteObservation(input: {
  readonly expected: 'allow' | 'deny' | 'unmeasured';
  readonly accepted: boolean;
  readonly refusal?: { readonly tag: string; readonly code: string };
}): JudgeVerdict {
  if (input.expected === 'unmeasured') return 'unavailable';
  if (input.accepted) return input.expected === 'deny' ? 'violation' : 'pass';
  if (input.expected === 'allow') return 'harness-error';
  const refusal = input.refusal;
  return (refusal?.tag === 'ContentError' && refusal.code === 'unauthorized') ||
    (refusal?.tag === 'LedgerFeedError' && refusal.code === 'forbidden')
    ? 'pass'
    : 'harness-error';
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
    if (input.plaintextRecovered === undefined) return 'harness-error';
    return input.plaintextRecovered ? 'violation' : 'pass';
  }
  if (input.kind === 'forged-accepted') {
    if (
      input.unverifiedAccepted === undefined ||
      !Number.isSafeInteger(input.unverifiedAccepted) ||
      input.unverifiedAccepted < 0
    )
      return 'harness-error';
    return input.unverifiedAccepted > 0 ? 'violation' : 'pass';
  }
  if (input.cursorAhead === undefined) return 'harness-error';
  return input.cursorAhead ? 'violation' : 'pass';
}

/**
 * Compose finish integrity from measured client facts and claims.
 * A measured violation remains visible alongside incomplete observations.
 * Backend reject of forged control records is not a client integrity loss.
 */
export function composeIntegrity(input: {
  observed: boolean;
  acceptedUnauthorized?: boolean;
  unauthorizedContentAccepted?: boolean;
  contentScanIncomplete?: boolean;
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
  if (input.contentScanIncomplete) parts.push('harness-error');
  if (input.wrongContextAccepted === undefined) parts.push('unavailable');
  else if (input.wrongContextAccepted) parts.push('violation');
  if (input.unauthorizedContentAccepted !== undefined) {
    parts.push(
      judgeUnauthorizedContent({
        observed: true,
        acceptedUnauthorizedWriter: input.unauthorizedContentAccepted,
      })
    );
  } else parts.push('unavailable');
  for (const claim of input.claims ?? []) {
    if (claim.kind === 'forged-accepted') parts.push(judgeClaim(claim));
  }
  return worstVerdict(parts);
}

export function composeDurability(input: {
  observed: boolean;
  cursorAheadOfDocument?: boolean;
  lostDurableData?: boolean;
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
