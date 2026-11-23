import { z } from 'zod';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const receiptSchema = z.object({
  nonce: z.string().length(36).regex(uuid),
  reset: z.boolean(),
  from: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  ids: z.array(z.string()),
});
export type RoostHistoryChangeReceipt = z.infer<typeof receiptSchema>;

const headerBytes = 18; // version + flags + full nonce; scope/cursors belong to Native
const invalid = () => new Error('Roost history change receipt is invalid');
const uuidText = (bytes: Buffer) => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** v3 is lossless: compact only canonical UUIDs, retain every other ID as JSON. */
export function encodeRoostHistoryChange(receipt: RoostHistoryChangeReceipt): Uint8Array {
  receiptSchema.parse(receipt);
  const packedIds = receipt.ids.every((id) => id.length === 36 && uuid.test(id));
  const ids = packedIds
    ? Buffer.alloc(4 + receipt.ids.length * 16)
    : Buffer.from(JSON.stringify(receipt.ids));
  if (packedIds) {
    ids.writeUInt32BE(receipt.ids.length);
    receipt.ids.forEach((id, index) =>
      ids.write(id.replaceAll('-', ''), 4 + index * 16, 16, 'hex')
    );
  }
  const bytes = Buffer.alloc(headerBytes + (receipt.from === undefined ? 0 : 8) + ids.length);
  bytes[0] = 3;
  bytes[1] = (receipt.reset ? 1 : 0) | (receipt.from === undefined ? 0 : 2) | (packedIds ? 4 : 0);
  bytes.write(receipt.nonce.replaceAll('-', ''), 2, 16, 'hex');
  if (receipt.from !== undefined) bytes.writeBigUInt64BE(BigInt(receipt.from), headerBytes);
  ids.copy(bytes, headerBytes + (receipt.from === undefined ? 0 : 8));
  return bytes;
}

export function decodeRoostHistoryChange(value: Uint8Array): RoostHistoryChangeReceipt {
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.length < headerBytes || bytes[0] !== 3) throw invalid();
  const flags = bytes.readUInt8(1);
  if ((flags & ~7) !== 0) throw invalid();
  const hasFrom = (flags & 2) !== 0;
  const offset = headerBytes + (hasFrom ? 8 : 0);
  if (bytes.length < offset) throw invalid();
  let ids: unknown;
  if (flags & 4) {
    if (bytes.length < offset + 4) throw invalid();
    const count = bytes.readUInt32BE(offset);
    if (bytes.length !== offset + 4 + count * 16) throw invalid();
    ids = Array.from({ length: count }, (_, index) =>
      uuidText(bytes.subarray(offset + 4 + index * 16, offset + 4 + (index + 1) * 16))
    );
  } else {
    ids = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset)));
  }
  return receiptSchema.parse({
    nonce: uuidText(bytes.subarray(2, 18)),
    reset: (flags & 1) !== 0,
    ...(hasFrom ? { from: Number(bytes.readBigUInt64BE(headerBytes)) } : {}),
    ids,
  });
}
