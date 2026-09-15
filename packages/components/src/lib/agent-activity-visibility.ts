import type { SessionStatus } from '@lody/shared';

/**
 * Only the execution owner's explicit phase can distinguish prompt activity
 * from finalization. History and presence arrive independently, so a finished
 * history entry cannot prove that the live turn has stopped thinking.
 */
export const shouldHideThinkingDuringFinalization = (
  liveStatus: SessionStatus | null | undefined
): boolean => liveStatus?.type === 'running' && liveStatus.phase === 'finalizing';
