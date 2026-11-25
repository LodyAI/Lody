import { createHash, randomUUID } from 'node:crypto';
import {
  buildExternalMessageAuthor,
  buildSessionTurnInputConfig,
  getServerNow,
  getSessionRoomId,
  isLoroRepoDocDeleted,
  normalizeSessionTurnInputConfig,
  resolveSessionConversationConfig,
  type ACPSessionId,
  type MachineId,
  type SessionId,
  type SessionInboxDeliverRequest,
  type SessionInboxDeliverResponse,
  type SessionInputBlock,
  type SessionMeta,
} from '@lody/shared';
import type { LoroDocumentManager, SessionDocument } from '@/lib/loro/doc';
import { createSessionBackend } from '@/session/session-backend';
import type { SessionEditAccess } from '@/session/session-automation-authority';

export type SessionInboxDeliverWorkspace = {
  readonly workspaceId: string;
  readonly manager: LoroDocumentManager;
  readonly revoked?: boolean;
  canEdit(sessionId: SessionId, userId: string): Promise<SessionEditAccess>;
};

export type SessionInboxDeliverDeps = {
  readonly machineId: MachineId;
  readonly ownerUserId: string;
  getWorkspaces(): readonly SessionInboxDeliverWorkspace[];
  isStartupSyncPending(): boolean;
};

/** Format a 64-char SHA-256 hex digest into an RFC 4122 v5-shaped UUID. */
export function deterministicTurnIdFromDigest(hexDigest: string): string {
  const bytes = Buffer.from(hexDigest.slice(0, 32), 'hex');
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function signalSessionQueue(
  doc: SessionDocument,
  manager: LoroDocumentManager
): Promise<void> {
  if (!doc.handle) {
    throw new Error('SESSION_QUEUE_DOCUMENT_UNAVAILABLE');
  }
  const frontiers = doc.handle.doc.frontiers();
  const meta = (await manager.repo.getDocMeta(doc.roomId))?.meta as SessionMeta | undefined;
  const updatedAt = Math.max(
    getServerNow(),
    (meta?.messageQueueUpdatedAt ?? 0) + 1,
    (meta?.messageQueueCheckedAt ?? 0) + 1
  );
  await manager.repo.upsertDocMeta(doc.roomId, {
    messageQueueUpdatedAt: updatedAt,
    messageQueueUpdateVersion: { updatedAt, frontiers },
  });
  await manager.repo.flush();
}

function defaultLabelForSource(source: SessionInboxDeliverRequest['source']): string {
  switch (source) {
    case 'ryugi':
      return 'Ryugi';
  }
}

/**
 * Enqueues an external host message into a target Session's message queue as
 * the machine-owner principal, returning the Ryugi receipt disposition:
 * - `queued`: accepted into the Session queue (or already queued/promoted for the same dedupeKey)
 * - `retry`: transient condition (syncing, unconfirmed access, unavailable signing)
 * - `unsubscribe`: terminal condition (archived, deleted, not found, denied, stopped)
 */
export async function deliverSessionInboxMessage(
  request: SessionInboxDeliverRequest,
  deps: SessionInboxDeliverDeps
): Promise<SessionInboxDeliverResponse> {
  const sessionId = request.sessionId as SessionId;
  const roomId = getSessionRoomId(sessionId);

  let matchedWorkspace: SessionInboxDeliverWorkspace | undefined;
  let record: Awaited<ReturnType<LoroDocumentManager['repo']['getDocMeta']>>;

  for (const workspace of deps.getWorkspaces()) {
    const candidate = await workspace.manager.repo.getDocMeta(roomId);
    if (candidate) {
      matchedWorkspace = workspace;
      record = candidate;
      break;
    }
  }

  if (!matchedWorkspace || !record) {
    if (deps.isStartupSyncPending()) {
      return { status: 'retry', reason: 'workspace_syncing' };
    }
    return { status: 'unsubscribe', reason: 'session_not_found' };
  }

  if (matchedWorkspace.revoked) {
    return { status: 'unsubscribe', reason: 'workspace_unavailable' };
  }

  if (isLoroRepoDocDeleted(record) || !record.meta) {
    return { status: 'unsubscribe', reason: 'session_deleted' };
  }

  const meta = record.meta as SessionMeta;
  if (meta.isArchived) {
    return { status: 'unsubscribe', reason: 'session_archived' };
  }
  if (meta.machineId !== deps.machineId) {
    return { status: 'unsubscribe', reason: 'session_not_owned' };
  }
  if (meta.collaborationStopped) {
    return { status: 'unsubscribe', reason: 'session_stopped' };
  }

  const access = await matchedWorkspace.canEdit(sessionId, deps.ownerUserId);
  if (access === 'no') {
    return { status: 'unsubscribe', reason: 'permission_denied' };
  }
  if (access === 'unknown') {
    return { status: 'retry', reason: 'permission_unconfirmed' };
  }

  const { manager } = matchedWorkspace;
  const doc = await manager.getOrCreateSessionDoc(sessionId);
  const backend = await createSessionBackend(doc, meta);

  let operationId: string;
  let userTurnId: string;
  if (request.dedupeKey) {
    const digest = createHash('sha256')
      .update(`${request.source}:${sessionId}:${request.dedupeKey}`)
      .digest('hex');
    operationId = `${request.source}:${digest.slice(0, 32)}`;
    userTurnId = deterministicTurnIdFromDigest(digest);
  } else {
    userTurnId = randomUUID();
    operationId = `${request.source}:${userTurnId}`;
  }

  // Idempotent retry handling: if this event was already promoted or queued,
  // re-signal the queue when still pending and acknowledge without duplicating.
  const [promotion, prior, queue] = await Promise.all([
    backend.getQueuePromotionRecord(operationId),
    backend.readTurn(userTurnId),
    backend.getMessageQueue(),
  ]);
  if (promotion || (prior.state === 'ready' && prior.turn.status !== 'prepared')) {
    return { status: 'queued', sessionId, userTurnId, deduplicated: true };
  }
  if (queue.some((item) => item.operationId === operationId)) {
    await signalSessionQueue(doc, manager);
    return { status: 'queued', sessionId, userTurnId, deduplicated: true };
  }

  const rows = await backend.readHistoryDirectory(0, await backend.readHistoryCount());
  const conversationConfig = resolveSessionConversationConfig(
    rows.flatMap((row) =>
      row.scalars?.role === 'user' && typeof row.turnId === 'string' && row.turnId.length > 0
        ? [
            {
              id: row.turnId,
              role: 'user' as const,
              inputConfig: normalizeSessionTurnInputConfig(row.inputConfig),
            },
          ]
        : []
    ),
    queue
  );

  const inputBlocks: SessionInputBlock[] = [{ type: 'text', text: request.message }];
  const turnInputConfig = buildSessionTurnInputConfig({
    modeId: conversationConfig.modeId,
    modelId: conversationConfig.modelId,
    configOptionValues: conversationConfig.configOptionValues,
    memory: conversationConfig.memory,
    mcpServerIds: conversationConfig.mcpServerIds,
    agentRoleId: conversationConfig.agentRoleId,
    agentRoleRevision: conversationConfig.agentRoleRevision,
    agentRoleSnapshot: conversationConfig.agentRoleSnapshot,
    prompt: request.message,
    inputBlocks,
    cliType: meta.cliType,
    agentType: meta.agentType,
    resume: (meta.acpSessionId ?? undefined) as ACPSessionId | undefined,
  });

  const acpSessionConfig = {
    ...turnInputConfig,
    prompt: request.message,
    cliType: meta.cliType,
    agentType: meta.agentType,
  };

  let e2eeIntent: string | undefined;
  if (manager.isEncryptedWorkspace()) {
    e2eeIntent = await manager.signMachineInput({
      sessionId,
      targetMachineId: meta.machineId,
      userTurnId,
      inputConfig: acpSessionConfig,
    });
    if (!e2eeIntent) {
      return { status: 'retry', reason: 'encrypted_signing_unavailable' };
    }
  }

  const author = buildExternalMessageAuthor({
    source: request.source,
    label: request.metadata?.label ?? defaultLabelForSource(request.source),
    artifact: request.metadata?.artifact,
    eventType: request.metadata?.eventType,
  });

  await doc.pushMessageQueue({
    task: request.message,
    userId: deps.ownerUserId,
    userTurnId,
    operationId,
    timestamp: new Date(getServerNow()).toISOString(),
    isEditing: false,
    editingStartedAt: undefined,
    project: meta.project,
    acpSessionConfig,
    author,
    e2eeIntent,
  });
  await signalSessionQueue(doc, manager);

  return { status: 'queued', sessionId, userTurnId };
}
