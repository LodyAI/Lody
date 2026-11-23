import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { runLabScenario } from '../src/platform/scenario-runner';
import type { LabAction } from '../src/platform/action-executor';
it.each(['member-removal', 'device-revocation'] as const)(
  'measures %s with retained old keys against real later ciphertext, forged control and wrong-context writes',
  async (exclusion) => {
    const directory = mkdtempSync(join(tmpdir(), 'lab-plan-properties-'));
    const good = { ok: true } as const;
    const actions: LabAction[] = [
      { kind: 'start', actor: 'owner', mode: 'create', expect: good },
      { kind: 'start', actor: 'insider', mode: 'create', expect: good },
      { kind: 'start', actor: 'guest', mode: 'create', expect: good },
      ...['owner', 'insider', 'guest'].map((actor) => ({
        kind: 'call' as const,
        actor,
        operation: 'keys' as const,
        expect: good,
      })),
      { kind: 'call', actor: 'owner', operation: 'create', document: 'loro', expect: good },
      {
        kind: 'call',
        actor: 'owner',
        operation: 'append',
        document: 'loro',
        text: 'original epoch zero long positive control',
        expect: good,
      },
      { kind: 'call', actor: 'insider', operation: 'pull', document: 'loro', expect: good },
      {
        kind: 'call',
        actor: 'insider',
        operation: 'observe',
        document: 'loro',
        expect: { ok: true, text: 'original epoch zero long positive control' },
      },
      { kind: 'crash', actor: 'insider', expect: good },
      ...(exclusion === 'member-removal'
        ? [
            {
              kind: 'call' as const,
              actor: 'owner',
              operation: 'remove-member-and-rotate' as const,
              target: 'insider',
              expect: { ok: true, outcome: 'Committed' as const },
            },
          ]
        : [
            {
              kind: 'call' as const,
              actor: 'owner',
              operation: 'revoke' as const,
              target: 'insider',
              expect: good,
            },
            {
              kind: 'call' as const,
              actor: 'owner',
              operation: 'acknowledge' as const,
              expect: good,
            },
            {
              kind: 'call' as const,
              actor: 'owner',
              operation: 'rotate-epoch' as const,
              expect: { ok: true, outcome: 'Committed' as const },
            },
          ]),
      { kind: 'call', actor: 'owner', operation: 'acknowledge-epoch-rotation', expect: good },
      {
        kind: 'call',
        actor: 'owner',
        operation: 'append',
        document: 'loro',
        text: ' protected epoch one after member removal',
        expect: good,
      },
      { kind: 'call', actor: 'guest', operation: 'keys', expect: good },
      { kind: 'call', actor: 'guest', operation: 'pull', document: 'loro', expect: good },
      {
        kind: 'call',
        actor: 'guest',
        operation: 'observe',
        document: 'loro',
        expect: {
          ok: true,
          text: 'original epoch zero long positive control protected epoch one after member removal',
        },
      },
      {
        kind: 'measure',
        actor: 'insider',
        probes: [
          'insider-post-exclusion',
          'wrong-context',
          'unauthorized-writer',
          'forged-control',
        ],
        expect: good,
      },
    ];
    try {
      const artifact = await Effect.runPromise(
        runLabScenario({
          directory,
          actors: [
            { id: 'owner', role: 'owner' },
            exclusion === 'member-removal'
              ? { id: 'insider', role: 'member', behavior: 'insider' }
              : { id: 'insider', role: 'owner', memberOf: 'owner', behavior: 'insider' },
            { id: 'guest', role: 'guest' },
          ],
          actions,
        })
      );
      expect(artifact.run.observations.filter((row) => !row.reply.ok)).toEqual([]);
      for (const id of [
        'confidentiality.backend-plaintext',
        'confidentiality.insider-post-exclusion',
        'confidentiality.excluded-device-and-member',
        'integrity.forged-control',
        'integrity.full-ledger-verification',
        'integrity.wrong-context',
        'integrity.unauthorized-writer',
        'integrity.author-write-permission',
        'durability.cursor-boundary-and-no-rollback',
        'durability.committed-rotation-complete-group',
      ])
        expect(
          artifact.run.properties.find((row) => row.id === id),
          id
        ).toMatchObject({ verdict: 'pass' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  0
);
