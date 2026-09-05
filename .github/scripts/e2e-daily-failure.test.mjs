import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { prepareDailyFailureReport } from './e2e-daily-failure.mjs';

const RUN = {
  runId: '123456',
  runUrl: 'https://github.com/LodyAI/Lody/actions/runs/123456',
  headSha: 'a'.repeat(40),
};

async function withWorkspace(callback) {
  const workspace = await mkdtemp(join(tmpdir(), 'lody-daily-failure-'));
  try {
    await callback(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function writeFailures(workspace, ids) {
  const root = join(workspace, 'daily-evidence');
  await mkdir(root, { recursive: true });
  const entries = [];
  for (const id of ids) {
    const path = `scenarios/${id.toLowerCase()}`;
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, 'failure.webm'), `video:${id}`);
    entries.push({ stableId: id, path });
  }
  await writeFile(join(root, 'failure-index.json'), `${JSON.stringify(entries)}\n`);
  return root;
}

void test('builds one inline player per failed scenario', async () => {
  await withWorkspace(async (workspace) => {
    const ids = ['LODY-SESSION-001', 'LODY-WORK-001'];
    const evidenceRoot = await writeFailures(workspace, ids);
    const result = await prepareDailyFailureReport({
      ...RUN,
      evidenceRoot,
      outputRoot: join(workspace, 'daily-report'),
      workingDirectory: workspace,
    });
    assert.equal(result.videos.length, 2);
    assert.equal(result.batches.length, 2);
    assert.deepEqual(
      result.batches.map((batch) => batch.videos),
      [
        ['daily-evidence/scenarios/lody-session-001/failure.webm'],
        ['daily-evidence/scenarios/lody-work-001/failure.webm'],
      ]
    );
    for (const batch of result.batches) {
      const body = await readFile(join(workspace, batch.bodyPath), 'utf8');
      assert.match(body, new RegExp(`!\\[\\]\\(${batch.videos[0]}\\)`));
    }
  });
});

void test('deduplicates repeated failure-index rows from the same scenario', async () => {
  await withWorkspace(async (workspace) => {
    const id = 'LODY-SESSION-001';
    const evidenceRoot = await writeFailures(workspace, [id]);
    const duplicate = { stableId: id, path: `scenarios/${id.toLowerCase()}` };
    await writeFile(
      join(evidenceRoot, 'failure-index.json'),
      `${JSON.stringify([duplicate, duplicate])}\n`
    );
    const result = await prepareDailyFailureReport({
      ...RUN,
      evidenceRoot,
      outputRoot: join(workspace, 'daily-report'),
      workingDirectory: workspace,
    });
    assert.equal(result.failures.length, 1);
    assert.equal(result.videos.length, 1);
  });
});

void test('gives every recording an independently retryable comment', async () => {
  await withWorkspace(async (workspace) => {
    const ids = Array.from(
      { length: 51 },
      (_, index) => `LODY-BATCH-${String(index + 1).padStart(3, '0')}`
    );
    const evidenceRoot = await writeFailures(workspace, ids);
    const result = await prepareDailyFailureReport({
      ...RUN,
      evidenceRoot,
      outputRoot: join(workspace, 'daily-report'),
      workingDirectory: workspace,
    });
    assert.equal(result.batches.length, 51);
    assert.equal(
      result.batches.every((batch) => batch.videos.length === 1),
      true
    );
    assert.notEqual(result.batches[0].marker, result.batches[1].marker);
  });
});

void test('reports missing and oversized videos without attaching them', async () => {
  await withWorkspace(async (workspace) => {
    const evidenceRoot = await writeFailures(workspace, ['LODY-SESSION-001', 'LODY-WORK-001']);
    await writeFile(
      join(evidenceRoot, 'scenarios/lody-session-001/failure.webm'),
      'too-large-for-test'
    );
    await rm(join(evidenceRoot, 'scenarios/lody-work-001/failure.webm'));
    const result = await prepareDailyFailureReport({
      ...RUN,
      evidenceRoot,
      outputRoot: join(workspace, 'daily-report'),
      workingDirectory: workspace,
      maxVideoBytes: 4,
    });
    assert.equal(result.videos.length, 0);
    assert.deepEqual(
      result.omitted.map((entry) => entry.stableId),
      ['LODY-SESSION-001', 'LODY-WORK-001']
    );
    assert.equal(result.batches.length, 1);
  });
});

void test('rejects a video that resolves outside the evidence root', async () => {
  await withWorkspace(async (workspace) => {
    const evidenceRoot = await writeFailures(workspace, ['LODY-SESSION-001']);
    const videoPath = join(evidenceRoot, 'scenarios/lody-session-001/failure.webm');
    await rm(videoPath);
    const outside = join(workspace, 'outside.webm');
    await writeFile(outside, 'video');
    await symlink(outside, videoPath);
    const result = await prepareDailyFailureReport({
      ...RUN,
      evidenceRoot,
      outputRoot: join(workspace, 'daily-report'),
      workingDirectory: workspace,
    });
    assert.equal(result.videos.length, 0);
    assert.equal(result.omitted[0].reason, 'failure.webm is not a regular file');
  });
});

void test('rejects a video reached through a symbolic-link directory', async () => {
  await withWorkspace(async (workspace) => {
    const evidenceRoot = join(workspace, 'daily-evidence');
    const outside = join(workspace, 'outside');
    await mkdir(join(evidenceRoot, 'scenarios'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, 'failure.webm'), 'video');
    await symlink(outside, join(evidenceRoot, 'scenarios/lody-session-001'));
    await writeFile(
      join(evidenceRoot, 'failure-index.json'),
      `${JSON.stringify([{ stableId: 'LODY-SESSION-001', path: 'scenarios/lody-session-001' }])}\n`
    );
    const result = await prepareDailyFailureReport({
      ...RUN,
      evidenceRoot,
      outputRoot: join(workspace, 'daily-report'),
      workingDirectory: workspace,
    });
    assert.equal(result.videos.length, 0);
    assert.equal(result.omitted[0].reason, 'failure.webm is not a regular file');
  });
});

void test('creates a report for infrastructure failures without a failure index', async () => {
  await withWorkspace(async (workspace) => {
    const result = await prepareDailyFailureReport({
      ...RUN,
      evidenceRoot: join(workspace, 'daily-evidence'),
      outputRoot: join(workspace, 'daily-report'),
      workingDirectory: workspace,
    });
    assert.equal(result.videos.length, 0);
    assert.equal(result.omitted[0].reason, 'failure-index.json is missing');
    const body = await readFile(join(workspace, result.batches[0].bodyPath), 'utf8');
    assert.match(body, /failure-index\.json is missing/u);
  });
});

void test('builds PR-specific markers and failure copy', async () => {
  await withWorkspace(async (workspace) => {
    const evidenceRoot = await writeFailures(workspace, ['LODY-REVIEW-001']);
    const result = await prepareDailyFailureReport({
      ...RUN,
      evidenceRoot,
      outputRoot: join(workspace, 'pr-report'),
      workingDirectory: workspace,
      channel: 'pr',
      suite: 'full',
    });
    const body = await readFile(join(workspace, result.batches[0].bodyPath), 'utf8');
    assert.match(body, /desktop-e2e-pr-failure-run:123456:video:LODY-REVIEW-001/u);
    assert.match(body, /Desktop PR full regression failed/u);
    assert.doesNotMatch(body, /Desktop Daily/u);
  });
});

void test('still reports a PR infrastructure failure before its suite artifact exists', async () => {
  await withWorkspace(async (workspace) => {
    const result = await prepareDailyFailureReport({
      ...RUN,
      evidenceRoot: join(workspace, 'pr-evidence'),
      outputRoot: join(workspace, 'pr-report'),
      workingDirectory: workspace,
      channel: 'pr',
      suite: 'unknown',
    });
    const body = await readFile(join(workspace, result.batches[0].bodyPath), 'utf8');
    assert.match(body, /Desktop PR regression failed/u);
    assert.match(body, /failure-index\.json is missing/u);
    assert.doesNotMatch(body, /Desktop PR unknown regression/u);
  });
});
