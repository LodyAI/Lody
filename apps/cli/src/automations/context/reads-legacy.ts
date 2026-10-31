import { providerBindingFingerprint } from '@/session/automation-observations';
import { evaluateCapacity } from '../runtime/capacity';
import {
  getSessionRoomId,
  isLoroRepoDocDeleted,
  resolveSessionPullRequests,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import {
  automationReadRequestSchema,
  automationReadResponseSchema,
  automationEmptyReadParametersSchema,
  automationEventReadParametersSchema,
  type AutomationReadRequest,
  type AutomationReadResponse,
  type AutomationWait,
} from '@lody/shared/automations';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { SessionAutomationAuthority } from '@/session/session-automation-authority';
import type { AutomationLedger } from '../storage/ledger';
import { readWorkflowRuns } from '../sources/workflows';
import { pullRequestCheckpointId } from '../sources/pull-requests';

/** Read adapters expose owner snapshots, never condition names or ambient process capabilities. */
export async function readAutomationContext(options: {
  ledger: AutomationLedger;
  manager: LoroDocumentManager;
  authority: SessionAutomationAuthority;
  wait: AutomationWait;
  input: AutomationReadRequest;
  now: number;
}): Promise<AutomationReadResponse> {
  const { ledger, manager, authority, wait, now } = options;
  const input = automationReadRequestSchema.parse(options.input);
  const current = ledger.wait(wait.id);
  if (
    !current ||
    current.state !== 'checking' ||
    current.ownerUserId !== wait.ownerUserId ||
    current.sessionId !== wait.sessionId ||
    wait.ownerMachineId !== ledger.machineId ||
    wait.workspaceId !== ledger.workspaceId
  )
    throw new Error('AUTOMATION_WAIT_INACTIVE');
  const record = await manager.repo.getDocMeta(getSessionRoomId(wait.sessionId as SessionId));
  const meta = record?.meta as SessionMeta | undefined;
  if (
    !record ||
    !meta ||
    isLoroRepoDocDeleted(record) ||
    meta.userId !== wait.ownerUserId ||
    meta.machineId !== ledger.machineId ||
    meta.isArchived
  )
    throw new Error('AUTOMATION_SESSION_UNAVAILABLE');
  if (input.resource !== 'events') automationEmptyReadParametersSchema.parse(input.parameters);
  // Record demand even when the first read has no snapshot yet.
  if (current.state === 'checking') ledger.recordRead(wait.id, input.resource, [], now);
  let value: unknown;
  let observedAt = now;
  switch (input.resource) {
    case 'session':
      value = {
        id: meta.id,
        latestInputId: meta.latestUserMsgId ?? null,
        lastHandledInputId: meta.lastHandledUserMsgId ?? null,
        archived: !!meta.isArchived,
        stopped: !!meta.collaborationStopped,
      };
      break;
    case 'session.group':
      value = await authority.settled(meta.id, wait.ownerUserId, wait.id);
      break;
    case 'github.pullRequests':
      value = resolveSessionPullRequests(meta).map((pr) => {
        const observation = ledger.checkpoint(pullRequestCheckpointId(meta.id, pr.url));
        return {
          url: pr.url,
          status: pr.status,
          observation: observation?.data ?? null,
          observedAt: observation?.observedAt ?? null,
        };
      });
      break;
    case 'github.workflowRuns': {
      const result = readWorkflowRuns(ledger, meta, now);
      value = result.value;
      if (current.state === 'checking')
        ledger.recordRead(wait.id, input.resource, result.evidence, now);
      observedAt = Math.min(
        now,
        ...result.evidence.map((item) => ledger.checkpoint(item.sourceId)?.observedAt ?? now)
      );
      break;
    }
    case 'provider.capacity': {
      const bindingId = meta.agentConfigId;
      const config =
        bindingId && (await manager.getAgentConfigForMachineLaunch(bindingId, meta.machineId));
      const snapshot = bindingId ? ledger.capacity(bindingId) : undefined;
      if (!config || !snapshot) value = { status: 'unknown', reason: 'capacity_unobserved' };
      else {
        const eligibility = evaluateCapacity(
          snapshot,
          { bindingId, fingerprint: providerBindingFingerprint(config) },
          now
        );
        value = {
          status: eligibility.value,
          reason: eligibility.reason,
          windows: snapshot.windows,
          authentication: snapshot.authentication,
          billing: snapshot.billing,
          validUntil: snapshot.validUntil,
        };
        observedAt = snapshot.observedAt;
      }
      break;
    }
    case 'events': {
      const parameters = automationEventReadParametersSchema.parse(input.parameters);
      value = ledger.sessionEvents(meta.id, parameters.since, parameters.limit);
      break;
    }
    default:
      throw new Error('AUTOMATION_READ_UNAVAILABLE');
  }
  // Parsing also caps serialized observations and rejects non-JSON owner values.
  const response = automationReadResponseSchema.parse({ value, observedAt });
  const latest = ledger.wait(wait.id);
  if (latest?.state !== current.state) throw new Error('AUTOMATION_WAIT_INACTIVE');
  return response;
}
