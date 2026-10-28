import { MemorySearchQuerySchema } from './schema.ts';
import type { MemoryResult } from './contracts.ts';

/** Literal description/body filter. Path keys are matched by the document service. */
export function buildMemorySearchQuery(query: string): MemoryResult<string> {
  const parsed = MemorySearchQuerySchema.safeParse(query);
  if (!parsed.success) return { ok: false, error: { code: 'invalid_input' } };
  const literal = JSON.stringify(parsed.data);
  return {
    ok: true,
    value: `$.documents[?(@.description contains ${literal} || @.body contains ${literal})]`,
  };
}
