import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import type {
  AutomationOrigin,
  AutomationReceipt,
  ConditionObservation,
} from '@lody/shared/automations';
import type { Lody } from '@/lib/lody';
import type { AuthContext } from '@/lib/command-runtime';
import type { WorkspaceSummary } from '@/lib/workspace';
import { automationIdentity, type AutomationLedger } from '../storage/ledger';
import type { ActionAuthorization, ActionResult } from '../runtime/engine';
import { authorizeAutomationReceipt, isDurableSessionDenial } from './authorization';
import {
  cancelArchiveAction,
  observeCurrentPr,
  prepareArchiveAction,
  reconcileArchiveAction,
  submitArchiveAction,
} from './archive-action';
import { prepareCompactAction } from './compact-action';
import {
  cancelQueueAction,
  prepareInvokeAction,
  reconcileQueueAction,
  submitQueueAction,
} from './invoke-action';

export { isDurableSessionDenial } from './authorization';
export { deliveryRequest } from '../policies/delivery';

/** Registered adapter to the existing Promise Session owner; no Agent execution lives here. */
export class AutomationSessionActionsLegacy {
  private readonly manager;
  private readonly authority;

  constructor(
    private readonly options: {
      lody: Lody;
      auth: AuthContext;
      workspace: WorkspaceSummary;
      ledger: AutomationLedger;
      admission(receipt: AutomationReceipt): Promise<ConditionObservation>;
      capacity(
        bindingId: string,
        modelId: string | undefined,
        receipt: AutomationReceipt
      ): Promise<ConditionObservation>;
    }
  ) {
    this.manager = options.lody.documentManager;
    this.authority = options.lody.getAutomationSessionAuthority();
  }

  private origin(receipt: AutomationReceipt): AutomationOrigin {
    const workId = receipt.prepared?.workId;
    const work = typeof workId === 'string' ? this.options.ledger.work(workId) : undefined;
    return {
      invocationId: receipt.id,
      ruleId: receipt.rule.id,
      ruleRevision: receipt.rule.revision,
      eventRef: automationIdentity(receipt.event.source, receipt.event.id),
      authorizationUserId: receipt.rule.ownerUserId,
      ...(receipt.evidence?.length
        ? {
            expectedHeads: receipt.evidence.map((item) => ({
              repository: item.repository,
              headSha: item.headSha,
            })),
          }
        : {}),
      ...(work ? { workIntentId: work.id, nativeSessionId: work.nativeSessionId } : {}),
    };
  }

  private archiveDeps() {
    return {
      manager: this.manager,
      authority: this.authority,
      ledger: this.options.ledger,
      admission: this.options.admission,
    };
  }

  private invokeDeps() {
    return {
      lody: this.options.lody,
      manager: this.manager,
      authority: this.authority,
      auth: this.options.auth,
      workspace: this.options.workspace,
      ledger: this.options.ledger,
      origin: (receipt: AutomationReceipt) => this.origin(receipt),
      authorize: (receipt: AutomationReceipt) => this.authorize(receipt),
    };
  }

  authorize(receipt: AutomationReceipt): Promise<ActionAuthorization> {
    return authorizeAutomationReceipt(
      {
        ledger: this.options.ledger,
        manager: this.manager,
        authority: this.authority,
        machineId: this.options.auth.machineId,
        userId: this.options.auth.userId,
        workspaceId: this.options.workspace.id,
        capacity: this.options.capacity,
      },
      receipt
    );
  }

  async prepare(receipt: AutomationReceipt): Promise<ActionResult> {
    switch (receipt.intent.action.kind) {
      case 'session.archive':
        return prepareArchiveAction(receipt);
      case 'session.compact':
        return prepareCompactAction(
          {
            manager: this.manager,
            authority: this.authority,
            machineId: this.options.auth.machineId,
            origin: (item) => this.origin(item),
          },
          receipt
        );
      case 'agent.invoke':
        return prepareInvokeAction(this.invokeDeps(), receipt);
      default:
        return { state: 'blocked', reason: 'action_capability_unavailable' };
    }
  }

  async submit(receipt: AutomationReceipt): Promise<ActionResult> {
    const allowed = await this.authorize(receipt);
    if (allowed.value !== 'yes') return { state: 'blocked', reason: allowed.reason };
    if (receipt.intent.action.kind === 'session.archive')
      return submitArchiveAction(this.archiveDeps(), receipt, allowed);
    return submitQueueAction(this.invokeDeps(), receipt);
  }

  async reconcile(receipt: AutomationReceipt): Promise<ActionResult> {
    const record = await this.manager.repo.getDocMeta(
      getSessionRoomId(receipt.sessionId as SessionId)
    );
    const meta = record?.meta as SessionMeta | undefined;
    if (record && isLoroRepoDocDeleted(record))
      return { state: 'cancelled', reason: 'target_deleted' };
    if (!meta) {
      if (
        receipt.prepared?.kind === 'create' &&
        this.authority.inputDisposition(receipt.sessionId as SessionId, receipt.turnId) ===
          'unsubmitted'
      )
        return this.submit(receipt);
      return { state: 'unknown', reason: 'target_unavailable' };
    }
    if (receipt.intent.action.kind === 'session.archive') {
      return reconcileArchiveAction(this.archiveDeps(), receipt, meta, () => this.submit(receipt));
    }
    return reconcileQueueAction(this.invokeDeps(), receipt, meta, () => this.submit(receipt));
  }

  currentPr(receipt: AutomationReceipt, prUrl: string): Promise<ConditionObservation> {
    return observeCurrentPr({ manager: this.manager, ledger: this.options.ledger }, receipt, prUrl);
  }

  async cancel(receipt: AutomationReceipt): Promise<ActionResult> {
    if (receipt.intent.action.kind === 'session.archive')
      return cancelArchiveAction(() => this.reconcile(receipt));
    return cancelQueueAction({ ledger: this.options.ledger, authority: this.authority }, receipt);
  }
}
