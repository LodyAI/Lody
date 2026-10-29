import { z } from 'zod';
import { MEMORY_LIMITS } from './schema';

/**
 * A memory's name and description are the leading front matter of its MEMORY.md,
 * so the Agent reads them with the entry and there is no second source of truth:
 *
 * ```md
 * ---
 * name: Work
 * description: Team conventions and project decisions
 * ---
 *
 * …entry body…
 * ```
 */
export const MEMORY_NAME_CHARACTERS = 80;
const line = (max: number) =>
  z
    .string()
    .transform((value) => value.replace(/\s+/g, ' ').trim())
    .refine((value) => Array.from(value).length <= max, 'Text too long');
export const MemoryProfileSchema = z
  .object({
    name: line(MEMORY_NAME_CHARACTERS).refine((value) => value.length > 0, 'Name required'),
    description: line(MEMORY_LIMITS.descriptionCharacters).optional(),
  })
  .strict();
export type MemoryProfile = z.output<typeof MemoryProfileSchema>;
export type MemoryProfileInput = z.input<typeof MemoryProfileSchema>;

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?/;

/** Read the profile and the rest of the entry. Unknown keys and lines are kept in `rest` untouched. */
export function readMemoryProfile(body: string): {
  name?: string;
  description?: string;
  rest: string;
} {
  const normalized = body.replace(/\r\n/g, '\n');
  const match = FRONT_MATTER.exec(normalized);
  if (!match) return { rest: normalized };
  const fields: Record<string, string> = {};
  for (const entry of match[1]!.split('\n')) {
    const separator = entry.indexOf(':');
    if (separator > 0) fields[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
  }
  return {
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    rest: normalized.slice(match[0].length).replace(/^\n/, ''),
  };
}

export function formatMemoryProfile(profile: MemoryProfileInput, rest = ''): string {
  const parsed = MemoryProfileSchema.parse(profile);
  const header = [
    '---',
    `name: ${parsed.name}`,
    ...(parsed.description ? [`description: ${parsed.description}`] : []),
    '---',
  ].join('\n');
  return rest ? `${header}\n\n${rest}` : `${header}\n`;
}

/** Replace only the profile, preserving the entry's body. */
export function replaceMemoryProfile(body: string, profile: MemoryProfileInput): string {
  return formatMemoryProfile(profile, readMemoryProfile(body).rest);
}
