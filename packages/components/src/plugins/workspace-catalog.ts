import type { MachineId } from '@lody/shared';
import type { createWorkspaceMachineRpcFacade } from '../providers/workspace-machine-rpc-facade';
import type { ClientCatalogInstallation } from './client-host-provider';
import type { PluginCallPort } from './query-bindings';
import { z } from 'zod';

export type RequestPlugin = ReturnType<typeof createWorkspaceMachineRpcFacade>['requestPlugin'];
export interface CatalogMachine {
  machineId: MachineId;
  owner: boolean;
}
export async function readPluginCatalog(
  workspaceId: string,
  machine: CatalogMachine,
  request: RequestPlugin,
  makeRegistry: (
    entry: ClientCatalogInstallation,
    port: PluginCallPort
  ) => ClientCatalogInstallation['registry']
): Promise<ClientCatalogInstallation[]> {
  const target = machine.machineId;
  const response = await request(target, { method: 'plugin/catalog', params: {} });
  if (response.type !== 'plugin/catalog') throw new Error('Unexpected plugin catalog');
  return response.installations.map((row) => {
    const pluginId = row.manifest.id;
    const port: PluginCallPort = {
      async call(method, descriptorId, ref, input, signal) {
        signal.throwIfAborted();
        if (ref.machineId !== target || ref.workspaceId !== workspaceId)
          throw Error('Plugin target mismatch');
        const scope = 'sessionId' in ref ? 'session' : 'projectId' in ref ? 'project' : 'machine';
        const result = await request(
          target,
          {
            method,
            params: {
              pluginId,
              descriptorId,
              clientDigest: row.clientDigest,
              scope,
              target: ref,
              input: z.json().parse(input),
            },
          },
          { signal, requireLocal: response.transport === 'local' }
        );
        signal.throwIfAborted();
        if (result.type !== method) throw Error('Unexpected plugin invocation response');
        return result.data;
      },
    };
    const entry: ClientCatalogInstallation = {
      ...(row.enabled &&
      row.manifest.permissions?.includes('workflow.autonomous') &&
      row.manifest.permissions.some((p) => p === 'sessions.write' || p === 'sessions.approve') &&
      row.workflowInstallation &&
      response.transport === 'encrypted' &&
      machine.owner
        ? {
            workflowBinding: JSON.stringify([
              workspaceId,
              target,
              pluginId,
              row.clientDigest,
              row.workflowInstallation.installationId,
              row.workflowInstallation.machineDigest,
              row.workflowInstallation.targetDevice,
              row.workflowInstallation.activeGrant?.grant_id,
            ]),
            declaredGrant: row.workflowInstallation.activeGrant,
            workflowApproval: async (
              projectId: string,
              action: 'grant' | 'revoke',
              roleIds: string[] | '*',
              operations: import('@lody/shared/plugins/machine-rpc').DeclaredWorkflowGrant['allowed_ops']
            ) => {
              const { issuer, activeGrant, ...binding } = row.workflowInstallation!;
              if (action === 'revoke' && !activeGrant) throw Error('No active grant');
              const now = Date.now();
              const result = await request(target, {
                method: 'plugin/declared-workflow-grant',
                params: {
                  ...binding,
                  issued_by_user_id: issuer,
                  grant_id: action === 'revoke' ? activeGrant!.grant_id : crypto.randomUUID(),
                  issued_at_ms: now,
                  workspace_id: workspaceId,
                  machine_id: target,
                  plugin_id: pluginId,
                  allowed_project_ids:
                    action === 'revoke'
                      ? activeGrant!.allowed_project_ids
                      : projectId === '*'
                        ? '*'
                        : [projectId],
                  allowed_role_ids: action === 'revoke' ? activeGrant!.allowed_role_ids : roleIds,
                  allowed_ops: action === 'revoke' ? activeGrant!.allowed_ops : operations,
                  action,
                },
              });
              if (
                result.type !== 'plugin/declared-workflow-grant' ||
                result.active !== (action === 'grant')
              )
                throw Error('Workflow approval not confirmed');
              return;
            },
          }
        : {}),
      workflowPrompts: row.workflowPrompts,
      async reserveSession(ref, input, signal) {
        if (!row.clientDigest || ref.workspaceId !== workspaceId || ref.machineId !== target)
          throw Error('Plugin create forbidden');
        const result = await request(
          target,
          {
            method: 'plugin/session-create',
            params: {
              pluginId,
              clientDigest: row.clientDigest,
              target: ref,
              scope: 'projectId' in ref ? 'project' : 'machine',
              input: { ...input, skillIds: input.skillIds?.slice() },
            },
          },
          { signal, requireLocal: response.transport === 'local' }
        );
        if (result.type !== 'plugin/session-create') throw Error('Invalid session receipt');
        return result;
      },
      inspection: row.inspection,
      workspaceId,
      pluginId,
      machineId: target,
      sourceKey: response.transport === 'local' ? 'local' : `machine:${target}`,
      configurationKey: JSON.stringify([
        row.manifest,
        row.inspection?.preferences,
        row.inspection?.projectPreferences,
      ]),
      digest: row.clientDigest ?? '',
      invalidations: row.invalidations ?? 0,
      client: row.manifest.client,
      enabled: row.enabled,
      dev: {
        workspaceId,
        machineId: target,
        manifest: row.manifest,
        owner: machine.owner,
        devMode: !!row.devSessionNonce,
        devSessionNonce: row.devSessionNonce,
      },
      async page(offset, signal) {
        signal.throwIfAborted();
        if (!row.clientDigest) throw Error('No client bundle');
        const reply = await request(
          target,
          {
            method: 'plugin/bundle-chunk',
            params: { pluginId, clientDigest: row.clientDigest, offset },
          },
          { signal, requireLocal: response.transport === 'local' }
        );
        signal.throwIfAborted();
        if (reply.type !== 'plugin/bundle-chunk') throw Error('Unexpected plugin bundle response');
        return {
          bytes: Uint8Array.from(atob(reply.base64), (c) => c.charCodeAt(0)),
          totalBytes: reply.totalBytes,
        };
      },
      ...(response.transport === 'local'
        ? {
            inspect: async () => {
              const result = await request(
                target,
                {
                  method: 'plugin/control',
                  params: { pluginId, clientDigest: row.clientDigest, action: 'inspect' },
                },
                { requireLocal: true }
              );
              if (result.type !== 'plugin/control') throw Error('Unexpected inspection response');
              return result.inspection;
            },
            control: async (action, changes, projectId) => {
              const result = await request(
                target,
                {
                  method: 'plugin/control',
                  params: {
                    pluginId,
                    clientDigest: row.clientDigest,
                    action: action === 'configure' ? 'configure-many' : action,
                    changes,
                    projectId,
                  },
                },
                { requireLocal: true }
              );
              if (result.type !== 'plugin/control')
                throw Error('Unexpected plugin control response');
              return result.inspection;
            },
          }
        : {}),
      registry: (...args) => makeRegistry(entry, port)(...args),
    };
    return entry;
  });
}
