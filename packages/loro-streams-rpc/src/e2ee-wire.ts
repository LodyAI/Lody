import { z } from 'zod';

/** Candidate M5 profile: the complete content-v0 RPC frame fits in 1 MiB. */
export const E2EE_RPC_MAX_FRAME_BYTES = 1024 * 1024;
// Existing content v0: header39 + nonce24 + tag16 + signature64.
const MAX_RPC_BODY_BYTES = E2EE_RPC_MAX_FRAME_BYTES - 143;
const RPC_RESPONSE_PREFIX_BYTES = 58;
const MAX_PRESENCE_BODY_BYTES = 64 * 1024;
const MAX_PRESENCE_TTL_MS = 60_000;
const uint32 = z.number().int().min(0).max(0xffffffff);
const timestamp = z.number().int().nonnegative().safe();
const byteArray = z.custom<Uint8Array>((value) => value instanceof Uint8Array);
const id = byteArray.refine((value) => value.byteLength === 16);
const requestSchema = z.object({
  requestId: id,
  expiresAt: timestamp,
  method: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => !/[^\x21-\x7e]/.test(value)),
  params: byteArray,
});
const responseSchema = z.object({
  requestId: id,
  requestDigest: byteArray.refine((value) => value.byteLength === 32),
  kind: z.enum(['progress', 'success', 'error']),
  sequence: uint32,
  payload: byteArray,
});
const presenceSchema = z
  .object({
    incarnation: id,
    sequence: uint32,
    issuedAt: timestamp,
    expiresAt: timestamp,
    payload: byteArray,
  })
  .refine(
    (value) =>
      value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= MAX_PRESENCE_TTL_MS
  );
const errorSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => !/[^A-Za-z0-9_-]/.test(value)),
  detail: byteArray,
});

/** Decrypted method bytes; neither decoding nor a deadline grants execution authority. */
export type E2eeRpcRequestBody = z.infer<typeof requestSchema>;
/** Digest is SHA-256 of the entire original signed encrypted request, checked by the host. */
export type E2eeRpcResponseBody = z.infer<typeof responseSchema>;
/** Host must additionally check room, signer, incarnation/sequence and issuedAt <= now < expiresAt. */
export type E2eePresenceBody = z.infer<typeof presenceSchema>;
/** Only an explicitly permitted method DTO belongs in detail; never raw exceptions. */
export type E2eeRpcErrorBody = z.infer<typeof errorSchema>;

/** Malformed-profile failure with no plaintext or input values in its diagnostic. */
export class E2eeWireError extends Error {
  constructor(
    readonly code:
      | 'fields'
      | 'size'
      | 'truncated'
      | 'trailing'
      | 'version'
      | 'integer'
      | 'text'
      | 'kind'
  ) {
    super(`Invalid E2EE realtime body: ${code}`);
    this.name = 'E2eeWireError';
  }
}

function checked<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new E2eeWireError('fields');
  return result.data;
}

function checkSize(size: number, max: number): void {
  if (size > max) throw new E2eeWireError('size');
}

class Writer {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(size: number, max: number) {
    checkSize(size, max);
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  u8(value: number): void {
    this.view.setUint8(this.offset++, value);
  }
  u16(value: number): void {
    this.view.setUint16(this.offset, value, false);
    this.offset += 2;
  }
  u32(value: number): void {
    this.view.setUint32(this.offset, value, false);
    this.offset += 4;
  }
  u64(value: number): void {
    this.view.setBigUint64(this.offset, BigInt(value), false);
    this.offset += 8;
  }
  raw(value: Uint8Array): void {
    this.bytes.set(value, this.offset);
    this.offset += value.byteLength;
  }
  text(value: string): void {
    this.u16(value.length);
    // All text16 fields in this profile are bounded ASCII.
    for (let i = 0; i < value.length; i++) this.u8(value.charCodeAt(i));
  }
  blob(value: Uint8Array): void {
    this.u32(value.byteLength);
    this.raw(value);
  }
}

class Reader {
  private readonly view: DataView;
  private offset = 0;

  constructor(
    private readonly bytes: Uint8Array,
    max: number
  ) {
    if (!(bytes instanceof Uint8Array)) throw new E2eeWireError('fields');
    checkSize(bytes.byteLength, max);
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  take(size: number): Uint8Array {
    if (size > this.bytes.byteLength - this.offset) throw new E2eeWireError('truncated');
    const value = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
  u8(): number {
    this.take(1);
    return this.view.getUint8(this.offset - 1);
  }
  u16(): number {
    this.take(2);
    return this.view.getUint16(this.offset - 2, false);
  }
  u32(): number {
    this.take(4);
    return this.view.getUint32(this.offset - 4, false);
  }
  u64(): number {
    this.take(8);
    const value = this.view.getBigUint64(this.offset - 8, false);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new E2eeWireError('integer');
    return Number(value);
  }
  text(max: number): string {
    const size = this.u16();
    if (size === 0 || size > max) throw new E2eeWireError('text');
    const value = this.take(size);
    // Checking raw bytes also rejects malformed UTF-8 and a leading UTF-8 BOM.
    if (value.some((byte) => byte < 0x21 || byte > 0x7e)) throw new E2eeWireError('text');
    return String.fromCharCode(...value);
  }
  blob(): Uint8Array {
    return this.take(this.u32());
  }
  version(): void {
    if (this.u8() !== 0) throw new E2eeWireError('version');
  }
  end(): void {
    if (this.offset !== this.bytes.byteLength) throw new E2eeWireError('trailing');
  }
}

/** Encode the candidate purpose-8 plaintext. Returns an owned copy; retain the sealed frame for retries. */
export function encodeE2eeRpcRequestBody(input: E2eeRpcRequestBody): Uint8Array {
  const body = checked(requestSchema, input);
  const out = new Writer(
    1 + 16 + 8 + 2 + body.method.length + 4 + body.params.byteLength,
    MAX_RPC_BODY_BYTES
  );
  out.u8(0);
  out.raw(body.requestId);
  out.u64(body.expiresAt);
  out.text(body.method);
  out.blob(body.params);
  return out.bytes;
}

/** Decode only after purpose-8 authentication. Owned byte fields must be wiped by the caller. */
export function decodeE2eeRpcRequestBody(bytes: Uint8Array): E2eeRpcRequestBody {
  const reader = new Reader(bytes, MAX_RPC_BODY_BYTES);
  reader.version();
  const body = checked(requestSchema, {
    requestId: reader.take(16),
    expiresAt: reader.u64(),
    method: reader.text(128),
    params: reader.blob(),
  });
  reader.end();
  return {
    ...body,
    requestId: Uint8Array.from(body.requestId),
    params: Uint8Array.from(body.params),
  };
}

const kinds = ['progress', 'success', 'error'] as const;

/** Encode purpose-9 plaintext; error payloads must also satisfy the nested error-body codec. */
export function encodeE2eeRpcResponseBody(input: E2eeRpcResponseBody): Uint8Array {
  const body = checked(responseSchema, input);
  if (body.kind === 'error') readErrorBody(body.payload);
  const out = new Writer(RPC_RESPONSE_PREFIX_BYTES + body.payload.byteLength, MAX_RPC_BODY_BYTES);
  out.u8(0);
  out.raw(body.requestId);
  out.raw(body.requestDigest);
  out.u8(kinds.indexOf(body.kind));
  out.u32(body.sequence);
  out.blob(body.payload);
  return out.bytes;
}

/** Decode authenticated purpose-9 plaintext; correlation, sequence state and target authority remain host checks. */
export function decodeE2eeRpcResponseBody(bytes: Uint8Array): E2eeRpcResponseBody {
  const reader = new Reader(bytes, MAX_RPC_BODY_BYTES);
  reader.version();
  const requestId = reader.take(16);
  const requestDigest = reader.take(32);
  const kind = kinds[reader.u8()];
  if (kind === undefined) throw new E2eeWireError('kind');
  const body = checked(responseSchema, {
    requestId,
    requestDigest,
    kind,
    sequence: reader.u32(),
    payload: reader.blob(),
  });
  reader.end();
  if (kind === 'error') readErrorBody(body.payload);
  return {
    ...body,
    requestId: Uint8Array.from(requestId),
    requestDigest: Uint8Array.from(requestDigest),
    payload: Uint8Array.from(body.payload),
  };
}

/** Encode the bounded purpose-7 body. TTL validity does not establish current liveness. */
export function encodeE2eePresenceBody(input: E2eePresenceBody): Uint8Array {
  const body = checked(presenceSchema, input);
  const out = new Writer(1 + 16 + 4 + 8 + 8 + 4 + body.payload.byteLength, MAX_PRESENCE_BODY_BYTES);
  out.u8(0);
  out.raw(body.incarnation);
  out.u32(body.sequence);
  out.u64(body.issuedAt);
  out.u64(body.expiresAt);
  out.blob(body.payload);
  return out.bytes;
}

/** Decode authenticated purpose-7 plaintext. Does not read a clock or apply room/replay policy. */
export function decodeE2eePresenceBody(bytes: Uint8Array): E2eePresenceBody {
  const reader = new Reader(bytes, MAX_PRESENCE_BODY_BYTES);
  reader.version();
  const body = checked(presenceSchema, {
    incarnation: reader.take(16),
    sequence: reader.u32(),
    issuedAt: reader.u64(),
    expiresAt: reader.u64(),
    payload: reader.blob(),
  });
  reader.end();
  return {
    ...body,
    incarnation: Uint8Array.from(body.incarnation),
    payload: Uint8Array.from(body.payload),
  };
}

/** Encode the nested final-error payload, including its bounded ASCII code and exact method DTO bytes. */
export function encodeE2eeRpcErrorBody(input: E2eeRpcErrorBody): Uint8Array {
  const body = checked(errorSchema, input);
  const out = new Writer(
    2 + body.code.length + 4 + body.detail.byteLength,
    MAX_RPC_BODY_BYTES - RPC_RESPONSE_PREFIX_BYTES
  );
  out.text(body.code);
  out.blob(body.detail);
  return out.bytes;
}

/** Decode a nested final-error payload; returned detail is owned and carries no raw exception authority. */
export function decodeE2eeRpcErrorBody(bytes: Uint8Array): E2eeRpcErrorBody {
  const body = readErrorBody(bytes);
  return { ...body, detail: Uint8Array.from(body.detail) };
}

function readErrorBody(bytes: Uint8Array): E2eeRpcErrorBody {
  const reader = new Reader(bytes, MAX_RPC_BODY_BYTES - RPC_RESPONSE_PREFIX_BYTES);
  const body = checked(errorSchema, { code: reader.text(64), detail: reader.blob() });
  reader.end();
  return body;
}
