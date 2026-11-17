import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = fileURLToPath(
  new URL('../../scripts/prebuild-native.py', import.meta.url),
);
const available = spawnSync('xcodegen', ['--version']).status === 0;

async function fixture() {
  const mobile = await realpath(await mkdtemp(join(tmpdir(), 'lody-project-')));
  const root = join(mobile, 'ios/apps/ios');
  await mkdir(root, { recursive: true });
  await mkdir(join(root, 'scripts'));
  await copyFile(
    new URL('../../../../../backend-config.mjs', import.meta.url),
    join(mobile, 'backend-config.mjs'),
  );
  await mkdir(join(root, 'App'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ version: '2.3.4' }),
  );
  await writeFile(
    join(root, 'App/Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleVersion</key><string>1</string><key>LodyOneSignalAppId</key><string>original</string></dict></plist>',
  );
  await writeFile(join(root, 'App/Main.swift'), 'struct App {}');
  const targets = {};
  for (const name of ['Lody', 'LodyShare', 'LodyNotificationService']) {
    targets[name] = {
      type: 'application',
      platform: 'iOS',
      sources: ['App'],
      ...(name === 'Lody'
        ? {}
        : { info: { path: `.generated/${name}/Info.plist` } }),
    };
  }
  await writeFile(
    join(root, 'project.yml'),
    JSON.stringify({ name: 'Lody', targets }),
  );
  return root;
}

function generate(root, environment = {}) {
  return spawnSync(
    'python3',
    [
      '-c',
      'import json, runpy, sys; from pathlib import Path; runpy.run_path(sys.argv[1])["generate"](Path(sys.argv[2]), json.loads(sys.argv[3]))',
      script,
      root,
      JSON.stringify({ PATH: process.env.PATH, ...environment }),
    ],
    { encoding: 'utf8' },
  );
}

function plist(path) {
  const result = spawnSync('plutil', ['-convert', 'json', '-o', '-', path], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test(
  'regeneration adds new Swift sources and stamps the app version without modifying source inputs',
  { skip: !available },
  async () => {
    const root = await fixture();
    try {
      const source = await readFile(join(root, 'App/Info.plist'), 'utf8');
      let result = generate(root, {
        BUILD_NUMBER: '42',
        LODY_ONESIGNAL_APP_ID: 'configured',
      });
      assert.equal(result.status, 0, result.stderr);
      const info = plist(join(root, '.generated/Lody/Info.plist'));
      assert.equal(info.CFBundleShortVersionString, '2.3.4');
      assert.equal(info.CFBundleVersion, '42');
      assert.equal(info.LodyOneSignalAppId, 'configured');
      assert.equal(
        await readFile(join(root, 'App/Info.plist'), 'utf8'),
        source,
      );
      await writeFile(join(root, 'App/NewScreen.swift'), 'struct NewScreen {}');
      result = generate(root);
      assert.equal(result.status, 0, result.stderr);
      const project = plist(join(root, 'Lody.xcodeproj/project.pbxproj'));
      const objects = Object.values(project.objects);
      const file = Object.entries(project.objects).find(
        ([, value]) =>
          value.isa === 'PBXFileReference' && value.path === 'NewScreen.swift',
      );
      assert.ok(file, 'New source is missing from the generated project');
      assert.ok(
        objects.some(
          (value) => value.isa === 'PBXBuildFile' && value.fileRef === file[0],
        ),
        'New source is not included in the build',
      );
    } finally {
      await rm(join(root, '../../..'), { recursive: true, force: true });
    }
  },
);

test(
  'release profiles affect Release signing only and incomplete coverage is rejected',
  { skip: !available },
  async () => {
    const root = await fixture();
    try {
      const profiles = {
        'ai.lody.mobile': 'app-profile',
        'ai.lody.mobile.share': 'share-profile',
        'ai.lody.mobile.notification-service': 'push-profile',
      };
      let result = generate(root, {
        IOS_PROFILE_MAP: JSON.stringify({ 'ai.lody.mobile': 'app-profile' }),
        APPLE_TEAM_ID: 'TEAM',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /profiles must cover exactly/);
      result = generate(root, {
        IOS_PROFILE_MAP: JSON.stringify(profiles),
        APPLE_TEAM_ID: 'TEAM',
      });
      assert.equal(result.status, 0, result.stderr);
      const project = plist(join(root, 'Lody.xcodeproj/project.pbxproj'));
      const configurations = Object.values(project.objects).filter(
        (value) => value.isa === 'XCBuildConfiguration',
      );
      const signed = configurations.filter(
        (value) => value.buildSettings.PROVISIONING_PROFILE_SPECIFIER,
      );
      assert.equal(signed.length, 3);
      assert.deepEqual(
        signed
          .map((value) => value.buildSettings.PROVISIONING_PROFILE_SPECIFIER)
          .sort(),
        Object.values(profiles).sort(),
      );
      for (const config of signed) {
        assert.equal(config.name, 'Release');
        assert.equal(config.buildSettings.CODE_SIGN_STYLE, 'Manual');
        assert.equal(config.buildSettings.DEVELOPMENT_TEAM, 'TEAM');
      }
      assert.ok(
        configurations
          .filter((value) => value.name === 'Debug')
          .every(
            (value) => !value.buildSettings.PROVISIONING_PROFILE_SPECIFIER,
          ),
      );
    } finally {
      await rm(join(root, '../../..'), { recursive: true, force: true });
    }
  },
);
