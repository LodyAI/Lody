import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { runLabScenario } from '../src/platform/scenario-runner';
import { type LabAction } from '../src/platform/action-executor';

const good = { ok: true } as const;
const actors = [
  { id: 'owner', role: 'owner' },
  { id: 'writer', role: 'member' },
] as const;
const prefix: readonly LabAction[] = [
  { kind: 'start', actor: 'owner', mode: 'create', expect: good },
  { kind: 'start', actor: 'writer', mode: 'create', expect: good },
  { kind: 'call', actor: 'owner', operation: 'keys', expect: good },
  { kind: 'call', actor: 'writer', operation: 'keys', expect: good },
  { kind: 'call', actor: 'owner', operation: 'create', document: 'loro', expect: good },
  { kind: 'call', actor: 'writer', operation: 'pull', document: 'loro', expect: good },
];
it('keeps a real append owned across plan phases and records both predictions after a concurrent genuine role change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-async-model-'));
  try {
    mkdirSync(join(root, 'baseline'));
    mkdirSync(join(root, 'race'));
    // Discover the exact next native request from a real unchanged prefix. This
    // avoids a timer or assuming how many key-round control reads occur.
    const baseline = await Effect.runPromise(
      runLabScenario({ directory: join(root, 'baseline'), actors, actions: prefix })
    );
    const reads = baseline.measurements.transport.events.filter(
      (row) => row.actor === 'writer' && row.stream === 'control' && row.method === 'GET'
    );
    const target = {
      actor: 'writer',
      stream: 'control' as const,
      method: 'GET' as const,
      occurrence: reads.at(-1)!.occurrence + 1,
    };
    const result = await Effect.runPromise(
      runLabScenario({
        directory: join(root, 'race'),
        actors,
        actions: [
          ...prefix,
          {
            kind: 'transport',
            actor: 'owner',
            action: { kind: 'intercept', target, mutation: { kind: 'delay' } },
            expect: good,
          },
          {
            kind: 'begin-call',
            actor: 'writer',
            id: 'held-append',
            operation: 'append',
            document: 'loro',
            text: 'must-not-reach-backend',
            expect: good,
          },
          {
            kind: 'transport',
            actor: 'owner',
            action: { kind: 'wait-response', target },
            expect: good,
          },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'set-role',
            target: 'writer',
            role: 'guest',
            expect: { ok: true, outcome: 'Committed' },
          },
          { kind: 'call', actor: 'owner', operation: 'acknowledge', expect: good },
          {
            kind: 'transport',
            actor: 'owner',
            action: { kind: 'release-delay', target },
            expect: good,
          },
          {
            kind: 'join-call',
            actor: 'writer',
            id: 'held-append',
            expect: { ok: false, refusal: { tag: 'LabContentError', code: 'unauthorized' } },
          },
          { kind: 'call', actor: 'owner', operation: 'pull', document: 'loro', expect: good },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'observe',
            document: 'loro',
            expect: { ok: true, text: '' },
          },
        ],
      })
    );
    const joined = result.measurements.modelMeasurements[12]!;
    expect(joined.concurrent?.action).toMatchObject({
      actor: 'writer',
      kind: 'call',
      operation: 'append',
    });
    expect(joined.concurrent?.before.expected).toBe('allow');
    expect(joined.concurrent?.atJoin.expected).toBe('deny');
    expect(joined.concurrent?.beforePoint.length).toBe(2);
    expect(joined.concurrent?.joinPoint.length).toBe(3);
    expect(joined.verdict).toBe('unavailable');
    expect(result.run.observations[12]!.integrity).toBe('pass');
    expect(result.run.observations[14]!.durability).toBe('pass');
    expect(result.measurements.transport.hits).toContainEqual({
      id: JSON.stringify(['writer', 'control', 'GET', target.occurrence]),
      kind: 'delay',
    });
    expect(
      result.measurements.transport.events.some(
        (row) => row.actor === 'writer' && row.stream === 'loro' && row.method === 'POST'
      )
    ).toBe(false);
    expect(result.originals).toHaveLength(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
