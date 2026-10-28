import { useCallback, useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { sessionContinuationFeatureEnabledAtom } from '@/atoms/settings';
import { getIpcServices } from '@/lib/electron-ipc-client';
import type { SessionContinuationView } from './session-continuation';
import type { SessionContinuationTweaksValue } from './session-continuation-tweaks';
import type { AutomationSettings } from '@lody/shared/automations';

type Target = { workspaceId: string; machineId: string; sessionId: string };
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
  };
}

type Snapshot = {
  key: string;
  views: SessionContinuationView[];
  settings: AutomationSettings | null;
};
export function useLocalSessionContinuation(target: Target | null, visible: boolean) {
  const enabled = useAtomValue(sessionContinuationFeatureEnabledAtom);
  const key = target ? `${target.workspaceId}:${target.machineId}:${target.sessionId}` : '';
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const workspaceId = target?.workspaceId;
  const machineId = target?.machineId;
  const sessionId = target?.sessionId;

  useEffect(() => {
    if (!enabled || !visible || !workspaceId || !machineId || !sessionId) return;
    const service = getIpcServices()?.sessionControl;
    if (!service) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const identity = { workspaceId, machineId, sessionId };
    const read = async () => {
      try {
        const [waits, settings] = await Promise.allSettled([
          service.automation({ ...identity, command: { type: 'list' } }),
          service.automation({ ...identity, command: { type: 'settings' } }),
        ]);
        if (waits.status !== 'fulfilled' || waits.value.type !== 'list')
          throw new Error('invalid response');
        if (active) {
          setSnapshot({
            key,
            views: waits.value.waits.map(toView),
            settings:
              settings.status === 'fulfilled' && settings.value.type === 'settings'
                ? settings.value.settings
                : null,
          });
          setErrorKey(null);
        }
      } catch {
        if (active) setErrorKey(key);
      } finally {
        if (active) timer = setTimeout(read, 15_000);
      }
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [enabled, visible, workspaceId, machineId, sessionId, key, revision]);

  const current = enabled && target && snapshot?.key === key ? snapshot : null;
  const send = useCallback(
    async (
      command: { type: 'cancel'; id: string } | { type: 'configure'; settings: AutomationSettings }
    ) => {
      if (!enabled || !target || busy) return;
      const service = getIpcServices()?.sessionControl;
      if (!service) {
        setErrorKey(key);
        return;
      }
      setBusy(true);
      try {
        await service.automation({ ...target, command });
        setErrorKey(null);
        refresh();
      } catch {
        setErrorKey(key);
      } finally {
        setBusy(false);
      }
    },
    [enabled, target, busy, refresh, key]
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
    views: current?.views ?? [],
    value,
    error: enabled && !!target && errorKey === key,
    busy,
    setTweak,
    cancel: (id: string) => void send({ type: 'cancel', id }),
  };
}
