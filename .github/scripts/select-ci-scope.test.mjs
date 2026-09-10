import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyPath,
  EXCLUDED_PACKAGES,
  finalizeWorkspace,
  formatGithubOutput,
  listChangedFiles,
  loadWorkspace,
  matchGlob,
  parseNameStatusZ,
  parseWorkspacePackageGlobs,
  selectCiScope,
  writeGithubOutput,
} from './select-ci-scope.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

function pkg(name, dir, { test: hasTest = true, typecheck = true, deps = [] } = {}) {
  return { name, dir, hasTest, hasTypecheck: typecheck, workspaceDeps: deps };
}

function syntheticWorkspace() {
  return finalizeWorkspace([
    pkg('lody', 'apps/cli', {
      deps: [
        '@lody/cli-supervisor',
        '@lody/code-review-helper',
        '@lody/cloud-api',
        '@lody/loro-streams-rpc',
        '@lody/platform',
        '@lody/shared',
        '@lody/turn-diff-store',
        'lody-code-review-viewer',
        'acp-extension-claude',
        'acp-extension-codex',
        'acp-extension-dsh',
        'acp-extension-grok',
        'acp-extension-core',
      ],
    }),
    pkg('@lody/electron', 'apps/electron', {
      deps: [
        '@lody/cli-supervisor',
        '@lody/platform',
        '@lody/shared',
        '@lody/components',
        '@lody/configs',
      ],
    }),
    pkg('@lody/shared', 'packages/shared', {
      deps: ['acp-extension-core', 'acp-extension-dsh'],
    }),
    pkg('@lody/components', 'packages/components', {
      deps: [
        '@lody/cloud-api',
        '@lody/loro-streams-rpc',
        '@lody/platform',
        '@lody/shared',
        '@lody/configs',
      ],
    }),
    pkg('@lody/platform', 'packages/platform', { deps: ['@lody/shared'] }),
    pkg('@lody/cli-supervisor', 'packages/cli-supervisor', { deps: ['@lody/shared'] }),
    pkg('@lody/cloud-api', 'packages/cloud-api', {
      test: false,
      deps: ['@lody/shared', 'acp-extension-core'],
    }),
    pkg('@lody/code-review-helper', 'packages/code-review-helper', {
      deps: ['@lody/components'],
    }),
    pkg('lody-code-review-viewer', 'packages/code-review-viewer', { test: false }),
    pkg('@lody/configs', 'packages/configs', { test: false, typecheck: false }),
    pkg('@loro-dev/ignore', 'packages/ignore'),
    pkg('@lody/loro-streams-rpc', 'packages/loro-streams-rpc', { deps: ['@lody/shared'] }),
    pkg('@lody/turn-diff-store', 'packages/turn-diff-store'),
    pkg('@lody/site-docs', 'site-docs', { deps: ['@lody/components', '@lody/shared'] }),
    pkg('@lody/e2e', 'e2e', { test: false, typecheck: false }),
    pkg('acp-extension-claude', 'packages/acp-extension-claude'),
    pkg('acp-extension-codex', 'packages/acp-extension-codex'),
    pkg('acp-extension-core', 'packages/acp-extension-core', { test: false, typecheck: false }),
    pkg('acp-extension-dsh', 'packages/acp-extension-dsh', { test: false, typecheck: false }),
    pkg('acp-extension-grok', 'packages/acp-extension-grok', { test: false, typecheck: false }),
  ]);
}

const workspace = syntheticWorkspace();

function select(files, extra = {}) {
  return selectCiScope({
    eventName: 'pull_request',
    labels: [],
    files,
    workspace,
    ...extra,
  });
}

function assertIncludes(actual, expected) {
  for (const value of expected) {
    assert.ok(actual.includes(value), `expected ${actual.join(',')} to include ${value}`);
  }
}

function assertExcludes(actual, forbidden) {
  for (const value of forbidden) {
    assert.ok(!actual.includes(value), `expected ${actual.join(',')} to exclude ${value}`);
  }
}

void test('matchGlob is rooted and expands braces', () => {
  assert.equal(matchGlob('package.json', 'package.json'), true);
  assert.equal(matchGlob('apps/cli/package.json', 'package.json'), false);
  assert.equal(matchGlob('foo.md', '**/*.{md,mdx}'), true);
  assert.equal(matchGlob('a/b.mdx', '**/*.{md,mdx}'), true);
  assert.equal(
    matchGlob(
      'packages/ignore/test/gitignore.test.ts',
      '**/*.{test,spec}.{ts,tsx,js,mjs,cjs,mts,cts}'
    ),
    true
  );
});

void test('1. docs-only skip-tests', () => {
  const scope = select(['README.md', 'specs/foo.md', '.agents/notes/proposed/testing/x.md']);
  assert.equal(scope.mode, 'skip-tests');
  assert.equal(scope.runTests, false);
  assert.equal(scope.runTypecheck, false);
  assert.equal(scope.runCheckQuick, false);
  assert.equal(scope.prepareAcpAdapters, false);
});

void test('2. cli-only source', () => {
  const scope = select(['apps/cli/src/index.ts']);
  assert.equal(scope.mode, 'affected');
  assert.deepEqual(scope.testPackages, ['lody']);
  assertExcludes(scope.testPackages, ['@lody/components', '@lody/electron']);
});

void test('3. components-only source fans out through helper to lody', () => {
  const scope = select(['packages/components/src/index.ts']);
  assert.equal(scope.mode, 'affected');
  assertIncludes(scope.testPackages, [
    '@lody/components',
    '@lody/code-review-helper',
    '@lody/electron',
    '@lody/site-docs',
    'lody',
  ]);
});

void test('4. shared source is near-full affected', () => {
  const scope = select(['packages/shared/src/index.ts']);
  assertIncludes(scope.testPackages, [
    '@lody/shared',
    'lody',
    '@lody/components',
    '@lody/electron',
    '@lody/site-docs',
    '@lody/platform',
  ]);
});

void test('5. lockfile is always-full', () => {
  const scope = select(['pnpm-lock.yaml', 'README.md']);
  assert.equal(scope.mode, 'full');
  assert.match(scope.reason, /always_full:pnpm-lock.yaml/);
  assert.equal(scope.runTests, true);
});

void test('6. root package.json is always-full', () => {
  const scope = select(['package.json']);
  assert.equal(scope.mode, 'full');
});

void test('7. test-only in a leaf does not fan out', () => {
  const scope = select(['packages/ignore/test/gitignore.test.ts']);
  assert.equal(scope.mode, 'affected');
  assert.deepEqual(scope.testPackages, ['@loro-dev/ignore']);
  assert.deepEqual(scope.fanoutPackages, []);
});

void test('8. test-only in a hub does not fan out', () => {
  const scope = select(['packages/shared/tests/foo.test.ts']);
  assert.deepEqual(scope.testPackages, ['@lody/shared']);
  assertExcludes(scope.testPackages, ['lody', '@lody/components']);
  assert.deepEqual(scope.fanoutPackages, []);
});

void test('9. markdown-only inside a package is skip-tests', () => {
  const scope = select(['apps/cli/src/session/AGENTS.md']);
  assert.equal(scope.mode, 'skip-tests');
});

void test('10. runtime markdown exception fans out to lody', () => {
  const scope = select(['packages/code-review-helper/prompts/review-helper-agent.md']);
  assert.equal(scope.mode, 'affected');
  assertIncludes(scope.seedPackages, ['@lody/code-review-helper']);
  assertIncludes(scope.fanoutPackages, ['lody']);
});

void test('10a. imported review fixture is helper test-only', () => {
  const scope = select([
    'packages/code-review-helper/src/stories/fixtures/grouped-refactor.review.md',
  ]);
  assert.equal(scope.mode, 'affected');
  assert.deepEqual(scope.testPackages, ['@lody/code-review-helper']);
  assert.deepEqual(scope.fanoutPackages, []);
});

void test('11. unknown path is full', () => {
  const scope = select(['not-a-real-root-file.bin']);
  assert.equal(scope.mode, 'full');
  assert.match(scope.reason, /unknown:/);
});

void test('12. empty successful diff is skip-tests', () => {
  const scope = select([]);
  assert.equal(scope.mode, 'skip-tests');
  assert.equal(scope.reason, 'empty_diff');
});

void test('13. git failure is full even with docs files', () => {
  const scope = select(['README.md'], { gitError: 'git_diff_failed' });
  assert.equal(scope.mode, 'full');
  assert.equal(scope.reason, 'git_diff_failed');
});

void test('14. site-docs public asset is site-docs test-only', () => {
  const scope = select(['site-docs/public/favicon.ico']);
  assert.equal(scope.mode, 'affected');
  assert.deepEqual(scope.testPackages, ['@lody/site-docs']);
  assert.deepEqual(scope.fanoutPackages, []);
});

void test('14a. site-docs MDX only is not skip-tests', () => {
  const scope = select(['site-docs/content/docs/en/(features)/session-handoff.mdx']);
  assert.equal(scope.mode, 'affected');
  assert.deepEqual(scope.testPackages, ['@lody/site-docs']);
  assert.deepEqual(scope.fanoutPackages, []);
  assert.equal(scope.runCheckQuick, true);
  assert.equal(scope.runTypecheck, true);
});

void test('15. site-docs code seeds site-docs', () => {
  const scope = select(['site-docs/lib/metadata.ts']);
  assert.deepEqual(scope.testPackages, ['@lody/site-docs']);
});

void test('16. locales seed components and electron with fan-out', () => {
  const scope = select(['locales/en.json']);
  assertIncludes(scope.seedPackages, ['@lody/components', '@lody/electron']);
  assertIncludes(scope.fanoutPackages, ['@lody/code-review-helper', 'lody', '@lody/site-docs']);
});

void test('17. e2e only keeps check:quick', () => {
  const scope = select(['e2e/src/steps/lifecycle.steps.ts']);
  assert.equal(scope.mode, 'affected');
  assert.equal(scope.runTests, false);
  assert.equal(scope.runTypecheck, false);
  assert.equal(scope.runCheckQuick, true);
});

void test('18. mixed docs + cli is cli-only affected', () => {
  const scope = select(['README.md', 'apps/cli/src/index.ts']);
  assert.deepEqual(scope.testPackages, ['lody']);
});

void test('19. ci-full label forces full', () => {
  const scope = select(['README.md'], { labels: ['ci-full'] });
  assert.equal(scope.mode, 'full');
  assert.equal(scope.reason, 'ci-full');
});

void test('20. push and workflow_dispatch are full', () => {
  assert.equal(select(['apps/cli/src/index.ts'], { eventName: 'push' }).mode, 'full');
  assert.equal(select(['apps/cli/src/index.ts'], { eventName: 'workflow_dispatch' }).mode, 'full');
});

void test('21. workflow file is always-full', () => {
  assert.equal(select(['.github/workflows/ci.yml']).mode, 'full');
});

void test('22. selector script is always-full', () => {
  assert.equal(select(['.github/scripts/select-ci-scope.mjs']).mode, 'full');
});

void test('23. patches are always-full', () => {
  assert.equal(select(['patches/loro-repo.patch']).mode, 'full');
});

void test('24. configs package is always-full', () => {
  assert.equal(select(['packages/configs/tsconfig.extend.json']).mode, 'full');
});

void test('25. cross-package rename seeds both packages', () => {
  const scope = select(['packages/platform/src/a.ts', 'packages/shared/src/a.ts']);
  assertIncludes(scope.seedPackages, ['@lody/platform', '@lody/shared']);
});

void test('26. deleted source still seeds fan-out', () => {
  const scope = select(['packages/platform/src/gone.ts']);
  assertIncludes(scope.seedPackages, ['@lody/platform']);
  assertIncludes(scope.fanoutPackages, ['@lody/components', 'lody']);
});

void test('29. always-full glob drift and rooted package.json', () => {
  assert.equal(classifyPath('pnpm-lock.yaml', workspace).kind, 'always-full');
  assert.equal(classifyPath('patches/loro-repo.patch', workspace).kind, 'always-full');
  const cliPackage = classifyPath('apps/cli/package.json', workspace);
  assert.equal(cliPackage.kind, 'source');
  assert.deepEqual(cliPackage.packages, ['lody']);
  const locales = classifyPath('locales/en.json', workspace);
  assert.equal(locales.kind, 'source');
  assert.deepEqual(locales.packages, ['@lody/components', '@lody/electron']);
  assert.equal(matchGlob('apps/cli/package.json', 'package.json'), false);
});

void test('30. kimi submodule is always-full', () => {
  assert.equal(select(['packages/acp-extension-kimi']).mode, 'full');
});

void test('31. cli-supervisor source tests lody and electron', () => {
  const scope = select(['packages/cli-supervisor/src/index.ts']);
  assertIncludes(scope.testPackages, ['@lody/cli-supervisor', '@lody/electron', 'lody']);
});

void test('32. cloud-api source has no own tests and fans out', () => {
  const scope = select(['packages/cloud-api/src/index.ts']);
  assert.deepEqual(
    scope.testPackages.sort(),
    [
      '@lody/code-review-helper',
      '@lody/components',
      '@lody/electron',
      '@lody/site-docs',
      'lody',
    ].sort()
  );
});

void test('33. workspace YAML parser ignores catalog and quoted exclusions', () => {
  const globs = parseWorkspacePackageGlobs(`packages:
  - packages/*
  - '!packages/acp-extension-kimi'
  - apps/cli
catalog:
  zod: 1
overrides:
  foo: bar
`);
  assert.deepEqual(globs, ['packages/*', '!packages/acp-extension-kimi', 'apps/cli']);
  assert.ok(!globs.includes('zod: 1'));
});

void test('33b. loadWorkspace on the real repo does not throw on missing ACP package.json', () => {
  const loaded = loadWorkspace(REPO_ROOT);
  assert.ok(loaded.byName.get('lody'));
  assert.ok(loaded.byName.get('@lody/components'));
  assert.ok(loaded.byName.has('acp-extension-core'));
  const mapped = classifyPath('packages/acp-extension-core/src/foo.ts', loaded);
  assert.equal(mapped.kind, 'source');
  assert.deepEqual(mapped.packages, ['acp-extension-core']);
});

void test('34. components test-only still prepares adapters', () => {
  const scope = select(['packages/components/tests/foo.test.ts']);
  assert.equal(scope.runTests, true);
  assert.equal(scope.prepareAcpAdapters, true);
  assert.deepEqual(scope.fanoutPackages, []);
});

void test('35. missing GITHUB_OUTPUT keys throw before write', () => {
  assert.throws(() => formatGithubOutput({ mode: 'full', reason: 'x' }), /missing/);
  const chunks = [];
  assert.throws(
    () =>
      writeGithubOutput({ mode: 'full', reason: 'x' }, { write: (chunk) => chunks.push(chunk) }),
    /missing/
  );
  assert.deepEqual(chunks, []);
});

void test('35b. complete scope writes every required key', () => {
  const scope = select(['apps/cli/src/index.ts']);
  const body = formatGithubOutput(scope);
  assert.match(body, /^mode=affected$/m);
  assert.match(body, /^run_tests=true$/m);
  assert.match(body, /^run_typecheck=true$/m);
  assert.match(body, /^run_check_quick=true$/m);
  assert.match(body, /^prepare_acp_adapters=true$/m);
  assert.match(body, /^test_packages=/m);
  assert.match(body, /^typecheck_packages=/m);
});

void test('36. helper source does not typecheck the viewer', () => {
  const scope = select(['packages/code-review-helper/src/index.ts']);
  assertExcludes(scope.typecheckPackages, ['lody-code-review-viewer']);
  assertIncludes(scope.fanoutPackages, ['lody']);
});

void test('excluded ACP packages never appear in testPackages', () => {
  const scope = select(['packages/shared/src/index.ts']);
  assertExcludes(scope.testPackages, EXCLUDED_PACKAGES);
});

void test('parseNameStatusZ expands renames to both paths', () => {
  const files = parseNameStatusZ(
    Buffer.from('R100\0packages/platform/src/a.ts\0packages/shared/src/a.ts\0')
  );
  assert.deepEqual(files, ['packages/platform/src/a.ts', 'packages/shared/src/a.ts']);
});

void test("listChangedFiles fail-open is the caller's job when exec throws", () => {
  assert.throws(() =>
    listChangedFiles({
      baseSha: 'aaa',
      headSha: 'bbb',
      execFileSync() {
        throw new Error('fetch failed');
      },
    })
  );
});

void test('platform source log includes helper and site-docs', () => {
  const scope = select(['packages/platform/src/index.ts']);
  assertIncludes(scope.fanoutPackages, [
    '@lody/components',
    '@lody/code-review-helper',
    '@lody/electron',
    '@lody/site-docs',
    'lody',
  ]);
});
