import { useState } from 'react';
import type { ClientHostBindings, LodyClient } from '@lody/plugin-sdk/client';
import type { SessionId } from '@lody/shared';
import { useSessionActions } from '../hooks/use-session-actions';

export function usePluginCommandBindings(
  workspaceId: string,
  machineId: string,
  signal: AbortSignal
): Pick<LodyClient, 'execute'> & Pick<ClientHostBindings, 'useLodyCommand'> {
  const { executePluginSessionCommand } = useSessionActions();
  const execute: LodyClient['execute'] = async (target, command, ...args) => {
    if (
      !('sessionId' in target) ||
      target.workspaceId !== workspaceId ||
      target.machineId !== machineId ||
      command.scope !== 'session' ||
      command.kind !== 'lody-command'
    )
      throw Object.assign(Error('Invalid session command target'), { code: 'forbidden' });
    await executePluginSessionCommand(
      workspaceId,
      machineId,
      target.sessionId as SessionId,
      command.id,
      args[0],
      signal
    );
    // Every command currently handled by the session executor has void output.
    return undefined as never;
  };
  return {
    execute,
    useLodyCommand(target, command) {
      const [active, setActive] = useState(0);
      return {
        pending: active > 0,
        mutate: async (input) => {
          setActive((n) => n + 1);
          try {
            return await execute(target, command, input);
          } finally {
            setActive((n) => n - 1);
          }
        },
      };
    },
  };
}
