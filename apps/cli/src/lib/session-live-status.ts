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
  /** An engine-opened turn (cron fire, task wake) is producing updates. */
  engineTurnActive?: boolean;
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
  // Engine-opened turns own no client-turn state and write no presence, so
  // only their activity marker can report them as running.
  if (args.engineTurnActive) {
    return { state: 'running' };
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
