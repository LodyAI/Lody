import { mkdtempSync, rmSync } from 'node:fs';

import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Effect } from 'effect';

import { expect, it } from 'vitest';
import { runLabScenario } from '../src/platform/scenario-runner';

it('keeps real offline edits across SIGKILL and flushes them through the finite process action interface', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-offline-actions-'));
  try {
    const artifact = await Effect.runPromise(
      runLabScenario({
        directory: root,
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
            operation: 'edit-offline',
            document: 'loro',
            text: 'durable offline action',
            expect: { ok: true },
          },
          { kind: 'crash', actor: 'owner', expect: { ok: true } },
          { kind: 'start', actor: 'owner', mode: 'open', expect: { ok: true } },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'flush-offline',
            document: 'loro',
            expect: { ok: true },
          },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'pull',
            document: 'loro',
            expect: { ok: true },
          },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'observe',
            document: 'loro',
            expect: { ok: true, text: 'durable offline action' },
          },
        ],
      })
    );
    expect(artifact.run.verdict).toBe('pass');
    expect(artifact.run.observations.at(-1)!.reply.value).toMatchObject({
      text: 'durable offline action',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('executes all finite kinds on real OS/HPKE/SQLite/SDK actors; bad cipher/storage retain the measured durable pair and lost ACK retries original bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-action-complete-'));
  try {
    const artifact = await Effect.runPromise(runLabScenario({ directory: root }));
    expect(artifact.run.verdict).toBe('pass');
    expect(artifact.run.observations).toHaveLength(39);
    expect(artifact.run.observations[18]!.reply.error).toEqual({
      tag: 'LabContentError',
      code: 'decrypt_failed',
    });
    expect(artifact.run.observations[38]!.reply.ok).toBe(true);
    expect(artifact.measurements.modelMeasurements).toHaveLength(39);
    expect(
      artifact.measurements.modelMeasurements.every(
        (row) => row.prediction.rule !== 'unknown-action'
      )
    ).toBe(true);
    expect(artifact.measurements.modelMeasurements.some((row) => row.verdict === 'violation')).toBe(
      false
    );
    expect(artifact.run.observations[18]!.reply.trace!.cipherChanged).toBeGreaterThan(0);
    expect(artifact.run.observations[32]!.reply.trace!.ackDropped).toBe(1);
    expect(artifact.run.observations[19]!.durability).toBe('pass');
    expect(artifact.run.observations[26]!.reply.ok).toBe(false);
    expect(artifact.run.observations[27]!.durability).toBe('pass');
    expect(artifact.run.observations[35]!.reply.value).toEqual({
      outcome: 'Committed',
      recordHex: artifact.originals[2]!.hex,
    });
    expect(artifact.originals).toHaveLength(3); // resume did not append/re-sign another record
    expect(
      artifact.ciphertext.every((stream) => stream.status === 200 && stream.bodyHex.length > 0)
    ).toBe(true);
    expect(artifact.run.coverage.exactCiphertextReplay).toBe('unavailable');
    expect(artifact.measurements.writerMeasurements).toHaveLength(3);
    expect(
      artifact.measurements.writerMeasurements.every(
        (row) => row.expected === 'allow' && row.accepted
      )
    ).toBe(true);
    expect(artifact.measurements.attacks.properties).toContainEqual({
      id: 'confidentiality.backend-plaintext',
      verdict: 'pass',
    });
    expect(artifact.measurements.attacks.properties).toContainEqual({
      id: 'confidentiality.insider-post-exclusion',
      verdict: 'unavailable',
    });
    expect(artifact.report.confidentiality).toBe('unavailable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
