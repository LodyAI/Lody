import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const script = join(repoRoot, 'apps/ios/scripts/check-native-sources.py');

function run(cwd, env = {}) {
  return spawnSync('python3', [script], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  });
}

async function write(path, contents = '') {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

test('passes when every Xcode-managed native source is linked in the native project', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lody-native-sources-'));
  try {
    await write(join(directory, 'pnpm-workspace.yaml'), 'packages: []\n');
    await mkdir(join(directory, 'apps/ios/Extensions'), { recursive: true });
    await write(
      join(directory, 'apps/ios/App/Chat/Cell.swift'),
      'enum Cell {}\n',
    );
    await write(
      join(directory, 'apps/ios/App/Chat/Shaders/Particles.metal'),
      '',
    );
    const pbxproj = join(directory, 'apps/ios/Lody.xcodeproj/project.pbxproj');
    await write(
      pbxproj,
      [
        '/* Cell.swift in Sources */',
        '/* Particles.metal in Sources */',
        '',
      ].join('\n'),
    );
    const result = run(directory, { PROJECT_FILE_PATH: pbxproj });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails when a new Swift file is not in the app compile sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lody-native-sources-'));
  try {
    await write(join(directory, 'pnpm-workspace.yaml'), 'packages: []\n');
    await mkdir(join(directory, 'apps/ios/Extensions'), { recursive: true });
    await write(
      join(directory, 'apps/ios/App/Chat/Cell.swift'),
      'enum Cell {}\n',
    );
    await write(
      join(directory, 'apps/ios/App/Chat/Gallery.swift'),
      'enum Gallery {}\n',
    );
    const pbxproj = join(directory, 'apps/ios/Lody.xcodeproj/project.pbxproj');
    await write(pbxproj, ['/* Cell.swift in Sources */', ''].join('\n'));
    const result = run(directory, { PROJECT_FILE_PATH: pbxproj });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Gallery\.swift/);
    assert.match(result.stderr, /pnpm prebuild/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('skips when the generated native project is absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lody-native-sources-'));
  try {
    await write(join(directory, 'pnpm-workspace.yaml'), 'packages: []\n');
    await mkdir(join(directory, 'apps/ios/Extensions'), { recursive: true });
    await write(
      join(directory, 'apps/ios/App/Chat/Cell.swift'),
      'enum Cell {}\n',
    );
    const result = run(directory);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a broken shared source link even when the project lists it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lody-native-sources-'));
  try {
    await write(join(directory, 'pnpm-workspace.yaml'), 'packages: []\n');
    await mkdir(join(directory, 'apps/ios/Extensions'), { recursive: true });
    const sources = join(directory, 'apps/ios/App');
    await mkdir(sources, { recursive: true });
    await symlink('../missing/Shared.swift', join(sources, 'Shared.swift'));
    await write(
      join(directory, 'apps/ios/Lody.xcodeproj/project.pbxproj'),
      '/* Shared.swift in Sources */',
    );
    const result = run(directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Shared\.swift/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('checks source membership when Xcode supplies a project directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lody-native-sources-'));
  try {
    await write(join(directory, 'pnpm-workspace.yaml'), 'packages: []\n');
    await mkdir(join(directory, 'apps/ios/Extensions'), { recursive: true });
    await write(
      join(directory, 'apps/ios/App/NewScreen.swift'),
      'struct NewScreen {}',
    );
    const project = join(directory, 'apps/ios/Lody.xcodeproj');
    await write(join(project, 'project.pbxproj'), '// Empty source phase');
    const result = run(directory, { PROJECT_FILE_PATH: project });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /NewScreen\.swift/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
