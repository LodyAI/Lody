import { basename } from 'node:path';
import { Effect } from 'effect';
import { findUserTurn } from '../../lib/e2ee/execution-intent-verification';
import {
  decodeE2eeIntentRecord,
  E2EE_INTENT_KIND,
  getSessionRoomId,
  type SessionId,
  type WorkspaceId,
  type MachineId,
} from '@lody/shared';
import {
  pluginSessionCreateParams,
  type DeclaredGrantSignature,
  type WorkflowGrantRequest,
} from '@lody/shared/plugins/machine-rpc';
import type { CliE2eeWorkspaceLegacy } from '../../lib/e2ee/workspace-legacy';
import type { LoroDocumentManager } from '../../lib/loro/doc';
import { acceptVerifiedPluginCreation, bindDaemonReadSources } from './daemon-command-runtime';
import {
  executeScopedPluginRead,
  type ResolveStandalonePluginOperation,
} from './daemon-command-executor';

interface Lease {
  signature: DeclaredGrantSignature;
  installationId: string;
  machineDigest: string;
  isCurrent: () => boolean;
}
/** Out-of-turn commands run as the signed workflow, not the issuer or a past turn. */
export function resolveDeclaredWorkflow(options: {
  workspaceId: string;
  machineId: MachineId;
  manager: LoroDocumentManager;
  identity: Pick<
    CliE2eeWorkspaceLegacy,
    | 'verifyDeclaredWorkflowGrant'
    | 'signingPublicKey'
    | 'pluginAuthoritySignal'
    | 'resolveVerifiedExecutionOriginal'
  >;
  lease: (id: string, instance: number) => Promise<Lease | undefined>;
  projectExists: (id: string) => Promise<boolean>;
  stopSession: (sid: SessionId, turnId: string) => Promise<void>;
  forkSession: (
    sid: SessionId,
    turnId: string,
    principal: string,
    authorize: () => Promise<void>
  ) => Promise<SessionId>;
  sessionScope: (id: SessionId) => Promise<readonly string[]>;
}): ResolveStandalonePluginOperation {
  return async (call, signal) => {
    if (!['start', 'service', 'event'].includes(call.origin.type)) return undefined;
    const read = call.op === 'lody.read' || call.op === 'lody.unstable.readSnapshot';
    const op =
      call.op === 'lody.execute'
        ? (
            {
              sessionCreate: 'sessions.create',
              sessionSend: 'sessions.send',
              sessionStop: 'sessions.requestStop',
              sessionArchive: 'sessions.requestArchive',
              sessionFork: 'sessionFork',
              sessionRespondInteraction: 'sessions.respondInteraction',
            } as const
          )[
            call.payload.descriptorId as
              | 'sessionCreate'
              | 'sessionSend'
              | 'sessionStop'
              | 'sessionArchive'
              | 'sessionFork'
              | 'sessionRespondInteraction'
          ]
        : undefined;
    if (!read && !op) return undefined;
    if (call.workspaceId !== options.workspaceId || call.machineId !== options.machineId)
      return undefined;
    const lease = await options.lease(call.pluginId, call.instanceId);
    if (!lease) return undefined;
    const { approval, isCurrent } = await options.identity.verifyDeclaredWorkflowGrant(
      lease.signature,
      call.machineId
    );
    if (
      approval.action !== 'grant' ||
      (op && !approval.allowed_ops.includes(op)) ||
      approval.workspace_id !== call.workspaceId ||
      approval.machine_id !== call.machineId ||
      approval.plugin_id !== call.pluginId ||
      approval.machineDigest !== lease.machineDigest ||
      approval.targetDevice !== options.identity.signingPublicKey
    )
      return undefined;
    const check = () => {
      signal.throwIfAborted();
      options.identity.pluginAuthoritySignal.throwIfAborted();
      if (!lease.isCurrent() || !isCurrent()) throw Error('Declared workflow grant withdrawn');
    };
    check();
    const raw = call.payload.target;
    const targetRef =
      call.op === 'lody.unstable.readSnapshot' &&
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw)
        ? (raw.session ?? raw.project)
        : raw;
    const ref = pluginSessionCreateParams.shape.target.safeParse(targetRef);
    if (
      !ref.success ||
      ref.data.machineId !== call.machineId ||
      ref.data.workspaceId !== call.workspaceId
    )
      return undefined;
    const row = ref.data.sessionId
      ? await options.manager.repo.getDocMeta(getSessionRoomId(ref.data.sessionId as SessionId))
      : undefined;
    const actual = (row?.meta as import('@lody/shared').SessionMeta | undefined)?.project;
    const projectId = ref.data.sessionId
      ? row && !row.deleted && row.meta.machineId === call.machineId && actual?.kind === 'local'
        ? actual.localProjectId
        : undefined
      : ref.data.projectId;
    if (ref.data.projectId && ref.data.projectId !== projectId) return undefined;
    if (
      !projectId ||
      (approval.allowed_project_ids !== '*' && !approval.allowed_project_ids.includes(projectId))
    )
      return undefined;
    const roleAllowed = (roleId: string | null | undefined) =>
      approval.allowed_role_ids === '*' || (!!roleId && approval.allowed_role_ids.includes(roleId));
    if (read) {
      const scope = options.sessionScope;
      const raw = call.payload.target,
        snapshot = call.op === 'lody.unstable.readSnapshot';
      const nested =
        snapshot &&
        typeof raw === 'object' &&
        raw !== null &&
        !Array.isArray(raw) &&
        raw.kind === 'session-meta'
          ? raw.session
          : undefined;
      const method = snapshot ? (nested ? 'session-meta' : undefined) : call.payload.descriptorId;
      if (
        !method ||
        !['sessions', 'sessionTurns', 'sessionDetail', 'subagentRun', 'session-meta'].includes(
          method
        )
      )
        return undefined;
      const parsed = pluginSessionCreateParams.shape.target.safeParse(snapshot ? nested : raw);
      if (!parsed.success) return undefined;
      const ref = parsed.data;
      if (
        ref.workspaceId !== call.workspaceId ||
        ref.machineId !== call.machineId ||
        (ref.projectId !== undefined && ref.projectId !== projectId)
      )
        return undefined;
      if (method === 'sessions' ? !!ref.sessionId : !ref.sessionId) return undefined;
      const ctx = {
        workspaceId: options.workspaceId as WorkspaceId,
        machineId: options.machineId,
        projectId,
        sessionId: ref.sessionId,
        pluginId: call.pluginId,
        userId: `plugin-workflow:${call.pluginId}:${lease.installationId}`,
        machineOwner: false,
        check,
      };
      const rawRef = { ...ref, projectId };
      return async (active) => {
        check();
        active.throwIfAborted();
        if (!(await options.projectExists(projectId))) throw Error('Workflow project unavailable');
        if (ref.sessionId) {
          const sid = ref.sessionId as SessionId;
          const row = await options.manager.repo.getDocMeta(getSessionRoomId(sid));
          if (
            !roleAllowed((row?.meta as import('@lody/shared').SessionMeta | undefined)?.agentRoleId)
          )
            throw Error('Workflow role forbidden');
          const project = (row?.meta as import('@lody/shared').SessionMeta | undefined)?.project;
          if (
            !row ||
            row.deleted ||
            row.meta.machineId !== call.machineId ||
            project?.kind !== 'local' ||
            project.localProjectId !== projectId
          )
            throw Error('Workflow session forbidden');
          const footprint = await scope(sid);
          if (!footprint.length || footprint.some((p) => p !== projectId))
            throw Error('Workflow session forbidden');
        }
        check();
        const sources = bindDaemonReadSources({
          ...ctx,
          manager: options.manager,
          sessionScope: scope,
        });
        const result = await executeScopedPluginRead(
          {
            ...ctx,
            ...sources,
            sessions: async (guard) =>
              (await sources.sessions(guard)).filter((meta) => roleAllowed(meta.agentRoleId)),
          },
          snapshot ? 'lody.unstable.readSnapshot' : 'lody.read',
          {
            ...call.payload,
            target: snapshot ? { kind: 'session-meta', session: rawRef } : rawRef,
          },
          active
        );
        check();
        return JSON.parse(JSON.stringify(result));
      };
    }
    if (op && op !== 'sessions.create') {
      if (
        !ref.success ||
        !ref.data.sessionId ||
        ref.data.workspaceId !== call.workspaceId ||
        ref.data.machineId !== call.machineId
      )
        return undefined;
      const sid = ref.data.sessionId as SessionId;
      const scope = async () => {
        const row = await options.manager.repo.getDocMeta(getSessionRoomId(sid));
        const meta = row?.meta as import('@lody/shared').SessionMeta | undefined;
        const footprint = await options.sessionScope(sid);
        if (
          !row ||
          row.deleted ||
          meta?.id !== sid ||
          meta.machineId !== call.machineId ||
          meta.isArchived ||
          meta.collaborationStopped ||
          meta.project?.kind !== 'local' ||
          meta.project.localProjectId !== projectId ||
          !footprint?.length ||
          footprint.some((id) => id !== projectId) ||
          (approval.allowed_role_ids !== '*' &&
            (!meta.agentRoleId || !approval.allowed_role_ids.includes(meta.agentRoleId)))
        )
          throw Error('Session outside declared workflow grant');
        check();
        return meta;
      };
      return async () => {
        const { lifecycleCommandInputs: inputs } =
          await import('@lody/shared/commands/host-commands');
        await scope();
        const authorize = async () => {
          await scope();
          check();
        };
        if (op === 'sessions.requestArchive') {
          inputs.sessionArchive.parse(call.payload.input);
          const { readSessionOperationTargets, SessionStatusFactory } =
            await import('@lody/shared');
          const targets = await readSessionOperationTargets(options.manager.repo, sid, 'archive');
          if (targets.length !== 1 || targets[0].id !== sid)
            throw Error('Archive affects additional sessions');
          await authorize();
          await options.manager.repo.upsertDocMeta(getSessionRoomId(sid), {
            isArchived: true,
            status: SessionStatusFactory.idle(),
          });
          await options.manager.repo.flush();
          return null;
        }
        const doc = await options.manager.getOrCreateSessionDoc(sid);
        if (op === 'sessions.requestStop' || op === 'sessionFork') {
          const source =
            op === 'sessionFork'
              ? inputs.sessionFork.parse(call.payload.input)?.fromTurnId
              : inputs.sessionStop.parse(call.payload.input);
          let turnId = source;
          if (!turnId) {
            const backend = await (
              await import('../../session/session-backend')
            ).createSessionBackend(doc);
            const h = backend.history,
              rows = await h.readDirectory(0, await h.count());
            if (rows.some((r) => r.state !== 'ready' || !r.scalars))
              throw Error('Session history unavailable');
            turnId =
              op === 'sessions.requestStop'
                ? ((await import('@lody/shared')).resolveActiveAssistantTurnId(
                    rows.map((r) => r.scalars)
                  ) ?? undefined)
                : [...rows]
                    .reverse()
                    .find(
                      (r) =>
                        r.scalars?.role === 'assistant' &&
                        (r.scalars.finished || r.scalars.endedAt !== undefined)
                    )?.turnId;
          }
          if (!turnId) throw Error('No eligible assistant turn');
          await authorize();
          if (op === 'sessions.requestStop') {
            await options.stopSession(sid, turnId);
            return null;
          }
          const id = await options.forkSession(
            sid,
            turnId,
            `plugin-workflow:${call.pluginId}:${lease.installationId}`,
            authorize
          );
          return { workspaceId: call.workspaceId, machineId: call.machineId, sessionId: id };
        }
        if (op === 'sessions.respondInteraction') {
          const p = inputs.sessionRespondInteraction.parse(call.payload.input);
          const backend = await (
            await import('../../session/session-backend')
          ).createSessionBackend(doc);
          await scope();
          check();
          if (!(await backend.respondPermission(p.requestId, p.outcome, { turnId: p.turnId })))
            throw Error('Interaction no longer pending');
          return null;
        }
        const p = inputs.sessionSend.parse(call.payload.input),
          meta = await scope();
        if (p.delivery === 'steer' || !meta.cliType || !meta.agentType)
          throw Error('Workflow delivery unavailable');
        const userTurnId = crypto.randomUUID(),
          inputConfig = {
            prompt: p.prompt,
            inputBlocks: [{ type: 'text' as const, text: p.prompt }],
            cliType: meta.cliType,
            agentType: meta.agentType,
          };
        const e2eeIntent = await options.manager.signMachineInput({
          sessionId: sid,
          userTurnId,
          inputConfig,
          targetMachineId: options.machineId,
        });
        if (!e2eeIntent) throw Error('Unsigned workflow input');
        await scope();
        check();
        await doc.pushMessageQueue({
          userTurnId,
          operationId: `queue:${userTurnId}`,
          userId: `plugin-workflow:${call.pluginId}:${lease.installationId}`,
          task: p.prompt,
          timestamp: new Date().toISOString(),
          isEditing: false,
          editingStartedAt: undefined,
          project: meta.project,
          acpSessionConfig: inputConfig,
          e2eeIntent,
        });
        if (!doc.handle) throw Error('Session unavailable');
        const frontiers = doc.handle.doc.frontiers(),
          state = await doc.getMetaState(),
          updatedAt = Math.max(
            Date.now(),
            (state?.messageQueueUpdatedAt ?? 0) + 1,
            (state?.messageQueueCheckedAt ?? 0) + 1
          );
        check();
        await options.manager.repo.upsertDocMeta(doc.roomId, {
          messageQueueUpdatedAt: updatedAt,
          messageQueueUpdateVersion: { updatedAt, frontiers },
        });
        await options.manager.repo.flush();
        return { turnId: userTurnId, disposition: 'queued' };
      };
    }
    const target = pluginSessionCreateParams.shape.target.parse(call.payload.target),
      input = pluginSessionCreateParams.shape.input.parse(call.payload.input);
    if (
      target.workspaceId !== call.workspaceId ||
      target.machineId !== call.machineId ||
      target.projectId !== projectId ||
      target.sessionId ||
      (approval.allowed_role_ids !== '*' &&
        (!input.roleId || !approval.allowed_role_ids.includes(input.roleId))) ||
      input.pullRequestUrl
    )
      return undefined;
    const parent = input.parentSession,
      origin = input.originTurn;
    const validRef = (ref: NonNullable<typeof parent>) =>
      ref.workspaceId === target.workspaceId &&
      ref.machineId === target.machineId &&
      (ref.projectId === undefined || ref.projectId === projectId);
    if (parent && !validRef(parent)) return undefined;
    if (
      origin &&
      (!parent || !validRef(origin.session) || origin.session.sessionId !== parent.sessionId)
    )
      return undefined;
    const validateLineage = async () => {
      if (!parent) return;
      const sid = parent.sessionId as SessionId;
      const row = await options.manager.repo.getDocMeta(getSessionRoomId(sid));
      const meta = row?.meta as import('@lody/shared').SessionMeta | undefined;
      const footprint = await options.sessionScope(sid);
      if (
        !row ||
        row.deleted ||
        meta?.machineId !== target.machineId ||
        meta.id !== sid ||
        meta.project?.kind !== 'local' ||
        meta.project.localProjectId !== projectId ||
        !footprint?.length ||
        footprint.some((id) => id !== projectId)
      )
        throw Error('Workflow parent forbidden');
      if (origin) {
        const verify = options.identity.resolveVerifiedExecutionOriginal;
        const doc = (await options.manager.getOrCreateSessionDoc(sid)).handle?.doc;
        if (!verify || !doc) throw Error('Workflow origin unavailable');
        const signedRow = () => findUserTurn(doc, origin.userTurnId);
        const original = signedRow();
        if (decodeE2eeIntentRecord(original?.e2eeIntent)?.kind !== E2EE_INTENT_KIND.memberInput)
          throw Error('Workflow origin is not a signed member input');
        const proof = await Effect.runPromise(
          verify(
            { workspaceId: target.workspaceId, sessionId: sid, userTurnId: origin.userTurnId },
            doc,
            { origin: true }
          )
        );
        if (
          !proof ||
          'state' in proof ||
          proof.machineAuthored ||
          proof.derivedFrom ||
          proof.schedule ||
          JSON.stringify(original) !== JSON.stringify(signedRow())
        )
          throw Error('Workflow origin forbidden');
      }
      check();
    };
    return async () => {
      const generation = (await options.manager.pluginWorkflows()).find(
        (g) => g.pluginId === call.pluginId && basename(g.root) === lease.installationId
      );
      const role = generation?.roles.get(input.roleId!);
      if (
        (input.roleId?.startsWith('plugin:') && !role) ||
        (input.providerId?.startsWith('plugin:') &&
          !generation?.acpProviders.has(input.providerId)) ||
        (role && input.providerId && role.defaultProvider !== input.providerId)
      )
        throw Error('Workflow role binding forbidden');
      const skills = (input.skillIds ?? []).map((id) =>
        id.startsWith('plugin:') ? id : `plugin:${call.pluginId}:${id}`
      );
      if (
        new Set(skills).size !== skills.length ||
        skills.some((id) => !role?.skills.includes(id) || !generation?.skills.has(id))
      )
        throw Error('Workflow skill forbidden');
      if (!(await options.projectExists(projectId))) throw Error('Workflow project unavailable');
      check();
      const principal = `plugin-workflow:${call.pluginId}:${lease.installationId}`;
      await validateLineage();
      check();
      const params = {
        pluginId: call.pluginId,
        scope: 'project' as const,
        target,
        input: { ...input, skillIds: skills },
      };
      const receipt = await acceptVerifiedPluginCreation(
        options.manager,
        principal,
        params,
        () =>
          options.manager.createClientPluginSession(params, principal, options.machineId, check),
        check,
        async (input) => {
          await validateLineage();
          check();
          const e2eeIntent = await options.manager.signMachineInput({
            ...input,
            targetMachineId: options.machineId,
          });
          if (!e2eeIntent) throw Error('Unsigned workflow input');
          return { e2eeIntent };
        }
      );
      check();
      return { ...target, sessionId: receipt.sessionId };
    };
  };
}

/** Only retained encrypted ingress can mint the actor proof consumed by Registry. */
export async function bindDeclaredGrantActor({
  params,
  actor,
  identity,
  machineId,
  projectExists,
}: {
  params: WorkflowGrantRequest;
  actor: import('./plugin-registry').VerifiedPluginGrant;
  identity?: Pick<CliE2eeWorkspaceLegacy, 'verifyDeclaredWorkflowGrant' | 'signingPublicKey'>;
  machineId: MachineId;
  projectExists: (id: string) => Promise<boolean>;
}) {
  if (!identity || !actor.declaredGrantSignature || !actor.machineOwner)
    throw Error('Owner approval required');
  const proof = await identity.verifyDeclaredWorkflowGrant(actor.declaredGrantSignature, machineId);
  if (
    JSON.stringify(proof.approval) !== JSON.stringify(params) ||
    !proof.isCurrent() ||
    (params.action === 'grant' &&
      params.allowed_project_ids !== '*' &&
      !(await Promise.all(params.allowed_project_ids.map(projectExists))).every(Boolean))
  )
    throw Error('Workflow approval forbidden');
  return { ...actor, workflowCurrent: proof.isCurrent, targetDevice: identity.signingPublicKey };
}
