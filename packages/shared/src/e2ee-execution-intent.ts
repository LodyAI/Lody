import { sha256Hex } from './incremental-sha256';
import { queuedInputEvidence } from './session-input';

/**
 * Encrypted execution intent (owner decision 2026-11-10). Every executable input
 * carries one signature over its message ID and a digest of the content that will
 * run, stored beside that content in the same commit. The signed bytes depend only
 * on the message and its scope, never on a CRDT operation ID, frame or document
 * layout, so a different document engine can keep the same authorization meaning.
 */
export const E2EE_INTENT_KIND = {
  /** A member's own input: a sent turn, a queued item or an edit of either. */
  memberInput: 1,
  /** An input this machine wrote itself: derived work, a scheduled run, an automation. */
  machineInput: 2,
  /** A schedule's definition or manual run, signed by whoever set it. */
  scheduleDeclaration: 3,
} as const;
export type E2eeIntentKind = (typeof E2EE_INTENT_KIND)[keyof typeof E2EE_INTENT_KIND];

/** Everything a signature binds. Hex fields are lowercase. */
export type E2eeIntentSubject = {
  readonly kind: E2eeIntentKind;
  /** Workspace genesis hash, 64 hex. */
  readonly genesis: string;
  readonly workspaceId: string;
  /** The only machine that may run it; empty for none (never for an input). */
  readonly targetMachineId: string;
  /** The session for inputs, the schedule for declarations. */
  readonly scope: string;
  /** Stable message ID: the turn ID, or a schedule declaration's key. */
  readonly messageId: string;
  /** SHA-256 of the canonical content, 64 hex. */
  readonly contentDigest: string;
};

export const E2EE_INTENT_RECORD_VERSION = 1;
/** version:u8, kind:u8, signer:32, Ed25519 signature:64. Stored as unpadded base64url
 * (131 characters): the document mirror has no binary value type, and a byte array
 * written through it would become a per-byte object, larger than hex. */
export const E2EE_INTENT_RECORD_BYTES = 98;
export const E2EE_INTENT_RECORD_PATTERN = /^[A-Za-z0-9_-]{131}$/;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += alphabet[a >> 2]! + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += alphabet[c & 63]!;
  }
  return out;
}
function fromBase64Url(text: string): Uint8Array | undefined {
  const values: number[] = [];
  for (const char of text) {
    const value = alphabet.indexOf(char);
    if (value < 0) return undefined;
    values.push(value);
  }
  const out: number[] = [];
  for (let index = 0; index < values.length; index += 4) {
    const [a, b, c, d] = values.slice(index, index + 4);
    if (b === undefined) return undefined;
    out.push((a! << 2) | (b >> 4));
    if (c !== undefined) out.push(((b & 15) << 4) | (c >> 2));
    if (d !== undefined) out.push(((c! & 3) << 6) | d);
  }
  const bytes = Uint8Array.from(out);
  // Canonical only: re-encoding must reproduce the exact text.
  return toBase64Url(bytes) === text ? bytes : undefined;
}
export type E2eeIntentRecord = {
  readonly kind: E2eeIntentKind;
  readonly signer: Uint8Array;
  readonly signature: Uint8Array;
};

const kinds = new Set<number>(Object.values(E2EE_INTENT_KIND));

export function encodeE2eeIntentRecord(record: E2eeIntentRecord): string {
  if (!kinds.has(record.kind) || record.signer.length !== 32 || record.signature.length !== 64)
    throw new Error('e2ee_intent_record_invalid');
  const out = new Uint8Array(E2EE_INTENT_RECORD_BYTES);
  out[0] = E2EE_INTENT_RECORD_VERSION;
  out[1] = record.kind;
  out.set(record.signer, 2);
  out.set(record.signature, 34);
  return toBase64Url(out);
}

/** Strict: any other encoding, length, version or kind is not a record. */
export function decodeE2eeIntentRecord(text: unknown): E2eeIntentRecord | undefined {
  if (typeof text !== 'string' || !E2EE_INTENT_RECORD_PATTERN.test(text)) return undefined;
  const value = fromBase64Url(text);
  if (!value || value.length !== E2EE_INTENT_RECORD_BYTES) return undefined;
  if (value[0] !== E2EE_INTENT_RECORD_VERSION || !kinds.has(value[1]!)) return undefined;
  return {
    kind: value[1] as E2eeIntentKind,
    signer: value.slice(2, 34),
    signature: value.slice(34, 98),
  };
}

const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, item]) => [key, sorted(item)])
        )
      : value;
/** One canonical JSON for every signer and verifier: sorted keys, no undefined. */
export const canonicalIntentJson = (value: unknown): string =>
  JSON.stringify(sorted(JSON.parse(JSON.stringify(value)) as unknown));

/**
 * Canonical content of a turn that will run: the author's chosen input (without
 * the `resume` that promotion supplies) and, for machine inputs, what derived or
 * scheduled it. Undefined when the input is not executable.
 */
export function turnExecutionContent(input: {
  readonly inputConfig: unknown;
  readonly derivedFrom?: unknown;
  readonly scheduleRun?: unknown;
}): string | undefined {
  const evidence = queuedInputEvidence(input.inputConfig);
  if (evidence === undefined) return undefined;
  return canonicalIntentJson({
    v: 1,
    input: JSON.parse(evidence) as unknown,
    derivedFrom: input.derivedFrom,
    scheduleRun: input.scheduleRun,
  });
}

export function turnExecutionDigest(input: Parameters<typeof turnExecutionContent>[0]) {
  const content = turnExecutionContent(input);
  return content === undefined ? undefined : sha256Hex(new TextEncoder().encode(content));
}

/** Declaration message IDs: one definition, and one per manual run. */
export const scheduleDeclarationMessageId = (manualRunKey?: string) =>
  manualRunKey ? `manual:${manualRunKey}` : 'definition';
