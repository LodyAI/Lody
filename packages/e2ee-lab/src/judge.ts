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

/** Test-only defective importer: treats unverified bytes as authenticated. */
export function defectiveAcceptInvalid(input: {
  invalidRecord: boolean;
  accepted: boolean;
}): JudgeVerdict {
  if (input.invalidRecord && input.accepted) return 'violation';
  if (input.invalidRecord && !input.accepted) return 'pass';
  return 'harness-error';
}
