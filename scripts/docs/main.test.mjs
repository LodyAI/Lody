import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { confirmTopic, documentStatus, inspectTopic, main, topicDiff } from './main.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'lody-doc-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  const write = (file, body) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), body);
  };
  git('init', '-q', '-b', 'document-review-fixture');
  git('config', 'user.email', 'synthetic@example.invalid');
  git('config', 'user.name', 'Synthetic fixture');
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
  const commit = () => {
    git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture');
  };
  commit();
  const readScope = () => JSON.parse(readFileSync(path.join(root, scopeFile), 'utf8'));
  return { root, git, write, commit, scopeFile, scope, readScope };
}

test('confirmation binds source and document bytes without approving the Spec', (t) => {
  const f = fixture(t);
  assert.equal(inspectTopic(f.root, 'specs/flow').status, 'unreviewed');
  confirmTopic(f.root, 'specs/flow', 'Contract still holds', 'Read source and synthetic test');
  const confirmed = readFileSync(path.join(f.root, f.scopeFile), 'utf8');
  assert.equal(inspectTopic(f.root, 'specs/flow').status, 'current');
  assert.equal(documentStatus(f.root).documents[0].status, 'draft');
  f.write('unrelated.txt', 'new commit only');
  f.commit();
  assert.equal(inspectTopic(f.root, 'specs/flow').status, 'current');
  f.write('apps/flow.ts', '// @dec:specs/flow\nexport const durable = false;\n');
  assert.equal(inspectTopic(f.root, 'specs/flow').status, 'stale');
  assert.match(topicDiff(f.root, 'specs/flow'), /-export const durable = true/);
  assert.match(topicDiff(f.root, 'specs/flow'), /\+export const durable = false/);
  assert.equal(readFileSync(path.join(f.root, f.scopeFile), 'utf8'), confirmed);
  assert.throws(
    () => confirmTopic(f.root, 'specs/flow', 'review', 'evidence'),
    /Commit reviewed content first/
  );
  f.write('apps/flow.ts', '// @dec:specs/flow\nexport const durable = true;\n');
  f.write('specs/flow.zh.md', '# Changed intent\nStatus: draft\nTranslation: pending\n');
  assert.equal(inspectTopic(f.root, 'specs/flow').status, 'stale');
});

test('new, removed, or unprotected sources need explicit review', (t) => {
  const f = fixture(t);
  confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  f.write('apps/new.ts', 'export {};\n');
  assert.ok(inspectTopic(f.root, 'specs/flow').changes.some((c) => c.kind === 'added-to-watch'));
  rmSync(path.join(f.root, 'apps/flow.ts'));
  assert.ok(inspectTopic(f.root, 'specs/flow').changes.some((c) => c.kind === 'missing'));
  assert.throws(
    () => confirmTopic(f.root, 'specs/flow', 'review', 'evidence'),
    /missing protected/
  );
  const record = f.readScope();
  record.sources = [];
  f.write(f.scopeFile, JSON.stringify(record));
  assert.ok(
    inspectTopic(f.root, 'specs/flow').changes.some((c) => c.kind === 'protection-removed')
  );
});

test('confirmation requires scope approval and meaningful evidence', (t) => {
  const f = fixture(t);
  assert.throws(() => confirmTopic(f.root, 'specs/flow', '', 'evidence'), /--reason/);
  f.write(f.scopeFile, JSON.stringify({ ...f.scope, scopeReview: null }));
  assert.equal(inspectTopic(f.root, 'specs/flow').status, 'scope-pending');
  assert.throws(
    () => confirmTopic(f.root, 'specs/flow', 'review', 'evidence'),
    /scope confirmation/
  );
});

test('review paths cannot escape the repo, follow symlinks, or hash metadata', (t) => {
  const f = fixture(t);
  for (const source of ['../elsewhere', '.git/config', 'specs/flow.anchors.json']) {
    f.write(f.scopeFile, JSON.stringify({ ...f.scope, sources: [source] }));
    assert.throws(() => inspectTopic(f.root, 'specs/flow'));
  }
  symlinkSync('flow.ts', path.join(f.root, 'apps/alias.ts'));
  f.write(f.scopeFile, JSON.stringify({ ...f.scope, sources: ['apps/alias.ts'] }));
  assert.throws(() => inspectTopic(f.root, 'specs/flow'), /Symlink/);
});

test('queues preserve translation debt and catch invalid note state and broken links', (t) => {
  const f = fixture(t);
  f.write(
    '.agents/notes/proposed/process/2026-09-06-example.zh.md',
    '# Note\nStatus: implemented\nTranslation: current\n[missing](absent.md)\n'
  );
  const report = documentStatus(f.root);
  assert.ok(report.documents.some((d) => d.missingTranslation && d.status === 'draft'));
  assert.ok(report.errors.some((e) => e.includes('lifecycle')));
  assert.ok(report.errors.some((e) => e.includes('counterpart missing')));
  assert.ok(report.errors.some((e) => e.includes('broken local link')));
  assert.equal(
    readFileSync(path.join(f.root, 'specs/flow.zh.md'), 'utf8').includes('approved'),
    false
  );
});

test('base comparison detects a deleted topic record', (t) => {
  const f = fixture(t);
  const base = f.git('rev-parse', 'HEAD');
  rmSync(path.join(f.root, f.scopeFile));
  assert.equal(main(f.root, ['check', '--base', base]), 1);
});

test('check discovers adjacent records and rejects an unrelated owner', (t) => {
  const f = fixture(t);
  confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  assert.equal(main(f.root, ['check']), 0);
  f.write('apps/flow.ts', '// @dec:specs/flow\nexport const durable = false;\n');
  assert.equal(main(f.root, ['check']), 1);
  const record = f.readScope();
  record.documents = ['specs/another.md'];
  f.write(f.scopeFile, JSON.stringify(record));
  assert.throws(() => inspectTopic(f.root, 'specs/flow'), /adjacent owning document/);
});

test('unrelated declarations stay current while anchor removal and reverse-link gaps fail', (t) => {
  const f = fixture(t);
  confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  f.write(
    'apps/flow.ts',
    '// @dec:specs/flow\nexport const durable = true;\nexport const unrelated = 2;\n'
  );
  assert.equal(inspectTopic(f.root, 'specs/flow').status, 'current');
  f.write('apps/extra.ts', '// @dec:specs/flow\nexport const other = 1;\n');
  assert.equal(main(f.root, ['check']), 1);
  assert.throws(() => confirmTopic(f.root, 'specs/flow', 'review', 'evidence'), /absent from/);
  rmSync(path.join(f.root, 'apps/extra.ts'));
  f.write('apps/flow.ts', 'export const durable = true;\n');
  assert.throws(() => inspectTopic(f.root, 'specs/flow'), /missing @dec/);
});

test('note opening requires a nonempty abstract in the authored language', (t) => {
  const f = fixture(t);
  const note = '.agents/notes/proposed/process/2026-09-06-example.md';
  const header = '# Example\nStatus: proposed\nTranslation: pending\n\n';
  f.write(note, header + '## Problem\nA problem.\n');
  assert.ok(documentStatus(f.root).errors.some((e) => e.includes('Abstract')));
  f.write(note, header + '## Abstract\n\n## Problem\nA problem.\n');
  assert.ok(documentStatus(f.root).errors.some((e) => e.includes('Abstract')));
  f.write(
    note,
    header +
      '## Abstract\nThe problem, approach, and remaining uncertainty.\n\n## Problem\nA problem.\n'
  );
  assert.deepEqual(documentStatus(f.root).errors, []);
});

test('removing one of several anchors exposes its source diff', (t) => {
  const f = fixture(t);
  const first = '// @dec:specs/flow\nexport function first() { return 1; }\n';
  const second = '// @dec:specs/flow\nexport function second() { return 2; }\n';
  f.write('apps/flow.ts', first + second);
  f.commit();
  confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  f.write('apps/flow.ts', first);
  assert.match(topicDiff(f.root, 'specs/flow'), /-export function second/);
});

test('CLI completes initial review, drift, diff, and reconfirmation without approving a Spec', (t) => {
  const f = fixture(t);
  for (const name of ['main.mjs', 'anchors.mjs']) {
    f.write(`scripts/docs/${name}`, readFileSync(new URL(name, import.meta.url), 'utf8'));
  }
  mkdirSync(path.join(f.root, 'node_modules'), { recursive: true });
  symlinkSync(
    path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
    path.join(f.root, 'node_modules/typescript')
  );
  const cli = (...args) =>
    execFileSync(process.execPath, [path.join(f.root, 'scripts/docs/main.mjs'), ...args], {
      cwd: f.root,
      stdio: 'pipe',
    }).toString();
  assert.equal(JSON.parse(cli('status')).topics[0].status, 'unreviewed');
  assert.throws(
    () => cli('check'),
    (error) => error.status === 1
  );
  const confirm = () =>
    cli(
      'confirm',
      '--topic',
      'specs/flow',
      '--reason',
      'Contract reviewed',
      '--evidence',
      'Synthetic source and tests'
    );
  confirm();
  assert.equal(JSON.parse(cli('check')).topics[0].status, 'current');
  const baseline = readFileSync(path.join(f.root, f.scopeFile), 'utf8');
  f.write('apps/flow.ts', '// @dec:specs/flow\nexport const durable = false;\n');
  assert.throws(
    () => cli('check'),
    (error) => error.status === 1
  );
  assert.match(cli('diff', '--topic', 'specs/flow'), /-export const durable = true/);
  assert.equal(readFileSync(path.join(f.root, f.scopeFile), 'utf8'), baseline);
  assert.throws(confirm, (error) => error.status === 1);
  f.commit();
  confirm();
  const report = JSON.parse(cli('check'));
  assert.equal(report.topics[0].status, 'current');
  assert.equal(report.documents[0].status, 'draft');
});

test('watch ignores committed symlinks just like working-tree discovery', (t) => {
  const f = fixture(t);
  symlinkSync('flow.ts', path.join(f.root, 'apps/CLAUDE.md'));
  f.commit();
  assert.equal(confirmTopic(f.root, 'specs/flow', 'review', 'evidence').status, 'current');
  assert.deepEqual(f.readScope().baseline.inventory, ['apps/flow.ts']);
});

test('diff reads baseline blobs when the recorded revision is unavailable and writes no objects', (t) => {
  const f = fixture(t);
  confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  const record = f.readScope();
  record.baseline.revision = 'a'.repeat(40);
  f.write(f.scopeFile, JSON.stringify(record));
  const before = f.git('count-objects', '-v');
  f.write('apps/flow.ts', '// @dec:specs/flow\nexport const durable = false;\n');
  assert.match(topicDiff(f.root, 'specs/flow'), /-export const durable = true/);
  assert.equal(f.git('count-objects', '-v'), before);
  record.baseline.sourceBlobs['apps/flow.ts'] = 'b'.repeat(40);
  f.write(f.scopeFile, JSON.stringify(record));
  assert.throws(() => topicDiff(f.root, 'specs/flow'), /Missing baseline blob/);
});

function captureReport(root, args) {
  let report;
  const original = console.log;
  console.log = (output) => {
    report = JSON.parse(output);
  };
  try {
    return {
      code: main(root, args),
      get report() {
        return report;
      },
    };
  } finally {
    console.log = original;
  }
}

test('bad topics and malformed source markers do not hide healthy topics or document queues', (t) => {
  const f = fixture(t);
  f.write(f.scopeFile, JSON.stringify({ ...f.scope, watch: [] }));
  confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  f.write('specs/b.md', '# B\nStatus: draft\nTranslation: pending\n');
  f.write('apps/b.ts', 'export const b = 1;\n');
  f.write(
    'specs/b.anchors.json',
    JSON.stringify({ ...f.scope, documents: ['specs/b.md'], sources: ['apps/b.ts'] })
  );
  f.write('apps/c.ts', '// @dec:specs/c malformed\nexport const c = 1;\n');
  const result = captureReport(f.root, ['check']);
  assert.equal(result.code, 1);
  assert.ok(result.report.documents.some((d) => d.file === 'specs/b.md'));
  assert.equal(result.report.topics.find((t) => t.topic === 'specs/flow').status, 'current');
  assert.equal(result.report.topics.find((t) => t.topic === 'specs/b').status, 'error');
  assert.ok(result.report.errors.some((e) => e.includes('apps/c.ts')));
  const status = captureReport(f.root, ['status']);
  assert.equal(status.code, 0);
  assert.equal(status.report.topics.length, 2);
});

test('repo-wide links include hubs and archives, while metadata stays scoped', (t) => {
  const f = fixture(t);
  const files = [
    'AGENTS.md',
    'CONTRIBUTING.md',
    '.agents/README.md',
    '.agents/content-review.md',
    '.agents/notes/archived/process/2026-09-06-old.md',
  ];
  for (const file of files) f.write(file, '[broken](missing-file.md)\n');
  f.write('README.md', '[reference][guide]\n\n[guide]: missing-guide.md\n');
  const errors = documentStatus(f.root).errors;
  for (const file of files)
    assert.ok(
      errors.some((e) => e.startsWith(`${file}: broken local link`)),
      file
    );
  assert.ok(errors.some((e) => e.includes('missing-guide.md')));
  assert.equal(errors.filter((e) => e.includes('invalid/missing')).length, 0);
});

test('retired records retain evidence, skip stale sources, and forbid live markers or confirmation', (t) => {
  const f = fixture(t);
  confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  f.commit();
  const base = f.git('rev-parse', 'HEAD');
  const record = f.readScope();
  record.retired = { date: '2026-09-06', reason: 'Contract removed', scopeReview: 'PR #2' };
  f.write(f.scopeFile, JSON.stringify(record));
  assert.equal(inspectTopic(f.root, 'specs/flow').status, 'retired');
  assert.equal(captureReport(f.root, ['check', '--base', base]).code, 1);
  rmSync(path.join(f.root, 'apps/flow.ts'));
  assert.equal(captureReport(f.root, ['check', '--base', base]).code, 0);
  assert.throws(() => confirmTopic(f.root, 'specs/flow', 'review', 'evidence'), /Retired topics/);
  record.retired.scopeReview = 'someone approved';
  f.write(f.scopeFile, JSON.stringify(record));
  assert.throws(() => inspectTopic(f.root, 'specs/flow'), /retirement/);
});

test('scope schema rejects unknown keys and untraceable reviews', (t) => {
  const f = fixture(t);
  f.write(f.scopeFile, JSON.stringify({ ...f.scope, sourcs: [] }));
  assert.throws(() => inspectTopic(f.root, 'specs/flow'), /unknown field sourcs/);
  for (const scopeReview of ['yes', '', 'PR #0', 'javascript:alert(1)']) {
    f.write(f.scopeFile, JSON.stringify({ ...f.scope, scopeReview }));
    assert.throws(() => inspectTopic(f.root, 'specs/flow'), /scopeReview/);
  }
  for (const scopeReview of ['PR #12', 'https://example.invalid/review/1', 'a'.repeat(40)]) {
    f.write(f.scopeFile, JSON.stringify({ ...f.scope, scopeReview }));
    assert.equal(inspectTopic(f.root, 'specs/flow').status, 'unreviewed');
  }
});

test('translation statuses must agree and every AGENTS file stays under 8 KiB', (t) => {
  const f = fixture(t);
  f.write('specs/flow.md', '# Flow\nStatus: approved\nTranslation: current\n');
  f.write('AGENTS.md', 'x'.repeat(8191));
  assert.ok(documentStatus(f.root).errors.some((e) => e.includes('Status differs')));
  assert.ok(!documentStatus(f.root).errors.some((e) => e.includes('8192 bytes')));
  f.write('apps/AGENTS.md', 'x'.repeat(8192));
  assert.ok(documentStatus(f.root).errors.some((e) => e.includes('apps/AGENTS.md: 8192')));
});

test('an AGENTS file near the gate warns without failing the check', (t) => {
  const f = fixture(t);
  f.write('AGENTS.md', 'x'.repeat(7000));
  assert.deepEqual(documentStatus(f.root).warnings, []);
  f.write('AGENTS.md', 'x'.repeat(7001));
  const near = documentStatus(f.root);
  assert.ok(near.warnings.some((w) => w.includes('AGENTS.md: 7001') && w.includes('1191 left')));
  assert.ok(!near.errors.some((e) => e.includes('AGENTS.md')));
  f.commit();
  confirmTopic(f.root, 'specs/flow', 'reviewed', 'evidence');
  assert.equal(main(f.root, ['check']), 0, 'a warning alone must not fail the check');
  f.write('AGENTS.md', 'x'.repeat(8192));
  f.commit();
  assert.equal(main(f.root, ['check']), 1);
});

test('a shallow clone of a consolidated commit can diff blobs without the original PR revision', (t) => {
  const f = fixture(t);
  confirmTopic(f.root, 'specs/flow', 'review', 'evidence');
  const revision = f.readScope().baseline.revision;
  f.git('checkout', '--orphan', 'consolidated-document-fixture');
  f.commit();
  const clone = mkdtempSync(path.join(tmpdir(), 'lody-doc-shallow-'));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${f.root}`, clone], {
    stdio: 'pipe',
  });
  assert.throws(() =>
    execFileSync('git', ['cat-file', '-e', revision], { cwd: clone, stdio: 'pipe' })
  );
  writeFileSync(
    path.join(clone, 'apps/flow.ts'),
    '// @dec:specs/flow\nexport const durable = false;\n'
  );
  assert.match(topicDiff(clone, 'specs/flow'), /-export const durable = true/);
});
