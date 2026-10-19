/**
 * The step a Session start was in when it failed. `SessionManager.createSession`
 * reports each step as it begins; the turn keeps the last one so a failure names
 * where it happened without wrapping (and re-classifying) the original error.
 */
export type SessionStartStage =
  | 'credentials'
  | 'workdir'
  | 'worktree'
  | 'worktree-setup'
  | 'sandbox'
  | 'git-identity'
  | 'agent-runtime'
  | 'agent-start';

const STAGE_LABELS: Record<SessionStartStage, string> = {
  credentials: 'Preparing repository credentials',
  workdir: 'Preparing the working directory',
  worktree: 'Preparing the worktree',
  'worktree-setup': 'Running the worktree setup script',
  sandbox: 'Preparing the agent sandbox',
  'git-identity': 'Resolving the Git identity',
  'agent-runtime': 'Resolving the agent runtime',
  'agent-start': 'Starting the agent',
};

/** User-visible failure text: the step first, then the error's own message. */
export const describeSessionStartFailure = (
  stage: SessionStartStage | undefined,
  message: string
): string => (stage ? `${STAGE_LABELS[stage]} failed: ${message}` : message);

/** Delays before the second and third start attempts; their count bounds the retries. */
export const SESSION_START_RETRY_DELAYS_MS = [1_000, 3_000] as const;

/**
 * The OS was momentarily out of processes, descriptors or memory. Only these are
 * retried: they were observed failing starts that succeeded when resent, and the
 * same request can succeed once the resource frees up. Anything else stays final.
 */
const TRANSIENT_SYSTEM_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM']);

export const isTransientSessionStartError = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_SYSTEM_CODES.has(code)) return true;
    if (value instanceof AggregateError && value.errors.some(visit)) return true;
    return visit((value as { cause?: unknown }).cause);
  };
  return visit(error);
};

/**
 * Whether a failed start may run again, and how. A start that never reached the
 * worktree setup script repeats as-is; one that finished it repeats as a resume so
 * the script is skipped; one that failed while the script ran never repeats,
 * because a user script is not known to be safe to run twice.
 */
const RETRY_MODE_BY_STAGE: Record<SessionStartStage, 'repeat' | 'resume' | 'none'> = {
  credentials: 'repeat',
  workdir: 'repeat',
  worktree: 'repeat',
  'worktree-setup': 'none',
  sandbox: 'resume',
  'git-identity': 'resume',
  'agent-runtime': 'resume',
  'agent-start': 'resume',
};

export const sessionStartRetryMode = (
  stage: SessionStartStage | undefined,
  resume: boolean
): 'repeat' | 'resume' | 'none' => {
  if (stage === undefined) return 'repeat';
  const mode = RETRY_MODE_BY_STAGE[stage];
  // A resumed start skips the script whenever its worktree already exists.
  return resume && mode === 'resume' ? 'repeat' : mode;
};

/**
 * A failed start whose cleanup could not confirm it terminated the partial agent or
 * released its credentials. Retrying it would stack a fresh attempt on leaked
 * resources, exactly when the machine is short of them, so it fails instead.
 * Keyed by the original error object, which is never wrapped.
 */
const incompleteStartCleanup = new WeakSet<object>();

export const recordIncompleteStartCleanup = (error: unknown): void => {
  if (typeof error === 'object' && error !== null) incompleteStartCleanup.add(error);
};

export const hadIncompleteStartCleanup = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && incompleteStartCleanup.has(error);

/**
 * Retries a daemon may start per window across all of its Sessions. A temporary OS
 * failure usually hits the whole machine, so per-turn retries alone would multiply
 * load exactly when it is exhausted.
 */
export const SESSION_START_RETRY_BUDGET = { limit: 6, windowMs: 60_000 } as const;

/** Takes one retry from `startedAt` (pruned in place) if the window allows it. */
export const takeSessionStartRetry = (
  startedAt: number[],
  now: number,
  budget: { readonly limit: number; readonly windowMs: number } = SESSION_START_RETRY_BUDGET
): boolean => {
  for (let oldest = startedAt[0]; oldest !== undefined && now - oldest >= budget.windowMs;) {
    startedAt.shift();
    oldest = startedAt[0];
  }
  if (startedAt.length >= budget.limit) return false;
  startedAt.push(now);
  return true;
};

/** Equal jitter: half the delay is fixed, half random, so failed turns spread out. */
export const jitterSessionStartRetryDelay = (delayMs: number, random: number): number =>
  Math.round(delayMs / 2 + (delayMs / 2) * random);
