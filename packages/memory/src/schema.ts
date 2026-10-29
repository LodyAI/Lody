import { z } from 'zod';

export const MEMORY_FORMAT_VERSION = 1;
export const MEMORY_ENTRY_PATH = 'MEMORY.md';
export const MEMORY_LIMITS = Object.freeze({
  descriptionCharacters: 300,
  pathCharacters: 256,
  queryCharacters: 256,
  entryBytes: 8 * 1024,
  documentBytes: 64 * 1024,
  totalBodyBytes: 8 * 1024 * 1024,
  documents: 256,
  pageSize: 50,
  readCharacters: 4000,
  excerptCharacters: 240,
});

export const MemoryIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const boundedText = (max: number) =>
  z.string().refine((s) => [...s].length <= max, 'Text too long');
const encoder = new TextEncoder();

/** Validate before interpolation, output or persistence; never echo invalid input in host errors. */
export const MemoryPathSchema = boundedText(MEMORY_LIMITS.pathCharacters).refine(
  (path) =>
    path === path.normalize('NFC') &&
    path.endsWith('.md') &&
    !/[\u0000-\u001f\u007f\\:%?#|\[\]]/.test(path) &&
    path
      .split('/')
      .every((part) => part.length > 0 && part !== '.' && part !== '..' && part.trim() === part) &&
    path.split('/').at(-1) !== '.md',
  'Invalid logical Markdown path'
);
export const MemoryDescriptionSchema = boundedText(MEMORY_LIMITS.descriptionCharacters);
export const MemoryIdentitySchema = z
  .object({
    memoryId: MemoryIdSchema,
    ownership: z.literal('personal'),
    ownerId: MemoryIdSchema,
  })
  .strict();
export type MemoryIdentity = z.infer<typeof MemoryIdentitySchema>;

const turnSource = z.object({ sessionId: MemoryIdSchema, turnId: MemoryIdSchema }).strict();
export const MemorySourceSchema = z.discriminatedUnion('actor', [
  z.object({ actor: z.literal('user'), turn: turnSource.optional() }).strict(),
  z.object({ actor: z.literal('agent'), turn: turnSource }).strict(),
]);
export const MemoryMutationContextSchema = z
  .object({
    /** Host-generated unique ID for each mutation. */
    changeId: MemoryIdSchema,
    recordedAt: timestamp,
    source: MemorySourceSchema,
  })
  .strict();
export type MemoryMutationContext = z.infer<typeof MemoryMutationContextSchema>;
export const MemoryChangeRecordSchema = z
  .object({
    kind: z.enum(['create', 'edit', 'move', 'forget']),
    recordedAt: timestamp,
    source: MemorySourceSchema,
  })
  .strict();
export type MemoryChangeRecord = z.infer<typeof MemoryChangeRecordSchema>;

const body = z
  .string()
  .refine(
    (s) => encoder.encode(s).byteLength <= MEMORY_LIMITS.documentBytes,
    'Document body too large'
  );
const page = {
  limit: z.number().int().min(1).max(MEMORY_LIMITS.pageSize).default(20),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
};

export const MemoryListInputSchema = z.object(page).strict();
export const MemorySearchQuerySchema = boundedText(MEMORY_LIMITS.queryCharacters).refine(
  (s) => s.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(s),
  'Invalid search query'
);
export const MemorySearchInputSchema = z
  .object({
    ...page,
    query: MemorySearchQuerySchema,
  })
  .strict();
export const MemoryReadInputSchema = z
  .object({
    path: MemoryPathSchema,
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MEMORY_LIMITS.readCharacters)
      .default(MEMORY_LIMITS.readCharacters),
  })
  .strict();

export const MemoryCreateInputSchema = z
  .object({
    path: MemoryPathSchema,
    description: MemoryDescriptionSchema.optional(),
    body,
  })
  .strict();
export const MemoryUpdateInputSchema = z
  .object({
    path: MemoryPathSchema,
    newPath: MemoryPathSchema.optional(),
    /** Omitted: preserve; null or empty: clear. */
    description: MemoryDescriptionSchema.nullable().optional(),
    body: body.optional(),
  })
  .strict()
  .refine(
    (v) => v.newPath !== undefined || v.description !== undefined || v.body !== undefined,
    'Empty update'
  );
export const MemoryForgetInputSchema = z.object({ path: MemoryPathSchema }).strict();
export type MemoryListInput = z.input<typeof MemoryListInputSchema>;
export type MemorySearchInput = z.input<typeof MemorySearchInputSchema>;
export type MemoryReadInput = z.input<typeof MemoryReadInputSchema>;
export type MemoryCreateInput = z.input<typeof MemoryCreateInputSchema>;
export type MemoryUpdateInput = z.input<typeof MemoryUpdateInputSchema>;
export type MemoryForgetInput = z.input<typeof MemoryForgetInputSchema>;
