import { Result } from 'effect';
import { z } from 'zod';
import type { E2eeContentSeal, E2eeContentOpen } from '@lody/platform';
import { fail } from './errors';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const bytes = (max: number) => z.instanceof(Uint8Array).refine((v) => v.length <= max);
const room = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('meta') }).strict(),
  z.object({ kind: z.literal('doc'), docId: z.string().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal('flock'), flockDocId: z.string().min(1).max(1000) }).strict(),
]);
const context = z
  .object({
    protocol: z.literal('loro-streams-crdt-payload-protection'),
    version: z.literal(2),
    kind: z.enum(['update_batch', 'snapshot']),
    continuationOffset: z.string().max(4096).optional(),
  })
  .strict();
const seal = z
  .object({
    epoch: z.number().int().min(0),
    room,
    context,
    plaintext: bytes(16 * 1024 * 1024),
    additionalData: bytes(65536),
  })
  .strict();
const open = z
  .object({
    room,
    context,
    sealed: bytes(16 * 1024 * 1024 + 4096),
    header: bytes(512),
    additionalData: bytes(65536),
  })
  .strict();
const page = z
  .object({
    workspaceId: z.string().min(1).max(128),
    genesisHash: hash,
    checkpoint: z.object({ length: z.number().int().min(1), headHash: hash }).strict(),
    startIndex: z.number().int().min(0),
    recordsHex: z
      .array(
        z
          .string()
          .max(16384)
          .regex(/^(?:[0-9a-f]{2})+$/)
      )
      .max(64),
    position: z.string().max(4096),
    nextCursor: z.string().max(4096).nullable(),
  })
  .strict();
const capture = <A>(schema: z.ZodType<A>, value: unknown) =>
  Result.try({ try: () => schema.parse(value), catch: () => fail('invalid-input') });
/** Capture caller-owned DTOs before any async admission/crypto boundary. */
export const captureSeal = (value: E2eeContentSeal) =>
  Result.map(capture(seal, value), (parsed) => {
    const additionalData = new Uint8Array(parsed.additionalData);
    return { ...parsed, additionalData, plaintext: new Uint8Array(parsed.plaintext) };
  });
/** Incoming encrypted frames are immutable for the complete authentication attempt. */
export const captureOpen = (value: E2eeContentOpen) =>
  Result.map(capture(open, value), (parsed) => ({
    ...parsed,
    sealed: new Uint8Array(parsed.sealed),
    header: new Uint8Array(parsed.header),
    additionalData: new Uint8Array(parsed.additionalData),
  }));
/** A relay page is bounded public evidence, never a second feed or authorization cache. */
export const capturePage = (value: unknown) => capture(page, value);
