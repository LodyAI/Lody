import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditExternalBoundarySource,
  auditExternalBoundaryTree,
} from './check-external-boundary-decode.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('repository external boundary files pass the decode guard', () => {
  const { checked, errors } = auditExternalBoundaryTree(repoRoot);
  assert.ok(checked >= 7);
  assert.deepEqual(errors, []);
});

test('flags bare type assertions on unwrapData / response.data in auth boundaries', () => {
  const { errors } = auditExternalBoundarySource(
    'apps/electron/src/renderer/src/auth-query-generation.ts',
    `const data = ((unwrapData(response) as TData | null | undefined) ?? null) as TData | null;`
  );
  assert.equal(errors.length, 2);
  assert.match(errors[0], /bare type assertion/);
});

test('flags createAuthQueryStore calls without a decode option in electron auth.ts', () => {
  const { errors } = auditExternalBoundarySource(
    'apps/electron/src/renderer/src/auth.ts',
    `const orgs = createAuthQueryStore('listOrganizations', async () => getAuthApi().listOrganizations());`
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must provide a runtime decode option/);
});

test('flags bare Result assertions in cloud-platform-api.ts outside decodeCloudResult', () => {
  const { errors } = auditExternalBoundarySource(
    'packages/components/src/providers/cloud-platform-api.ts',
    `function useBad<Result>(v: unknown): Result { return v as Result; }`
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /bypasses decodeCloudResult/);
});

test('flags router.tsx missing defaultErrorComponent', () => {
  const { errors } = auditExternalBoundarySource(
    'packages/components/src/router.tsx',
    `export const createRouter = () => createTanstackRouter({ routeTree });`
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /defaultErrorComponent/);
});
