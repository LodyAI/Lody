import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const buildModeGuard = join(
  repoRoot,
  '.github/scripts/verify-ios-build-mode.sh',
);
const linkageGuard = join(
  repoRoot,
  '.github/scripts/verify-apple-bundle-linkage.sh',
);

function runGuard(script, args, env = {}) {
  return spawnSync('/bin/bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function touch(path, contents = '') {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

test('native builds reject any React Native, Expo, or Hermes pod', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lody-build-mode-'));
  const iosDirectory = join(directory, 'ios');
  try {
    await touch(
      join(iosDirectory, 'Lody.xcodeproj/project.pbxproj'),
      '// native project',
    );
    assert.equal(runGuard(buildModeGuard, [iosDirectory]).status, 0);
    for (const name of ['React-Core', 'ExpoModulesCore', 'hermes-engine']) {
      await mkdir(join(iosDirectory, 'Pods', name), { recursive: true });
      assert.notEqual(runGuard(buildModeGuard, [iosDirectory]).status, 0, name);
      await rm(join(iosDirectory, 'Pods'), { recursive: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects an app whose framework dependency is not embedded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lody-linkage-'));
  const app = join(directory, 'Lody.app');
  const tools = join(directory, 'tools');
  const fileTool = join(tools, 'file');
  const otool = join(tools, 'otool');
  try {
    await touch(join(app, 'Lody'));
    await touch(
      join(app, 'Frameworks/ExpoModulesWorklets.framework/ExpoModulesWorklets'),
    );
    await touch(
      fileTool,
      '#!/bin/bash\nprintf "Mach-O 64-bit dynamically linked shared library arm64\\n"\n',
    );
    await touch(
      otool,
      `#!/bin/bash
binary="$2"
printf '%s:\\n' "$binary"
case "$binary" in
  */ExpoModulesWorklets)
    printf '\\t@rpath/ExpoModulesWorklets.framework/ExpoModulesWorklets (compatibility version 1.0.0, current version 1.0.0)\\n'
    printf '\\t@rpath/React.framework/React (compatibility version 1.0.0, current version 1.0.0)\\n'
    printf '\\t@rpath/libswiftCore.dylib (compatibility version 1.0.0, current version 1.0.0)\\n'
    ;;
esac
`,
    );
    await chmod(fileTool, 0o755);
    await chmod(otool, 0o755);

    const missing = runGuard(linkageGuard, [app], {
      FILE_BIN: fileTool,
      OTOOL_BIN: otool,
    });
    assert.notEqual(missing.status, 0);
    assert.match(
      `${missing.stdout}${missing.stderr}`,
      /React\.framework\/React/,
    );

    await touch(join(app, 'Frameworks/React.framework/React'));
    const complete = runGuard(linkageGuard, [app], {
      FILE_BIN: fileTool,
      OTOOL_BIN: otool,
    });
    assert.equal(complete.status, 0, complete.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native builds reject stale framework references without Pods', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lody-build-mode-'));
  try {
    await touch(
      join(directory, 'Lody.xcodeproj/project.pbxproj'),
      'React.framework in Frameworks',
    );
    assert.notEqual(runGuard(buildModeGuard, [directory]).status, 0);
    await writeFile(
      join(directory, 'Lody.xcodeproj/project.pbxproj'),
      'LodyKit.framework in Frameworks',
    );
    assert.equal(runGuard(buildModeGuard, [directory]).status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
