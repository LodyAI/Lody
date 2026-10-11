import { randomUUID } from 'node:crypto';
import { RoostHostError } from '@loro-dev/roost-node';
import { version } from '@/pkg';
import { getDesktopBuildDescription } from '@/utils/desktop-build';
import { getLogger, type Logger } from '@/utils/logger';

type FailureContext = {
  readonly stage: 'initialize' | 'worker' | 'read' | 'write' | 'close';
  readonly sessionId?: string;
  readonly operation?: string;
  readonly exitCode?: number;
};

const diagnosticIds = new WeakMap<Error, string>();
const failureStages = new WeakMap<Error, FailureContext['stage']>();
const codes = new Set([
  'workerFailed',
  'workerExited',
  'nativeUnavailable',
  'protocol',
  'storage',
  'closed',
  'unknownOutcome',
  'notDispatched',
  'closeTimeout',
  'invalid',
  'pending',
  'conflict',
  'sealed',
  'stale',
  'unauthorized',
  'messageLimit',
  'queueLimit',
  'cancelledBeforeDispatch',
]);

export class RoostHistoryFailure extends Error {
  constructor(
    readonly diagnosticId: string,
    readonly code: string,
    readonly stage: FailureContext['stage'],
    cause: unknown
  ) {
    // This is the only evidence transported to other machines/renderers.
    super(`Roost history ${stage} failed (code=${code}; diagnostic=${diagnosticId})`, { cause });
    this.name = 'RoostHistoryFailure';
  }
}

function errorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  while (error instanceof Error && chain.length < 8 && !chain.includes(error)) {
    chain.push(error);
    error = error.cause;
  }
  return chain;
}

export function reportRoostHistoryFailure(
  error: unknown,
  context: FailureContext,
  logger: Pick<Logger, 'error'> = getLogger('roost-history')
): RoostHistoryFailure {
  const chain = errorChain(error);
  const diagnosticId = chain.map((entry) => diagnosticIds.get(entry)).find(Boolean) ?? randomUUID();
  const stage =
    chain.map((entry) => failureStages.get(entry)).find((value) => value && value !== 'worker') ??
    context.stage;
  for (const entry of chain) {
    diagnosticIds.set(entry, diagnosticId);
    failureStages.set(entry, stage);
  }
  const code =
    chain
      .filter((entry) => entry instanceof RoostHostError)
      .map((entry) => entry.code)
      .find((value) => codes.has(value)) ?? 'historyFailure';
  const failure =
    error instanceof RoostHistoryFailure
      ? error
      : new RoostHistoryFailure(diagnosticId, code, stage, error);
  diagnosticIds.set(failure, diagnosticId);
  try {
    logger.error('Roost history failure', {
      diagnosticId,
      backend: 'roost',
      ...context,
      originStage: failure.stage,
      code: failure.code,
      cliVersion: version,
      desktopBuild: getDesktopBuildDescription(),
      node: process.versions.node,
      electron: process.versions.electron,
      napi: process.versions.napi,
      platform: process.platform,
      arch: process.arch,
      // Explicit Error fields only: no history/request payloads, options,
      // credential-store seed, or arbitrary properties on a thrown object.
      errors: chain.map((entry) => ({
        name: entry.name,
        message: entry.message,
        stack: entry.stack,
      })),
    });
  } catch {
    // Diagnostic sink failure must not replace the storage failure.
  }
  return failure;
}

/** Keep the history RPC envelope compatible, and raw causes on the owner only. */
export function describeRoostHistoryFailure(
  error: unknown,
  context: FailureContext
): string | undefined {
  if (
    !(error instanceof Error) ||
    (!(error instanceof RoostHostError) &&
      !(error instanceof RoostHistoryFailure) &&
      !diagnosticIds.has(error))
  )
    return undefined;
  return reportRoostHistoryFailure(error, context).message;
}
