/**
 * Per-prompt record of "did this turn possibly act?", used to decide whether an
 * automatic prompt replay is safe.
 *
 * ## Why this exists rather than reading turn state
 *
 * The replay gate used to read `acpFlushCountInTurn`, which `clearTurnState`
 * zeroes — so the gate erased its own evidence exactly when a turn ended, which
 * is when the gate gets consulted. And it only ever saw ACP `session/update`
 * notifications, while `session/request_permission` and `fs/write_text_file` are
 * independent JSON-RPC requests that never pass through `enqueueACPUpdate`. A
 * turn could therefore approve a permission, run a tool, write files, and still
 * read as "produced nothing", which authorized replaying a prompt whose tools had
 * already run.
 *
 * One recorder belongs to one `PromptHandoffRun`: the fiber holds it, a steer
 * carries it along the successor chain, and it dies with the run. Boundedness is
 * therefore constructional — at most one live recorder per session — so there is
 * no key design and no eviction policy.
 *
 * ## Deliberate scope
 *
 * Created at BIND time, not at `beginTurn`. The `beginTurn → bind` window is
 * exactly where a resume fallback's pre-prompt startup updates arrive, and those
 * belong to session startup rather than to the user's turn. Excluding them is the
 * intent, not a gap — do not "fix" it by moving construction earlier.
 *
 * Process restart loses every recorder, which reads as `unknown` and refuses
 * replay. Re-dispatch after a restart is a different mechanism (crash replay) and
 * is not in this contract.
 */

export type PromptActivityObservation =
  /** The agent produced output that was routed to a history entry. */
  | 'persisted_output'
  /**
   * The agent may have acted without leaving routed output: an approved
   * permission request, or an `fs/write_text_file`.
   */
  | 'dropped_prompt_activity'
  /** Observed the whole prompt and it did nothing. Only this permits a replay. */
  | 'none'
  /** Not observable — no recorder for this turn. Always fail closed. */
  | 'unknown';

export class PromptActivityRecorder {
  private routed = false;
  private sideEffects = false;
  /**
   * Latched by this run's first routed update. Until then, side-effect signals
   * are ALSO credited to the predecessor run — see `recordSideEffect`.
   */
  private tookOver = false;

  /**
   * @param previous The run this one succeeded via an applied steer, if any.
   */
  constructor(private readonly previous?: PromptActivityRecorder) {}

  recordRouted(): void {
    this.routed = true;
    this.tookOver = true;
  }

  /**
   * A permission request or an `fs/write_text_file`.
   *
   * `steerApplicationBarrier` only guards `session/update` — in `agent-client.ts`
   * exactly one `await` of it, in `sessionUpdate`. `requestPermission` and
   * `writeTextFile` are NOT covered, so during a steer handover a side effect the
   * PREDECESSOR caused can arrive after the successor has bound. Attribution is
   * genuinely ambiguous there, and the conservative answer is the predecessor:
   * that is the run which may already have acted and whose replay must be
   * refused. Crediting both is deliberate — over-refusing a replay is safe, while
   * losing the signal is not.
   */
  recordSideEffect(): void {
    this.sideEffects = true;
    if (!this.tookOver) {
      this.previous?.recordSideEffect();
    }
  }

  observe(): Exclude<PromptActivityObservation, 'unknown'> {
    if (this.routed) {
      return 'persisted_output';
    }
    if (this.sideEffects) {
      return 'dropped_prompt_activity';
    }
    return 'none';
  }
}

/** Only a positive "this prompt did nothing" permits an automatic replay. */
export const allowsPromptReplay = (observation: PromptActivityObservation): boolean =>
  observation === 'none';
