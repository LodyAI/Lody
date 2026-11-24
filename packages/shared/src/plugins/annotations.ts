import { z } from 'zod';
import { pluginIdSchema } from './manifest-schema';
export const MAX_PLUGIN_ANNOTATION_BYTES = 4096;
const json = z.json();
export type PluginAnnotations = Record<string, z.infer<typeof json>>;
const annotation = z.strictObject({ value: json });
export function writePluginAnnotation(
  prior: PluginAnnotations | undefined,
  pluginId: string,
  input: unknown
): PluginAnnotations {
  pluginIdSchema.parse(pluginId);
  const { value } = annotation.parse(input);
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_PLUGIN_ANNOTATION_BYTES)
    throw Error('Plugin annotation exceeds 4 KiB');
  return { ...prior, [pluginId]: value };
}
export function readPluginAnnotations(raw: unknown): PluginAnnotations | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const out: PluginAnnotations = Object.create(null);
  for (const [id, value] of Object.entries(raw)) {
    if (!pluginIdSchema.safeParse(id).success) continue;
    const v = json.safeParse(value);
    if (
      v.success &&
      new TextEncoder().encode(JSON.stringify(v.data)).length <= MAX_PLUGIN_ANNOTATION_BYTES
    )
      out[id] = v.data;
  }
  return out;
}
