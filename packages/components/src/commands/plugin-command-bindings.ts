import {
  bindClientSessionCreate,
  type ReserveClientSession,
} from '../plugins/client-session-create';
import type { CreateSessionRequest } from '@lody/plugin-sdk';
import { useAtomValue, useStore } from 'jotai';
import { userAtom } from '../atoms';
import { activeWorkspaceRuntimeAtom } from '../atoms/runtime';
import { useSessionManagementGuard } from '../hooks/use-session-management-guard';
import { executeScheduleCommand } from './schedule-commands';
import { useState } from 'react';
import type { ClientHostBindings, LodyClient } from '@lody/plugin-sdk/client';
import type { SessionId } from '@lody/shared';
import { useSessionActions } from '../hooks/use-session-actions';

export function usePluginCommandBindings(
  workspaceId: string,
  machineId: string,
  signal: AbortSignal,
  permissions: readonly string[],
  reserveSession?: ReserveClientSession
): Pick<LodyClient, 'execute'> & Pick<ClientHostBindings, 'useLodyCommand'> {
  const { executePluginSessionCommand } = useSessionActions();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom),
    store = useStore(),
    guard = useSessionManagementGuard(runtime);
  const execute: LodyClient['execute'] = async (target, command, ...args) => {
    const permission =
      command.id === 'sessionRespondInteraction'
        ? 'sessions.approve'
        : [
              'sessionCreate',
              'sessionSend',
              'sessionStop',
              'sessionArchive',
              'sessionRestore',
              'sessionFork',
            ].includes(command.id)
          ? 'sessions.write'
          : undefined;
    if (permission && !permissions.includes(permission))
      throw Object.assign(Error('Undeclared plugin permission'), { code: 'forbidden' });
    if (command.id === 'sessionCreate') {
      const userId = store.get(userAtom)?.id;
      const check = () => {
        signal.throwIfAborted();
        if (
          !userId ||
          !runtime ||
          store.get(activeWorkspaceRuntimeAtom) !== runtime ||
          store.get(userAtom)?.id !== userId
        )
          throw Error('Plugin session create forbidden');
      };
      check();
      if (command.kind !== 'lody-command' || !('machineId' in target) || 'sessionId' in target)
        throw Error('Invalid create target');
      await guard([]);
      check();
      return (await bindClientSessionCreate(
        runtime,
        userId,
        workspaceId,
        machineId,
        signal,
        reserveSession,
        check
      )(target, args[0] as CreateSessionRequest)) as never;
    }
    if (command.id === 'scheduleSetEnabled' || command.id === 'scheduleRunNow') {
      const actor = store.get(userAtom)?.id;
      const check = () => {
        signal.throwIfAborted();
        if (
          !runtime ||
          !actor ||
          store.get(userAtom)?.id !== actor ||
          store.get(activeWorkspaceRuntimeAtom) !== runtime ||
          runtime.workspaceId !== workspaceId ||
          target.workspaceId !== workspaceId ||
          ('machineId' in target && target.machineId !== machineId) ||
          'sessionId' in target ||
          command.kind !== 'lody-command'
        )
          throw Object.assign(Error('Invalid schedule command target'), { code: 'forbidden' });
      };
      check();
      await guard([]);
      check();
      return (await executeScheduleCommand(
        runtime!,
        command.id,
        args[0],
        machineId,
        'projectId' in target ? target.projectId : undefined,
        actor!,
        check
      )) as never;
    }
    if (command.id.startsWith('pinSection'))
      throw Object.assign(Error('Workspace pin section commands are unavailable in this host'), {
        code: 'unsupported',
      });
    if (
      !('sessionId' in target) ||
      target.workspaceId !== workspaceId ||
      target.machineId !== machineId ||
      command.scope !== 'session' ||
      command.kind !== 'lody-command'
    )
      throw Object.assign(Error('Invalid session command target'), { code: 'forbidden' });
    const result = await executePluginSessionCommand(
      workspaceId,
      machineId,
      target.sessionId as SessionId,
      command.id,
      args[0],
      signal
    );
    return result as never;
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
