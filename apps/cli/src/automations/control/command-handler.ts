import { Clock, Effect } from 'effect';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import type {
  AutomationCommand,
  AutomationProgramContext,
  AutomationWait,
} from '@lody/shared/automations';
import type { Lody } from '@/lib/lody';
import type { AutomationLedger } from '../storage/ledger';
import type { ManagedRuns } from '../runtime/managed-runs';
import { resolveAutomationCwd } from '../context/exec';
import { evaluateAutomationProgram } from '../programs/codemode';
import { sessionPolicySettings } from '../policies/session';
import type { DeliveryCoordinator } from '../policies/delivery-coordinator';
import { actionActivity, publicActivity, workActivity } from './activities';

export type CommandHandlerDeps = {
  ledger: AutomationLedger;
  lody: Lody;
  machineId: string;
  managedRunLogs: string;
  delivery: DeliveryCoordinator;
  isClosing(): boolean;
  getManagedRuns(): ManagedRuns | undefined;
  assertCanEdit(sessionId: string, userId: string): Promise<void>;
  sessionContext(sessionId: string, userId: string): Promise<AutomationProgramContext>;
  runEffect<A>(effect: Effect.Effect<A, unknown>): Promise<A>;
  wake(): Promise<void>;
  cancelInvocation(id: string): Promise<void>;
};

export function publicWait(ledger: AutomationLedger, wait: AutomationWait) {
  const receipt = wait.invocationId && ledger.receipt(wait.invocationId);
  return {
    ...wait,
    ...(receipt
      ? {
          continuation: {
            id: receipt.id,
            state: receipt.state,
            reason: receipt.reason,
            turnId: receipt.turnId,
            attempts: receipt.attempts,
            retryAt: receipt.retryAt,
          },
        }
      : {}),
  };
}

export async function executeAutomationCommand(
  deps: CommandHandlerDeps,
  command: AutomationCommand,
  principal: string,
  requesterSessionId?: string
): Promise<unknown> {
  const { ledger, lody, machineId, managedRunLogs, delivery } = deps;
  const assertReadable = async (wait: AutomationWait, userId: string) => {
    if (wait.ownerMachineId !== machineId) throw new Error('AUTOMATION_NOT_FOUND');
    await deps.assertCanEdit(wait.sessionId, userId);
  };
  const now = await deps.runEffect(Clock.currentTimeMillis);
  switch (command.type) {
    case 'register': {
      const sessionId = command.sessionId ?? requesterSessionId;
      if (!sessionId) throw new Error('AUTOMATION_SESSION_REQUIRED');
      const context = await deps.sessionContext(sessionId, principal);
      if (command.expiresAt !== undefined && command.expiresAt <= now)
        throw new Error('AUTOMATION_ALREADY_EXPIRED');
      await deps.runEffect(
        evaluateAutomationProgram(
          command.program,
          context,
          () => Effect.fail(new Error('AUTOMATION_VALIDATION_HAS_NO_READS')),
          true
        )
      );
      if (deps.isClosing()) throw new Error('AUTOMATION_OWNER_CLOSING');
      const { type: _type, sessionId: _session, ...registration } = command;
      const wait = ledger.registerWait(registration, sessionId, principal, now);
      await deps.wake();
      return publicWait(ledger, wait);
    }
    case 'run': {
      const sessionId = command.sessionId ?? requesterSessionId;
      if (!sessionId) throw new Error('AUTOMATION_SESSION_REQUIRED');
      await deps.sessionContext(sessionId, principal);
      const root = await lody.resolveAutomationWorkdir(sessionId as SessionId);
      if (!root) throw new Error('AUTOMATION_EXEC_WORKSPACE_UNAVAILABLE');
      await deps.runEffect(resolveAutomationCwd(root, command.cwd));
      if (deps.isClosing()) throw new Error('AUTOMATION_OWNER_CLOSING');
      const { type: _type, sessionId: _session, ...run } = command;
      const wait = ledger.registerRun(run, sessionId, principal, managedRunLogs, now);
      await deps.wake();
      return publicWait(ledger, wait);
    }
    case 'settings':
    case 'configure': {
      const sessionId = command.sessionId ?? requesterSessionId;
      if (!sessionId) throw new Error('AUTOMATION_SESSION_REQUIRED');
      await deps.sessionContext(sessionId, principal);
      if (command.type === 'configure') {
        const record =
          command.settings.recoverCapacity === true
            ? await lody.documentManager.repo.getDocMeta(getSessionRoomId(sessionId as SessionId))
            : undefined;
        const meta = record?.meta as SessionMeta | undefined;
        const currentTurn =
          meta?.machineId === machineId && !isLoroRepoDocDeleted(record)
            ? meta.latestUserMsgId
            : undefined;
        await delivery.configureSession({
          sessionId,
          principal,
          settings: command.settings,
          currentTurn,
          runEffect: deps.runEffect,
          cancelReceipt: deps.cancelInvocation,
        });
      }
      await deps.wake();
      return sessionPolicySettings(ledger, sessionId);
    }
    case 'list': {
      const sessionId = command.sessionId ?? requesterSessionId;
      if (sessionId) await deps.assertCanEdit(sessionId, principal);
      return ledger
        .waits(sessionId ? undefined : principal, sessionId)
        .map((wait) => publicWait(ledger, wait));
    }
    case 'show': {
      const wait = ledger.wait(command.id);
      if (!wait) throw new Error('AUTOMATION_NOT_FOUND');
      await assertReadable(wait, principal);
      return publicWait(ledger, wait);
    }
    case 'activities': {
      const sessionId = command.sessionId ?? requesterSessionId;
      if (sessionId) await deps.assertCanEdit(sessionId, principal);
      const page = ledger.activityPage(
        sessionId ? undefined : principal,
        sessionId,
        command.limit,
        command.before
      );
      return { ...page, items: page.items.map(publicActivity) };
    }
    case 'cancel': {
      const wait = ledger.wait(command.id);
      if (wait) {
        await assertReadable(wait, principal);
        await deps.cancelInvocation(wait.id);
        const owner = deps.getManagedRuns();
        if (wait.run && owner) await deps.runEffect(owner.stop(wait.id));
        const current = ledger.wait(wait.id);
        return current && publicWait(ledger, current);
      }
      const receipt = ledger.receipt(command.id);
      if (!receipt) {
        const work = ledger.work(command.id);
        if (!work) throw new Error('AUTOMATION_NOT_FOUND');
        await deps.assertCanEdit(work.sessionId, principal);
        ledger.putWork({ ...work, state: 'cancelled', updatedAt: now });
        if (work.invocationId) await deps.cancelInvocation(work.invocationId);
        await deps.wake();
        const current = ledger.work(command.id);
        return current ? workActivity(current) : undefined;
      }
      await deps.assertCanEdit(receipt.sessionId, principal);
      await deps.cancelInvocation(command.id);
      const current = ledger.receipt(command.id);
      return current ? actionActivity(current) : undefined;
    }
  }
  throw new Error('AUTOMATION_COMMAND_UNSUPPORTED');
}
