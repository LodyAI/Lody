import { steerUserTurn } from '../lib/session-send-delivery';
import { lifecycleCommandInputs as inputs } from '@lody/shared/commands/host-commands';
import {
  getServerNow,
  resolveActiveAssistantTurnId,
  type SessionMeta,
  type SessionId,
  type SessionHistory,
} from '@lody/shared';
import type { WorkspaceRuntime } from '../atoms/runtime';
import { buildDraftUserHistoryEntry } from '../lib/session-attachment-draft';
import { acceptSessionUserTurn } from '../lib/session-send-admission';
import type { SessionActions } from '../hooks/use-session-actions';

async function activeTurn(runtime: WorkspaceRuntime, sessionId: SessionId) {
  return runtime.sendResources.withSessionStore(sessionId, async (store) => {
    const history = store.sessionData.history;
    const rows = await history.readDirectory(0, await history.count());
    if (rows.some((row) => row.state !== 'ready' || !row.scalars))
      throw Error('Session history unavailable');
    return resolveActiveAssistantTurnId(rows.map((row) => row.scalars));
  });
}

export async function executeSessionLifecycle(
  id: keyof typeof inputs,
  input: unknown,
  meta: SessionMeta,
  runtime: WorkspaceRuntime,
  actorId: string,
  actions: Pick<SessionActions, 'archiveSession' | 'restoreSession' | 'requestSessionCancel'>,
  signal: AbortSignal
) {
  const sessionId = meta.id;
  switch (id) {
    case 'sessionFork': {
      const opts = inputs[id].parse(input);
      const sourceTurnId =
        opts?.fromTurnId ??
        (await runtime.sendResources.withSessionStore(sessionId, async (store) => {
          const h = store.sessionData.history;
          const rows = await h.readDirectory(0, await h.count());
          if (rows.some((r) => r.state !== 'ready' || !r.scalars))
            throw Error('Session history unavailable');
          return rows.findLast(
            (r) =>
              r.scalars?.role === 'assistant' &&
              (r.scalars.finished || r.scalars.endedAt !== undefined)
          )?.turnId;
        }));
      signal.throwIfAborted();
      if (!sourceTurnId) throw Error('No assistant turn to fork');
      const targetSessionId = crypto.randomUUID() as SessionId;
      const reply = await runtime.requestSessionFork(meta.machineId, {
        sourceSessionId: sessionId,
        sourceTurnId,
        targetSessionId,
        requestedByUserId: actorId,
      });
      if (
        !reply?.success ||
        reply.sourceSessionId !== sessionId ||
        reply.targetSessionId !== targetSessionId ||
        reply.disposition === 'confirmation-required' ||
        reply.disposition === 'failed'
      )
        throw Error(reply?.error?.message ?? 'Session fork unavailable');
      return {
        workspaceId: String(runtime.workspaceId),
        machineId: String(meta.machineId),
        sessionId: String(targetSessionId),
      } as import('@lody/plugin-sdk').SessionRef;
    }
    case 'sessionArchive':
      inputs[id].parse(input);
      return actions.archiveSession(sessionId);
    case 'sessionRestore':
      inputs[id].parse(input);
      return actions.restoreSession(sessionId);
    case 'sessionStop': {
      inputs[id].parse(input);
      const turnId = await activeTurn(runtime, sessionId);
      signal.throwIfAborted();
      if (!turnId) throw Error('No active assistant turn');
      return actions.requestSessionCancel(sessionId, turnId);
    }
    case 'sessionRespondInteraction': {
      // The ordinary permission writer carries an outcome but no memberInput signature.
      // Never downgrade an encrypted approval to an unsigned transcript mutation.
      await runtime.waitForContentAdmission?.();
      signal.throwIfAborted();
      if (runtime.contentMode === 'e2ee')
        throw Object.assign(Error('Signed interaction responses unavailable'), {
          code: 'forbidden',
        });
      const { requestId, outcome, turnId } = inputs[id].parse(input);
      return runtime.writer.respondSessionPermission(sessionId, requestId, outcome, { turnId });
    }
    case 'sessionSend': {
      const { prompt, delivery } = inputs[id].parse(input);
      if (meta.isArchived || !meta.agentType || !meta.cliType || meta.collaborationStopped)
        throw Error('Session is unavailable for input');
      const timestamp = new Date(getServerNow()).toISOString(),
        turnId = crypto.randomUUID();
      const inputBlocks = [{ type: 'text' as const, text: prompt }],
        inputConfig = { prompt, inputBlocks, agentType: meta.agentType, cliType: meta.cliType };
      const expected = delivery === 'steer' ? await activeTurn(runtime, sessionId) : undefined;
      signal.throwIfAborted();
      if (delivery === 'steer' && !expected) throw Error('No active turn to steer');
      const turn = buildDraftUserHistoryEntry({
        userId: actorId,
        timestamp,
        inputBlocks,
        status: expected ? 'pending_apply' : 'pending',
        inputConfig,
      });
      if (!turn) throw Error('Empty session input');
      const accepted = await acceptSessionUserTurn(
        runtime,
        sessionId,
        { ...turn, id: turnId } as SessionHistory,
        expected ? { kind: 'guide', expectedTurnId: expected } : { kind: 'queue' },
        undefined,
        expected
          ? undefined
          : {
              task: prompt,
              userId: actorId,
              userTurnId: turnId,
              operationId: `queue:${turnId}`,
              timestamp,
              isEditing: false,
              acpSessionConfig: inputConfig,
              project: meta.project,
            }
      );
      if (expected) {
        if (
          accepted === 'written' &&
          (await steerUserTurn(runtime, sessionId, expected, turnId, { machineId: meta.machineId }))
        )
          return { turnId, disposition: 'steered' as const };
        throw Object.assign(Error('Input accepted; steer outcome not confirmed'), {
          code: 'outcome_unknown',
          turnId,
        });
      }
      return { turnId, disposition: 'queued' as const };
    }
  }
}
