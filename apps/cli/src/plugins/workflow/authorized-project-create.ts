import { getSessionRoomId, type SessionId, type WorkspaceId, type MachineId } from '@lody/shared';
import {
  pluginSessionCreateParams,
  type WorkflowApprovalReceipt,
  type PluginMachineRequest,
} from '@lody/shared/plugins/machine-rpc';
import type { CliE2eeWorkspaceLegacy } from '../../lib/e2ee/workspace-legacy';
import type { LoroDocumentManager } from '../../lib/loro/doc';
import { acceptVerifiedPluginCreation, bindDaemonReadSources } from './daemon-command-runtime';
import {
  executeScopedPluginRead,
  type ResolveStandalonePluginOperation,
} from './daemon-command-executor';

interface Lease {
  receipt: WorkflowApprovalReceipt;
  installationId: string;
  machineDigest: string;
  isCurrent: () => boolean;
}
/** A workflow owns only its verifier sessions. No historical turn or plugin-supplied identity participates. */
export function authorizedProjectCreate(options: {
  workspaceId: string;
  machineId: MachineId;
  manager: LoroDocumentManager;
  identity: Pick<
    CliE2eeWorkspaceLegacy,
    'verifyWorkflowApproval' | 'signingPublicKey' | 'pluginAuthoritySignal'
  >;
  lease: (id: string, instance: number) => Promise<Lease | undefined>;
  projectExists: (id: string) => Promise<boolean>;
  sessionScope?: (id: SessionId) => Promise<readonly string[]>;
}): ResolveStandalonePluginOperation {
  return async (call, signal) => {
    const read = call.op === 'lody.read' || call.op === 'lody.readSnapshot';
    if (
      !read &&
      call.op !== 'sessions.create' &&
      !(call.op === 'lody.execute' && call.payload.descriptorId === 'sessionCreate')
    )
      return undefined;
    if (call.workspaceId !== options.workspaceId || call.machineId !== options.machineId)
      return undefined;
    const lease = await options.lease(call.pluginId, call.instanceId);
    if (!lease) return undefined;
    const { approval, isCurrent } = await options.identity.verifyWorkflowApproval(
      lease.receipt,
      call.machineId
    );
    if (
      approval.action !== 'grant' ||
      approval.operation !== 'sessions.create' ||
      approval.pluginId !== call.pluginId ||
      approval.installationId !== lease.installationId ||
      approval.machineDigest !== lease.machineDigest ||
      approval.targetDevice !== options.identity.signingPublicKey
    )
      return undefined;
    const check = () => {
      signal.throwIfAborted();
      options.identity.pluginAuthoritySignal.throwIfAborted();
      if (!lease.isCurrent() || !isCurrent() || Date.now() >= approval.expiresAt)
        throw Error('Workflow create approval withdrawn');
    };
    check();
    const projectId = approval.projectId;
    if (read) {
      // Legacy create-only receipts never authorize reading source sessions.
      const reads = approval.readOperations;
      const scope = options.sessionScope;
      if (!Array.isArray(reads) || !scope) return undefined;
      const raw = call.payload.target,
        snapshot = call.op === 'lody.readSnapshot';
      const nested =
        snapshot &&
        typeof raw === 'object' &&
        raw !== null &&
        !Array.isArray(raw) &&
        raw.kind === 'session-meta'
          ? raw.session
          : undefined;
      const method = snapshot ? (nested ? 'session-meta' : undefined) : call.payload.descriptorId;
      if (!method || !reads.some((operation) => operation === method)) return undefined;
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
        const result = await executeScopedPluginRead(
          {
            ...ctx,
            ...bindDaemonReadSources({ ...ctx, manager: options.manager, sessionScope: scope }),
          },
          snapshot ? 'lody.readSnapshot' : 'lody.read',
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
    const target = pluginSessionCreateParams.shape.target.parse(call.payload.target),
      input = pluginSessionCreateParams.shape.input.parse(call.payload.input);
    if (
      target.workspaceId !== call.workspaceId ||
      target.machineId !== call.machineId ||
      target.projectId !== projectId ||
      target.sessionId ||
      input.parentSession ||
      input.originTurn ||
      input.skillIds?.length ||
      input.pullRequestUrl
    )
      return undefined;
    return async () => {
      if (!(await options.projectExists(projectId))) throw Error('Workflow project unavailable');
      check();
      const principal = `plugin-workflow:${call.pluginId}:${lease.installationId}`;
      const params = { pluginId: call.pluginId, scope: 'project' as const, target, input };
      const receipt = await acceptVerifiedPluginCreation(
        options.manager,
        principal,
        params,
        () =>
          options.manager.createClientPluginSession(params, principal, options.machineId, check),
        check,
        async (input) => {
          check();
          const e2eeIntent = await options.manager.signMachineInput({
            ...input,
            targetMachineId: options.machineId,
          });
          if (!e2eeIntent) throw Error('Unsigned verifier input');
          return { e2eeIntent };
        }
      );
      check();
      return { ...target, sessionId: receipt.sessionId };
    };
  };
}

/** Only retained encrypted ingress can mint the actor proof consumed by Registry. */
export async function bindWorkflowApprovalActor({
  request,
  actor,
  identity,
  machineId,
  projectExists,
}: {
  request: Extract<PluginMachineRequest, { method: 'plugin/workflow-create-approval' }>;
  actor: import('./plugin-registry').VerifiedPluginGrant;
  identity?: Pick<CliE2eeWorkspaceLegacy, 'verifyWorkflowApproval' | 'signingPublicKey'>;
  machineId: MachineId;
  projectExists: (id: string) => Promise<boolean>;
}) {
  if (!identity || !actor.workflowReceipt || !actor.machineOwner)
    throw Error('Owner approval required');
  const proof = await identity.verifyWorkflowApproval(actor.workflowReceipt, machineId);
  if (
    JSON.stringify(proof.approval) !== JSON.stringify(request.params) ||
    !proof.isCurrent() ||
    (request.params.action === 'grant' &&
      (request.params.expiresAt <= Date.now() ||
        request.params.expiresAt > Date.now() + 86400000 ||
        !(await projectExists(request.params.projectId))))
  )
    throw Error('Workflow approval forbidden');
  return { ...actor, workflowCurrent: proof.isCurrent, targetDevice: identity.signingPublicKey };
}
