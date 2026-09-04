/** Per-prompt evidence used to decide whether an automatic replay is safe. */
export type PromptActivityObservation =
  | 'persisted_output'
  | 'dropped_prompt_activity'
  | 'none'
  | 'unknown';

export class PromptActivityRecorder {
  private routed = false;
  private sideEffects = false;
  private successor?: PromptActivityRecorder;

  constructor(private readonly previous?: PromptActivityRecorder) {
    previous?.attachSuccessor(this);
  }

  private attachSuccessor(successor: PromptActivityRecorder): void {
    this.successor = successor;
  }

  recordRouted(): void {
    this.routed = true;
  }

  recordSideEffect(): void {
    this.sideEffects = true;
    // A predecessor-side request can arrive after the steer was accepted but
    // before the successor is bound.
    this.successor?.recordInheritedSideEffect();
    // Permission/file requests can cross a steer handoff. Until this run emits
    // output, conservatively credit the predecessor too.
    if (!this.routed) {
      this.previous?.recordSideEffect();
    }
  }

  private recordInheritedSideEffect(): void {
    this.sideEffects = true;
  }

  observe(): Exclude<PromptActivityObservation, 'unknown'> {
    if (this.routed) return 'persisted_output';
    if (this.sideEffects) return 'dropped_prompt_activity';
    return 'none';
  }
}

export const allowsPromptReplay = (observation: PromptActivityObservation): boolean =>
  observation === 'none';
