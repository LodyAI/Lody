import type { PluginManifest } from './manifest-schema';

export type ProjectPluginValues = Record<string, string | number | boolean>;
export const projectConfigPrefix = (machine: string, plugin: string) => [
  'projectPluginConfig',
  machine,
  plugin,
];
export function projectPluginValues(manifest: PluginManifest, raw: unknown): ProjectPluginValues {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw Error('Invalid project configuration');
  const values: ProjectPluginValues = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    const field = Object.hasOwn(manifest.config ?? {}, key) ? manifest.config?.[key] : undefined;
    if (
      !field ||
      field.scope !== 'project' ||
      (field.type === 'select'
        ? !field.options.some((o) => o.value === value)
        : typeof value !== field.type) ||
      (field.type === 'number' &&
        (!Number.isFinite(value) ||
          value < (field.min ?? -Infinity) ||
          value > (field.max ?? Infinity)))
    )
      throw Error('Invalid project configuration field');
    values[key] = value;
  }
  if (new TextEncoder().encode(JSON.stringify(values)).length > 16384)
    throw Error('Project configuration exceeds 16 KiB');
  return values;
}
