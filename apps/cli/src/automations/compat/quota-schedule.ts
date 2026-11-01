import type { SessionId, SessionMeta } from '@lody/shared';
import { getSessionRoomId, isLoroRepoDocDeleted } from '@lody/shared';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { PreparedSessionInput } from '@/lib/prepared-session-input';
import { matchesQuotaReservation } from '@/lib/schedules/legacy-quota-reservation';
import type { ScheduleRun } from '@/lib/schedules/schedule-store';
import type { SessionAutomationAuthority } from '@/session/session-automation-authority';
import type { AutomationLedger } from '../storage/ledger';

/** The Inbox gate orders this handoff against acceptance of the same failed Turn. */
export async function dispatchQuotaSchedule(options: {
  run: ScheduleRun<PreparedSessionInput>;
  prepared: PreparedSessionInput;
  userId: string;
  ledger: AutomationLedger;
  manager: LoroDocumentManager;
  authority: SessionAutomationAuthority;
}): Promise<'dispatched' | 'discarded'> {
  const { run, prepared, userId, ledger, manager, authority } = options;
  const sessionId = run.sessionId as SessionId;
  return authority.guardInput(sessionId, userId, async () => {
    const works = ledger
      .sessionWork(sessionId, userId)
      .filter((work) => matchesQuotaReservation(run, work.turnId));
    for (const work of works) {
      const receipt = work.invocationId && ledger.receipt(work.invocationId);
      if (receipt && authority.inputAccepted(sessionId, userId, receipt.turnId)) return 'discarded';
    }
    const record = await manager.repo.getDocMeta(getSessionRoomId(sessionId));
    const meta = record?.meta as SessionMeta | undefined;
    if (!record || !meta || isLoroRepoDocDeleted(record)) throw new Error('SESSION_UNAVAILABLE');
    if (!meta.latestUserMsgId || !matchesQuotaReservation(run, meta.latestUserMsgId))
      return 'discarded';
    await manager.repo.upsertDocMeta(getSessionRoomId(sessionId), {
      latestUserMsgId: prepared.userTurn.id,
      lastMissingHistoryUserMsgId: undefined,
    } satisfies Partial<SessionMeta>);
    return 'dispatched';
  });
}
