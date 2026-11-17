import { Effect, Result } from 'effect';
import * as Bytes from './bytes';
import { ValidationError } from './errors';
import { verifySignature } from './signature';
import { signVerified, type DeviceSigner } from './signing';

const domain = new TextEncoder().encode('lody-e2ee/execution-intent/v1\0');
const MAX_FIELD_BYTES = 1024;
const kinds = new Set([1, 2, 3]);

/**
 * What one execution intent signature binds (owner decision 2026-11-10). Only the
 * message and its scope, never a document operation, frame or epoch: a different
 * document engine can keep the same meaning, and key rotation cannot invalidate it.
 */
export interface ExecutionIntent {
  /** 1 member input, 2 machine input, 3 schedule declaration. */
  readonly kind: number;
  readonly genesis: Bytes.GenesisHash;
  readonly workspaceId: string;
  readonly targetMachineId: string;
  /** Session for inputs, schedule for declarations. */
  readonly scope: string;
  readonly messageId: string;
  /** SHA-256 of the canonical content that will run. */
  readonly contentDigest: Uint8Array;
}

/** domain, kind:u8, genesis:32, four u16be-length UTF-8 fields, contentDigest:32. */
export function executionIntentBytes(input: ExecutionIntent) {
  return Result.gen(function* () {
    const genesis = yield* Bytes.genesisHash(input.genesis.toBytes());
    if (
      !kinds.has(input.kind) ||
      !(input.contentDigest instanceof Uint8Array) ||
      input.contentDigest.length !== 32
    )
      return yield* Result.fail(new ValidationError({ code: 'canonical' }));
    const fields: Uint8Array[] = [];
    for (const value of [input.workspaceId, input.targetMachineId, input.scope, input.messageId]) {
      if (typeof value !== 'string')
        return yield* Result.fail(new ValidationError({ code: 'canonical' }));
      const bytes = new TextEncoder().encode(value);
      if (bytes.length > MAX_FIELD_BYTES)
        return yield* Result.fail(new ValidationError({ code: 'canonical' }));
      const field = new Uint8Array(2 + bytes.length);
      new DataView(field.buffer).setUint16(0, bytes.length, false);
      field.set(bytes, 2);
      fields.push(field);
    }
    const parts = [
      domain,
      Uint8Array.of(input.kind),
      genesis.toBytes(),
      ...fields,
      input.contentDigest,
    ];
    const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  });
}

/** Sign one intent with this device; the fixed verifier checks the signer's output. */
export const signExecutionIntent = Effect.fnUntraced(function* (
  input: ExecutionIntent & { readonly signer: DeviceSigner }
) {
  const message = yield* Effect.fromResult(executionIntentBytes(input));
  return yield* signVerified(input.signer, message);
});

/** Strict Ed25519 verification. Proves authorship only, never current membership. */
export function verifyExecutionIntent(
  input: ExecutionIntent,
  signingPublicKey: Uint8Array,
  signature: Uint8Array
) {
  return Result.flatMap(executionIntentBytes(input), (message) =>
    verifySignature(signingPublicKey, message, signature)
  );
}
