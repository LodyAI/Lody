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
