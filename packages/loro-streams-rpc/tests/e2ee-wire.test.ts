import { describe, expect, it } from 'vitest';
import {
  decodeE2eePresenceBody,
  decodeE2eeRpcErrorBody,
  decodeE2eeRpcRequestBody,
  decodeE2eeRpcResponseBody,
  encodeE2eePresenceBody,
  encodeE2eeRpcErrorBody,
  encodeE2eeRpcRequestBody,
  encodeE2eeRpcResponseBody,
  E2eeWireError,
  E2EE_RPC_MAX_FRAME_BYTES,
  type E2eeRpcResponseBody,
} from '../src/index';
import vector from './fixtures/e2ee-wire-v0.json';
import {
  E2EE_FEATURE_CHUNK_BYTES,
  encodeFeatureResponsePage,
  decodeFeatureResponsePage,
} from '../src/e2ee-feature-parts';

const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const utf8 = (value: string) => new TextEncoder().encode(value);
const request = () => ({
  requestId: Uint8Array.from({ length: 16 }, (_, index) => index),
  expiresAt: 0x0102030405,
  method: 'session/dispatch-turn',
  params: utf8('{ "sessionId": "synthetic" }'),
});
const error = () => ({ code: 'permission_denied', detail: utf8('{"reason":"synthetic"}') });
const response = (kind: 'progress' | 'success' | 'error' = 'progress'): E2eeRpcResponseBody => ({
  requestId: request().requestId,
  requestDigest: fromHex(vector.digest),
  kind,
  sequence: kind === 'progress' ? 0 : kind === 'success' ? 0xffffffff : 0x01020304,
  payload:
    kind === 'progress'
      ? utf8('{"accepted":true}')
      : kind === 'success'
        ? utf8('null')
        : fromHex(vector.errorPayload),
});
const presence = () => ({
  incarnation: Uint8Array.from({ length: 16 }, (_, index) => index + 16),
  sequence: 0x01020304,
  issuedAt: 0x0102030405,
  expiresAt: 0x0102030405 + 60_000,
  payload: new Uint8Array([0, 255]),
});
const cases = [
  { name: 'request', raw: vector.request, decode: decodeE2eeRpcRequestBody },
  { name: 'progress', raw: vector.progress, decode: decodeE2eeRpcResponseBody },
  { name: 'success', raw: vector.success, decode: decodeE2eeRpcResponseBody },
  { name: 'error', raw: vector.error, decode: decodeE2eeRpcResponseBody },
  { name: 'presence', raw: vector.presence, decode: decodeE2eePresenceBody },
  { name: 'error payload', raw: vector.errorPayload, decode: decodeE2eeRpcErrorBody },
];
function rejects(action: () => unknown, code?: E2eeWireError['code']) {
  expect(action).toThrow(E2eeWireError);
  if (code) expect(action).toThrow(`Invalid E2EE realtime body: ${code}`);
}
function replace(raw: string, offset: number, replacement: Uint8Array): Uint8Array {
  const bytes = fromHex(raw);
  bytes.set(replacement, offset);
  return bytes;
}

describe('candidate E2EE realtime body profile', () => {
  it('matches independent Python struct vectors without reserializing method bytes', () => {
    expect(hex(encodeE2eeRpcRequestBody(request()))).toBe(vector.request);
    expect(decodeE2eeRpcRequestBody(fromHex(vector.request))).toEqual(request());
    expect(hex(encodeE2eeRpcErrorBody(error()))).toBe(vector.errorPayload);
    expect(decodeE2eeRpcErrorBody(fromHex(vector.errorPayload))).toEqual(error());
    expect(hex(encodeE2eePresenceBody(presence()))).toBe(vector.presence);
    expect(decodeE2eePresenceBody(fromHex(vector.presence))).toEqual(presence());
    for (const kind of ['progress', 'success', 'error'] as const) {
      expect(hex(encodeE2eeRpcResponseBody(response(kind)))).toBe(vector[kind]);
      expect(decodeE2eeRpcResponseBody(fromHex(vector[kind]))).toEqual(response(kind));
    }
  });

  it.each(cases)('rejects every truncation and trailing bytes: $name', ({ raw, decode }) => {
    const bytes = fromHex(raw);
    for (let length = 0; length < bytes.byteLength; length++) {
      rejects(() => decode(bytes.subarray(0, length)));
    }
    rejects(() => decode(new Uint8Array([...bytes, 0])), 'trailing');
  });

  it.each(cases.filter(({ name }) => name !== 'error payload'))(
    'rejects unknown versions: $name',
    ({ raw, decode }) => {
      for (const version of [1, 255])
        rejects(() => decode(replace(raw, 0, new Uint8Array([version]))), 'version');
    }
  );

  it('rejects unknown response kinds and malformed nested errors', () => {
    for (const kind of [3, 255])
      rejects(
        () => decodeE2eeRpcResponseBody(replace(vector.success, 49, new Uint8Array([kind]))),
        'kind'
      );
    rejects(() =>
      encodeE2eeRpcResponseBody({ ...response('error'), payload: utf8('unstructured error') })
    );
    rejects(() => decodeE2eeRpcResponseBody(replace(vector.success, 49, new Uint8Array([2]))));
  });

  it('rejects unsafe u64 values instead of rounding a deadline or presence timestamp', () => {
    const unsafe = new Uint8Array([0, 0x20, 0, 0, 0, 0, 0, 0]);
    rejects(() => decodeE2eeRpcRequestBody(replace(vector.request, 17, unsafe)), 'integer');
    for (const offset of [21, 29])
      rejects(() => decodeE2eePresenceBody(replace(vector.presence, offset, unsafe)), 'integer');
    const input = { ...request(), expiresAt: Number.MAX_SAFE_INTEGER };
    expect(decodeE2eeRpcRequestBody(encodeE2eeRpcRequestBody(input))).toEqual(input);
    for (const expiresAt of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      rejects(() => encodeE2eeRpcRequestBody({ ...input, expiresAt }));
    }
    for (const sequence of [-1, 0.5, 0x100000000])
      rejects(() => encodeE2eeRpcResponseBody({ ...response(), sequence }));
  });

  it('bounds the complete RPC frame before copying or expanding advertised lengths', () => {
    const overhead = 143;
    expect(E2EE_RPC_MAX_FRAME_BYTES).toBe(1024 * 1024);
    const bodyLimit = 1024 * 1024 - overhead;
    const params = new Uint8Array(bodyLimit - 31 - 1);
    const input = { ...request(), method: 'a', params };
    const encoded = encodeE2eeRpcRequestBody(input);
    expect(encoded.byteLength + overhead).toBe(1024 * 1024);
    expect(decodeE2eeRpcRequestBody(encoded).params.byteLength).toBe(params.byteLength);
    rejects(
      () => encodeE2eeRpcRequestBody({ ...input, params: new Uint8Array(params.byteLength + 1) }),
      'size'
    );
    rejects(() => decodeE2eeRpcRequestBody(new Uint8Array([...encoded, 0])), 'size');
    const result: E2eeRpcResponseBody = {
      ...response('success'),
      payload: new Uint8Array(bodyLimit - 58),
    };
    expect(encodeE2eeRpcResponseBody(result).byteLength + overhead).toBe(1024 * 1024);
    rejects(
      () =>
        encodeE2eeRpcResponseBody({
          ...result,
          payload: new Uint8Array(result.payload.byteLength + 1),
        }),
      'size'
    );
    rejects(() => decodeE2eeRpcResponseBody(new Uint8Array(bodyLimit + 1)), 'size');
    const nested = encodeE2eeRpcErrorBody({
      code: 'x',
      detail: new Uint8Array(bodyLimit - 58 - 7),
    });
    expect(
      encodeE2eeRpcResponseBody({ ...response('error'), payload: nested }).byteLength + overhead
    ).toBe(1024 * 1024);
    rejects(
      () => encodeE2eeRpcErrorBody({ code: 'x', detail: new Uint8Array(bodyLimit - 58 - 6) }),
      'size'
    );
    // A 4 GiB length prefix must fail on the remaining view, before any allocation.
    const huge = new Uint8Array([255, 255, 255, 255]);
    rejects(
      () => decodeE2eeRpcRequestBody(replace(vector.request, 27 + request().method.length, huge)),
      'truncated'
    );
    rejects(() => decodeE2eeRpcResponseBody(replace(vector.success, 54, huge)), 'truncated');
    rejects(() => decodeE2eePresenceBody(replace(vector.presence, 37, huge)), 'truncated');
    rejects(
      () => decodeE2eeRpcErrorBody(replace(vector.errorPayload, 2 + error().code.length, huge)),
      'truncated'
    );
  });

  it('bounds presence bodies and the positive TTL without consulting wall time', () => {
    for (const ttl of [1, 60_000]) {
      const body = { ...presence(), expiresAt: presence().issuedAt + ttl };
      expect(decodeE2eePresenceBody(encodeE2eePresenceBody(body))).toEqual(body);
    }
    for (const ttl of [-1, 0, 60_001])
      rejects(() =>
        encodeE2eePresenceBody({ ...presence(), expiresAt: presence().issuedAt + ttl })
      );
    const encoded = encodeE2eePresenceBody(presence());
    const changed = new DataView(encoded.buffer);
    changed.setBigUint64(29, BigInt(presence().issuedAt + 60_001), false);
    rejects(() => decodeE2eePresenceBody(encoded), 'fields');
    const full = { ...presence(), payload: new Uint8Array(64 * 1024 - 41) };
    expect(encodeE2eePresenceBody(full).byteLength).toBe(64 * 1024);
    rejects(
      () =>
        encodeE2eePresenceBody({ ...full, payload: new Uint8Array(full.payload.byteLength + 1) }),
      'size'
    );
    rejects(() => decodeE2eePresenceBody(new Uint8Array(64 * 1024 + 1)), 'size');
  });

  it('validates bounded ASCII and fixed byte identities on both directions', () => {
    for (const method of [
      '',
      'a'.repeat(129),
      'has space',
      'méthod',
      '\ufeffmethod',
      '\0',
      'method\n',
      'method\r',
      'method\u2028',
    ])
      rejects(() => encodeE2eeRpcRequestBody({ ...request(), method }));
    const longest = { ...request(), method: 'a'.repeat(128) };
    expect(decodeE2eeRpcRequestBody(encodeE2eeRpcRequestBody(longest))).toEqual(longest);
    for (const code of ['', 'x'.repeat(65), 'not allowed', 'slash/code', 'é', 'code\n'])
      rejects(() => encodeE2eeRpcErrorBody({ ...error(), code }));
    for (const size of [0, 15, 17]) {
      rejects(() => encodeE2eeRpcRequestBody({ ...request(), requestId: new Uint8Array(size) }));
      rejects(() => encodeE2eeRpcResponseBody({ ...response(), requestId: new Uint8Array(size) }));
      rejects(() => encodeE2eePresenceBody({ ...presence(), incarnation: new Uint8Array(size) }));
    }
    rejects(() => encodeE2eeRpcResponseBody({ ...response(), requestDigest: new Uint8Array(31) }));
    rejects(
      () => decodeE2eeRpcRequestBody(replace(vector.request, 27, new Uint8Array([0xff]))),
      'text'
    );
    rejects(
      () => decodeE2eeRpcRequestBody(replace(vector.request, 25, new Uint8Array([255, 255]))),
      'text'
    );
    rejects(
      () => decodeE2eeRpcErrorBody(replace(vector.errorPayload, 2, new Uint8Array([47]))),
      'fields'
    );
  });

  it.each(cases)(
    'owns decoded bytes even when the input is an offset Node Buffer: $name',
    ({ raw, decode }) => {
      const buffer = Buffer.from(`ffff${raw}eeee`, 'hex');
      const source = buffer.subarray(2, buffer.byteLength - 2);
      const decoded = decode(source);
      const expected = decode(fromHex(raw));
      source.fill(0);
      expect(decoded).toEqual(expected);
      for (const value of Object.values(decoded)) if (value instanceof Uint8Array) value.fill(255);
      expect(hex(source)).toBe('00'.repeat(source.byteLength));
    }
  );

  it('owns encoded bytes and keeps method parameters opaque and exact', () => {
    const input = request();
    const encoded = encodeE2eeRpcRequestBody(input);
    input.requestId.fill(255);
    input.params.fill(0);
    expect(hex(encoded)).toBe(vector.request);
    // Method schema/JSON validation belongs after authentication in the integration.
    const opaque = { ...request(), params: new Uint8Array([255, 0]) };
    expect(decodeE2eeRpcRequestBody(encodeE2eeRpcRequestBody(opaque))).toEqual(opaque);
  });
});

describe('common encrypted machine response pages', () => {
  it('retains exact byte/count metadata within the signed frame budget', () => {
    const result = new Uint8Array(1024 * 1024 + 19).fill(65);
    const count = Math.ceil(result.length / E2EE_FEATURE_CHUNK_BYTES);
    const chunks: Uint8Array[] = [];
    for (let sequence = 0; sequence < count; sequence++) {
      const body = {
        ...response(sequence === count - 1 ? 'success' : 'progress'),
        sequence,
        payload: encodeFeatureResponsePage(result, sequence),
      };
      const wire = encodeE2eeRpcResponseBody(body);
      expect(wire.length + 143).toBeLessThanOrEqual(E2EE_RPC_MAX_FRAME_BYTES);
      const decoded = decodeFeatureResponsePage(decodeE2eeRpcResponseBody(wire));
      expect(decoded.totalPages).toBe(count);
      expect(decoded.totalBytes).toBe(result.length);
      chunks.push(decoded.bytes);
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(result));
  });

  it('refuses inconsistent counts, byte lengths, sequence and terminal position', () => {
    const payload = new Uint8Array(E2EE_FEATURE_CHUNK_BYTES + 3).fill(97);
    const first = { ...response(), sequence: 0, payload: encodeFeatureResponsePage(payload, 0) };
    const last = {
      ...response('success'),
      sequence: 1,
      payload: encodeFeatureResponsePage(payload, 1),
    };
    for (const [body, offset, value] of [
      [first, 0, 0],
      [first, 0, 3],
      [first, 4, 0],
      [first, 4, 16 * 1024 * 1024 + 1],
      [last, 4, payload.length + 1],
    ] as const) {
      const changed = body.payload.slice();
      new DataView(changed.buffer).setUint32(offset, value);
      expect(() => decodeFeatureResponsePage({ ...body, payload: changed })).toThrow();
    }
    for (const changed of [
      { ...first, sequence: 1 },
      { ...first, kind: 'success' as const },
      { ...last, kind: 'progress' as const },
      { ...last, payload: last.payload.subarray(0, -1) },
      { ...last, payload: Uint8Array.from([...last.payload, 0]) },
      { ...first, payload: utf8('{"old":"unframed result"}') },
    ])
      expect(() => decodeFeatureResponsePage(changed)).toThrow();
  });
});
