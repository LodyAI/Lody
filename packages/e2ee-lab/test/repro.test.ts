import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Result } from 'effect';
import { expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import { signGenesisRecord } from '@lody/e2ee-core/protocol';
import { verifyLedger, hashRecordBytes } from '@lody/e2ee-core/protocol';
import { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { commitEpochKey } from '@lody/e2ee-core/protocol';
import { history } from './ledger-fixture';
import {
  captureLabReadPack,
  captureLabActionPack,
  replayLabCapturedReads,
} from '../src/platform/repro-pack';
import { replayLabActions, minimizeLabActions } from '../src/platform/repro-runner';
import { runLabScenario } from '../src/platform/scenario-runner';
import { runOwnedChild } from './native-child';
const ok = Result.getOrThrow;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

it('reopens exact captured update/snapshot ciphertext with real crypto and caller-pinned history, rejecting unrelated failures', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = history(181),
          material = new Uint8Array(32).fill(182),
          key = () => Effect.sync(() => ok(Bytes.epochKey(material)));
        const genesis = yield* signGenesisRecord({
          signer: f.owner,
          initialKey: ok(Bytes.epochKey(material)),
          encryptionPublicKey: ok(Bytes.encryptionPublicKey(new Uint8Array(32).fill(183))),
          membershipId: f.membership,
          userId: ok(Bytes.userId(new Uint8Array(32).fill(184))),
        });
        const point = { head: hashRecordBytes(genesis.record), length: 1 };
        const view = ok(
          verifyLedger({ anchor: genesis.genesis, records: [genesis.record], checkpoint: point })
        );
        const binding = yield* makeStreamsUpdateBinding({
          genesis: genesis.genesis,
          resource: 'captured-document',
          model: 'loro',
          writeEpoch: 0,
          signer: f.owner,
          ledger: () => Effect.succeed(view),
          readEpochKey: key,
        });
        const plaintext = new TextEncoder().encode('original protected bytes');
        const reads = [];
        for (const kind of ['update_batch', 'snapshot'] as const) {
          const context = {
            protocol: 'loro-streams-crdt-payload-protection' as const,
            version: 2 as const,
            kind,
            ...(kind === 'snapshot' ? { continuationOffset: 'captured-offset' } : {}),
          };
          const aad = (header: Uint8Array) =>
            new Uint8Array([
              ...new TextEncoder().encode('loro-streams-crdt-payload-protection/v2\0'),
              ...header,
            ]);
          const original = yield* binding.seal({ context, plaintext, additionalData: aad });
          reads.push({
            id: kind,
            resource: 'captured-document',
            model: 'loro' as const,
            kind,
            ...(kind === 'snapshot' ? { continuationOffset: 'captured-offset' } : {}),
            header: hex(original.header),
            sealed: hex(original.sealed),
            additionalData: hex(aad(original.header)),
            expected: {
              ok: true as const,
              plaintextSha256: createHash('sha256').update(plaintext).digest('hex'),
            },
          });
        }
        const corrupted = new Uint8Array(Buffer.from(reads[0]!.sealed, 'hex'));
        corrupted[74] ^= 1;
        const pack = {
          format: 'lody-e2ee-captured-reads/v1',
          syntheticOnly: true,
          genesis: hex(genesis.genesis.toBytes()),
          records: [hex(genesis.record)],
          reads: [
            ...reads,
            {
              ...reads[0]!,
              id: 'mutated-original',
              sealed: hex(corrupted),
              expected: {
                ok: false,
                refusal: { tag: 'ContentError', code: 'bad-content-signature' },
              },
            },
          ],
        };
        const captured = captureLabReadPack(pack);
        for (const resource of ['has space', '文档', 'line\nbreak']) {
          expect(() =>
            captureLabReadPack({ ...captured, reads: [{ ...captured.reads[0]!, resource }] })
          ).toThrow();
        }
        const first = yield* replayLabCapturedReads({
          pack: captured,
          genesis: genesis.genesis,
          checkpoint: point,
          signer: f.owner,
          readEpochKey: key,
        });
        expect(first.verdict).toBe('pass');
        expect(first.observations).toHaveLength(3);
        expect(first.observations[2]!.refusal).toEqual({
          tag: 'ContentError',
          code: 'bad-content-signature',
        });
        expect(captured.reads[0]!.sealed).toBe(reads[0]!.sealed);
        const unrelated = yield* replayLabCapturedReads({
          pack: captured,
          genesis: genesis.genesis,
          checkpoint: point,
          signer: f.owner,
          readEpochKey: () => Effect.fail(new Error('missing fixture capability')),
        });
        expect(unrelated.verdict).toBe('harness-error');
        const disguisedCapabilityFailure = yield* replayLabCapturedReads({
          pack: {
            ...captured,
            reads: [
              {
                ...captured.reads[0]!,
                expected: { ok: false, refusal: { tag: 'ContentError', code: 'missing-read-key' } },
              },
            ],
          },
          genesis: genesis.genesis,
          checkpoint: point,
          signer: f.owner,
          readEpochKey: () => Effect.fail(new Error('unavailable key backend')),
        });
        expect(disguisedCapabilityFailure.verdict).toBe('harness-error');
        let wrongHandle: Bytes.EpochKey | undefined;
        const wrongKey = yield* replayLabCapturedReads({
          pack: {
            ...captured,
            reads: [
              {
                ...captured.reads[0]!,
                expected: {
                  ok: false,
                  refusal: { tag: 'ContentError', code: 'commitment-mismatch' },
                },
              },
            ],
          },
          genesis: genesis.genesis,
          checkpoint: point,
          signer: f.owner,
          readEpochKey: () =>
            Effect.sync(() => {
              const owned = ok(Bytes.epochKey(new Uint8Array(32).fill(185)));
              wrongHandle = owned;
              return owned;
            }),
        });
        expect(wrongKey.verdict).toBe('harness-error');
        expect(Result.isFailure(commitEpochKey(genesis.genesis, 0, wrongHandle!))).toBe(true);
        const transferred = ok(Bytes.epochKey(material));
        const transferredPack = { ...captured, reads: [captured.reads[0]!] };
        const consume = yield* replayLabCapturedReads({
          pack: transferredPack,
          genesis: genesis.genesis,
          checkpoint: point,
          signer: f.owner,
          readEpochKey: () => Effect.succeed(transferred),
        });
        expect(consume.verdict).toBe('pass');
        // The actual public binding disposed its owned input after this read.
        // A provider that returns that same dead handle is a harness failure.
        const disposed = yield* replayLabCapturedReads({
          pack: {
            ...transferredPack,
            reads: [
              {
                ...captured.reads[0]!,
                expected: { ok: false, refusal: { tag: 'EpochKeyError', code: 'invalid-input' } },
              },
            ],
          },
          genesis: genesis.genesis,
          checkpoint: point,
          signer: f.owner,
          readEpochKey: () => Effect.succeed(transferred),
        });
        expect(disposed.verdict).toBe('harness-error');
        const wrongPoint = yield* Effect.result(
          replayLabCapturedReads({
            pack: captured,
            genesis: genesis.genesis,
            checkpoint: { head: f.checkpoint.head, length: 1 },
            signer: f.owner,
            readEpochKey: key,
          })
        );
        expect(Result.isFailure(wrongPoint)).toBe(true);
      })
    )
  );
});

it('owns only bounded JSON data and refuses accessor, old format and missing schedule before replay', () => {
  let accessed = false;
  expect(() =>
    captureLabReadPack({
      get format() {
        accessed = true;
        return 'old';
      },
    })
  ).toThrow();
  expect(accessed).toBe(false);
  expect(() =>
    captureLabReadPack({ format: 'legacy-entropy-pack', syntheticOnly: true })
  ).toThrow();
  expect(() =>
    captureLabActionPack({ version: 1, syntheticOnly: true, run: { observations: [] } })
  ).toThrow();
});

it('reexecutes finite captured action outcomes on fresh actual processes and detects edited observations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-repro-actions-'));
  try {
    const record = join(directory, 'record'),
      replay = join(directory, 'replay'),
      changed = join(directory, 'changed');
    for (const path of [record, replay, changed]) mkdirSync(path);
    const artifact = await Effect.runPromise(
      runLabScenario({
        directory: record,
        actions: [
          { kind: 'start', actor: 'owner', mode: 'create', expect: { ok: true } },
          { kind: 'call', actor: 'owner', operation: 'keys', expect: { ok: true } },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'create',
            document: 'loro',
            expect: { ok: true },
          },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'append',
            document: 'loro',
            text: 'retained action',
            expect: { ok: true },
          },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'observe',
            document: 'loro',
            expect: { ok: true, text: 'retained action' },
          },
        ],
      })
    );
    const rerun = await Effect.runPromise(
      replayLabActions({ sourceDirectory: record, pack: artifact, directory: replay })
    );
    expect(rerun.differences).toEqual([]);
    expect(rerun.matched).toBe(true);
    expect(rerun.reproduced).toBe(true);
    expect(rerun.verdict).toBe('pass');
    expect(rerun.run.observations.at(-1)!.reply.value).toMatchObject({ text: 'retained action' });
    const cli = JSON.parse(
      await Effect.runPromise(
        runOwnedChild([
          '--import',
          'tsx',
          fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
          'replay',
          join(record, 'evidence.json'),
          join(directory, 'cli-replay'),
        ])
      )
    );
    expect(cli.reproduced).toBe(true);
    expect(cli.scope).toBe('captured-original-action-material');
    // Edit an inert artifact, not an actor or verifier. Reexecution must measure
    // the actual text and expose this evidence mismatch.
    const corrupted = JSON.parse(readFileSync(join(record, 'evidence.json'), 'utf8'));
    corrupted.run.observations.at(-1).reply.value.text = 'unwitnessed text';
    const mismatch = await Effect.runPromise(
      replayLabActions({ sourceDirectory: record, pack: corrupted, directory: changed })
    );
    expect(mismatch.matched).toBe(false);
    expect(mismatch.differences.at(-1)?.index).toBe(4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('compares exact measured fault hit counts rather than coarsening every nonzero count to true', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-repro-fault-count-'));
  try {
    const record = join(directory, 'record'),
      replay = join(directory, 'replay');
    mkdirSync(record);
    mkdirSync(replay);
    const artifact = await Effect.runPromise(
      runLabScenario({
        directory: record,
        actions: [
          { kind: 'start', actor: 'owner', mode: 'create', expect: { ok: true } },
          { kind: 'attack', actor: 'owner', attack: 'drop-control-ack', expect: { ok: true } },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'revoke',
            target: 'peer',
            expect: {
              ok: false,
              refusal: { tag: 'LabTransportFault', code: 'dropped-committed-ack' },
            },
          },
        ],
      })
    );
    expect(artifact.run.observations[2]!.reply.trace?.ackDropped).toBe(1);
    const altered = JSON.parse(JSON.stringify(artifact));
    altered.run.observations[2].reply.trace.ackDropped = 2;
    const result = await Effect.runPromise(
      replayLabActions({ sourceDirectory: record, pack: altered, directory: replay })
    );
    expect(result.matched).toBe(false);
    expect(result.differences[0]?.index).toBe(2);
    expect(result.run.observations[2]!.reply.trace?.ackDropped).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('minimizes measured action violations with fresh real trials and refuses an all-pass pack', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-repro-minimize-'));
  try {
    const record = join(directory, 'record');
    mkdirSync(record);
    const artifact = await Effect.runPromise(
      runLabScenario({
        directory: record,
        actions: [
          { kind: 'start', actor: 'owner', mode: 'create', expect: { ok: true } },
          { kind: 'call', actor: 'owner', operation: 'keys', expect: { ok: true } },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'create',
            document: 'loro',
            expect: { ok: true },
          },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'observe',
            document: 'loro',
            expect: { ok: true, text: 'deliberately missing' },
          },
        ],
      })
    );
    expect(artifact.run.verdict).toBe('violation');
    const minimized = await Effect.runPromise(
      minimizeLabActions({
        sourceDirectory: record,
        pack: artifact,
        directory: join(directory, 'trials'),
        maxTrials: 8,
      })
    );
    expect(minimized.originalSize).toBe(4);
    expect(minimized.trials).toBeLessThanOrEqual(8);
    expect(minimized.finalSize).toBeLessThan(4);
    expect(minimized.items.at(-1)?.originalIndex).toBe(3);
    expect(minimized.coverage).toBe('partial');
    const allPass = JSON.parse(JSON.stringify(artifact));
    allPass.run.observations.at(-1).action.expect.text = '';
    const refused = await Effect.runPromise(
      Effect.result(
        minimizeLabActions({
          sourceDirectory: record,
          pack: allPass,
          directory: join(directory, 'no-security'),
        })
      )
    );
    expect(Result.isFailure(refused)).toBe(true);
    if (Result.isFailure(refused))
      expect(refused.failure).toMatchObject({ code: 'not-reproduced' });
    const unwitnessed = JSON.parse(JSON.stringify(artifact));
    unwitnessed.run.observations.at(-1).reply.value.text = 'a different claimed failure';
    const differentFailure = await Effect.runPromise(
      Effect.result(
        minimizeLabActions({
          sourceDirectory: record,
          pack: unwitnessed,
          directory: join(directory, 'unwitnessed'),
        })
      )
    );
    expect(Result.isFailure(differentFailure)).toBe(true);
    if (Result.isFailure(differentFailure))
      expect(differentFailure.failure).toMatchObject({ code: 'not-reproduced' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
