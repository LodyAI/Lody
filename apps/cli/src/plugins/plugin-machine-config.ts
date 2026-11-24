import type { PluginManifest } from '@lody/shared/plugins/manifest-schema';
import { z } from 'zod';

type Field = NonNullable<PluginManifest['config']>[string];
type Value = string | number | boolean;

export class MissingPluginConfiguration extends Error {}

export interface MachineConfigVault {
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
}

async function entry(key: string) {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  return new AsyncEntry('Lody Plugin Configuration', key, { linux: { store: 'secret-service' } });
}
export const systemMachineConfigVault: MachineConfigVault = {
  read: async (key) => (await entry(key)).getPassword(AbortSignal.timeout(30_000)),
  write: async (key, value) => {
    await (await entry(key)).setPassword(value, AbortSignal.timeout(30_000));
  },
};

export function valueFor(field: Field, value: unknown): Value {
  switch (field.type) {
    case 'boolean':
      return z.boolean().parse(value);
    case 'number':
      return z
        .number()
        .min(field.min ?? -Infinity)
        .max(field.max ?? Infinity)
        .parse(value);
    case 'select':
      if (!field.options.some((o) => o.value === value)) throw new Error('Invalid selection');
  }
  return z.string().parse(value);
}
export function machineConfig(
  manifest: PluginManifest,
  workspaceId: string,
  machineId: string,
  vault = systemMachineConfigVault
) {
  const key = (name: string) => JSON.stringify([workspaceId, machineId, manifest.id, name]);
  const privateField = (field: Field) => field.type === 'secret' || field.scope === 'machine';
  return {
    async set(name: string, value: unknown) {
      const field = Object.entries(manifest.config ?? {}).find(([k]) => k === name)?.[1];
      if (!field || !privateField(field)) throw new Error('Not a machine configuration field');
      await vault.write(key(name), JSON.stringify(valueFor(field, value)));
    },
    async resolve(preferences: Readonly<Record<string, unknown>> = {}) {
      const result: Record<string, Value> = Object.create(null);
      for (const [name, field] of Object.entries(manifest.config ?? {})) {
        if (field.scope === 'client') continue;
        const stored = privateField(field) ? await vault.read(key(name)) : undefined;
        const value =
          stored !== undefined
            ? JSON.parse(stored)
            : ((!privateField(field) && Object.hasOwn(preferences, name)
                ? preferences[name]
                : undefined) ?? ('default' in field ? field.default : undefined));
        if (value !== undefined) result[name] = valueFor(field, value);
        else if (field.required)
          throw new MissingPluginConfiguration(`Missing required configuration: ${name}`);
      }
      return result;
    },
  };
}
