import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { git as runGit } from './git.mjs';

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
  openSync,
  closeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { confirmTopic, documentStatus, inspectTopic, main, topicDiff } from './main.mjs';

const execute = promisify(execFile);

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'lody-doc-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = async (...args) => (await execute('git', args, { cwd: root })).stdout.trim();
  const write = (file, body) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), body);
  };
  await git('init', '-q', '-b', 'document-review-fixture');
  await git('config', 'user.email', 'synthetic@example.invalid');
  await git('config', 'user.name', 'Synthetic fixture');
  write('specs/flow.zh.md', '# Flow\n\nStatus: draft\nTranslation: pending\n');
  write('apps/flow.ts', '// @dec:specs/flow\nexport const durable = true;\n');
  const scopeFile = 'specs/flow.anchors.json';
  const scope = {
    version: 1,
    rationale: 'Protect durable flow',
    scopeReview: 'PR #1',
    documents: ['specs/flow.zh.md'],
    sources: ['apps/flow.ts'],
    watch: ['apps'],
  };
  write(scopeFile, JSON.stringify(scope));
  const commit = async () => {
    await git('add', '.');
    await git(
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-qm',
      'fixture'
    );
  };
  await commit();
  const readScope = () => JSON.parse(readFileSync(path.join(root, scopeFile), 'utf8'));
  return { root, git, write, commit, scopeFile, scope, readScope };
}

test('confirmation binds source and document bytes without approving the Spec', async (t) => {
  const f = await fixture(t);
  assert.equal((await inspectTopic(f.root, 'specs/flow')).status, 'unreviewed');
  await confirmTopic(
    f.root,
    'specs/flow',
    'Contract still holds',
    'Read source and synthetic test'
  );
  const confirmed = readFileSync(path.join(f.root, f.scopeFile), 'utf8');
  assert.equal((await inspectTopic(f.root, 'specs/flow')).status, 'current');
  assert.equal((await documentStatus(f.root)).documents[0].status, 'draft');
  f.write('unrelated.txt', 'new commit only');
  await f.commit();
  assert.equal((await inspectTopic(f.root, 'specs/flow')).status, 'current');
  f.write('apps/flow.ts', '// @dec:specs/flow\nexport const durable = false;\n');
  assert.equal((await inspectTopic(f.root, 'specs/flow')).status, 'stale');
  assert.match(await topicDiff(f.root, 'specs/flow'), /-export const durable = true/);
  assert.match(await topicDiff(f.root, 'specs/flow'), /\+export const durable = false/);
  assert.equal(readFileSync(path.join(f.root, f.scopeFile), 'utf8'), confirmed);
  await assert.rejects(
    () => confirmTopic(f.root, 'specs/flow', 'review', 'evidence'),
    /Commit reviewed content first/
  );
  f.write('apps/flow.ts', '// @dec:specs/flow\nexport const durable = true;\n');
  f.write('specs/flow.zh.md', '# Changed intent\nStatus: draft\nTranslation: pending\n');
  assert.equal((await inspectTopic(f.root, 'specs/flow')).status, 'stale');
});

test('new, removed, or unprotected sources need explicit review', async (t) => {
  const f = await fixture(t);
  await confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  f.write('apps/new.ts', 'export {};\n');
  assert.ok(
    (await inspectTopic(f.root, 'specs/flow')).changes.some((c) => c.kind === 'added-to-watch')
  );
  rmSync(path.join(f.root, 'apps/flow.ts'));
  assert.ok((await inspectTopic(f.root, 'specs/flow')).changes.some((c) => c.kind === 'missing'));
  await assert.rejects(
    () => confirmTopic(f.root, 'specs/flow', 'review', 'evidence'),
    /missing protected/
  );
  const record = f.readScope();
  record.sources = [];
  f.write(f.scopeFile, JSON.stringify(record));
  assert.ok(
    (await inspectTopic(f.root, 'specs/flow')).changes.some((c) => c.kind === 'protection-removed')
  );
});

test('confirmation requires scope approval and meaningful evidence', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => confirmTopic(f.root, 'specs/flow', '', 'evidence'), /--reason/);
  f.write(f.scopeFile, JSON.stringify({ ...f.scope, scopeReview: null }));
  assert.equal((await inspectTopic(f.root, 'specs/flow')).status, 'scope-pending');
  await assert.rejects(
    () => confirmTopic(f.root, 'specs/flow', 'review', 'evidence'),
    /scope confirmation/
  );
});

test('review paths cannot escape the repo, follow symlinks, or hash metadata', async (t) => {
  const f = await fixture(t);
  for (const source of ['../elsewhere', '.git/config', 'specs/flow.anchors.json']) {
    f.write(f.scopeFile, JSON.stringify({ ...f.scope, sources: [source] }));
    await assert.rejects(() => inspectTopic(f.root, 'specs/flow'));
  }
  symlinkSync('flow.ts', path.join(f.root, 'apps/alias.ts'));
  f.write(f.scopeFile, JSON.stringify({ ...f.scope, sources: ['apps/alias.ts'] }));
  await assert.rejects(() => inspectTopic(f.root, 'specs/flow'), /Symlink/);
});

test('queues preserve translation debt and catch invalid note state and broken links', async (t) => {
  const f = await fixture(t);
  f.write(
    '.agents/notes/proposed/process/2026-09-06-example.zh.md',
    '# Note\nStatus: implemented\nTranslation: current\n[missing](absent.md)\n'
  );
  const report = await documentStatus(f.root);
  assert.ok(report.documents.some((d) => d.missingTranslation && d.status === 'draft'));
  assert.ok(report.errors.some((e) => e.includes('lifecycle')));
  assert.ok(report.errors.some((e) => e.includes('counterpart missing')));
  assert.ok(report.errors.some((e) => e.includes('broken local link')));
  assert.equal(
    readFileSync(path.join(f.root, 'specs/flow.zh.md'), 'utf8').includes('approved'),
    false
  );
});

test('base comparison detects a deleted topic record', async (t) => {
  const f = await fixture(t);
  const base = await f.git('rev-parse', 'HEAD');
  rmSync(path.join(f.root, f.scopeFile));
  assert.equal(await main(f.root, ['check', '--base', base]), 1);
});

test('check discovers adjacent records and rejects an unrelated owner', async (t) => {
  const f = await fixture(t);
  await confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  assert.equal(await main(f.root, ['check']), 0);
  f.write('apps/flow.ts', '// @dec:specs/flow\nexport const durable = false;\n');
  assert.equal(await main(f.root, ['check']), 1);
  const record = f.readScope();
  record.documents = ['specs/another.md'];
  f.write(f.scopeFile, JSON.stringify(record));
  await assert.rejects(() => inspectTopic(f.root, 'specs/flow'), /adjacent owning document/);
});

test('unrelated declarations stay current while anchor removal and reverse-link gaps fail', async (t) => {
  const f = await fixture(t);
  await confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  f.write(
    'apps/flow.ts',
    '// @dec:specs/flow\nexport const durable = true;\nexport const unrelated = 2;\n'
  );
  assert.equal((await inspectTopic(f.root, 'specs/flow')).status, 'current');
  f.write('apps/extra.ts', '// @dec:specs/flow\nexport const other = 1;\n');
  assert.equal(await main(f.root, ['check']), 1);
  await assert.rejects(
    () => confirmTopic(f.root, 'specs/flow', 'review', 'evidence'),
    /absent from/
  );
  rmSync(path.join(f.root, 'apps/extra.ts'));
  f.write('apps/flow.ts', 'export const durable = true;\n');
  await assert.rejects(() => inspectTopic(f.root, 'specs/flow'), /missing @dec/);
});

test('note opening requires a nonempty abstract in the authored language', async (t) => {
  const f = await fixture(t);
  const note = '.agents/notes/proposed/process/2026-09-06-example.md';
  const header = '# Example\nStatus: proposed\nTranslation: pending\n\n';
  f.write('README.md', `[decision](${note})\n`);
  f.write(note, header + '## Problem\nA problem.\n');
  assert.ok((await documentStatus(f.root)).errors.some((e) => e.includes('Abstract')));
  f.write(note, header + '## Abstract\n\n## Problem\nA problem.\n');
  assert.ok((await documentStatus(f.root)).errors.some((e) => e.includes('Abstract')));
  f.write(
    note,
    header +
      '## Abstract\nThe problem, approach, and remaining uncertainty.\n\n## Problem\nA problem.\n'
  );
  assert.deepEqual((await documentStatus(f.root)).errors, []);
});

test('removing one of several anchors exposes its source diff', async (t) => {
  const f = await fixture(t);
  const first = '// @dec:specs/flow\nexport function first() { return 1; }\n';
  const second = '// @dec:specs/flow\nexport function second() { return 2; }\n';
  f.write('apps/flow.ts', first + second);
  await f.commit();
  await confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  f.write('apps/flow.ts', first);
  assert.match(await topicDiff(f.root, 'specs/flow'), /-export function second/);
});

test('CLI completes initial review, drift, diff, and reconfirmation without approving a Spec', async (t) => {
  const f = await fixture(t);
  for (const name of ['main.mjs', 'anchors.mjs', 'git.mjs']) {
    f.write(`scripts/docs/${name}`, readFileSync(new URL(name, import.meta.url), 'utf8'));
  }
  mkdirSync(path.join(f.root, 'node_modules'), { recursive: true });
  symlinkSync(
    path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
    path.join(f.root, 'node_modules/typescript')
  );
  // Regular files also work on hosts where nested Node processes cannot write to socket stdio.
  const runCli = async (args, options = {}) => {
    const outputs = ['stdout', 'stderr'].map((name) => path.join(f.root, '.git', `cli-${name}`));
    const descriptors = outputs.map((file) => openSync(file, 'w'));
    let code, signal;
    try {
      const child = spawn(process.execPath, [path.join(f.root, 'scripts/docs/main.mjs'), ...args], {
        ...options,
        cwd: f.root,
        stdio: ['ignore', ...descriptors],
      });
      [code, signal] = await once(child, 'close');
    } finally {
      descriptors.forEach(closeSync);
    }
    const [stdout, stderr] = outputs.map((file) => readFileSync(file, 'utf8'));
    if (code !== 0 || signal)
      throw Object.assign(new Error(stderr), { code, signal, stdout, stderr });
    return stdout;
  };
  const cli = (...args) => runCli(args);
  assert.equal(JSON.parse(await cli('status')).topics[0].status, 'unreviewed');
  await assert.rejects(
    () => cli('check'),
    (error) => error.code === 1
  );
  const confirm = async () =>
    await cli(
      'confirm',
      '--topic',
      'specs/flow',
      '--reason',
      'Contract reviewed',
      '--evidence',
      'Synthetic source and tests'
    );
  await confirm();
  assert.equal(JSON.parse(await cli('check')).topics[0].status, 'current');
  const baseline = readFileSync(path.join(f.root, f.scopeFile), 'utf8');
  f.write('apps/flow.ts', '// @dec:specs/flow\nexport const durable = false;\n');
  await assert.rejects(
    () => cli('check'),
    (error) => error.code === 1
  );
  assert.match(await cli('diff', '--topic', 'specs/flow'), /-export const durable = true/);
  assert.equal(readFileSync(path.join(f.root, f.scopeFile), 'utf8'), baseline);
  await assert.rejects(confirm, (error) => error.code === 1);
  await f.commit();
  await confirm();
  const report = JSON.parse(await cli('check'));
  assert.equal(report.topics[0].status, 'current');
  assert.equal(report.documents[0].status, 'draft');
  await assert.rejects(
    () =>
      runCli(['status'], {
        env: { ...process.env, PATH: '' },
      }),
    (error) => error.code === 1 && error.stdout === '' && /git ENOENT/.test(error.stderr)
  );
});

test('watch ignores committed symlinks just like working-tree discovery', async (t) => {
  const f = await fixture(t);
  symlinkSync('flow.ts', path.join(f.root, 'apps/CLAUDE.md'));
  await f.commit();
  assert.equal((await confirmTopic(f.root, 'specs/flow', 'review', 'evidence')).status, 'current');
  assert.deepEqual(f.readScope().baseline.inventory, ['apps/flow.ts']);
});

test('diff reads baseline blobs when the recorded revision is unavailable and writes no objects', async (t) => {
  const f = await fixture(t);
  await confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  const record = f.readScope();
  record.baseline.revision = 'a'.repeat(40);
  f.write(f.scopeFile, JSON.stringify(record));
  const before = await f.git('count-objects', '-v');
  f.write('apps/flow.ts', '// @dec:specs/flow\nexport const durable = false;\n');
  assert.match(await topicDiff(f.root, 'specs/flow'), /-export const durable = true/);
  assert.equal(await f.git('count-objects', '-v'), before);
  record.baseline.sourceBlobs['apps/flow.ts'] = 'b'.repeat(40);
  f.write(f.scopeFile, JSON.stringify(record));
  await assert.rejects(() => topicDiff(f.root, 'specs/flow'), /Missing baseline blob/);
});

async function captureReport(root, args) {
  let report;
  const original = console.log;
  console.log = (output) => {
    report = JSON.parse(output);
  };
  try {
    return {
      code: await main(root, args),
      get report() {
        return report;
      },
    };
  } finally {
    console.log = original;
  }
}

test('bad topics and malformed source markers do not hide healthy topics or document queues', async (t) => {
  const f = await fixture(t);
  f.write(f.scopeFile, JSON.stringify({ ...f.scope, watch: [] }));
  await confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  f.write('specs/b.md', '# B\nStatus: draft\nTranslation: pending\n');
  f.write('apps/b.ts', 'export const b = 1;\n');
  f.write(
    'specs/b.anchors.json',
    JSON.stringify({ ...f.scope, documents: ['specs/b.md'], sources: ['apps/b.ts'] })
  );
  f.write('apps/c.ts', '// @dec:specs/c malformed\nexport const c = 1;\n');
  const result = await captureReport(f.root, ['check']);
  assert.equal(result.code, 1);
  assert.ok(result.report.documents.some((d) => d.file === 'specs/b.md'));
  assert.equal(result.report.topics.find((t) => t.topic === 'specs/flow').status, 'current');
  assert.equal(result.report.topics.find((t) => t.topic === 'specs/b').status, 'error');
  assert.ok(result.report.errors.some((e) => e.includes('apps/c.ts')));
  const status = await captureReport(f.root, ['status']);
  assert.equal(status.code, 0);
  assert.equal(status.report.topics.length, 2);
});

test('repo-wide links include hubs and archives, while metadata stays scoped', async (t) => {
  const f = await fixture(t);
  const files = [
    'AGENTS.md',
    'CONTRIBUTING.md',
    '.agents/README.md',
    '.agents/content-review.md',
    '.agents/notes/archived/process/2026-09-06-old.md',
  ];
  for (const file of files) f.write(file, '[broken](missing-file.md)\n');
  f.write('README.md', '[reference][guide]\n\n[guide]: missing-guide.md\n');
  const errors = (await documentStatus(f.root)).errors;
  for (const file of files)
    assert.ok(
      errors.some((e) => e.startsWith(`${file}: broken local link`)),
      file
    );
  assert.ok(errors.some((e) => e.includes('missing-guide.md')));
  assert.equal(errors.filter((e) => e.includes('invalid/missing')).length, 0);
});

test('retired records retain evidence, skip stale sources, and forbid live markers or confirmation', async (t) => {
  const f = await fixture(t);
  await confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  await f.commit();
  const base = await f.git('rev-parse', 'HEAD');
  const record = f.readScope();
  record.retired = { date: '2026-09-06', reason: 'Contract removed', scopeReview: 'PR #2' };
  f.write(f.scopeFile, JSON.stringify(record));
  assert.equal((await inspectTopic(f.root, 'specs/flow')).status, 'retired');
  assert.equal((await captureReport(f.root, ['check', '--base', base])).code, 1);
  rmSync(path.join(f.root, 'apps/flow.ts'));
  assert.equal((await captureReport(f.root, ['check', '--base', base])).code, 0);
  await assert.rejects(
    () => confirmTopic(f.root, 'specs/flow', 'review', 'evidence'),
    /Retired topics/
  );
  record.retired.scopeReview = 'someone approved';
  f.write(f.scopeFile, JSON.stringify(record));
  await assert.rejects(() => inspectTopic(f.root, 'specs/flow'), /retirement/);
});

test('scope schema rejects unknown keys and untraceable reviews', async (t) => {
  const f = await fixture(t);
  f.write(f.scopeFile, JSON.stringify({ ...f.scope, sourcs: [] }));
  await assert.rejects(() => inspectTopic(f.root, 'specs/flow'), /unknown field sourcs/);
  for (const scopeReview of ['yes', '', 'PR #0', 'javascript:alert(1)']) {
    f.write(f.scopeFile, JSON.stringify({ ...f.scope, scopeReview }));
    await assert.rejects(() => inspectTopic(f.root, 'specs/flow'), /scopeReview/);
  }
  for (const scopeReview of ['PR #12', 'https://example.invalid/review/1', 'a'.repeat(40)]) {
    f.write(f.scopeFile, JSON.stringify({ ...f.scope, scopeReview }));
    assert.equal((await inspectTopic(f.root, 'specs/flow')).status, 'unreviewed');
  }
});

test('translation statuses must agree and AGENTS files respect their word ceilings', async (t) => {
  const f = await fixture(t);
  const words = (count) => `${'word '.repeat(count)}\n`;
  f.write('specs/flow.md', '# Flow\nStatus: approved\nTranslation: current\n');
  f.write('AGENTS.md', words(1200));
  assert.ok((await documentStatus(f.root)).errors.some((e) => e.includes('Status differs')));
  assert.ok(!(await documentStatus(f.root)).errors.some((e) => e.includes('word ceiling')));
  f.write('apps/AGENTS.md', words(1201));
  assert.ok(
    (await documentStatus(f.root)).errors.some((e) =>
      e.includes('apps/AGENTS.md: 1201 words exceeds its 1200-word ceiling')
    )
  );
  f.write(
    'scripts/docs/agents-budgets.json',
    JSON.stringify({ default: 1200, files: { 'apps/AGENTS.md': 1300 } })
  );
  assert.ok(!(await documentStatus(f.root)).errors.some((e) => e.includes('ceiling')));
  f.write(
    'scripts/docs/agents-budgets.json',
    JSON.stringify({ default: 1200, files: { 'apps/AGENTS.md': 1300, 'gone/AGENTS.md': 10 } })
  );
  assert.ok(
    (await documentStatus(f.root)).errors.some((e) => e.includes('gone/AGENTS.md is budgeted'))
  );
  f.write('scripts/docs/agents-budgets.json', JSON.stringify({ default: 0, files: {} }));
  assert.ok((await documentStatus(f.root)).errors.some((e) => e.includes('positive integer')));
  f.write(
    'scripts/docs/agents-budgets.json',
    JSON.stringify({ default: 1200, files: { 'apps/README.md': 5 } })
  );
  assert.ok((await documentStatus(f.root)).errors.some((e) => e.includes('not an AGENTS.md')));
});

test('a pending note counterpart warns without failing the check', async (t) => {
  const f = await fixture(t);
  const note = '.agents/notes/proposed/process/2026-09-06-example.md';
  f.write(note, '# Note\n\nStatus: proposed\nTranslation: pending\n\n## Abstract\n\nBody.\n');
  f.write('README.md', `[decision](${note})\n`);
  const pending = await documentStatus(f.root);
  assert.ok(
    pending.warnings.some((w) => w.includes(`${note}: ${note.replace(/\.md$/, '.zh.md')}`))
  );
  assert.deepEqual(pending.errors, []);
  await f.commit();
  await confirmTopic(f.root, 'specs/flow', 'reviewed', 'evidence');
  assert.equal(await main(f.root, ['check']), 0, 'translation debt alone must not fail the check');
  f.write(
    note.replace(/\.md$/, '.zh.md'),
    '# 记录\n\nStatus: proposed\nTranslation: current\n\n## 摘要\n\n正文。\n'
  );
  assert.deepEqual((await documentStatus(f.root)).warnings, []);
});

test('an AGENTS file near its ceiling warns without failing the check', async (t) => {
  const f = await fixture(t);
  const words = (count) => `${'word '.repeat(count)}\n`;
  f.write('AGENTS.md', words(1080));
  assert.deepEqual((await documentStatus(f.root)).warnings, []);
  f.write('AGENTS.md', words(1081));
  const near = await documentStatus(f.root);
  assert.ok(
    near.warnings.some((w) => w.includes('AGENTS.md: 1081 of 1200 words') && w.includes('119 left'))
  );
  assert.ok(!near.errors.some((e) => e.includes('AGENTS.md')));
  await f.commit();
  await confirmTopic(f.root, 'specs/flow', 'reviewed', 'evidence');
  assert.equal(await main(f.root, ['check']), 0, 'a warning alone must not fail the check');
  f.write('AGENTS.md', words(1201));
  await f.commit();
  assert.equal(await main(f.root, ['check']), 1);
});

test('note hygiene gates apply to notes the task changed and queue stale references', async (t) => {
  const f = await fixture(t);
  const note = '.agents/notes/implemented/bug-fix/2026-09-06-example.md';
  const header =
    '# Example\n\nStatus: implemented\nTranslation: pending\n\n## Abstract\n\nBody.\n\n';
  f.write('apps/kept.ts', 'export {};\n');
  f.write(note, header + '## Plan\n\nAll 12 tests pass. See `apps/kept.ts` and `apps/moved.ts`.\n');
  const fresh = await documentStatus(f.root);
  assert.ok(
    fresh.errors.some((e) => e.startsWith(`${note}: implemented notes`) && e.includes('"## Plan"'))
  );
  assert.ok(
    fresh.warnings.some((w) => w.startsWith(`${note}: run-log phrase "All 12 tests pass"`))
  );
  assert.deepEqual(fresh.staleReferences, [{ file: note, missing: ['apps/moved.ts'] }]);
  await f.commit();
  const committed = await documentStatus(f.root);
  assert.ok(!committed.errors.some((e) => e.includes(note)), 'earlier records are not reopened');
  assert.ok(!committed.warnings.some((w) => w.includes('run-log phrase')));
  assert.equal(committed.staleReferences.length, 1, 'stale references stay queued');
  const base = await f.git('rev-parse', 'HEAD~1');
  assert.ok((await documentStatus(f.root, { base })).errors.some((e) => e.includes(note)));
  f.write(note, header + '## Decision\n\nThe owning suite pins the ordering.\n');
  const fixed = await documentStatus(f.root);
  assert.ok(!fixed.errors.some((e) => e.includes(note)));
  assert.deepEqual(fixed.staleReferences, []);
});

test('a new note must be linked from a current-state owner document', async (t) => {
  const f = await fixture(t);
  const note = '.agents/notes/implemented/bug-fix/2026-09-08-provider-quirk.md';
  const body = '# Quirk\n\nStatus: implemented\nTranslation: current\n\n## Abstract\n\nBody.\n';
  const unlinked = (report) => report.errors.some((e) => e.startsWith(`${note}: a new note needs`));
  f.write(note, body);
  f.write(note.replace(/\.md$/, '.zh.md'), body.replace('Abstract', '摘要'));
  f.write(
    '.agents/notes/implemented/bug-fix/2026-09-09-sibling.md',
    `[quirk](2026-09-08-provider-quirk.md)\n`
  );
  const fresh = await documentStatus(f.root);
  assert.ok(unlinked(fresh), 'a link from another note does not make it discoverable');
  assert.equal(fresh.errors.filter((e) => e.includes('a new note needs')).length, 2);
  assert.ok(fresh.unlinkedNotes.includes(note));
  f.write(
    'apps/README.md',
    '[Why the quirk exists](../.agents/notes/implemented/bug-fix/2026-09-08-provider-quirk.zh.md)\n'
  );
  const linked = await documentStatus(f.root);
  assert.ok(!unlinked(linked), 'a link to either language satisfies the pair');
  assert.ok(!linked.unlinkedNotes.includes(note));
  rmSync(path.join(f.root, 'apps/README.md'));
  f.write(
    '.agents/notes/AGENTS.md',
    '[Rationale](implemented/bug-fix/2026-09-08-provider-quirk.md)\n'
  );
  assert.ok(!unlinked(await documentStatus(f.root)), 'the note rules file is an owner, not a note');
  rmSync(path.join(f.root, '.agents/notes/AGENTS.md'));
  await f.commit();
  const existing = await documentStatus(f.root);
  assert.ok(!unlinked(existing), 'existing notes are queued, not failed');
  assert.ok(existing.unlinkedNotes.includes(note));
  const moved = note.replace('/implemented/', '/proposed/');
  mkdirSync(path.join(f.root, path.dirname(moved)), { recursive: true });
  await f.git('mv', note, moved);
  await f.git('mv', note.replace(/\.md$/, '.zh.md'), moved.replace(/\.md$/, '.zh.md'));
  for (const file of [moved, moved.replace(/\.md$/, '.zh.md')])
    f.write(file, readFileSync(path.join(f.root, file), 'utf8').replace('implemented', 'proposed'));
  assert.ok(
    !(await documentStatus(f.root)).errors.some((e) => e.includes('a new note needs')),
    'a lifecycle move is not a new note'
  );
});

test('a fully superseded note must already be archived', async (t) => {
  const f = await fixture(t);
  const note = '.agents/notes/implemented/process/2026-09-07-new.md';
  const body = (target) =>
    `# New\n\nStatus: implemented\nTranslation: pending\nSupersedes: [old](${target})\n\n## Abstract\n\nBody.\n`;
  f.write(note, body('2026-09-01-old.md'));
  f.write(
    '.agents/notes/implemented/process/2026-09-01-old.md',
    '# Old\n\nStatus: implemented\nTranslation: pending\n\n## Abstract\n\nBody.\n'
  );
  assert.ok(
    (await documentStatus(f.root)).errors.some((e) => e.includes(`${note}: Supersedes target`))
  );
  f.write(note, body('../../archived/process/2026-09-01-old.md'));
  assert.ok((await documentStatus(f.root)).errors.some((e) => e.includes('Supersedes target')));
  f.write(
    '.agents/notes/archived/process/2026-09-01-old.md',
    '# Old\n\nStatus: implemented\nArchived: 2026-09-07\nTranslation: pending\n\n## Abstract\n\nBody.\n'
  );
  rmSync(path.join(f.root, '.agents/notes/implemented/process/2026-09-01-old.md'));
  assert.ok(!(await documentStatus(f.root)).errors.some((e) => e.includes('Supersedes')));
});

test('a shallow clone of a consolidated commit can diff blobs without the original PR revision', async (t) => {
  const f = await fixture(t);
  await confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  const revision = f.readScope().baseline.revision;
  await f.git('checkout', '--orphan', 'consolidated-document-fixture');
  await f.commit();
  const clone = mkdtempSync(path.join(tmpdir(), 'lody-doc-shallow-'));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  await execute('git', ['clone', '--quiet', '--depth=1', `file://${f.root}`, clone], {
    stdio: 'pipe',
  });
  await assert.rejects(
    async () => await execute('git', ['cat-file', '-e', revision], { cwd: clone, stdio: 'pipe' })
  );
  writeFileSync(
    path.join(clone, 'apps/flow.ts'),
    '// @dec:specs/flow\nexport const durable = false;\n'
  );
  assert.match(await topicDiff(clone, 'specs/flow'), /-export const durable = true/);
});

test('Git preserves binary blobs, cwd, and NUL-delimited unusual paths', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 255, 254, 13, 10, 128, 0]);
  f.write('binary.dat', bytes);
  const unusual = 'specs/space 中文\nname.md';
  f.write(unusual, '[missing](absent.md)\n');
  await f.commit();
  assert.deepEqual(await runGit(f.root, ['cat-file', 'blob', 'HEAD:binary.dat']), bytes);
  const listed = await runGit(f.root, ['ls-files', '-z']);
  assert.ok(Buffer.isBuffer(listed));
  assert.ok(listed.toString().split('\0').includes(unusual));
  assert.ok(
    (await documentStatus(f.root)).errors.includes(`${unusual}: broken local link absent.md`)
  );
});

test('Git diff accepts equal and different content, while other failures retain diagnostics', async (t) => {
  const f = await fixture(t);
  f.write('before', 'original\n');
  f.write('after', 'original\n');
  const args = ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', 'before', 'after'];
  assert.deepEqual(await runGit(f.root, args, { diff: true }), Buffer.alloc(0));
  f.write('after', 'changed\n');
  assert.match((await runGit(f.root, args, { diff: true })).toString(), /\+changed/);
  await assert.rejects(
    () => runGit(f.root, args),
    (error) => error.code === 1
  );
  await assert.rejects(
    () =>
      runGit(f.root, ['rev-parse', '--verify', 'refs/heads/missing-synthetic-ref'], { diff: true }),
    (error) =>
      error.code === 128 &&
      Buffer.isBuffer(error.stderr) &&
      error.stderr.includes('fatal:') &&
      error.message.includes(error.stderr.toString().trim())
  );
});

test('Git launch failures reject even when diff permits exit code 1', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    () => runGit(f.root, ['status'], { diff: true, env: { ...process.env, PATH: '' } }),
    (error) => error.code === 'ENOENT' && /git/.test(error.message)
  );
  if (process.platform === 'win32') return; // POSIX executable permission bits.
  const bin = path.join(f.root, 'bin');
  f.write('bin/git', '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(bin, 'git'), 0o644);
  await assert.rejects(
    () => runGit(f.root, ['status'], { diff: true, env: { ...process.env, PATH: bin } }),
    (error) => error.code === 'EACCES'
  );
});

test(
  'Git signal termination and truncated stdout or stderr never become successful diffs',
  {
    skip: process.platform === 'win32' && 'POSIX executable fixture and signals',
  },
  async (t) => {
    const f = await fixture(t);
    const executable = path.join(f.root, 'bin/git');
    const options = { diff: true, env: { ...process.env, PATH: path.dirname(executable) } };
    f.write(
      'bin/git',
      `#!${process.execPath}\nrequire('node:fs').writeSync(2, 'synthetic signal diagnostic');\nprocess.kill(process.pid, 'SIGTERM');\n`
    );
    chmodSync(executable, 0o755);
    await assert.rejects(
      () => runGit(f.root, [], options),
      (error) =>
        error.signal === 'SIGTERM' && error.stderr.toString() === 'synthetic signal diagnostic'
    );
    for (const stream of ['stdout', 'stderr']) {
      f.write(
        'bin/git',
        `#!${process.execPath}\nrequire('node:fs').writeSync(${stream === 'stdout' ? 1 : 2}, Buffer.alloc(4096, 120));\nprocess.exitCode = 1;\n`
      );
      await assert.rejects(
        () => runGit(f.root, [], { ...options, maxBuffer: 32 }),
        (error) => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && error[stream].length === 32
      );
    }
  }
);
