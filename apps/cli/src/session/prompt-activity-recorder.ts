/** Per-prompt evidence used to decide whether an automatic replay is safe. */
export type PromptActivityObservation =
  | 'persisted_output'
  | 'dropped_prompt_activity'
  | 'none'
  | 'unknown';

export class PromptActivityRecorder {
  private routed = false;
  private sideEffects = false;

  constructor(private readonly previous?: PromptActivityRecorder) {}

  recordRouted(): void {
    this.routed = true;
  }

  recordSideEffect(): void {
    this.sideEffects = true;
    // Permission/file requests can cross a steer handoff. Until this run emits
    // output, conservatively credit the predecessor too.
    if (!this.routed) {
      this.previous?.recordSideEffect();
    }
  }

  observe(): Exclude<PromptActivityObservation, 'unknown'> {
    if (this.routed) return 'persisted_output';
    if (this.sideEffects) return 'dropped_prompt_activity';
    return 'none';
  }
}

export const allowsPromptReplay = (observation: PromptActivityObservation): boolean =>
  observation === 'none';
