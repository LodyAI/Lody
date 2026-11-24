import { Effect } from 'effect';
import { requestLocalPluginControl } from '@lody/shared/node/local-ipc';
export async function requestPluginControl(
  command:
    | { action: 'link'; path: string; dev: true }
    | { action: 'logs' | 'reload' | 'disable' | 'remove' | 'rollback'; pluginId: string },
  encryptedWorkspaceId?: string
) {
  const { response, payload } = await Effect.runPromise(
    requestLocalPluginControl({ encryptedWorkspaceId, command })
  );
  if (!response.ok) throw new Error(`Plugin ${command.action} failed (${response.status})`);
  return payload;
}
