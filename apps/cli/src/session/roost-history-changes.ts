import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SessionHistoryChanges } from '@lody/shared';
import type { RoostHistoryChange } from '@lody/shared/session-data';
import type { RoostNodeStream } from '@loro-dev/roost-node';

const TABLE = 'lody_renderer_history_changes_v1';
const cursorSchema = z
  .string()
  .regex(/^\d+$/)
  .refine((value) => BigInt(value) <= 0xffffffffffffffffn);
const receiptSchema = z.object({
  version: z.literal(1),
  scope: z.string(),
  nonce: z.string(),
  before: cursorSchema,
  through: cursorSchema,
  reset: z.boolean(),
  from: z.number().int().nonnegative().optional(),
  ids: z.array(z.string()),
});
const checkpointSchema = z.tuple([z.string(), cursorSchema, z.string()]);
type Receipt = z.infer<typeof receiptSchema>;
const key = (cursor: bigint) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(cursor);
  return bytes;
};
const encode = (receipt: Receipt) => new TextEncoder().encode(JSON.stringify(receipt));
const decode = (value: Uint8Array) =>
  receiptSchema.parse(JSON.parse(new TextDecoder().decode(value)));
const token = (receipt: Receipt) => JSON.stringify([receipt.scope, receipt.through, receipt.nonce]);

/** Semantic receipts over verified native event intervals; no history bodies or commands. */
export function createRoostHistoryChanges(host: () => RoostNodeStream, scope: () => string) {
  const anchor = async (cursor: bigint): Promise<Receipt> => {
    const stream = host();
    const entry = { table: TABLE, key: key(cursor) };
    const [stored] = await stream.readIndex([entry]);
    if (stored) return decode(stored);
    const receipt: Receipt = {
      version: 1,
      scope: scope(),
      nonce: randomUUID(),
      before: cursor.toString(),
      through: cursor.toString(),
      reset: false,
      ids: [],
    };
    const accepted = await stream.compareAndWriteIndex(
      [{ ...entry, value: null }],
      [{ ...entry, value: encode(receipt) }]
    );
    if (accepted) return receipt;
    const [winner] = await stream.readIndex([entry]);
    if (!winner) throw new Error('Roost history checkpoint is unavailable');
    return decode(winner);
  };
  return {
    checkpoint: async (cursor: bigint) => token(await anchor(cursor)),
    record: async (
      before: bigint,
      through: bigint,
      change: RoostHistoryChange | undefined,
      verified: boolean,
      changedIds: readonly string[] = []
    ) => {
      if (through === before) return;
      const receipt: Receipt = {
        version: 1,
        scope: scope(),
        nonce: randomUUID(),
        before: before.toString(),
        through: through.toString(),
        reset: !verified,
        ...(change?.kind === 'structure' ? { from: change.from } : {}),
        ids: [
          ...new Set([...changedIds, ...(change?.kind === 'changed' ? change.businessIds : [])]),
        ],
      };
      // An intervening native mutation refuses this receipt. The index is local
      // derived state and emits no event or outgoing history mutation itself.
      await host().writeBatch([], {
        expectedEventCursor: through,
        indexPuts: [{ table: TABLE, key: key(through), value: encode(receipt) }],
      });
    },
    read: async (checkpoint: string, through: bigint): Promise<SessionHistoryChanges> => {
      const current = await anchor(through);
      const reset = (): SessionHistoryChanges => ({ state: 'reset', checkpoint: token(current) });
      let parsed: z.infer<typeof checkpointSchema>;
      try {
        parsed = checkpointSchema.parse(JSON.parse(checkpoint));
      } catch {
        return reset();
      }
      const [boundScope, after, nonce] = parsed;
      if (boundScope !== scope() || BigInt(after) > through) return reset();
      const [stored] = await host().readIndex([{ table: TABLE, key: key(BigInt(after)) }]);
      if (!stored || decode(stored).nonce !== nonce) return reset();
      let cursor = BigInt(after);
      let from: number | undefined;
      const ids = new Set<string>();
      while (cursor < through) {
        const rows = await host().scanIndex(TABLE, key(cursor + 1n), 128n);
        if (!rows.length) return reset();
        for (const row of rows) {
          const receipt = decode(row.value);
          if (
            BigInt(receipt.through) <= cursor ||
            !Buffer.from(row.key).equals(key(BigInt(receipt.through)))
          )
            throw new Error('Roost history change receipt is inconsistent');
          if (BigInt(receipt.through) > through) return reset();
          if (receipt.scope !== boundScope || BigInt(receipt.before) !== cursor || receipt.reset)
            return reset();
          if (receipt.from !== undefined) from = Math.min(from ?? receipt.from, receipt.from);
          for (const id of receipt.ids) ids.add(id);
          cursor = BigInt(receipt.through);
          if (cursor === through) break;
        }
      }
      return {
        state: 'ready',
        checkpoint: token(current),
        ...(from === undefined ? {} : { from }),
        ids: [...ids],
      };
    },
  };
}
