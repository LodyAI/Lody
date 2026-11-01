import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopBuildArtifacts } from './build-artifacts.js';

void test('test desktop selection requires all profile markers and never falls back to release', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-build-selection-'));
  try {
    assert.equal(desktopBuildArtifacts(root).main, join(root, 'apps/electron/out/main/index.js'));
    assert.throws(() => desktopBuildArtifacts(root, 'invalid'), /Unknown/);
    assert.throws(() => desktopBuildArtifacts(root, 'test-build'));
    for (const section of ['main', 'preload', 'renderer']) {
      const dir = join(root, '.test-build/electron/out', section);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'test-build.json'),
        JSON.stringify({ profile: 'test-build', version: 1 })
      );
    }
    const selected = desktopBuildArtifacts(root, 'test-build');
    assert.equal(selected.main, join(root, '.test-build/electron/out/main/index.js'));
    assert.equal(selected.renderer, join(root, '.test-build/electron/out/renderer/index.html'));
    writeFileSync(
      join(root, '.test-build/electron/out/preload/test-build.json'),
      JSON.stringify({ profile: 'release', version: 1 })
    );
    assert.throws(() => desktopBuildArtifacts(root, 'test-build'), /marked test-build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
