import { z } from 'zod';
import { decodeJson } from '@loro-dev/roost';
import { toApplicationJson } from '@loro-dev/roost/lody-history';
import { roostContentPatches } from './roost-content-patches';

const index = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const path = z.array(
  z.union([z.object({ key: z.string() }).strict(), z.object({ index }).strict()])
);
const deltaSchema = z
  .object({
    format: z.literal('lody-message-state'),
    version: z.literal(1),
    primaryTurnId: z.string().regex(/^[0-9a-f]{32}$/),
    patches: z.array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('set'), path, contentJson: z.string() }).strict(),
        z.object({ kind: z.literal('remove'), path }).strict(),
        z.object({ kind: z.literal('appendText'), path, text: z.string() }).strict(),
        z
          .object({ kind: z.literal('spliceText'), path, index, delete: index, text: z.string() })
          .strict(),
        z
          .object({
            kind: z.literal('spliceArray'),
            path,
            index,
            delete: index,
            valuesJson: z.string(),
          })
          .strict(),
      ])
    ),
  })
  .strict();
type StatePath = z.infer<typeof path>;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const json = (text: string): unknown =>
  toApplicationJson(decodeJson(new TextEncoder().encode(text)));

/** The immutable primary is the baseline, so unchanged body bytes never enter state. */
export function createRoostMessageState(primary: unknown, primaryTurnId: string, next: unknown) {
  const patches = roostContentPatches(primary, next).map((op) => ({
    ...op,
    path: op.path.slice(1).map((part) => ('key' in part ? part : { index: Number(part.index) })),
    ...('index' in op ? { index: Number(op.index), delete: Number(op.delete) } : {}),
  }));
  // Native offsets are u64; application arrays/strings are bounded JS values.
  // Store safe JSON numbers rather than serializing bigint as an application field.
  return deltaSchema.parse({
    format: 'lody-message-state',
    version: 1,
    primaryTurnId,
    patches,
  });
}

/** Reconstruct application content without changing the signed primary. */
export function projectRoostMessageState(
  primary: unknown,
  primaryTurnId: string,
  stored: unknown
): unknown {
  // Previous adapters stored a complete entry, always including its business ID.
  if (object(stored) && typeof stored.id === 'string') return structuredClone(stored);
  const delta = deltaSchema.parse(stored);
  if (delta.primaryTurnId !== primaryTurnId) throw new Error('Roost state primary mismatch');
  let result: unknown = structuredClone(primary);
  const member = (parent: unknown, part: StatePath[number], existing: boolean): string | number => {
    if ('index' in part) {
      if (!Array.isArray(parent) || part.index >= parent.length)
        throw new Error('Roost state array path is invalid');
      return part.index;
    }
    if (!object(parent) || (existing && !Object.hasOwn(parent, part.key)))
      throw new Error('Roost state object path is invalid');
    return part.key;
  };
  const read = (parts: StatePath): unknown => {
    let value = result;
    for (const part of parts) {
      const key = member(value, part, true);
      value = Reflect.get(value as object, key);
    }
    return value;
  };
  const write = (parts: StatePath, value: unknown, remove = false) => {
    const last = parts.at(-1);
    if (!last) {
      if (remove) throw new Error('Roost state cannot remove its root');
      result = value;
      return;
    }
    const parent = read(parts.slice(0, -1));
    const key = member(parent, last, remove);
    if (remove) {
      if (Array.isArray(parent)) throw new Error('Roost state cannot remove an array index');
      Reflect.deleteProperty(parent as object, key);
    } else
      Object.defineProperty(parent, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  };
  for (const op of delta.patches) {
    if (op.kind === 'set') write(op.path, json(op.contentJson));
    else if (op.kind === 'remove') write(op.path, undefined, true);
    else {
      const value = read(op.path);
      if (op.kind === 'spliceArray') {
        const values = json(op.valuesJson);
        if (
          !Array.isArray(value) ||
          !Array.isArray(values) ||
          op.index > value.length ||
          op.delete > value.length - op.index
        )
          throw new Error('Roost state array splice is invalid');
        write(op.path, value.slice(0, op.index).concat(values, value.slice(op.index + op.delete)));
      } else {
        if (typeof value !== 'string') throw new Error('Roost state text path is invalid');
        if (op.kind === 'appendText') write(op.path, value + op.text);
        else {
          const scalars = Array.from(value);
          if (op.index > scalars.length || op.delete > scalars.length - op.index)
            throw new Error('Roost state text splice is invalid');
          write(
            op.path,
            scalars.slice(0, op.index).join('') +
              op.text +
              scalars.slice(op.index + op.delete).join('')
          );
        }
      }
    }
  }
  return result;
}
