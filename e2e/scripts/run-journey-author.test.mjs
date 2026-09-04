import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertCandidatePathSet,
  buildCodexEnvironment,
  buildCodexExecArgs,
  buildValidationEnvironment,
  createArtifactRoot,
  parseLocalAuthorOptions,
  parseLocalValidationOptions,
  validateMain,
  validationCommandPlan,
} from './run-journey-author.mjs';

void test('keeps author artifacts out of repository source paths and refuses overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lody-author-artifacts-'));
  try {
    await assert.rejects(
      createArtifactRoot(root, join(root, 'e2e/src/support/fixtures'), 'run-1'),
      /must be a direct child/u
    );
    await assert.rejects(
      createArtifactRoot(root, join(tmpdir(), 'outside'), 'run-1'),
      /direct child/u
    );
    const artifactRoot = await createArtifactRoot(root, undefined, 'run-1');
    assert.equal(artifactRoot, join(root, 'e2e/artifacts/journey-author/run-1'));
    await assert.rejects(createArtifactRoot(root, undefined, 'run-1'), /already exists/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('rejects validation side effects outside the packaged candidate', () => {
  assert.doesNotThrow(() =>
    assertCandidatePathSet(' M e2e/journeys/registry.json\0?? e2e/src/features/mcp.feature\0', [
      'e2e/src/features/mcp.feature',
      'e2e/journeys/registry.json',
    ])
  );
  assert.throws(
    () =>
      assertCandidatePathSet(' M e2e/journeys/registry.json\0?? packages/components/leak.ts\0', [
        'e2e/journeys/registry.json',
      ]),
    /paths differ/u
  );
});

void test('requires an explicit human-review acknowledgement for validation', () => {
  assert.deepEqual(
    parseLocalValidationOptions([
      '--',
      '--artifact-dir',
      '/tmp/candidate',
      '--approve-reviewed',
      '--budget-minutes',
      '60',
    ]),
    { artifactDir: '/tmp/candidate', approveReviewed: true, budgetMinutes: 60 }
  );
  assert.throws(() => parseLocalValidationOptions(['--candidate', 'LODY-MCP-001']), /Unknown/u);
});

void test('refuses validation before touching a checkout without human acknowledgement', async () => {
  await assert.rejects(
    validateMain(['--artifact-dir', '/tmp/unreviewed'], '/tmp/not-a-repository'),
    /approve-reviewed/u
  );
});

void test('parses bounded local author options', () => {
  assert.deepEqual(
    parseLocalAuthorOptions([
      '--',
      '--candidate',
      'LODY-MCP-001',
      '--budget-minutes',
      '45',
      '--model',
      'gpt-5.6-sol',
      '--prepare-only',
    ]),
    {
      candidate: 'LODY-MCP-001',
      budgetMinutes: 45,
      model: 'gpt-5.6-sol',
      prepareOnly: true,
    }
  );
  assert.throws(() => parseLocalAuthorOptions(['--budget-minutes', '5']), /15 through 120/u);
  assert.throws(() => parseLocalAuthorOptions(['--publish']), /Unknown option/u);
});

void test('passes only local authentication prerequisites to Codex', () => {
  const environment = buildCodexEnvironment({
    HOME: '/maintainer',
    PATH: '/bin',
    CODEX_HOME: '/maintainer/.codex',
    OPENAI_API_KEY: 'must-not-pass',
    GH_TOKEN: 'must-not-pass',
    LODY_SECRET: 'must-not-pass',
  });
  assert.deepEqual(environment, {
    CODEX_HOME: '/maintainer/.codex',
    HOME: '/maintainer',
    PATH: '/bin',
  });
});

void test('validates reviewed code with an isolated home and no caller secrets', () => {
  const environment = buildValidationEnvironment('/tmp/validation-home', {
    HOME: '/maintainer',
    PATH: '/bin',
    CODEX_HOME: '/maintainer/.codex',
    OPENAI_API_KEY: 'must-not-pass',
    GH_TOKEN: 'must-not-pass',
  });
  assert.deepEqual(environment, {
    PATH: '/bin',
    CI: '1',
    HOME: '/tmp/validation-home',
    TMPDIR: '/tmp/validation-home/tmp',
  });
});

void test('runs the author ephemerally in a writable isolated worktree', () => {
  const args = buildCodexExecArgs({
    model: 'gpt-5.6-sol',
    root: '/tmp/author',
    schemaPath: '/tmp/author/schema.json',
    outputPath: '/tmp/evidence/result.json',
  });
  assert.deepEqual(args, [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--sandbox',
    'workspace-write',
    '--model',
    'gpt-5.6-sol',
    '--config',
    'model_reasoning_effort="high"',
    '--config',
    'sandbox_workspace_write.network_access=false',
    '--config',
    'shell_environment_policy.include_only=["PATH"]',
    '--config',
    'shell_environment_policy.ignore_default_excludes=false',
    '--output-schema',
    '/tmp/author/schema.json',
    '--output-last-message',
    '/tmp/evidence/result.json',
    '--cd',
    '/tmp/author',
    '-',
  ]);
});

void test('keeps three independent focused rounds between build and full regression', () => {
  const plan = validationCommandPlan('LODY-MCP-001');
  assert.deepEqual(
    plan.map((stage) => stage.name),
    [
      'submodules',
      'install',
      'contract',
      'build',
      'focused-1',
      'focused-2',
      'focused-3',
      'full',
      'diff-check',
    ]
  );
  assert.deepEqual(
    plan.filter((stage) => stage.round).map((stage) => stage.round),
    [1, 2, 3]
  );
  assert.ok(plan.slice(1, -1).every((stage) => stage.command === 'pnpm'));
  assert.equal(plan.find((stage) => stage.name === 'focused-1').args.at(-1), '@LODY-MCP-001');
});
