import { Effect } from 'effect';
import type { AutomationCommand } from '@lody/shared/automations';
import { makeLocalControlClientAuto } from '@lody/shared/node/local-ipc';
import { makeLocalWorkspaceCatalog } from '@/lib/local-workspace-catalog';
import {
  classifyLocalDaemonIpcError,
  getAuthContextOrThrow,
  resolveWorkspaceOrThrow,
} from '@/lib/command-runtime';
import { LODY_AUTH_URL } from '@/utils/const';

/** CLI/MCP application boundary; accepted automation always belongs to the daemon. */
export async function sendDaemonAutomationCommand(
  command: AutomationCommand,
  target: {
    machineId: string;
    workspaceId: string;
    requesterSessionId?: string;
    socketPath?: string;
  }
): Promise<unknown> {
  const result = await Effect.runPromise(
    makeLocalControlClientAuto({ socketPath: target.socketPath })
      .automationControl({
        machineId: target.machineId,
        workspaceId: target.workspaceId,
        requesterSessionId: target.requesterSessionId,
        command,
      })
      .pipe(Effect.result)
  );
  if (result._tag === 'Failure') throw classifyLocalDaemonIpcError(result.failure);
  if (!result.success.ok) throw new Error(result.success.error);
  return result.success.result;
}

export async function sendAutomationCommand(
  command: AutomationCommand,
  selector?: string
): Promise<unknown> {
  if (LODY_AUTH_URL) {
    const auth = getAuthContextOrThrow('automation');
    const workspace = await resolveWorkspaceOrThrow(auth, selector);
    return sendDaemonAutomationCommand(command, {
      machineId: auth.machineId,
      workspaceId: workspace.id,
    });
  }
  const catalog = await Effect.runPromise(makeLocalWorkspaceCatalog().read());
  const selected = selector ?? process.env.LODY_WORKSPACE_ID;
  const candidates = catalog.workspaces.filter(
    (row) =>
      row.state === 'active' &&
      (!selected || [row.workspaceId, row.slug, row.name].includes(selected))
  );
  const candidate = candidates[0];
  if (candidates.length !== 1 || !candidate || !catalog.machine)
    throw new Error(
      'Choose an active local workspace with --workspace; start the local daemon first'
    );
  return sendDaemonAutomationCommand(command, {
    machineId: catalog.machine.machineId,
    workspaceId: candidate.workspaceId,
  });
}
