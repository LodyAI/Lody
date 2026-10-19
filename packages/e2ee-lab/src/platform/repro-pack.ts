import { createHash } from 'node:crypto';
import { Data, Effect, Result, Schema } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { type LedgerCheckpoint } from '@lody/e2ee-core';
import { verifyLedgerEffect, epochHistoryPacket } from '@lody/e2ee-core/protocol';
import { commitEpochKey } from '@lody/e2ee-core/protocol';
import { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import type { DeviceSigner } from '@lody/e2ee-core';
import { inspectLabEvidence } from './action-executor';
import { worstVerdict } from '../pure/judge';

const hex = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{2})*$/));
const hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const refusal = Schema.Struct({ tag: Schema.String, code: Schema.String });
const ReadCase = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  resource: Schema.String.check(Schema.isPattern(/^[!-~]{1,1024}$/)),
  model: Schema.Literals(['loro', 'flock']),
  kind: Schema.Literals(['update_batch', 'snapshot']),
  continuationOffset: Schema.optional(Schema.String.check(Schema.isMaxLength(3950))),
  header: hex,
  sealed: hex,
  additionalData: hex,
  expected: Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), plaintextSha256: hash }),
    Schema.Struct({ ok: Schema.Literal(false), refusal }),
  ]),
});
const CapturedReads = Schema.Struct({
  format: Schema.Literal('lody-e2ee-captured-reads/v1'),
  syntheticOnly: Schema.Literal(true),
  genesis: hash,
  records: Schema.Array(hex).check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  reads: Schema.Array(ReadCase).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
export type LabCapturedReads = typeof CapturedReads.Type;
export class LabReproError extends Data.TaggedError('LabReproError')<{
  readonly code: 'invalid-pack' | 'budget' | 'context' | 'missing-observation' | 'not-reproduced';
}> {}
const maximumBytes = 32 * 1024 * 1024;

/** Only ordinary JSON data enters a pack. Capture without invoking caller getters,
 * iterators, toJSON or prototype hooks; retain one bounded owned representation. */
export function captureLabReproJson(input: unknown): unknown {
  let nodes = 0,
    stringBytes = 0;
  const own = (value: unknown, depth: number): unknown => {
    if (++nodes > 200_000 || depth > 32) throw new LabReproError({ code: 'budget' });
    if (typeof value === 'string') {
      stringBytes += Buffer.byteLength(value, 'utf8');
      if (stringBytes > maximumBytes) throw new LabReproError({ code: 'budget' });
      return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null)
      throw new LabReproError({ code: 'invalid-pack' });
    if (Array.isArray(value)) {
      const count = value.length;
      if (count > 200_000) throw new LabReproError({ code: 'budget' });
      const rows: unknown[] = [];
      for (let index = 0; index < count; index++) {
        const field = Object.getOwnPropertyDescriptor(value, String(index));
        if (!field || !('value' in field)) throw new LabReproError({ code: 'invalid-pack' });
        rows.push(own(field.value, depth + 1));
      }
      if (value.length !== count) throw new LabReproError({ code: 'invalid-pack' });
      return rows;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new LabReproError({ code: 'invalid-pack' });
    const object: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      stringBytes += Buffer.byteLength(key, 'utf8');
      if (stringBytes > maximumBytes) throw new LabReproError({ code: 'budget' });
      const field = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in field) || key === '__proto__')
        throw new LabReproError({ code: 'invalid-pack' });
      // Undefined optional fields in internally measured observations are omitted,
      // exactly as JSON does. Missing observations still remain coverage gaps.
      if (field.value !== undefined) object[key] = own(field.value, depth + 1);
    }
    return object;
  };
  const output = own(input, 0);
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > maximumBytes)
    throw new LabReproError({ code: 'budget' });
  return output;
}

export function captureLabReadPack(input: unknown): LabCapturedReads {
  const pack = Schema.decodeUnknownSync(CapturedReads)(captureLabReproJson(input));
  const ids = new Set<string>();
  for (const row of pack.reads) {
    if (ids.has(row.id) || (row.kind === 'snapshot') !== (row.continuationOffset !== undefined))
      throw new LabReproError({ code: 'invalid-pack' });
    ids.add(row.id);
  }
  return pack;
}

const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const ErrorIdentity = Schema.Struct({ _tag: Schema.String, code: Schema.String });
/** Actual signed-history verification and AEAD opens of captured originals.
 * The pack supplies bytes, never its own trust endpoint or secret material.
 * This replays reads only; it neither reseals nor replaces the secure RNG. */
export const replayLabCapturedReads = Effect.fn('Lab.replayCapturedReads')(function* (input: {
  readonly pack: unknown;
  readonly genesis: Bytes.GenesisHash;
  readonly checkpoint: LedgerCheckpoint;
  readonly signer: DeviceSigner;
  readonly readEpochKey: (epoch: number) => Effect.Effect<Bytes.EpochKey, unknown>;
}) {
  const pack = yield* Effect.try({
    try: () => captureLabReadPack(input.pack),
    catch: (cause) =>
      cause instanceof LabReproError ? cause : new LabReproError({ code: 'invalid-pack' }),
  });
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
  const checkpoint = {
    head: yield* Effect.fromResult(Bytes.recordHash(input.checkpoint.head.toBytes())),
    length: input.checkpoint.length,
  };
  const readEpochKey = input.readEpochKey;
  const signer = Object.freeze({
    publicKey: yield* Effect.fromResult(Bytes.signingPublicKey(input.signer.publicKey.toBytes())),
    sign: input.signer.sign.bind(input.signer),
  });
  if (Buffer.from(genesis.toBytes()).toString('hex') !== pack.genesis)
    return yield* new LabReproError({ code: 'context' });
  const ledger = yield* verifyLedgerEffect({
    anchor: genesis,
    records: pack.records.map(bytes),
    checkpoint,
  });
  const observations = [];
  for (const row of pack.reads) {
    const measurement = yield* Effect.scoped(
      Effect.gen(function* () {
        let keyCapabilityFailed = false;
        const binding = yield* makeStreamsUpdateBinding({
          genesis,
          resource: row.resource,
          model: row.model,
          writeEpoch: 'current',
          signer,
          ledger: () => Effect.succeed(ledger),
          readEpochKey: (epoch) =>
            readEpochKey(epoch).pipe(
              Effect.map((owned) => {
                const packet = epochHistoryPacket(ledger, epoch);
                const commitment = commitEpochKey(genesis, epoch, owned);
                if (
                  Result.isFailure(packet) ||
                  Result.isFailure(commitment) ||
                  !packet.success.commitment.equals(commitment.success)
                )
                  keyCapabilityFailed = true;
                // Transfer even a rejected handle into the binding's existing
                // bracket. It alone owns release; a provider failure must not
                // skip cleanup or masquerade as an expected ciphertext refusal.
                return owned;
              }),
              Effect.tapError(() =>
                Effect.sync(() => {
                  keyCapabilityFailed = true;
                })
              )
            ),
        });
        const opened = yield* Effect.result(
          binding.open({
            context: {
              protocol: 'loro-streams-crdt-payload-protection',
              version: 2,
              kind: row.kind,
              ...(row.continuationOffset === undefined
                ? {}
                : { continuationOffset: row.continuationOffset }),
            },
            header: bytes(row.header),
            sealed: bytes(row.sealed),
            additionalData: bytes(row.additionalData),
          })
        );
        if (opened._tag === 'Success') {
          const plaintext = opened.success;
          try {
            const plaintextSha256 = digest(plaintext);
            return {
              ok: true as const,
              plaintextSha256,
              verdict:
                row.expected.ok && row.expected.plaintextSha256 === plaintextSha256
                  ? ('pass' as const)
                  : ('violation' as const),
            };
          } finally {
            plaintext.fill(0);
          }
        }
        const identity = Schema.decodeUnknownResult(ErrorIdentity)(opened.failure);
        if (keyCapabilityFailed || identity._tag === 'Failure')
          return { ok: false as const, verdict: 'harness-error' as const };
        const actual = { tag: identity.success._tag, code: identity.success.code };
        const measured = actual.tag === 'ContentError' || actual.tag === 'LedgerError';
        return {
          ok: false as const,
          refusal: actual,
          verdict:
            measured &&
            !row.expected.ok &&
            row.expected.refusal.tag === actual.tag &&
            row.expected.refusal.code === actual.code
              ? ('pass' as const)
              : ('harness-error' as const),
        };
      })
    );
    observations.push({ id: row.id, originalSha256: digest(bytes(row.sealed)), ...measurement });
  }
  return {
    scope: 'captured-original-reads' as const,
    observations,
    verdict: worstVerdict(observations.map((row) => row.verdict)),
    coverage: { reseal: 'unsupported' as const, confidentiality: 'unavailable' as const },
  };
});

/** Action artifacts are inert captured observations. Recompute their verdicts;
 * never consume their self-reported pass/report/fingerprint as authority. */
export function captureLabActionPack(input: unknown) {
  const owned = captureLabReproJson(input);
  const measured = inspectLabEvidence(owned);
  const schedule = Schema.decodeUnknownSync(
    Schema.Struct({
      run: Schema.Struct({
        schedule: Schema.Array(
          Schema.Struct({
            kind: Schema.Literal('permit'),
            identity: Schema.Struct({
              actor: Schema.String,
              operation: Schema.String,
              phase: Schema.String,
              parent: Schema.optional(Schema.String),
            }),
            occurrence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
            eventId: Schema.optional(Schema.String),
          })
        ).check(Schema.isMaxLength(256)),
      }),
    })
  )(owned).run.schedule;
  if (measured.run.observations.length === 0)
    throw new LabReproError({ code: 'missing-observation' });
  const traces = Schema.decodeUnknownSync(
    Schema.Struct({
      run: Schema.Struct({
        observations: Schema.Array(
          Schema.Struct({
            reply: Schema.Struct({
              trace: Schema.optional(
                Schema.Struct({
                  frames: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
                  cipherChanged: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
                  ackDropped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
                })
              ),
            }),
          })
        ).check(Schema.isMaxLength(256)),
      }),
    })
  )(owned).run.observations;
  const privateReplay = Schema.decodeUnknownSync(
    Schema.Struct({
      privateReplay: Schema.Struct({
        format: Schema.Literal('lody-lab-private-replay/v1'),
        sha256: hash,
      }),
    })
  )(owned).privateReplay;
  return {
    observations: measured.run.observations.map((row, index) => ({
      ...row,
      reply: { ...row.reply, trace: traces[index]?.reply.trace },
    })),
    schedule,
    privateReplay,
    properties: Schema.decodeUnknownSync(
      Schema.Struct({
        run: Schema.Struct({
          properties: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              verdict: Schema.Literals([
                'pass',
                'violation',
                'unavailable',
                'outside-model',
                'harness-error',
              ]),
            })
          ),
        }),
      })
    )(owned).run.properties,
  };
}
