import assert from 'node:assert/strict';
import test from 'node:test';
import { auditLegacyCloudSource } from './check-legacy-cloud-access.mjs';

const file = 'packages/components/src/new-surface.tsx';
test('rejects ordinary hooks, imperative calls, and escaped references to new legacy APIs', () => {
  for (const expression of [
    'useCloudQuery(api.promptShortcuts.listAccessibleDocuments, { workspaceId })',
    'client.mutation(api.github.newLegacyMutation, { workspaceId })',
    'client.query(api["machines"]["listVisibleMachines"], { workspaceId })',
    'api.github.getWorkspaceRepositories',
    'client.query("usage:newLegacyQuery", { workspaceId })',
  ]) {
    const result = auditLegacyCloudSource(
      file,
      `import { api } from '@lody/cloud-api';\nconst value = ${expression};`
    );
    assert.equal(result.errors.length, 1, expression);
    assert.equal(result.rows[0].protection, 'UNGUARDED');
  }
});

test('accepts only the owning admission wrappers, including real import aliases', () => {
  const result = auditLegacyCloudSource(
    file,
    `
    import { cloudOperations as operations } from '@/lib/cloud-api-operations';
    import { useLegacyWorkspaceQuery as read, useLegacyWorkspaceMutation as write, useLegacyWorkspaceAction as act } from '@/hooks/use-legacy-workspace-query';
    read(operations.promptShortcuts.listAccessibleDocuments, { workspaceId });
    write(operations.github.setRepoEnabled);
    act(operations.github.createGitHubInstallState);
  `
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 3);
  assert.ok(result.rows.every((row) => row.protection === 'shared admission wrapper'));
  const forged = auditLegacyCloudSource(
    file,
    `
    import { cloudOperations } from '@/lib/cloud-api-operations';
    import { useCloudQuery as useLegacyWorkspaceQuery } from '@lody/platform/react';
    useLegacyWorkspaceQuery(cloudOperations.github.getWorkspaceRepositories, { workspaceId });
  `
  );
  assert.equal(forged.errors.length, 1);
});

test('keeps supported control APIs and harmless protocol-name comparisons separate', () => {
  const result = auditLegacyCloudSource(
    file,
    `
    import { cloudOperations } from '@/lib/cloud-api-operations';
    useCloudQuery(cloudOperations.billing.getWorkspaceBillingEntitlement, { workspaceId });
    useCloudQuery(cloudOperations.e2eeWorkspaces.describe, { workspaceId });
    const name = cloudOperations.machines.listVisibleMachines.name;
    useCloudQuery(cloudOperations.auth.getUserById, { workspaceId, userId });
  `
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 1);
  assert.match(result.rows[0].protection, /returns null/);
});

test('an audited adapter exception never permits another endpoint or another client entry', () => {
  const source = `import { api } from '@lody/cloud-api'; client.action(api.github.getAccessTokenByRepoNameForClient, input);`;
  assert.deepEqual(
    auditLegacyCloudSource('packages/components/src/providers/cloud-github-token-port.ts', source)
      .errors,
    []
  );
  assert.equal(auditLegacyCloudSource(file, source).errors.length, 1);
  assert.equal(
    auditLegacyCloudSource(
      'packages/components/src/providers/cloud-github-token-port.ts',
      source.replace('getAccessTokenByRepoNameForClient', 'newUnsafeAction')
    ).errors.length,
    1
  );
});

test('rejects namespace imports and module destructuring that bypass a normal import spelling', () => {
  for (const source of [
    `import * as backend from '@lody/cloud-api'; useCloudQuery(backend.api.github.getWorkspaceRepositories, { workspaceId });`,
    `import { api } from '@lody/cloud-api'; const { github } = api;`,
    `import { api } from '@lody/cloud-api'; const github = api.github;`,
    `import { api } from '@lody/cloud-api'; client.query(api[namespace][operation], input);`,
  ])
    assert.ok(auditLegacyCloudSource(file, source).errors.length > 0);
});

test('recognizes registry namespace imports at both raw and guarded call sites', () => {
  const raw = auditLegacyCloudSource(
    file,
    `
    import * as registry from '@/lib/cloud-api-operations';
    useCloudQuery(registry.cloudOperations.github.getWorkspaceRepositories, { workspaceId });
  `
  );
  assert.equal(raw.errors.length, 1);
  assert.equal(raw.rows[0].name, 'github:getWorkspaceRepositories');
  const guarded = auditLegacyCloudSource(
    file,
    `
    import * as registry from '@/lib/cloud-api-operations';
    import { useLegacyWorkspaceQuery } from '@/hooks/use-legacy-workspace-query';
    useLegacyWorkspaceQuery(registry.cloudOperations.github.getWorkspaceRepositories, { workspaceId });
  `
  );
  assert.deepEqual(guarded.errors, []);
  assert.equal(guarded.rows.length, 1);
  assert.equal(guarded.rows[0].protection, 'shared admission wrapper');
  for (const expression of [
    'registry.cloudOperations[namespace][operation]',
    'registry.cloudOperations.github',
    'registry.cloudOperations',
  ]) {
    assert.ok(
      auditLegacyCloudSource(
        file,
        `import * as registry from '@/lib/cloud-api-operations'; const escaped = ${expression};`
      ).errors.length > 0
    );
  }
});

test('rejects legacy references constructed through renamed Convex factories', () => {
  for (const source of [
    `import { makeFunctionReference as reference } from 'convex/server'; client.query(reference('github:getWorkspaceRepositories'), input);`,
    `import * as server from 'convex/server'; const reference = server.makeFunctionReference; reference('machines:listVisibleMachines');`,
    `import { makeFunctionReference as makeRef } from 'convex/server'; const reference = makeRef; reference('promptShortcuts:listAccessibleDocuments');`,
  ])
    assert.equal(auditLegacyCloudSource(file, source).errors.length, 1, source);
  const control = auditLegacyCloudSource(
    file,
    `import { makeFunctionReference as reference } from 'convex/server'; reference('e2eeWorkspaces:describe');`
  );
  assert.deepEqual(control.errors, []);
  assert.deepEqual(control.rows, []);
});
