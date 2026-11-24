import { writePluginAnnotation } from '@lody/shared/plugins/annotations';
import {
  getSessionRoomId,
  type MachineId,
  type WorkspaceId,
  type SessionId,
  type SessionHistoryInput,
  type SessionMeta,
} from '@lody/shared';
import type { PluginMachineRequest, PluginMachineResult } from '@lody/shared/plugins/machine-rpc';
import { createSessionBackend } from '../../session/session-backend';
import type { SessionExecutionService } from '../../session/session-execution-service';
import type { LoroDocumentManager } from '../../lib/loro/doc';
import { daemonCommandExecutor } from './daemon-command-executor';
const initialWrites = new WeakMap<object, Promise<void>>();

type Create = Extract<PluginMachineRequest, { method: 'plugin/session-create' }>['params'];
export function bindDaemonCommands(ctx: {
  workspaceId: WorkspaceId;
  machineId: MachineId;
  pluginId: string;
  userId: string;
  machineOwner: boolean;
  sessionId?: string;
  projectId?: string;
  check(): void;
  create(
    p: Omit<Create, 'clientDigest'>,
    check: () => void
  ): Promise<Extract<PluginMachineResult, { type: 'plugin/session-create' }>>;
  sessionScope(id: SessionId): Promise<readonly string[]>;
  manager: LoroDocumentManager;
  execution: SessionExecutionService;
  signalDispatch(id: SessionId): void;
}) {
  const { userId, create } = ctx;
  return daemonCommandExecutor({
    ...ctx,
    create: async (p, live) => {
      const guard = () => {
        live();
        if (ctx.manager.isEncryptedWorkspace() || p.input.originTurn) throw Error('forbidden');
      };
      guard();
      return acceptVerifiedPluginCreation(ctx.manager, userId, p, () => create(p, guard), guard);
    },
    ...bindDaemonReadSources(ctx),
    lifecycle: async (id, meta, input, check) => {
      const { lifecycleCommandInputs: inputs } =
        await import('@lody/shared/commands/host-commands');
      const sdk = await import('@lody/shared');
      const sessionId = meta.id;
      if (id === 'sessionArchive' || id === 'sessionRestore') {
        inputs[id].parse(input);
        const targets = await sdk.readSessionOperationTargets(
          ctx.manager.repo,
          sessionId,
          id === 'sessionArchive' ? 'archive' : 'restore'
        );
        if (targets.length !== 1 || targets[0].id !== sessionId || targets[0].userId !== userId)
          throw Error('forbidden');
        check();
        await ctx.manager.repo.upsertDocMeta(
          getSessionRoomId(sessionId),
          id === 'sessionArchive'
            ? { isArchived: true, status: sdk.SessionStatusFactory.idle() }
            : { isArchived: false }
        );
        return null;
      }
      const doc = await ctx.manager.getOrCreateSessionDoc(sessionId);
      const backend = await createSessionBackend(doc);
      if (id === 'sessionStop') {
        inputs[id].parse(input);
        const h = backend.history;
        const rows = await h.readDirectory(0, await h.count());
        if (rows.some((r) => r.state !== 'ready' || !r.scalars))
          throw Error('Session history unavailable');
        const turnId = sdk.resolveActiveAssistantTurnId(rows.map((r) => r.scalars));
        if (!turnId) throw Error('No active turn');
        check();
        const result = await ctx.execution.cancelSession(
          {
            type: 'session/cancel',
            machineId: ctx.machineId,
            workspaceId: ctx.workspaceId,
            sessionId,
            turnId,
          },
          { pendingInput: 'preserve', prePromptSession: 'discard' }
        );
        if (!result.success) throw Error('Stop failed');
        return null;
      }
      // A verified read/mutation grant is not a signature for new encrypted input or an approval.
      if (ctx.manager.isEncryptedWorkspace()) throw Error('forbidden');
      if (id === 'sessionRespondInteraction') {
        const p = inputs[id].parse(input);
        check();
        if (
          !(await backend.respondPermission(p.requestId, p.outcome, {
            turnId: p.turnId,
          }))
        )
          throw Error('Interaction no longer pending');
        return null;
      }
      if (id === 'sessionSend') {
        const p = inputs[id].parse(input);
        if (
          p.delivery === 'steer' ||
          meta.isArchived ||
          meta.collaborationStopped ||
          !meta.cliType ||
          !meta.agentType
        )
          throw Error('Input unavailable');
        const inputBlocks = [{ type: 'text' as const, text: p.prompt }];
        const entry = sdk.buildPendingUserHistoryEntry({
          userId,
          timestamp: new Date().toISOString(),
          inputBlocks,
          inputConfig: {
            prompt: p.prompt,
            inputBlocks,
            cliType: meta.cliType,
            agentType: meta.agentType,
          },
        });
        if (!entry) throw Error('Invalid input');
        check();
        if (backend.kind === 'loro') {
          const turnId = crypto.randomUUID();
          await doc.pushMessageQueue({
            e2eeIntent: undefined,

            task: p.prompt,
            userId,
            userTurnId: turnId,
            operationId: `queue:${turnId}`,
            timestamp: entry.timestamp,
            isEditing: false,
            editingStartedAt: undefined,
            project: meta.project,
            acpSessionConfig: {
              prompt: p.prompt,
              inputBlocks,
              cliType: meta.cliType,
              agentType: meta.agentType,
            },
          });
          if (!doc.handle) throw Error('Session unavailable');
          const frontiers = doc.handle.doc.frontiers();
          const now = await doc.getMetaState();
          const updatedAt = Math.max(
            sdk.getServerNow(),
            (now?.messageQueueUpdatedAt ?? 0) + 1,
            (now?.messageQueueCheckedAt ?? 0) + 1
          );
          check();
          await ctx.manager.repo.upsertDocMeta(doc.roomId, {
            messageQueueUpdatedAt: updatedAt,
            messageQueueUpdateVersion: { updatedAt, frontiers },
          });
          await ctx.manager.repo.flush();
          return { turnId, disposition: 'queued' };
        }
        if (!backend.inputAcceptance?.acceptAndDispatch) throw Error('Input unavailable');
        const receipt = await backend.inputAcceptance.acceptAndDispatch({
          ...entry,
          id: crypto.randomUUID(),
        });
        if (receipt.status !== 'accepted') throw Error('Input acceptance uncertain');
        if (receipt.active) ctx.signalDispatch(sessionId);
        return { turnId: receipt.turnId, disposition: 'queued' };
      }
      throw Error('forbidden');
    },
    annotation: async (entity, input, check) => {
      if ('session' in entity) {
        check();
        await ctx.manager.repo.upsertDocMeta(getSessionRoomId(entity.session.id), {
          annotations: writePluginAnnotation(entity.session.annotations, ctx.pluginId, input),
        });
        return;
      }
      const sdk = await import('@lody/shared');
      const { withMachineCatalogWriteLock } = await import('../../lib/local-project-meta');
      await withMachineCatalogWriteLock(sdk.getMachineRoomId(ctx.machineId), async () => {
        const handle = await ctx.manager.repo.openFlockDoc(
          sdk.getMachineFlockDocId(ctx.workspaceId, ctx.machineId)
        );
        check();
        const id = entity.projectId as import('@lody/shared').LocalProjectId;
        const row = sdk.getMachineFlockLocalProjects(
          sdk.readMachineFlockRowsFromFlock(handle.flock, { families: ['localProject'] })
        )[id];
        if (!row) throw Error('Project unavailable');
        sdk.writeMachineFlockRowToFlock(handle.flock, {
          key: sdk.machineFlockKeys.localProject(id),
          value: {
            ...row,
            annotations: writePluginAnnotation(row.annotations, ctx.pluginId, input),
          },
        });
        await ctx.manager.repo.flush();
        await handle.syncOnce();
      });
    },
    preference: async (id, meta, input, check) => {
      const sdk = await import('@lody/shared');
      const { bindSessionCommands } = await import('@lody/shared/commands/host-commands');
      const { statusViewSessionsFromMetas, statusViewPatchToMeta } =
        await import('@lody/shared/status-view');
      const write = async (patch: Partial<SessionMeta>) => {
        check();
        await ctx.manager.repo.upsertDocMeta(getSessionRoomId(meta.id), patch);
      };
      const receipt = async (read: boolean) => {
        if (meta.parentSessionId) throw Error('forbidden');
        const now = sdk.getServerNow();
        const last = Math.max(
          meta.lastMessageAt ?? 0,
          (meta.snoozedUntil ?? 0) <= now ? (meta.snoozedUntil ?? 0) : 0
        );
        if (!read && !last) return;
        const at = read ? Math.max(last || now, meta.lastReadAt ?? 0) : last - 1;
        await write({ lastReadAt: at });
      };
      await bindSessionCommands({
        markSessionRead: () => receipt(true),
        markSessionUnread: () => receipt(false),
        updateSessionTitle: async (_, title) => {
          const doc = await ctx.manager.getOrCreateSessionDoc(meta.id);
          check();
          await doc.setTitle(title, 'user');
        },
        runStatusViewCommand: async (command) => {
          if (meta.parentSessionId || ('includeOpened' in command && command.includeOpened))
            throw Error('forbidden');
          const metas =
            command.type === 'setPinned' || command.type === 'move'
              ? (await ctx.manager.repo.listDoc({ prefix: sdk.SESSION_DOC_PREFIX })).flatMap((r) =>
                  r.deleted || r.meta.machineId !== ctx.machineId || r.meta.userId !== userId
                    ? []
                    : [r.meta as SessionMeta]
                )
              : [meta];
          const state = {
            sessions: statusViewSessionsFromMetas(metas, { keepArchivedId: meta.id }),
            sections: [],
            sectionsLoaded: false,
            canManageSections: false,
            nowMs: sdk.getServerNow(),
          };
          const writes = sdk.planStatusViewCommand(state, command, {
            nowMs: state.nowMs,
            randomByte: () => Math.floor(Math.random() * 256),
          });
          if (writes.some((w) => w.type !== 'session' || w.sessionId !== meta.id))
            throw Error('forbidden');
          for (const w of writes)
            if (w.type === 'session') await write(statusViewPatchToMeta(w.patch));
        },
      })(meta.id, id, input);
    },
  });
}

export function bindDaemonReadSources(
  ctx: Pick<
    Parameters<typeof bindDaemonCommands>[0],
    'workspaceId' | 'machineId' | 'projectId' | 'sessionScope' | 'manager'
  >
): Pick<
  import('./daemon-command-executor').ScopedPluginReadContext,
  'project' | 'sessions' | 'meta' | 'history' | 'queueCount' | 'turns'
> {
  return {
    project: async (id) =>
      (await import('../../lib/local-project-meta')).resolveWorkspaceLocalProject(
        ctx.manager.repo,
        ctx.workspaceId,
        ctx.machineId,
        id as import('@lody/shared').LocalProjectId
      ),
    sessions: async (check) => {
      const { SESSION_DOC_PREFIX, getSessionIdFromRoomId } = await import('@lody/shared');
      const rows = await ctx.manager.repo.listDoc({ prefix: SESSION_DOC_PREFIX });
      const metas = [];
      for (const row of rows) {
        check();
        const sid = getSessionIdFromRoomId(row.docId);
        if (!sid || row.deleted || row.meta.machineId !== ctx.machineId) continue;
        const meta = row.meta as SessionMeta;
        if (ctx.projectId) {
          if (meta.project?.kind !== 'local' || meta.project.localProjectId !== ctx.projectId)
            continue;
          const projects = await ctx.sessionScope(sid);
          if (!projects.length || projects.some((p) => p !== ctx.projectId)) continue;
        }
        metas.push({ ...meta, id: sid });
      }
      return metas;
    },
    meta: async (id) => {
      const row = await ctx.manager.repo.getDocMeta(getSessionRoomId(id as SessionId));
      if (!row || row.deleted || row.meta.machineId !== ctx.machineId) throw Error('forbidden');
      return row.meta as SessionMeta;
    },
    history: async (id) =>
      (await createSessionBackend(await ctx.manager.getOrCreateSessionDoc(id as SessionId)))
        .history,
    queueCount: async (id) =>
      (await (await ctx.manager.getOrCreateSessionDoc(id as SessionId)).getMessageQueue()).length,
    turns: async (id, limit, offset, ids) => {
      const doc = await ctx.manager.getOrCreateSessionDoc(id as SessionId);
      const backend = await createSessionBackend(doc);
      const h = backend.history;
      const count = ids ? 0 : await h.count(),
        end = Math.max(0, count - offset),
        start = Math.max(0, end - limit);
      const rows = ids
        ? await Promise.all(ids.map((id) => h.readTurn(id)))
        : await h.readRange(start, end);
      return {
        items: rows.flatMap((r) => (r.state === 'ready' ? [r.turn as SessionHistoryInput] : [])),
        more: start > 0,
      };
    },
  };
}

/** The caller reserves against its freshly verified operation/target. An encrypted signer must
 * classify new input independently of plugin-provided historical origin. Replay never re-signs. */
export async function acceptVerifiedPluginCreation(
  manager: LoroDocumentManager,
  userId: string,
  p: Omit<Create, 'clientDigest'>,
  reserve: () => Promise<Extract<PluginMachineResult, { type: 'plugin/session-create' }>>,
  guard: () => void,
  sign?: (input: {
    sessionId: SessionId;
    userTurnId: string;
    inputConfig: SessionHistoryInput['inputConfig'];
  }) => Promise<{
    e2eeIntent: string;
    derivedFrom?: NonNullable<SessionHistoryInput['derivedFrom']>;
  }>
) {
  guard();
  if (manager.isEncryptedWorkspace() && !sign) throw Error('forbidden');
  const receipt = await reserve();
  if (receipt.userId !== userId) throw Error('forbidden');
  if (receipt.archived) return receipt;
  const sid = receipt.sessionId as SessionId,
    turnId = `plugin-create:${sid}`;
  const doc = await manager.getOrCreateSessionDoc(sid);
  const backend = await createSessionBackend(doc);
  const { buildInitialHistoryEntry } = await import('@lody/shared');
  const entry = buildInitialHistoryEntry({
    userId,
    timestamp: receipt.createdAt,
    cliType: receipt.cliType,
    agentType: receipt.agentType,
    prompt: [
      receipt.role?.prefix?.trim(),
      receipt.skillPrompt,
      [
        p.input.prompt,
        ...(p.input.skillIds ?? []).filter((id) => !id.startsWith('plugin:')).map((id) => `$${id}`),
      ].join(' '),
    ]
      .filter(Boolean)
      .join('\n\n'),
    inputBlocks: undefined,
    modeId: receipt.role?.modeId,
    modelId: receipt.role?.modelId,
    configOptionValues: receipt.role?.configOptionValues,
  });
  if (!entry || !entry.inputConfig) throw Error('Initial input unavailable');
  entry.id = turnId;
  if (receipt.role)
    Object.assign(entry.inputConfig, {
      agentRoleId: receipt.role.snapshot.id,
      agentRoleRevision: receipt.role.snapshot.revision,
      agentRoleSnapshot: receipt.role.snapshot,
      ...(receipt.role.mcpServerIds ? { mcpServerIds: receipt.role.mcpServerIds } : {}),
      ...(receipt.role.memory ? { memory: receipt.role.memory } : {}),
    });
  if (backend.kind === 'loro') {
    const accept = async () => {
      guard();
      const prior = await backend.readTurn(turnId);
      if (prior.state === 'ready') {
        const meta = await backend.getMetaState();
        if (
          !meta ||
          meta.isArchived ||
          meta.latestUserMsgId ||
          meta.lastHandledUserMsgId ||
          meta.processingUserMsgId ||
          prior.turn.status !== 'pending'
        )
          return;
        guard();
        await backend.publishUserTurnActivation(turnId);
        return;
      }
      if (prior.state !== 'missing') throw Error('Initial input unavailable');
      guard();
      if (manager.isEncryptedWorkspace()) {
        if (!sign) throw Error('forbidden');
        const signed = await sign({
          sessionId: sid,
          userTurnId: turnId,
          inputConfig: entry.inputConfig,
        });
        guard();
        if (!signed.e2eeIntent) throw Error('forbidden');
        entry.e2eeIntent = signed.e2eeIntent;
        if (signed.derivedFrom) entry.derivedFrom = signed.derivedFrom;
      }
      await backend.appendUserTurn(entry);
    };
    const write = (initialWrites.get(doc) ?? Promise.resolve()).then(accept, accept);
    initialWrites.set(doc, write);
    try {
      await write;
    } finally {
      if (initialWrites.get(doc) === write) initialWrites.delete(doc);
    }
  } else {
    guard();
    if (manager.isEncryptedWorkspace()) throw Error('forbidden');
    if (!backend.inputAcceptance?.acceptAndDispatch)
      throw Error('Initial input admission unavailable');
    const result = await backend.inputAcceptance.acceptAndDispatch(entry);
    if (result.status !== 'accepted') throw Error('Initial input outcome uncertain');
  }
  return receipt;
}
