import { Effect } from 'effect';
import type { ScheduleCommand, SessionId } from '@lody/shared';
import { makeLocalControlClientAuto } from '@lody/shared/node/local-ipc';
import { makeLocalWorkspaceCatalog } from '../local-workspace-catalog';
import {
  classifyLocalDaemonIpcError,
  getAuthContextOrThrow,
  resolveWorkspaceOrThrow,
  withWorkspaceManager,
} from '../command-runtime';
import { executeScheduleCommand } from './schedule-command-service';
import { LODY_AUTH_URL } from '@/utils/const';

export async function sendScheduleCommand(
  command: ScheduleCommand,
  options: { workspace?: string; requesterSessionId?: SessionId } = {}
): Promise<unknown> {
  if (LODY_AUTH_URL) {
    const auth = getAuthContextOrThrow('schedule');
    const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);
    return withWorkspaceManager(auth, workspace, 'schedule', (manager) =>
      executeScheduleCommand(
        {
          manager,
          auth,
          workspace,
          localOnly: false,
          requesterSessionId: options.requesterSessionId,
        },
        command
      )
    );
  }
  const catalog = await Effect.runPromise(makeLocalWorkspaceCatalog().read());
  const selector = options.workspace ?? process.env.LODY_WORKSPACE_ID;
  const candidates = catalog.workspaces.filter(
    (row) =>
      row.state === 'active' &&
      (!selector || [row.workspaceId, row.slug, row.name].includes(selector))
  );
  if (candidates.length !== 1 || !catalog.machine)
    throw new Error(
      'Choose an active local workspace with --workspace; start the local daemon first'
    );
  const response = await Effect.runPromise(
    makeLocalControlClientAuto()
      .scheduleControl({
        machineId: catalog.machine.machineId,
        workspaceId: candidates[0]!.workspaceId,
        command,
        requesterSessionId: options.requesterSessionId,
      })
      .pipe(Effect.either)
  );
  if (response._tag === 'Left') throw classifyLocalDaemonIpcError(response.left);
  if (!response.right.ok) throw new Error(response.right.error);
  return response.right.result;
}
