import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { runLabScenario } from '../src/platform/scenario-runner';

import type { LabAction } from '../src/platform/action-executor';
import type { LabActorConfiguration } from '../src/pure/actor-config';
const good = { ok: true } as const;
const actors: readonly LabActorConfiguration[] = [
  { id: 'warden', role: 'owner' },
  { id: 'captain', role: 'admin', behavior: 'noncompliant-manager' },
  { id: 'editor', role: 'member' },
  { id: 'visitor', role: 'guest' },
  { id: 'rescue', role: 'owner', kind: 'recovery', memberOf: 'warden' },
  { id: 'retired', role: 'owner', kind: 'machine', memberOf: 'warden' },
];
it('runs configurable Owner/Admin/Member/Guest and R devices, merges four parties and stages a genuine revoke-triggered rotation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-n-actors-'));
  try {
    const actions: LabAction[] = [];
    for (const actor of ['warden', 'captain', 'editor', 'visitor', 'rescue'])
      actions.push({ kind: 'start', actor, mode: 'create', expect: good });
    for (const actor of ['warden', 'captain', 'editor', 'visitor', 'rescue'])
      actions.push({ kind: 'call', actor, operation: 'keys', expect: good });
    actions.push({
      kind: 'call',
      actor: 'warden',
      operation: 'create',
      document: 'loro',
      expect: good,
    });
    for (const actor of ['warden', 'captain', 'editor'])
      actions.push(
        { kind: 'call', actor, operation: 'pull', document: 'loro', expect: good },
        {
          kind: 'call',
          actor,
          operation: 'append',
          document: 'loro',
          text: `${actor};`,
          expect: good,
        }
      );
    for (const actor of ['warden', 'captain', 'editor', 'visitor'])
      actions.push(
        { kind: 'call', actor, operation: 'pull', document: 'loro', expect: good },
        {
          kind: 'call',
          actor,
          operation: 'observe',
          document: 'loro',
          expect: { ok: true, text: 'warden;captain;editor;' },
        }
      );
    actions.push(
      { kind: 'call', actor: 'warden', operation: 'revoke', target: 'retired', expect: good },
      { kind: 'call', actor: 'warden', operation: 'acknowledge', expect: good },
      {
        kind: 'call',
        actor: 'captain',
        operation: 'rotate-epoch',
        expect: { ok: true, outcome: 'Committed' },
      },
      { kind: 'call', actor: 'captain', operation: 'acknowledge-epoch-rotation', expect: good }
    );
    for (const actor of ['warden', 'captain', 'editor', 'visitor', 'rescue'])
      actions.push({ kind: 'call', actor, operation: 'keys', expect: good });
    actions.push(
      {
        kind: 'call',
        actor: 'editor',
        operation: 'append',
        document: 'loro',
        text: 'epoch1;',
        expect: good,
      },
      { kind: 'call', actor: 'visitor', operation: 'pull', document: 'loro', expect: good },
      {
        kind: 'call',
        actor: 'visitor',
        operation: 'observe',
        document: 'loro',
        expect: { ok: true, text: 'warden;captain;editor;epoch1;' },
      }
    );
    const result = await Effect.runPromise(runLabScenario({ directory, actors, actions }));
    const failures = result.run.observations.filter((row) => !row.reply.ok);
    expect(failures).toEqual([]);
    expect(result.run.verdict).toBe('pass');
    expect(Object.keys(result.identity)).toHaveLength(6);
    expect(
      result.run.properties.find((row) => row.id === 'durability.committed-rotation-complete-group')
        ?.verdict
    ).toBe('pass');
    expect(statSync(join(directory, 'private-replay/material.json')).mode & 0o777).toBe(0o600);
    const publicEvidence = readFileSync(join(directory, 'evidence.json'), 'utf8');
    expect(publicEvidence).not.toContain('"signing":');
    expect(publicEvidence).not.toContain('"encryption":');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
