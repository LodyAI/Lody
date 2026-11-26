import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'check-comment-ratchet.mjs'
);

const ciEnv = { CI: 'true', GITHUB_ACTIONS: 'true' };
const localEnv = { CI: '', GITHUB_ACTIONS: '' };

function createRepo(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'comment-ratchet-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    }).trim();
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  const baseline = (scopes) =>
    write(
      'scripts/comment-ratchet-baseline.json',
      `${JSON.stringify({ version: 1, scopes }, null, 2)}\n`
    );
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const run = (env = localEnv) => {
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/check-comment-ratchet.mjs')],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...env },
      }
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  copyFileSync(scriptPath, path.join(root, 'scripts/check-comment-ratchet.mjs'));
  // The baseline leaves two lines of slack, as main's real baseline did.
  write('packages/ui/a.ts', '// one\nexport const a = 1;\n');
  baseline({ 'packages/ui': 3 });
  const base = commit('base');
  git('update-ref', 'refs/remotes/origin/main', base);
  return { root, git, write, baseline, commit, run, base };
}

test('a change that adds comments fails even when the baseline has slack', (t) => {
  const repo = createRepo(t);
  repo.git('switch', '-q', '-c', 'feature');
  repo.write('packages/ui/b.ts', '// added by this change\nexport const b = 1;\n');

  const result = repo.run();

  assert.equal(result.status, 1);
  assert.match(result.output, /packages\/ui: \+1 comment line/);
  assert.match(result.output, /packages\/ui\/b\.ts: \+1/);
});

test('a change that adds no comments passes when its base already exceeds the baseline', (t) => {
  const repo = createRepo(t);
  repo.write('packages/ui/a.ts', '// one\n// two\n// three\n// four\nexport const a = 1;\n');
  const main = repo.commit('main grows past its baseline');
  repo.git('update-ref', 'refs/remotes/origin/main', main);
  repo.git('switch', '-q', '-c', 'feature');
  repo.write('packages/ui/c.ts', 'export const c = 1;\n');

  const result = repo.run();

  assert.equal(result.status, 0);
  assert.match(result.output, /base already exceeds the baseline[\s\S]*packages\/ui: 4 > 3/);
});

test('merging main does not charge main’s comments to the branch', (t) => {
  const repo = createRepo(t);
  repo.git('switch', '-q', '-c', 'feature');
  repo.write('packages/ui/c.ts', 'export const c = 1;\n');
  repo.commit('feature work');
  repo.git('switch', '-q', 'main');
  repo.write('packages/ui/a.ts', '// one\n// two\nexport const a = 1;\n');
  const main = repo.commit('main adds a comment');
  repo.git('update-ref', 'refs/remotes/origin/main', main);
  repo.git('switch', '-q', 'feature');
  repo.git('merge', '-q', '--no-edit', 'main');

  assert.equal(repo.run().status, 0);
});

test('an untracked new file counts toward the change', (t) => {
  const repo = createRepo(t);
  repo.git('switch', '-q', '-c', 'feature');
  repo.write('packages/ui/new.ts', '// not yet added to git\nexport const n = 1;\n');

  const result = repo.run();

  assert.equal(result.status, 1);
  assert.match(result.output, /packages\/ui\/new\.ts: \+1/);
});

test('raising a scope’s baseline in the same change permits that growth', (t) => {
  const repo = createRepo(t);
  repo.git('switch', '-q', '-c', 'feature');
  repo.write('packages/ui/b.ts', '// moved here from another scope\nexport const b = 1;\n');
  repo.baseline({ 'packages/ui': 4 });

  assert.equal(repo.run().status, 0);
});

test('a pull request merge ref is judged by what merging adds to the base tip', (t) => {
  const repo = createRepo(t);
  repo.git('switch', '-q', '-c', 'feature');
  repo.write('packages/ui/b.ts', '// added by the pull request\nexport const b = 1;\n');
  const head = repo.commit('pull request');
  repo.git('switch', '-q', 'main');
  repo.write('packages/ui/a.ts', '// one\n// two\n// three\n// four\nexport const a = 1;\n');
  const main = repo.commit('main grows past its baseline');
  repo.git('switch', '-q', '--detach', main);
  repo.git('merge', '-q', '--no-edit', head);
  assert.equal(repo.git('rev-parse', 'HEAD^2'), head);

  const result = repo.run(ciEnv);

  assert.equal(result.status, 1);
  assert.match(result.output, /packages\/ui\/b\.ts: \+1/);
  assert.doesNotMatch(result.output, /packages\/ui\/a\.ts/);
});

test('a pull request that adds no comments passes on a base that exceeds the baseline', (t) => {
  const repo = createRepo(t);
  repo.git('switch', '-q', '-c', 'feature');
  repo.write('packages/ui/c.ts', 'export const c = 1;\n');
  const head = repo.commit('pull request');
  repo.git('switch', '-q', 'main');
  repo.write('packages/ui/a.ts', '// one\n// two\n// three\n// four\nexport const a = 1;\n');
  const main = repo.commit('main grows past its baseline');
  repo.git('switch', '-q', '--detach', main);
  repo.git('merge', '-q', '--no-edit', head);

  assert.equal(repo.run(ciEnv).status, 0);
});

test('a push to main is checked against the absolute baseline', (t) => {
  const repo = createRepo(t);
  repo.write('packages/ui/a.ts', '// one\n// two\n// three\n// four\nexport const a = 1;\n');
  repo.commit('main grows past its baseline');

  const result = repo.run(ciEnv);

  assert.equal(result.status, 1);
  assert.match(result.output, /packages\/ui: 4 comment lines exceeds baseline 3/);
});

test('without a base branch the absolute baseline still applies locally', (t) => {
  const repo = createRepo(t);
  repo.git('update-ref', '-d', 'refs/remotes/origin/main');
  repo.write('packages/ui/a.ts', '// one\n// two\n// three\n// four\nexport const a = 1;\n');

  const result = repo.run();

  assert.equal(result.status, 1);
  assert.match(result.output, /exceeds baseline 3/);
});
