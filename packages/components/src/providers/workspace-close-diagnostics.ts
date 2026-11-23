import { recordClientLog } from '../lib/client-log';

export type WorkspaceCloseStage =
  | 'dispatch'
  | 'readers'
  | 'pending-input'
  | 'send-resources'
  | 'listeners'
  | 'doc-stores'
  | 'file-index'
  | 'transport'
  | 'io-drain'
  | 'repo'
  | 'content'
  | 'runtime';

/** Local, bounded diagnostics: never copy exception messages, stacks or arbitrary tags. */
export function reportWorkspaceCloseFailure(stage: WorkspaceCloseStage, error: unknown): void {
  const types: string[] = [];
  const seen = new Set<unknown>();
  const visit = (cause: unknown, depth: number): void => {
    if (depth > 3 || types.length >= 8 || seen.has(cause)) return;
    seen.add(cause);
    const name = cause instanceof Error || cause instanceof DOMException ? cause.name : '';
    types.push(
      [
        'Error',
        'AggregateError',
        'AbortError',
        'QuotaExceededError',
        'InvalidStateError',
        'TimeoutError',
        'NotFoundError',
        'SecurityError',
      ].includes(name)
        ? name
        : 'unknown'
    );
    if (cause instanceof AggregateError && Array.isArray(cause.errors))
      for (const child of cause.errors.slice(0, 8)) visit(child, depth + 1);
    if (cause instanceof Error && cause.cause !== undefined) visit(cause.cause, depth + 1);
  };
  try {
    visit(error, 0);
    console.error('Workspace close failed', { stage, causeTypes: types });
    recordClientLog('error', 'runtime.close_failed', 'Workspace close failed', {
      stage,
      causeTypes: types.join(','),
    });
  } catch {
    // Diagnostic sinks cannot change resource ownership or the original failure.
  }
}
