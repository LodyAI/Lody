import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionBoundaryViolations } from './check-session-data-boundary.mjs';
test('rejects old calls, computed access and destructuring in CLI business code', () => {
  for (const source of [
    'doc.updateHistory(fn)',
    'doc["getHistory"]()',
    'const {getHistory:read}=doc',
    'doc.mirror.subscribe(cb)',
  ])
    assert.equal(sessionBoundaryViolations('apps/cli/src/session/example.ts', source).length, 1);
});
test('keeps session storage construction and UI writers behind the port', () => {
  assert.equal(
    sessionBoundaryViolations(
      'packages/components/src/hooks/example.ts',
      'store.historyWriter.read(id)'
    ).length,
    1
  );
  assert.equal(
    sessionBoundaryViolations(
      'apps/cli/src/session/example.ts',
      "import {createLoroSessionData as make} from '@lody/shared/session-data'"
    ).length,
    1
  );
  assert.deepEqual(
    sessionBoundaryViolations(
      'apps/cli/src/lib/loro/doc.ts',
      "import {createLoroSessionData} from '@lody/shared/session-data'; doc.mirror.subscribe(cb)"
    ),
    []
  );
  assert.deepEqual(
    sessionBoundaryViolations(
      'packages/components/src/hooks/example.ts',
      'await store.sessionData.history.readTurn(id)'
    ),
    []
  );
});
test('public domain types cannot import the storage schema', () => {
  assert.equal(
    sessionBoundaryViolations(
      'packages/shared/src/session-data/types.ts',
      "import type {SessionHistoryInput} from '../schema'"
    ).length,
    1
  );
});
