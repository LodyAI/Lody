import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useMemo, useState } from 'react';
import type { AgentConfigMeta, AgentSessionDefaults, MachineId } from '@lody/shared';

import { cmdUpdateAgentConfigAtom, getAllAgentConfigAtom } from '@/atoms/agents';
import { useRefreshMachineAcpCapabilities } from '@/hooks/use-refresh-machine-acp-capabilities';

import type { Autonomy } from './catalog';
import { useDeviceCapabilities } from './device-capabilities';
import { useActiveDevice } from './machines';
import { harness, useHarness, type Scope } from './store';

/** The harness keys that map onto a real Sorbet session setting. */
export type SessionDefaultKey = 'mainModel' | 'effort' | 'autonomy';
export const SESSION_DEFAULT_KEYS: SessionDefaultKey[] = ['mainModel', 'effort', 'autonomy'];

/** Sorbet's ACP config ids; the probe's own option ids win when it reports them. */
export const SORBET_MODEL_CONFIG_ID = 'model';
export const SORBET_THOUGHT_LEVEL_CONFIG_ID = 'thought_level';
export const SORBET_PERMISSION_MODE_CONFIG_ID = 'permission_mode';

/** The three autonomy cards are Sorbet's three selectable permission modes. */
export const AUTONOMY_PERMISSION_MODE: Record<Autonomy, string> = {
  ask: 'ask',
  smart: 'auto',
  auto: 'full-access',
};
const PERMISSION_MODE_AUTONOMY = Object.fromEntries(
  Object.entries(AUTONOMY_PERMISSION_MODE).map(([autonomy, mode]) => [mode, autonomy])
) as Record<string, Autonomy>;

const isSorbet = (config: Pick<AgentConfigMeta, 'cliType' | 'agentType'>) =>
  config.cliType === 'builtin' && config.agentType === 'sorbet';

/** Each machine's Lody Agent Provider: the lowest id, as the bridge resolves it. */
export function sorbetConfigsByMachine(configs: AgentConfigMeta[]) {
  const byMachine = new Map<MachineId, AgentConfigMeta>();
  for (const config of [...configs].filter(isSorbet).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!byMachine.has(config.machineId)) byMachine.set(config.machineId, config);
  }
  return byMachine;
}

interface ConfigIds {
  model: string;
  effort: string;
}

export function readSessionDefault(
  defaults: AgentSessionDefaults | undefined,
  key: SessionDefaultKey,
  ids: ConfigIds
): string | undefined {
  const values = defaults?.configOptionValues ?? {};
  const read = (id: string) =>
    typeof values[id] === 'string' ? (values[id] as string) : undefined;
  if (key === 'mainModel') return read(ids.model) ?? defaults?.modelId;
  if (key === 'effort') return read(ids.effort);
  const mode = read(SORBET_PERMISSION_MODE_CONFIG_ID);
  return mode ? PERMISSION_MODE_AUTONOMY[mode] : undefined;
}

export function writeSessionDefault(
  defaults: AgentSessionDefaults | undefined,
  key: SessionDefaultKey,
  value: string,
  ids: ConfigIds
): AgentSessionDefaults {
  const configOptionValues = { ...defaults?.configOptionValues };
  const next: AgentSessionDefaults = { ...defaults, configOptionValues };
  if (key === 'mainModel') {
    // Sorbet carries the model as a config option; a legacy id would only
    // switch the model a second time.
    configOptionValues[ids.model] = value;
    delete next.modelId;
  } else if (key === 'effort') {
    configOptionValues[ids.effort] = value;
  } else {
    configOptionValues[SORBET_PERMISSION_MODE_CONFIG_ID] =
      AUTONOMY_PERMISSION_MODE[value as Autonomy] ?? value;
  }
  return next;
}

export interface SessionDefaults {
  /** What the scope shows for each key; `undefined` when nothing is known yet. */
  values: Partial<Record<SessionDefaultKey, string>>;
  /** Keys this device sets differently from the profile. */
  overridden: Set<SessionDefaultKey>;
  /** How many keys a given device overrides; drives the device switcher's meta. */
  overridesFor: (machineId: string) => number;
  /** Permission modes the selected machine's agent offers, as autonomy ids. */
  autonomyOffered: Set<Autonomy> | null;
  set: (key: SessionDefaultKey, value: string) => Promise<void>;
  reset: (keys: SessionDefaultKey[]) => Promise<void>;
  /** Machines a write is still landing on, and the last write's failure. */
  saving: boolean;
  error: string | null;
  /** False until the machine has a Lody Agent Provider to write to. */
  available: boolean;
}

export function useSessionDefaults(scope: Scope): SessionDefaults {
  const state = useHarness();
  const { device } = useActiveDevice();
  const capabilities = useDeviceCapabilities();
  const allConfigs = useAtomValue(getAllAgentConfigAtom);
  const updateConfig = useSetAtom(cmdUpdateAgentConfigAtom);
  const refreshCapabilities = useRefreshMachineAcpCapabilities();
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const configs = useMemo(() => sorbetConfigsByMachine(allConfigs), [allConfigs]);
  const deviceConfig = device ? configs.get(device.id as MachineId) : undefined;
  const ids: ConfigIds = useMemo(
    () => ({
      model: capabilities.modelOption?.id ?? SORBET_MODEL_CONFIG_ID,
      effort: capabilities.effortOption?.id ?? SORBET_THOUGHT_LEVEL_CONFIG_ID,
    }),
    [capabilities.modelOption?.id, capabilities.effortOption?.id]
  );
  const permissionOption = capabilities.capability?.configOptions?.find(
    (option) => option.id === SORBET_PERMISSION_MODE_CONFIG_ID && option.type === 'select'
  );

  const agentCurrent = (key: SessionDefaultKey): string | undefined => {
    const option =
      key === 'mainModel'
        ? capabilities.modelOption
        : key === 'effort'
          ? capabilities.effortOption
          : permissionOption;
    const current = typeof option?.currentValue === 'string' ? option.currentValue : undefined;
    if (key !== 'autonomy' || !current) return current;
    return PERMISSION_MODE_AUTONOMY[current];
  };
  const deviceValue = (machineId: string | undefined, key: SessionDefaultKey) => {
    const config = machineId ? configs.get(machineId as MachineId) : undefined;
    const stored = readSessionDefault(config?.sessionDefaults, key, ids);
    return stored ?? (machineId === device?.id ? agentCurrent(key) : undefined);
  };
  const profileSet = new Set(state.profileKeys ?? []);
  const profileValue = (key: SessionDefaultKey) =>
    profileSet.has(key) ? String(state.profile[key]) : deviceValue(device?.id, key);
  const differs = (machineId: string) =>
    SESSION_DEFAULT_KEYS.filter((key) => {
      if (!profileSet.has(key)) return false;
      const value = deviceValue(machineId, key);
      return value !== undefined && value !== String(state.profile[key]);
    });

  const values = Object.fromEntries(
    SESSION_DEFAULT_KEYS.map((key) => [
      key,
      scope === 'profile' ? profileValue(key) : deviceValue(device?.id, key),
    ])
  ) as Partial<Record<SessionDefaultKey, string>>;

  const write = useCallback(
    async (targets: AgentConfigMeta[], key: SessionDefaultKey, value: string) => {
      setSaving((count) => count + 1);
      setError(null);
      try {
        const failed: string[] = [];
        await Promise.all(
          targets.map(async (config) => {
            try {
              await updateConfig({
                ...config,
                sessionDefaults: writeSessionDefault(config.sessionDefaults, key, value, ids),
              });
            } catch {
              failed.push(config.machineId);
              return;
            }
            void refreshCapabilities({ machineId: config.machineId, configId: config.id }).catch(
              () => {}
            );
          })
        );
        if (failed.length)
          setError(
            failed.length === targets.length
              ? 'Could not save this setting.'
              : `Saved, except on ${failed.length} device${failed.length > 1 ? 's' : ''}.`
          );
      } finally {
        setSaving((count) => count - 1);
      }
    },
    [ids, refreshCapabilities, updateConfig]
  );

  const set = useCallback(
    async (key: SessionDefaultKey, value: string) => {
      if (scope === 'profile') {
        harness.setProfileDefault(key, value);
        await write([...configs.values()], key, value);
        return;
      }
      if (deviceConfig) await write([deviceConfig], key, value);
    },
    [configs, deviceConfig, scope, write]
  );

  const reset = useCallback(
    async (keys: SessionDefaultKey[]) => {
      if (!deviceConfig) return;
      for (const key of keys) {
        if (profileSet.has(key)) await write([deviceConfig], key, String(state.profile[key]));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deviceConfig, state.profile, state.profileKeys, write]
  );

  const autonomyOffered = permissionOption
    ? new Set(
        permissionOption.options
          .map((option) => PERMISSION_MODE_AUTONOMY[option.value])
          .filter((autonomy): autonomy is Autonomy => Boolean(autonomy))
      )
    : null;

  return {
    values,
    overridden: new Set(scope === 'profile' || !device ? [] : differs(device.id)),
    overridesFor: (machineId) => differs(machineId).length,
    autonomyOffered,
    set,
    reset,
    saving: saving > 0,
    error,
    available: scope === 'profile' ? configs.size > 0 : !!deviceConfig,
  };
}
