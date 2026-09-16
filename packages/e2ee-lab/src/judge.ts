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

/** Integrity of an honest import. A defective importer that accepts invalid bytes is a violation. */
export function judgeImport(input: {
  rejected: boolean;
  ledgerLength: number;
  expectedLength: number;
}): JudgeVerdict {
  if (!input.rejected && input.ledgerLength > input.expectedLength) return 'violation';
  if (input.rejected && input.ledgerLength === input.expectedLength) return 'pass';
  if (!input.rejected && input.ledgerLength === input.expectedLength) return 'pass';
  return 'harness-error';
}
