import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SessionHistoryChanges } from '@lody/shared';
import type { RoostHistoryChange } from '@lody/shared/session-data';
import type { RoostNodeStream } from '@loro-dev/roost-node';
import {
  encodeRoostHistoryChange as encode,
  decodeRoostHistoryChange as decode,
  type RoostHistoryChangeReceipt as Receipt,
} from './roost-history-change-codec';

const cursorSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= 0xffffffffffffffffn);
const checkpointSchema = z.tuple([z.string(), cursorSchema, z.string()]);
export const ROOST_HISTORY_RECEIPT_PAGE_SIZE = 128n;
type ReadyChanges = Extract<SessionHistoryChanges, { state: 'ready' }>;

const scopeBytes = (scope: string) => {
  if (scope.length !== 64 || !/^[0-9a-f]{64}$/.test(scope))
    throw new Error('Roost history scope is invalid');
  return Buffer.from(scope, 'hex');
};

/** Only use with a locally issued or verified checkpoint. */
export const roostCheckpointCursor = (checkpoint: string): bigint =>
  BigInt(checkpointSchema.parse(JSON.parse(checkpoint))[1]);

export function roostCommitMetadata(scope: string, ids: readonly string[]) {
  return {
    scope: scopeBytes(scope),
    value: encode({ nonce: randomUUID(), reset: false, ids: [...new Set(ids)] }),
  };
}

/** Semantic payloads attached to native events; gaps require a full recovery. */
export function createRoostHistoryChanges(host: () => RoostNodeStream, scope: () => string) {
  const token = (boundScope: string, cursor: bigint, receipt: Receipt) =>
    JSON.stringify([boundScope, cursor.toString(), receipt.nonce]);
  const anchor = async (
    stream: RoostNodeStream,
    bound: string,
    cursor: bigint,
    signal?: AbortSignal
  ): Promise<Receipt> => {
    const boundScope = scopeBytes(bound);
    const stored = await stream.readCommitMetadata(boundScope, cursor, { signal });
    signal?.throwIfAborted();
    if (stored) return decode(stored.value);
    const result = await stream.annotateCommit(
      boundScope,
      cursor,
      {
        before: cursor,
        value: encode({ nonce: randomUUID(), reset: false, ids: [] }),
      },
      { ifAbsent: true, signal }
    );
    signal?.throwIfAborted();
    return decode(result.value);
  };
  return {
    checkpoint: async (cursor: bigint, signal?: AbortSignal) => {
      const stream = host();
      const boundScope = scope();
      return token(boundScope, cursor, await anchor(stream, boundScope, cursor, signal));
    },
    record: async (
      before: bigint,
      through: bigint,
      change: RoostHistoryChange | undefined,
      verified: boolean,
      changedIds: readonly string[] = []
    ) => {
      if (through === before) return;
      const receipt: Receipt = {
        nonce: randomUUID(),
        reset: !verified,
        ...(change?.kind === 'structure' ? { from: change.from } : {}),
        ids: [
          ...new Set([...changedIds, ...(change?.kind === 'changed' ? change.businessIds : [])]),
        ],
      };
      // Verified multi-stage SDK operations use this guard. Hot patches already
      // attach their summary in the content transaction, avoiding this extra write.
      await host().annotateCommit(scopeBytes(scope()), through, { before, value: encode(receipt) });
    },
    read: async (
      since: string | ReadyChanges,
      through: bigint,
      signal?: AbortSignal
    ): Promise<SessionHistoryChanges> => {
      const stream = host();
      const boundScope = scope();
      const bytes = scopeBytes(boundScope);
      const current = await anchor(stream, boundScope, through, signal);
      const reset = (): SessionHistoryChanges => ({
        state: 'reset',
        checkpoint: token(boundScope, through, current),
      });
      const prefix = typeof since === 'string' ? undefined : since;
      let parsed: z.infer<typeof checkpointSchema>;
      try {
        parsed = checkpointSchema.parse(
          JSON.parse(typeof since === 'string' ? since : since.checkpoint)
        );
      } catch {
        return reset();
      }
      const [previousScope, after, nonce] = parsed;
      if (previousScope !== boundScope || BigInt(after) > through) return reset();
      const stored = await stream.readCommitMetadata(bytes, BigInt(after), { signal });
      signal?.throwIfAborted();
      if (!stored || decode(stored.value).nonce !== nonce) return reset();
      let scanned = BigInt(after);
      let covered = scanned;
      let from = prefix?.from;
      const ids = new Set(prefix?.ids);
      while (scanned < through) {
        const remaining = through - scanned;
        const limit =
          remaining < ROOST_HISTORY_RECEIPT_PAGE_SIZE ? remaining : ROOST_HISTORY_RECEIPT_PAGE_SIZE;
        const page = await stream.commitMetadataAfter(bytes, scanned, limit, { signal });
        signal?.throwIfAborted();
        if (page.through <= scanned) return reset();
        for (const row of page.records) {
          if (row.through > through) break;
          if (row.through <= covered || row.before !== covered) return reset();
          const receipt = decode(row.value);
          if (receipt.reset) return reset();
          if (receipt.from !== undefined) from = Math.min(from ?? receipt.from, receipt.from);
          for (const id of receipt.ids) ids.add(id);
          covered = row.through;
        }
        scanned = page.through;
      }
      if (covered !== through) return reset();
      return {
        state: 'ready',
        checkpoint: token(boundScope, through, current),
        ...(from === undefined ? {} : { from }),
        ids: [...ids],
      };
    },
  };
}
