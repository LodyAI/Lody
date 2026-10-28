import { z } from 'zod';
import {
  roostContentPatches,
  stageRoostContent,
  contentPathKey,
  type TextAppendHints,
  type TextAppend,
} from './roost-content-patches';
import type { ContentOp } from '@loro-dev/roost-node';
import { applicationJsonText } from '@loro-dev/roost/lody-history';
import type { AgentHistoryMutationPath } from '@lody/shared';

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
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
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

/** Extend a compact state without rebuilding its immutable primary. Append
 * composition is restricted to the last related operation; other edits replace
 * only the authored top-level fields' baseline-relative deltas. */
export function planRoostMessageState(
  primary: unknown,
  primaryTurnId: string,
  previous: unknown,
  before: unknown,
  next: unknown,
  appends?: TextAppendHints,
  changes?: readonly AgentHistoryMutationPath[]
): { content: ReturnType<typeof createRoostMessageState>; appends?: TextAppendHints } {
  const old = deltaSchema.safeParse(previous);
  if (!old.success || old.data.primaryTurnId !== primaryTurnId)
    return { content: createRoostMessageState(primary, primaryTurnId, next) };
  const edits = roostContentPatches(before, next, appends, changes);
  const patches = old.data.patches.slice();
  const hints = new Map<string, TextAppend>();
  let composed = true;
  for (const edit of edits) {
    if (edit.kind !== 'appendText') {
      composed = false;
      break;
    }
    const target = edit.path
      .slice(1)
      .map((part) => ('key' in part ? part : { index: Number(part.index) }));
    const related = (a: typeof target, b: typeof target) => {
      const n = Math.min(a.length, b.length);
      return a.slice(0, n).every((part, i) => JSON.stringify(part) === JSON.stringify(b[i]));
    };
    let found = -1;
    for (let i = patches.length - 1; i >= 0; i--) {
      const patch = patches[i];
      if (patch && related(patch.path, target)) {
        found = i;
        break;
      }
    }
    const prior = patches[found];
    if (prior) {
      if (prior.kind !== 'appendText' || JSON.stringify(prior.path) !== JSON.stringify(target)) {
        composed = false;
        break;
      }
      const value = prior.text + edit.text;
      patches[found] = { ...prior, text: value };
      hints.set(
        contentPathKey([
          { key: 'content' },
          { key: 'patches' },
          { index: BigInt(found) },
          { key: 'text' },
        ]),
        { previous: prior.text, value, text: edit.text }
      );
    } else patches.push({ kind: 'appendText', path: target, text: edit.text });
  }
  if (composed) return { content: { ...old.data, patches }, appends: hints };
  if (
    changes?.length &&
    changes.every((change) => change.path.length && typeof change.path[0] === 'string') &&
    old.data.patches.every((op) => op.path[0] && 'key' in op.path[0])
  ) {
    const fields = new Set(changes.map((change) => change.path[0]));
    const fresh = roostContentPatches(primary, next, undefined, changes).map((op) => ({
      ...op,
      path: op.path.slice(1).map((part) => ('key' in part ? part : { index: Number(part.index) })),
      ...('index' in op ? { index: Number(op.index), delete: Number(op.delete) } : {}),
    }));
    return {
      content: deltaSchema.parse({
        ...old.data,
        patches: [
          ...old.data.patches.filter((op) => {
            const first = op.path[0];
            return !first || !('key' in first) || !fields.has(first.key);
          }),
          ...fresh,
        ],
      }),
    };
  }
  return { content: createRoostMessageState(primary, primaryTurnId, next) };
}

/** Preserve one unchanged large patch node while changing its array position.
 * The final patch order stays exact; this schedules storage edits, not semantic
 * state operations. Ordinary appends retain the existing diff and hints. */
export function roostMessageStatePatches(
  previous: unknown,
  next: unknown,
  appends?: TextAppendHints
): ContentOp[] {
  const baseline = roostContentPatches(previous, next, appends);
  const inPatches = (op: ContentOp) =>
    op.path[1] && 'key' in op.path[1] && op.path[1].key === 'patches';
  const hasLargePayload = (op: ContentOp) => {
    // A genuine append already transmits only new bytes. Do not parse or
    // inspect the full state to optimize that unchanged hot path.
    if (op.kind === 'appendText') return false;
    const payload =
      'contentJson' in op
        ? op.contentJson
        : 'valuesJson' in op
          ? op.valuesJson
          : 'text' in op
            ? op.text
            : '';
    return payload.length >= 1024;
  };
  if (
    baseline.some((op) => op.path.length < 2) ||
    !baseline.some((op) => inPatches(op) && hasLargePayload(op)) ||
    !object(previous) ||
    !object(next) ||
    !Array.isArray(previous.patches) ||
    !Array.isArray(next.patches) ||
    previous.patches.length > 128 ||
    next.patches.length > 128
  )
    return baseline;
  const old = deltaSchema.safeParse(previous);
  const updated = deltaSchema.safeParse(next);
  if (!old.success || !updated.success || old.data.primaryTurnId !== updated.data.primaryTurnId)
    return baseline;

  type StatePatch = z.infer<typeof deltaSchema>['patches'][number];
  const positions = (patches: readonly StatePatch[]) => {
    const result = new Map<string, number | null>();
    patches.forEach((patch, position) => {
      if (patch.kind !== 'appendText') return;
      const identity = JSON.stringify(patch.path);
      result.set(identity, result.has(identity) ? null : position);
    });
    return result;
  };
  const before = positions(old.data.patches);
  const after = positions(updated.data.patches);
  const anchors: { oldPosition: number; newPosition: number; bytes: number }[] = [];
  for (const [identity, oldPosition] of before) {
    const newPosition = after.get(identity);
    if (oldPosition == null || newPosition == null || oldPosition === newPosition) continue;
    const oldPatch = old.data.patches[oldPosition];
    const newPatch = updated.data.patches[newPosition];
    if (
      oldPatch?.kind !== 'appendText' ||
      newPatch?.kind !== 'appendText' ||
      oldPatch.text !== newPatch.text ||
      oldPatch.text.length < 1024
    )
      continue;
    const bytes = Buffer.byteLength(oldPatch.text);
    if (bytes >= 4096) anchors.push({ oldPosition, newPosition, bytes });
  }
  if (!anchors.length) return baseline;

  // Optional planning only: no writes or authoritative validation happen here.
  // Any unsupported local representation keeps the original diff/error boundary.
  try {
    const size = (ops: readonly ContentOp[]) => Buffer.byteLength(applicationJsonText(ops));
    const originalBytes = size(baseline);
    let best = baseline;
    let bestBytes = originalBytes;
    const arrayPath: ContentOp['path'] = [{ key: 'content' }, { key: 'patches' }];
    for (const anchor of anchors.sort((a, b) => b.bytes - a.bytes).slice(0, 4)) {
      const candidate = baseline.filter((op) => !inPatches(op));
      const splice = (at: number, remove: number, values: readonly StatePatch[]) => {
        if (!remove && !values.length) return;
        candidate.push({
          kind: 'spliceArray',
          path: arrayPath,
          index: BigInt(at),
          delete: BigInt(remove),
          valuesJson: applicationJsonText(values),
        });
      };
      // Leave the old anchor as the sole array element, then restore the exact
      // next suffix/prefix around it. Its text never enters an inserted value.
      splice(anchor.oldPosition + 1, old.data.patches.length - anchor.oldPosition - 1, []);
      splice(0, anchor.oldPosition, []);
      splice(1, 0, updated.data.patches.slice(anchor.newPosition + 1));
      splice(0, 0, updated.data.patches.slice(0, anchor.newPosition));
      const bytes = size(candidate);
      if (bytes + 1024 >= bestBytes || bytes * 2 > originalBytes) continue;
      const staged = stageRoostContent(previous, candidate);
      if (staged === undefined || applicationJsonText(staged) !== applicationJsonText(next))
        continue;
      best = candidate;
      bestBytes = bytes;
    }
    return best;
  } catch {
    return baseline;
  }
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
  const ops: ContentOp[] = delta.patches.map(
    (op) =>
      ({
        ...op,
        path: [
          { key: 'content' },
          ...op.path.map((part) => ('key' in part ? part : { index: BigInt(part.index) })),
        ],
        ...('index' in op ? { index: BigInt(op.index), delete: BigInt(op.delete) } : {}),
      }) as ContentOp
  );
  const result = stageRoostContent(primary, ops);
  if (result === undefined) throw new Error('Roost state content operation is invalid');
  return result;
}
