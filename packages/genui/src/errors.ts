/**
 * One diagnostic channel for every layer: source extraction, JSX parsing,
 * expression evaluation, state declarations and catalog validation. A surface
 * reports problems; it never throws through the model's output.
 */
export interface GenuiDiagnostic {
  readonly phase: 'directives' | 'jsx' | 'state' | 'eval' | 'catalog';
  readonly message: string;
  readonly offset?: number;
}

export class GenuiError extends Error {
  readonly phase: GenuiDiagnostic['phase'];
  readonly offset?: number;

  constructor(phase: GenuiDiagnostic['phase'], message: string, offset?: number) {
    super(message);
    this.name = 'GenuiError';
    this.phase = phase;
    this.offset = offset;
  }

  toDiagnostic(): GenuiDiagnostic {
    return { phase: this.phase, message: this.message, offset: this.offset };
  }
}

export function diagnosticOf(error: unknown, phase: GenuiDiagnostic['phase']): GenuiDiagnostic {
  if (error instanceof GenuiError) return error.toDiagnostic();
  return {
    phase,
    message: error instanceof Error ? error.message : String(error),
  };
}
