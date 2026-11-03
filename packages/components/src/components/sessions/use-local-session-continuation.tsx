import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { MACHINE_PROTOCOL_CAPABILITIES, machineSupportsProtocolCapability } from '@lody/shared';
import { getMachineMetaByIdAtomFamily } from '@/atoms/machines';
import { getIpcServices } from '@/lib/electron-ipc-client';
import type { SessionContinuationView } from './session-continuation';
import type { SessionContinuationTweaksValue } from './session-continuation-tweaks';
import type { AutomationSettings } from '@lody/shared/automations';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import type { MachineId, SessionId } from '@lody/shared';
import type { RemoteAutomationOperation } from '@lody/shared/automations';

type Target = {
  workspaceId: string;
  machineId: string;
  sessionId: string;
  remote?: { runtime: WorkspaceRuntime; requesterUserId: string };
};
type Wait = {
  id: string;
  reason?: string;
  state: string;
  nextCheckAt: number;
  expiresAt?: number;
  continuation?: { state: string; reason?: string };
};

function toView(wait: Wait): SessionContinuationView {
  const phase = wait.state === 'checking' ? 'waiting' : wait.state;
  const state = wait.continuation?.state;
  const delivery =
    state === 'running'
      ? 'running'
      : state === 'settled'
        ? 'settled'
        : state === 'blocked'
          ? 'blocked'
          : state === 'queued'
            ? 'queued'
            : 'unknown';
  return {
    id: wait.id,
    reason: wait.reason ?? '',
    phase:
      phase === 'matched' && state === 'failed'
        ? 'failed'
        : phase === 'matched' && (state === 'cancelled' || state === 'superseded')
          ? 'cancelled'
          : ['waiting', 'matched', 'failed', 'expired', 'cancelled'].includes(phase)
            ? (phase as SessionContinuationView['phase'])
            : 'unknown',
    nextCheckAt: wait.nextCheckAt,
    expiresAt: wait.expiresAt,
    ...(phase === 'matched' ? { continuation: delivery } : {}),
    ...(state === 'blocked' && wait.continuation?.reason === 'target_stopped'
      ? { block: 'stopped' as const }
      : {}),
  };
}

type Snapshot = {
  key: string;
  views: SessionContinuationView[];
  settings: AutomationSettings | null;
  listError: boolean;
  settingsUnavailable: boolean;
};
export function useLocalSessionContinuation(requestedTarget: Target | null, visible: boolean) {
  const { t } = useTranslation();
  const machine = useAtomValue(
    getMachineMetaByIdAtomFamily(requestedTarget?.machineId as MachineId | undefined)
  );
  const supported = machineSupportsProtocolCapability(
    machine,
    requestedTarget?.remote
      ? MACHINE_PROTOCOL_CAPABILITIES.remoteAutomationControl
      : MACHINE_PROTOCOL_CAPABILITIES.sessionAutomations
  );
  const target = supported ? requestedTarget : null;
  const key = target
    ? JSON.stringify([
        target.workspaceId,
        target.machineId,
        target.sessionId,
        target.remote?.requesterUserId ?? null,
      ])
    : '';
  const currentKey = useRef(key);
  currentKey.current = key;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const workspaceId = target?.workspaceId;
  const machineId = target?.machineId;
  const sessionId = target?.sessionId;
  const remoteRuntime = target?.remote?.runtime;
  const requesterUserId = target?.remote?.requesterUserId;

  const execute = useCallback(
    async (command: RemoteAutomationOperation) => {
      if (!workspaceId || !machineId || !sessionId)
        throw new Error('Automation target unavailable');
      if (remoteRuntime && requesterUserId) {
        if (!remoteRuntime.requestSessionAutomationControl)
          throw new Error('Remote automation unavailable');
        return remoteRuntime.requestSessionAutomationControl(
          machineId as MachineId,
          sessionId as SessionId,
          requesterUserId,
          command
        );
      }
      const service = getIpcServices()?.sessionControl;
      if (!service) throw new Error('Local automation unavailable');
      return service.automation({ workspaceId, machineId, sessionId, command });
    },
    [workspaceId, machineId, sessionId, remoteRuntime, requesterUserId]
  );

  useEffect(() => {
    if (!workspaceId || !machineId || !sessionId) {
      setSnapshot(null);
      return undefined;
    }
    if (!visible) return undefined;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const [waits, settings] = await Promise.allSettled([
        execute({ type: 'list' }),
        execute({ type: 'settings' }),
      ]);
      if (active) {
        const listOk = waits.status === 'fulfilled' && waits.value.type === 'list';
        const settingsOk = settings.status === 'fulfilled' && settings.value.type === 'settings';
        setSnapshot((previous) => {
          const sameTarget = previous?.key === key ? previous : null;
          return {
            key,
            views: listOk ? waits.value.waits.map(toView) : (sameTarget?.views ?? []),
            settings: settingsOk ? settings.value.settings : (sameTarget?.settings ?? null),
            listError: !listOk,
            settingsUnavailable: !settingsOk,
          };
        });
        timer = setTimeout(() => void read(), 15_000);
      }
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [visible, workspaceId, machineId, sessionId, key, revision, execute]);

  const current = target && snapshot?.key === key ? snapshot : null;
  const send = useCallback(
    async (
      command: { type: 'cancel'; id: string } | { type: 'configure'; settings: AutomationSettings }
    ) => {
      if (!target || busy) return;
      setBusy(true);
      try {
        const result = await execute(command);
        if (result.type !== (command.type === 'cancel' ? 'cancel' : 'settings')) {
          throw new Error('Invalid automation response');
        }
      } catch {
        if (currentKey.current === key) {
          setSnapshot((previous) =>
            previous?.key === key
              ? {
                  ...previous,
                  ...(command.type === 'cancel'
                    ? { listError: true }
                    : { settingsUnavailable: true }),
                }
              : previous
          );
          toast.error(
            command.type === 'cancel'
              ? t(
                  'sessions.continuation.cancelUnknown',
                  'Could not confirm whether the wait was cancelled. Checking again…'
                )
              : t(
                  'sessions.continuation.settingsUnknown',
                  'Could not confirm whether the setting was saved. Checking again…'
                )
          );
        }
      } finally {
        if (currentKey.current === key) refresh();
        setBusy(false);
      }
    },
    [target, busy, refresh, execute, t, key]
  );
  const value: SessionContinuationTweaksValue | null = current?.settings
    ? {
        recoverCapacity: current.settings.recoverCapacity === true,
        archiveAfterMerge: current.settings.archiveAfterMerge === true,
        compactWhenIdle: typeof current.settings.compactWhenIdle === 'object',
      }
    : null;
  const setTweak = useCallback(
    (name: keyof SessionContinuationTweaksValue, checked: boolean) => {
      const compact = current?.settings?.compactWhenIdle;
      const setting =
        name === 'compactWhenIdle' && checked
          ? typeof compact === 'object'
            ? compact
            : { contextTokens: 300_000, cacheTtlMs: 600_000, leadTimeMs: 60_000 }
          : checked;
      void send({ type: 'configure', settings: { [name]: setting } });
    },
    [current, send]
  );
  return {
    supported: !!target,
    views: current?.views ?? [],
    value,
    recoveryEnabled: current?.settings ? current.settings.recoverCapacity === true : null,
    error: current?.listError ?? false,
    settingsUnavailable: current?.settingsUnavailable ?? false,
    busy,
    refresh,
    setTweak,
    cancel: (id: string) => void send({ type: 'cancel', id }),
  };
}
