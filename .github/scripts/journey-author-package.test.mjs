import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { journeyFingerprint, renderCoverage } from '../../e2e/scripts/journey-registry.mjs';
import {
  applyAblation,
  matchesAllowedPath,
  packageCandidate,
  promoteCandidate,
  restoreAblation,
} from './journey-author-package.mjs';

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fixture() {
  const journey = {
    id: 'LODY-TEST-001',
    state: 'backlog',
    priority: 'P1',
    runtime: 'none',
    title: 'Exercise a synthetic visible outcome',
    owner: 'test',
    fixture: 'synthetic',
    ownerPaths: ['e2e/src/features/'],
    actions: [{ id: 'test.open' }],
    checkpoints: ['visible outcome'],
    cleanup: ['desktop exits'],
    coverage: {
      renderer: 'Test UI',
      electronIpc: 'Real IPC',
      bundledCli: 'Real CLI',
      durableState: 'Synthetic state',
      externalWire: 'None',
    },
    gap: 'No journey exists.',
    evidence: ['e2e/src/features/onboarding.feature'],
    signals: { criticality: 3, boundaryRisk: 3, changeFrequency: 3, escapedDefect: false },
    estimatedMinutes: 4,
    freshness: 3,
    scoutJourneys: [],
    blockedReason: null,
  };
  journey.fingerprint = journeyFingerprint(journey);
  const taskCore = {
    schemaVersion: 1,
    kind: 'lody-e2e-journey-author-task',
    disposition: 'claimed',
    baseSha: 'a'.repeat(40),
    candidate: journey,
    claim: { leaseId: 'lease' },
  };
  const task = { ...taskCore, digest: digest(taskCore) };
  const featureContent =
    '# language: zh-CN\n@lody @P1 @essence @runtime-none @LODY-TEST-001\n功能: Test\n\n  场景: Test outcome\n    那么 visible outcome\n';
  const pageContent = 'export const expected = "visible outcome";\n';
  const files = [
    {
      path: 'e2e/src/features/test.feature',
      content: featureContent,
      bytes: Buffer.byteLength(featureContent),
      sha256: createHash('sha256').update(featureContent).digest('hex'),
    },
    {
      path: 'e2e/src/support/pages/test-page.ts',
      content: pageContent,
      bytes: Buffer.byteLength(pageContent),
      sha256: createHash('sha256').update(pageContent).digest('hex'),
    },
  ];
  const candidateCore = {
    schemaVersion: 1,
    kind: 'lody-e2e-journey-candidate',
    status: 'ready',
    taskDigest: task.digest,
    candidateId: journey.id,
    fingerprint: journey.fingerprint,
    baseSha: task.baseSha,
    leaseId: 'lease',
    title: journey.title,
    ablation: {
      path: 'e2e/src/support/pages/test-page.ts',
      search: '"visible outcome"',
      replacement: '"__LODY_COUNTERFACTUAL_LODY_TEST_001__"',
      expectedFailure: '__LODY_COUNTERFACTUAL_LODY_TEST_001__',
    },
    files,
  };
  return {
    journey,
    task,
    candidate: { ...candidateCore, digest: digest(candidateCore) },
  };
}

void test('allows only the documented author boundary', () => {
  for (const path of [
    'e2e/src/features/session.feature',
    'e2e/src/steps/session.steps.ts',
    'e2e/src/support/pages/session.ts',
    'e2e/src/support/fixtures/session.json',
    'e2e/src/features/README.md',
    'e2e/src/steps/README.md',
    'e2e/src/support/README.md',
  ])
    assert.equal(matchesAllowedPath(path), true, path);
});

void test('rejects product, broad support, policy, and owner paths', () => {
  for (const path of [
    'apps/electron/src/main.ts',
    'e2e/src/support/world.ts',
    'e2e/README.md',
    'e2e/COVERAGE.md',
    'e2e/journeys/registry.json',
    '.github/workflows/ci.yml',
  ])
    assert.equal(matchesAllowedPath(path), false, path);
});

void test('promotes only the claimed row and regenerates coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lody-journey-package-'));
  try {
    const { journey, task, candidate } = fixture();
    const registry = {
      schemaVersion: 1,
      scoring: {
        criticality: 100,
        boundaryRisk: 20,
        changeFrequency: 5,
        freshness: 5,
        escapedDefect: 40,
        scoutSignal: 35,
        changedPath: 50,
        estimatedMinutePenalty: 2,
      },
      journeys: [journey],
    };
    await mkdir(join(root, 'e2e/journeys'), { recursive: true });
    await writeFile(
      join(root, 'e2e/journeys/registry.json'),
      `${JSON.stringify(registry, null, 2)}\n`
    );
    const promoted = await promoteCandidate({ root, task, candidate });
    const actualRegistry = JSON.parse(
      await readFile(join(root, 'e2e/journeys/registry.json'), 'utf8')
    );
    assert.equal(actualRegistry.journeys[0].state, 'active');
    assert.equal(actualRegistry.journeys[0].feature, 'src/features/test.feature');
    assert.equal(
      await readFile(join(root, 'e2e/COVERAGE.md'), 'utf8'),
      renderCoverage(actualRegistry)
    );
    assert.deepEqual(
      promoted.files.map((file) => file.path),
      [
        'e2e/COVERAGE.md',
        'e2e/journeys/registry.json',
        'e2e/src/features/test.feature',
        'e2e/src/support/pages/test-page.ts',
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('applies and exactly restores the bounded counterfactual', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lody-journey-ablation-'));
  try {
    const { task, candidate } = fixture();
    const target = join(root, candidate.ablation.path);
    await mkdir(join(root, 'e2e/src/support/pages'), { recursive: true });
    await writeFile(
      target,
      candidate.files.find((file) => file.path === candidate.ablation.path).content
    );
    await applyAblation({ root, task, candidate });
    assert.match(await readFile(target, 'utf8'), /__LODY_COUNTERFACTUAL_LODY_TEST_001__/u);
    await restoreAblation({ root, task, candidate });
    assert.equal(
      await readFile(target, 'utf8'),
      candidate.files.find((file) => file.path === candidate.ablation.path).content
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('packages one structured journey and rejects a pre-seeded sentinel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lody-journey-author-'));
  try {
    const { task, candidate: expected } = fixture();
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    for (const file of expected.files) {
      await mkdir(join(root, file.path, '..'), { recursive: true });
      await writeFile(join(root, file.path), file.content);
    }
    const finalMessage = JSON.stringify({
      status: 'ready',
      failureClass: 'none',
      summary: 'One synthetic journey is ready.',
      ablation: expected.ablation,
    });
    const candidate = await packageCandidate({ root, task, finalMessage });
    assert.equal(candidate.status, 'ready');
    assert.deepEqual(
      candidate.files.map((file) => file.path),
      expected.files.map((file) => file.path)
    );

    const pagePath = join(root, expected.ablation.path);
    await writeFile(
      pagePath,
      `${expected.files.find((file) => file.path === expected.ablation.path).content}// ${expected.ablation.expectedFailure}\n`
    );
    const seeded = await packageCandidate({ root, task, finalMessage });
    assert.equal(seeded.status, 'blocked');
    assert.equal(seeded.classification.code, 'test-capability');
    assert.match(seeded.classification.summary, /validator-only/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
