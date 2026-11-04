import type { SessionStatus } from '@lody/shared';
import type { SessionExecutionSnapshot } from '@/session/session-execution-service';

export type ResolvedSessionLiveStatus = {
  state: 'initializing' | 'running' | 'waiting' | 'unknown';
  reason?: string;
};

export const resolveSessionLiveStatus = (args: {
  presence: SessionStatus | null;
  execution: SessionExecutionSnapshot;
  hasPendingDispatch: boolean;
}): ResolvedSessionLiveStatus => {
  if (args.presence?.type === 'requestPermission') {
    return { state: 'waiting' };
  }
  if (args.presence?.type === 'initializing') {
    return { state: 'initializing' };
  }
  if (args.presence?.type === 'running') {
    return { state: 'running' };
  }
  if (args.execution.releaseBlocked) {
    // Still busy (fork and MCP treat `waiting` as busy), but not `initializing`:
    // the previous turn ended and is waiting to confirm its release.
    return {
      state: 'waiting',
      reason: `The previous turn has not confirmed releasing its resources: ${args.execution.releaseBlocked.reason}`,
    };
  }
  if (args.execution.hasActiveTurn || args.execution.hasBlockingPendingCreate) {
    return { state: 'initializing' };
  }
  if (args.hasPendingDispatch) {
    return { state: 'waiting' };
  }
  return {
    state: 'unknown',
    reason: 'No active session presence or pending daemon work was observed.',
  };
};
