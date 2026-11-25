import {
  normalizeSessionTurnInputConfig,
  type MachineId,
  type SessionId,
  type SessionTurnInputConfig,
} from '@lody/shared';
import type { AutomationOrigin, AutomationReceipt } from '@lody/shared/automations';
import { z } from 'zod';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { createSessionBackend } from '@/session/session-backend';
import type { SessionAutomationAuthority } from '@/session/session-automation-authority';
import type { ActionResult } from '../runtime/engine';
import { compactActionSchema } from './authorization';

const json = (input: unknown) =>
  z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(input)));

export type CompactActionDeps = {
  manager: LoroDocumentManager;
  authority: SessionAutomationAuthority;
  machineId: MachineId;
  origin(receipt: AutomationReceipt): AutomationOrigin;
};

export async function prepareCompactAction(
  deps: CompactActionDeps,
  receipt: AutomationReceipt
): Promise<ActionResult> {
  const compact = compactActionSchema.parse(receipt.intent.action.parameters);
  const sessionId = compact.sessionId as SessionId;
  const settled = await deps.authority.settled(sessionId, receipt.rule.ownerUserId, receipt.id);
  if (settled.value !== 'yes') return { state: 'blocked', reason: settled.reason };
  const doc = await deps.manager.getOrCreateSessionDoc(sessionId);
  const backend = await createSessionBackend(doc);
  const meta = await backend.getMetaState();
  if (!meta?.acpSessionId || !meta.agentConfigId)
    return { state: 'blocked', reason: 'native_session_unavailable' };
  const capability = await deps.manager.getAcpCapabilities(deps.machineId, meta.agentConfigId);
  if (
    !capability?.availableCommands?.some((command) => command.name.replace(/^\//, '') === 'compact')
  )
    return { state: 'blocked', reason: 'native_compact_unavailable' };
  const original = await backend.readTurn(compact.idleTurnId);
  if (original.state !== 'ready')
    return { state: 'blocked', reason: 'maintenance_input_unavailable' };
  const config: SessionTurnInputConfig = {
    ...normalizeSessionTurnInputConfig(original.turn.inputConfig),
    prompt: '/compact',
    inputBlocks: [{ type: 'text', text: '/compact' }],
    cliType: meta.cliType,
    agentType: meta.agentType,
    resume: meta.acpSessionId,
    _lodyAutomation: {
      ...deps.origin(receipt),
      nativeSessionId: meta.acpSessionId,
      maintenance: {
        kind: 'compact',
        idleTurnId: compact.idleTurnId,
        expiresAt: compact.expiresAt,
      },
    },
  };
  return {
    state: 'resolved',
    sessionId,
    prepared: json({ kind: 'queue', config, project: meta.project }),
  };
}
