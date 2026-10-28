import { MemoryPathSchema } from './schema.ts';
import type { MemoryResult } from './contracts.ts';

/** Wiki paths are rooted in the memory, never in a filesystem or external URL. */
export function resolveMemoryPath(input: string): MemoryResult<string> {
  if (typeof input !== 'string') return { ok: false, error: { code: 'invalid_input' } };
  const raw = input.startsWith('[[') && input.endsWith(']]') ? input.slice(2, -2) : input;
  if (raw.split('/').some((part) => part === '.' || part === '..')) {
    return { ok: false, error: { code: 'invalid_input' } };
  }
  const path = raw.endsWith('.md') ? raw : `${raw}.md`;
  const parsed = MemoryPathSchema.safeParse(path);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: { code: 'invalid_input' } };
}
