import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

void test('native credential namespace must be re-audited when auth dependencies change', () => {
  const audited = { 'better-auth-capacitor': '0.3.6', '@capacitor/preferences': '8.0.1' };
  for (const [name, version] of Object.entries(audited)) {
    const installed = JSON.parse(
      readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')
    );
    assert.equal(installed.version, version, `Re-audit native reset storage ownership for ${name}`);
  }
  const workspace = readFileSync(new URL('../../../pnpm-workspace.yaml', import.meta.url), 'utf8');
  assert.equal(
    workspace.match(/^\s+better-auth-capacitor:\s*(\S+)/m)?.[1],
    audited['better-auth-capacitor'],
    'Catalog changed: re-audit auth storage and update this deliberate compatibility gate'
  );
});

void test('native credential policy handles recreated cookies and bounds failed boots', (t) => {
  const compiler = spawnSync('swiftc', ['--version'], { encoding: 'utf8' });
  if (compiler.error?.code === 'ENOENT') {
    t.skip('Swift compiler unavailable; run on macOS before merging');
    return;
  }
  assert.equal(compiler.status, 0, compiler.stderr);
  const dir = mkdtempSync(join(tmpdir(), 'lody-native-reset-'));
  try {
    const main = join(dir, 'main.swift');
    copyFileSync(new URL('../tests/native-reset-credentials.swift', import.meta.url), main);
    const executable = join(dir, 'native-reset-test');
    const compiled = spawnSync(
      'swiftc',
      [
        '-module-cache-path',
        join(dir, 'cache'),
        fileURLToPath(new URL('../ios/App/App/LodyNativeResetCredentials.swift', import.meta.url)),
        main,
        '-o',
        executable,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = spawnSync(executable, [], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
