import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function desktopBuildArtifacts(root: string, profile = 'release') {
  if (!['release', 'test-build'].includes(profile)) throw new Error('Unknown E2E build profile');
  const out =
    profile === 'test-build'
      ? join(root, '.test-build/electron/out')
      : join(root, 'apps/electron/out');
  if (profile === 'test-build') {
    for (const section of ['main', 'preload', 'renderer']) {
      assert.deepEqual(
        JSON.parse(readFileSync(join(out, section, 'test-build.json'), 'utf8')),
        { profile: 'test-build', version: 1 },
        'E2E requires marked test-build output'
      );
    }
  }
  return { profile, main: join(out, 'main/index.js'), renderer: join(out, 'renderer/index.html') };
}
