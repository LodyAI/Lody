import { z } from 'zod';
import type { SessionHistoryInput } from '../schema';

const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const path = z
  .array(z.union([z.object({ key: z.string() }).strict(), z.object({ index: offset }).strict()]))
  .min(1)
  .max(128);

/** Read-only logical content operations; offsets count Unicode scalars. */
export const SessionHistoryContentPatchSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set'), path, value: z.json() }).strict(),
  z.object({ kind: z.literal('remove'), path }).strict(),
  z.object({ kind: z.literal('appendText'), path, text: z.string() }).strict(),
  z
    .object({
      kind: z.literal('spliceText'),
      path,
      index: offset,
      delete: offset,
      text: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('spliceArray'),
      path,
      index: offset,
      delete: offset,
      values: z.array(z.json()),
    })
    .strict(),
]);

export type SessionHistoryContentPatch = z.infer<typeof SessionHistoryContentPatchSchema>;

/** Prepare a complete replacement without mutating a cached/shared history row. */
export function applySessionHistoryPatches(
  turn: SessionHistoryInput,
  patches: readonly SessionHistoryContentPatch[]
): SessionHistoryInput {
  const result = structuredClone(turn);
  function invalid(): never {
    throw new Error('Invalid history content patch');
  }
  for (const patch of patches) {
    let parent: unknown = result;
    let member: string | number = '';
    for (const [index, part] of patch.path.entries()) {
      if (parent === null || typeof parent !== 'object') invalid();
      if ('index' in part) {
        if (!Array.isArray(parent) || part.index >= parent.length) invalid();
        member = part.index;
      } else {
        if (Array.isArray(parent)) invalid();
        member = part.key;
      }
      const last = index === patch.path.length - 1;
      if (last) break;
      if (!Object.hasOwn(parent as object, member)) invalid();
      parent = Reflect.get(parent as object, member);
    }
    if (!patch.path.length) invalid();
    const write = (value: unknown) => {
      // Define an own data property, including for JSON keys such as __proto__.
      Object.defineProperty(parent, member, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    };
    if (patch.kind === 'set') {
      write(structuredClone(patch.value));
      continue;
    }
    if (patch.kind === 'remove') {
      if (Array.isArray(parent)) invalid();
      Reflect.deleteProperty(parent as object, member);
      continue;
    }
    if (!Object.hasOwn(parent as object, member)) invalid();
    const value: unknown = Reflect.get(parent as object, member);
    if (patch.kind === 'appendText') {
      if (typeof value !== 'string') invalid();
      write(value + patch.text);
    } else if (patch.kind === 'spliceText') {
      if (typeof value !== 'string') invalid();
      const scalars = Array.from(value as string);
      if (patch.index + patch.delete > scalars.length) invalid();
      write(
        scalars.slice(0, patch.index).join('') +
          patch.text +
          scalars.slice(patch.index + patch.delete).join('')
      );
    } else {
      if (!Array.isArray(value) || patch.index + patch.delete > value.length) invalid();
      const array = value as unknown[];
      write([
        ...array.slice(0, patch.index),
        ...structuredClone(patch.values),
        ...array.slice(patch.index + patch.delete),
      ]);
    }
  }
  if (result.id !== turn.id) invalid();
  return result;
}
