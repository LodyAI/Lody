import test from 'node:test';
import assert from 'node:assert/strict';
import { tabOwner } from '../../../../packages/cloud-runtime/src/runtime/directory-tab.ts';

test('a tab resolves the root and only inherits directory context', () => {
  const rows = new Map([
    [
      'root',
      {
        machineId: 'm',
        project: { kind: 'local', localProjectId: 'p' },
        agentConfigId: 'a',
        cliType: 'builtin',
        agentType: 'codex',
        resume: 'must-not-copy',
      },
    ],
    ['child', { parentSessionId: 'root', machineId: 'm' }],
  ]);
  assert.equal(tabOwner('child', (id) => rows.get(id)).id, 'root');
  assert.throws(() => tabOwner('missing', (id) => rows.get(id)));
  rows.set('root', { parentSessionId: 'child' });
  assert.throws(() => tabOwner('child', (id) => rows.get(id)));
});
