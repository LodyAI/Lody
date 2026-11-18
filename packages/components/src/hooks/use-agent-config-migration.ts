import { useEffect, useMemo, useRef, useState } from 'react';
import { atom, useAtomValue } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { type AgentConfigId, type MachineId, getAgentConfigRoomId } from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { getLegacyAgentConfigsAtom, writeAgentConfigToMachineFlock } from '@/atoms/agents';
import { useVisibleMachineMetas } from './use-visible-machine-metas';
import { withoutEncryptedSharedMachines } from '@/lib/visible-machine-index';

const EMPTY_LEGACY_CONFIGS = atom<never[]>([]);

const MUTEX_KEY_PREFIX = 'lody-agent-config-migration:';
const MUTEX_TTL_MS = 60_000;

type MigrationStatus = 'idle' | 'running' | 'done' | 'error';

/**
 * BC-AGENT-CONFIG-MACHINE-ASSOCIATION
 *
 * Fan out pre-refactor `AgentConfigMeta` records (which have no `machineId`) so
 * there is exactly one config per (legacy config × visible machine). The original
 * legacy doc is deleted after the fan-out. This hook is idempotent: subsequent
 * reads find no legacy configs and do nothing.
 *
 * The mutex guards against two tabs racing through the same migration.
 */
export function useAgentConfigMigration(options: { enabled?: boolean } = {}): {
  status: MigrationStatus;
  legacyCount: number;
} {
  const enabled = options.enabled ?? true;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const legacyConfigs = useAtomValue(enabled ? getLegacyAgentConfigsAtom : EMPTY_LEGACY_CONFIGS);
  const visibleMachineIndex = useVisibleMachineMetas({ includeMachineFlock: false });
  const { isLoading } = visibleMachineIndex;
  // Never write automatically into another member's encrypted shared machine.
  const machines = useMemo(
    () => withoutEncryptedSharedMachines(visibleMachineIndex.machines, visibleMachineIndex),
    [visibleMachineIndex]
  );
  const [status, setStatus] = useState<MigrationStatus>('idle');
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled || !runtime || !workspaceId) return;
    if (isLoading) return;
    if (inFlightRef.current) return;
    if (legacyConfigs.length === 0) {
      setStatus((prev) => (prev === 'running' ? 'done' : prev));
      return;
    }
    if (machines.size === 0) return;

    const mutexKey = `${MUTEX_KEY_PREFIX}${workspaceId}`;
    if (!acquireMutex(mutexKey)) return;

    inFlightRef.current = true;
    setStatus('running');

    const machineIds = Array.from(machines.keys());
    const legacySnapshot = legacyConfigs;

    void (async () => {
      try {
        for (const legacy of legacySnapshot) {
          for (const machineId of machineIds) {
            if (!enabledRef.current) return;
            const newId = uuidv4() as AgentConfigId;
            const nextMeta = {
              id: newId,
              machineId: machineId as MachineId,
              name: legacy.name,
              description: legacy.description,
              cliType: legacy.cliType,
              agentType: legacy.agentType,
              customAcp: legacy.customAcp,
              runtimeOverrides: legacy.runtimeOverrides,
              env: legacy.env,
              prompt: legacy.prompt,
              titleGeneration: legacy.titleGeneration,
              brandId: legacy.brandId,
            };
            await writeAgentConfigToMachineFlock(runtime, nextMeta);
          }
          if (!enabledRef.current) return;
          await runtime.writer.deleteDoc(getAgentConfigRoomId(legacy.id));
        }
        setStatus('done');
      } catch (error) {
        console.error('[agent-config-migration] failed:', error);
        setStatus('error');
      } finally {
        releaseMutex(mutexKey);
        inFlightRef.current = false;
      }
    })();
  }, [runtime, workspaceId, legacyConfigs, machines, isLoading, enabled]);

  return { status: enabled ? status : 'idle', legacyCount: enabled ? legacyConfigs.length : 0 };
}

function acquireMutex(key: string): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const now = Date.now();
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && now - parsed < MUTEX_TTL_MS) {
        return false;
      }
    }
    window.localStorage.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

function releaseMutex(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
