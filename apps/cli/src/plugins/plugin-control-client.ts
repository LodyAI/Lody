import { Effect } from 'effect';
import { requestLocalPluginControl } from '@lody/shared/node/local-ipc';
export async function requestPluginControl(
  command:
    | { action: 'install'; path: string; sha256: string }
    | { action: 'link'; path: string; dev: true }
    | { action: 'logs' | 'reload' | 'disable' | 'rollback'; pluginId: string },
  encryptedWorkspaceId?: string
) {
  const { response, payload } = await Effect.runPromise(
    requestLocalPluginControl(
      encryptedWorkspaceId !== undefined ? { encryptedWorkspaceId, command } : command
    )
  );
  if (!response.ok) throw new Error(`Plugin ${command.action} failed (${response.status})`);
  return payload;
}
