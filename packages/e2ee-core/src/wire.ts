import { Point, verifyAsync } from '@noble/ed25519';

/** Experimental wire format. All strings are ASCII; payload bytes are opaque to the core. */
export interface ControlEvent {
  readonly genesis: string;
  readonly previous: string;
  readonly operationId: string;
  readonly actor: string;
  readonly memberInstance: string;
  readonly device: string;
  readonly kind: string;
  readonly payload: string;
}

export interface Signer {
  readonly id: string;
  /** Raw Ed25519 public key, lowercase hex. Obtained from verified state, not wire claims. */
  readonly publicKey: string;
}

export interface SignedRecord {
  readonly event: ControlEvent;
  readonly signatures: readonly (readonly [id: string, signature: string])[];
}

const DOMAIN = 'lody-control/v1';
export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_WIRE_BYTES = 140 * 1024;
const MAX_SIGNERS = 8;
const encoder = new TextEncoder();

export class ControlLogError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ControlLogError';
  }
}

export function invariant(condition: boolean, code: string): asserts condition {
  if (!condition) throw new ControlLogError(code);
}

export function checkHex(value: unknown, bytes?: number): asserts value is string {
  invariant(typeof value === 'string' && /^(?:[0-9a-f]{2})*$/.test(value), 'invalid-hex');
  if (bytes !== undefined) invariant(value.length === bytes * 2, 'invalid-length');
}

function checkId(value: unknown): asserts value is string {
  invariant(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'invalid-id');
}

function eventTuple(event: ControlEvent): readonly string[] {
  checkHex(event.genesis, 32);
  checkHex(event.previous, 32);
  checkHex(event.operationId, 16);
  for (const id of [event.actor, event.memberInstance, event.device, event.kind]) checkId(id);
  invariant(
    typeof event.payload === 'string' && event.payload.length <= MAX_PAYLOAD_BYTES * 2,
    'payload-too-large'
  );
  checkHex(event.payload);
  return [
    DOMAIN,
    event.genesis,
    event.previous,
    event.operationId,
    event.actor,
    event.memberInstance,
    event.device,
    event.kind,
    event.payload,
  ];
}

function checkSignerIds(ids: readonly string[]): void {
  invariant(ids.length > 0 && ids.length <= MAX_SIGNERS, 'invalid-signers');
  for (let i = 0; i < ids.length; i++) {
    checkId(ids[i]);
    if (i > 0) invariant(ids[i - 1]! < ids[i]!, 'unsorted-or-duplicate-signers');
  }
}

export function signingBytes(
  event: ControlEvent,
  signerIds: readonly string[]
): Uint8Array<ArrayBuffer> {
  checkSignerIds(signerIds);
  return encoder.encode(JSON.stringify([eventTuple(event), signerIds]));
}

export function encodeRecord(record: SignedRecord): string {
  const ids = record.signatures.map(([id]) => id);
  checkSignerIds(ids);
  for (const [, signature] of record.signatures) checkHex(signature, 64);
  const wire = JSON.stringify([
    eventTuple(record.event),
    record.signatures.map(([id, sig]) => [id, sig]),
  ]);
  invariant(wire.length <= MAX_WIRE_BYTES, 'record-too-large');
  return wire;
}

export function decodeRecord(wire: string): SignedRecord {
  invariant(typeof wire === 'string' && wire.length <= MAX_WIRE_BYTES, 'record-too-large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(wire);
  } catch {
    throw new ControlLogError('invalid-json');
  }
  invariant(Array.isArray(parsed) && parsed.length === 2, 'invalid-record');
  const [tuple, signatures] = parsed as unknown[];
  invariant(
    Array.isArray(tuple) && tuple.length === 9 && tuple.every((x) => typeof x === 'string'),
    'invalid-event'
  );
  invariant(tuple[0] === DOMAIN, 'unsupported-version');
  invariant(Array.isArray(signatures) && signatures.length <= MAX_SIGNERS, 'invalid-signers');
  const checkedSignatures: [string, string][] = [];
  for (const pair of signatures) {
    invariant(Array.isArray(pair) && pair.length === 2, 'invalid-signature');
    const [id, signature] = pair as unknown[];
    invariant(typeof id === 'string' && typeof signature === 'string', 'invalid-signature');
    checkedSignatures.push([id, signature]);
  }
  const event: ControlEvent = Object.freeze({
    genesis: tuple[1]!,
    previous: tuple[2]!,
    operationId: tuple[3]!,
    actor: tuple[4]!,
    memberInstance: tuple[5]!,
    device: tuple[6]!,
    kind: tuple[7]!,
    payload: tuple[8]!,
  });
  const record: SignedRecord = { event, signatures: checkedSignatures };
  invariant(encodeRecord(record) === wire, 'noncanonical-record');
  return record;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  checkHex(hex);
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validSigningPoint(bytes: Uint8Array): boolean {
  try {
    const point = Point.fromBytes(bytes, false);
    return !point.isSmallOrder() && point.isTorsionFree();
  } catch {
    return false;
  }
}

/** Canonical nonzero prime-subgroup Ed25519 key. Never use this for X25519 keys. */
export function checkSigningKey(value: unknown): asserts value is string {
  checkHex(value, 32);
  invariant(validSigningPoint(fromHex(value)), 'invalid-signing-key');
}

/** Native non-extractable signing; one strict verification profile on every runtime. */
export class WebCryptoControl {
  constructor(private readonly subtle: SubtleCrypto = globalThis.crypto.subtle) {}

  async hashRecord(wire: string): Promise<string> {
    decodeRecord(wire);
    return toHex(
      new Uint8Array(
        await this.subtle.digest('SHA-256', encoder.encode(`lody-control-record/v1\0${wire}`))
      )
    );
  }

  async verify(publicKey: string, message: Uint8Array, signature: string): Promise<boolean> {
    checkHex(publicKey, 32);
    checkHex(signature, 64);
    const bytes = new Uint8Array(message);
    const key = fromHex(publicKey);
    const sig = fromHex(signature);
    if (!validSigningPoint(key)) return false;
    // The library's strict mode checks canonical A/R and S < L, but its cofactored
    // equation also permits mixed-torsion R. Restrict R to the prime subgroup too.
    // Identity R is allowed; it is not a public key or a proof of possession.
    try {
      if (!Point.fromBytes(sig.subarray(0, 32), false).isTorsionFree()) return false;
    } catch {
      return false;
    }
    return verifyAsync(sig, bytes, key, { zip215: false });
  }

  async sign(
    event: ControlEvent,
    keys: readonly { id: string; key: CryptoKey }[]
  ): Promise<string> {
    // Copy before the first await: caller mutations must not change what gets encoded.
    const stableEvent = { ...event };
    const stableKeys = keys
      .map(({ id, key }) => ({ id, key }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const message = signingBytes(
      stableEvent,
      stableKeys.map(({ id }) => id)
    );
    const signatures: [string, string][] = [];
    for (const { id, key } of stableKeys) {
      const signature = await this.subtle.sign('Ed25519', key, message);
      signatures.push([id, toHex(new Uint8Array(signature))]);
    }
    return encodeRecord({ event: stableEvent, signatures });
  }
}
