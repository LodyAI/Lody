import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const installer = path.join(
  repositoryRoot,
  '.github/scripts/install-app-store-profiles.sh',
);

test('reuses matching profiles and replaces invalid profiles without creating certificates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lody-signing-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const runnerTemp = path.join(root, 'runner');
  const githubEnv = path.join(root, 'github-env');
  const log = path.join(root, 'asc-log');
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(runnerTemp, { recursive: true }),
  ]);

  const fakeAsc = path.join(bin, 'asc');
  await writeFile(
    fakeAsc,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_ASC_LOG, JSON.stringify(args) + '\\n');

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function print(value) {
  process.stdout.write(JSON.stringify(value));
}

const command = args.slice(0, 2).join(' ');
if (command === 'certificates list') {
  print({
    data: [{
      type: 'certificates',
      id: 'cert-current',
      attributes: {
        name: 'Apple Distribution: Example',
        certificateType: 'DISTRIBUTION',
        displayName: 'Example',
        serialNumber: 'A1B2C3',
        expirationDate: '2027-09-01T00:00:00Z',
        certificateContent: 'certificate',
      },
      relationships: {},
      links: { self: 'https://example.test/certificates/cert-current' },
    }],
    links: { self: 'https://example.test/certificates' },
    meta: { paging: { total: 1, limit: 200 } },
  });
} else if (command === 'bundle-ids list') {
  print({
    data: [
      {
        type: 'bundleIds',
        id: 'bundle-app',
        attributes: {
          name: 'Lody',
          identifier: 'ai.lody.mobile',
          platform: 'UNIVERSAL',
          seedId: 'TEAM123',
        },
        relationships: {},
        links: { self: 'https://example.test/bundleIds/bundle-app' },
      },
      {
        type: 'bundleIds',
        id: 'bundle-extension',
        attributes: {
          name: 'Lody Notification Service',
          identifier: 'ai.lody.mobile.notification-service',
          platform: 'UNIVERSAL',
          seedId: 'TEAM123',
        },
        relationships: {},
        links: { self: 'https://example.test/bundleIds/bundle-extension' },
      },
    ],
    links: { self: 'https://example.test/bundleIds' },
    meta: { paging: { total: 2, limit: 200 } },
  });
} else if (command === 'profiles list') {
  const activeProfile = {
    type: 'profiles',
    id: 'profile-app',
    attributes: {
      name: 'ai.lody.mobile CI App Store 40',
      platform: 'IOS',
      profileType: 'IOS_APP_STORE',
      profileState: 'ACTIVE',
      profileContent: 'profile',
      uuid: 'APP-UUID',
      createdDate: '2026-09-08T00:00:00Z',
      expirationDate: '2027-09-08T00:00:00Z',
    },
    relationships: {},
    links: { self: 'https://example.test/profiles/profile-app' },
  };
  const invalidProfile = {
    type: 'profiles',
    id: 'profile-extension-invalid',
    attributes: {
      name: 'Lody Notification Service App Store',
      platform: 'IOS',
      profileType: 'IOS_APP_STORE',
      profileState: 'INVALID',
      profileContent: 'profile',
      uuid: 'OLD-EXTENSION-UUID',
      createdDate: '2026-09-07T00:00:00Z',
      expirationDate: '2027-09-07T00:00:00Z',
    },
    relationships: {},
    links: {
      self: 'https://example.test/profiles/profile-extension-invalid',
    },
  };
  const includeInvalid = option('--profile-state') === 'ACTIVE,INVALID';
  print({
    data: includeInvalid
      ? [activeProfile, invalidProfile]
      : [activeProfile],
    links: { self: 'https://example.test/profiles' },
    meta: { paging: { total: includeInvalid ? 2 : 1, limit: 200 } },
  });
} else if (command === 'profiles view' && option('--id') === 'profile-app') {
  print({
    data: {
      type: 'profiles',
      id: 'profile-app',
      attributes: {
        name: 'ai.lody.mobile CI App Store 40',
        platform: 'IOS',
        profileType: 'IOS_APP_STORE',
        profileState: 'ACTIVE',
        profileContent: 'profile',
        uuid: 'APP-UUID',
        createdDate: '2026-09-08T00:00:00Z',
        expirationDate: '2027-09-08T00:00:00Z',
      },
      relationships: {},
      links: { self: 'https://example.test/profiles/profile-app' },
    },
    included: [
      {
        type: 'certificates',
        id: 'cert-current',
        attributes: {
          certificateType: 'DISTRIBUTION',
          serialNumber: 'A1B2C3',
        },
      },
      {
        type: 'bundleIds',
        id: 'bundle-app',
        attributes: {
          identifier: 'ai.lody.mobile',
        },
      },
    ],
  });
} else if (command === 'profiles view' && option('--id') === 'profile-extension-invalid') {
  print({
    data: {
      type: 'profiles',
      id: 'profile-extension-invalid',
      attributes: {
        name: 'Lody Notification Service App Store',
        platform: 'IOS',
        profileType: 'IOS_APP_STORE',
        profileState: 'INVALID',
        profileContent: 'profile',
        uuid: 'OLD-EXTENSION-UUID',
        createdDate: '2026-09-07T00:00:00Z',
        expirationDate: '2027-09-07T00:00:00Z',
      },
      relationships: {},
      links: {
        self: 'https://example.test/profiles/profile-extension-invalid',
      },
    },
    included: [
      {
        type: 'certificates',
        id: 'cert-current',
        attributes: {
          certificateType: 'DISTRIBUTION',
          serialNumber: 'A1B2C3',
        },
      },
      {
        type: 'bundleIds',
        id: 'bundle-extension',
        attributes: {
          identifier: 'ai.lody.mobile.notification-service',
        },
      },
    ],
  });
} else if (command === 'profiles create') {
  print({
    data: {
      type: 'profiles',
      id: 'profile-extension',
      attributes: {
        name: option('--name'),
        platform: 'IOS',
        profileType: 'IOS_APP_STORE',
        profileState: 'ACTIVE',
        profileContent: 'profile',
        uuid: 'EXTENSION-UUID',
        createdDate: '2026-09-09T00:00:00Z',
        expirationDate: '2027-09-09T00:00:00Z',
      },
      relationships: {},
      links: { self: 'https://example.test/profiles/profile-extension' },
    },
  });
} else if (command === 'profiles download') {
  writeFileSync(option('--output'), option('--id'));
  print({ id: option('--id'), path: option('--output') });
} else if (command === 'profiles inspect') {
  const profileId = readFileSync(option('--path'), 'utf8');
  const extension = profileId === 'profile-extension';
  const bundleId = extension
    ? 'ai.lody.mobile.notification-service'
    : 'ai.lody.mobile';
  print({
    path: option('--path'),
    uuid: extension ? 'EXTENSION-UUID' : 'APP-UUID',
    name: extension
      ? 'ai.lody.mobile.notification-service CI App Store 41'
      : 'ai.lody.mobile CI App Store 40',
    appIdName: extension ? 'Lody Notification Service' : 'Lody',
    teamId: 'TEAM123',
    teamName: 'Example',
    bundleId,
    applicationIdentifier: \`TEAM123.\${bundleId}\`,
    platforms: ['iOS'],
    createdAt: '2026-09-09T00:00:00Z',
    expiresAt: '2027-09-09T00:00:00Z',
    expired: false,
    timeToLive: 365,
    provisionedDeviceCount: 0,
    provisionsAllDevices: false,
    certificates: [],
    entitlements: {
      'application-identifier': \`TEAM123.\${bundleId}\`,
      'get-task-allow': false,
    },
  });
} else if (command === 'profiles delete') {
  print({ deleted: option('--id') });
} else {
  process.stderr.write(\`Unexpected asc invocation: \${args.join(' ')}\\n\`);
  process.exit(2);
}
`,
  );
  await chmod(fakeAsc, 0o755);

  const result = spawnSync('/bin/bash', [installer], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      APPLE_TEAM_ID: 'TEAM123',
      FAKE_ASC_LOG: log,
      GITHUB_ENV: githubEnv,
      GITHUB_RUN_ID: '41',
      HOME: home,
      IOS_DIST_CERT_SERIAL: 'a1:b2:c3',
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp,
      TARGET_BUNDLE_IDS: 'ai.lody.mobile\nai.lody.mobile.notification-service',
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const environment = await readFile(githubEnv, 'utf8');
  assert.equal(
    environment.trim(),
    'IOS_PROFILE_MAP={"ai.lody.mobile":"APP-UUID","ai.lody.mobile.notification-service":"EXTENSION-UUID"}',
  );

  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const createCalls = calls.filter(
    ([resource, action]) => resource === 'profiles' && action === 'create',
  );
  assert.deepEqual(createCalls, [
    [
      'profiles',
      'create',
      '--name',
      'ai.lody.mobile.notification-service CI App Store 41',
      '--profile-type',
      'IOS_APP_STORE',
      '--bundle',
      'bundle-extension',
      '--certificate',
      'cert-current',
      '--output',
      'json',
    ],
  ]);
  const deleteCalls = calls.filter(
    ([resource, action]) => resource === 'profiles' && action === 'delete',
  );
  assert.deepEqual(deleteCalls, [
    ['profiles', 'delete', '--id', 'profile-extension-invalid', '--confirm'],
  ]);
  const certificateCreateCalls = calls.filter(
    ([resource, action]) => resource === 'certificates' && action === 'create',
  );
  assert.deepEqual(certificateCreateCalls, []);

  await Promise.all([
    access(
      path.join(
        home,
        'Library/MobileDevice/Provisioning Profiles/APP-UUID.mobileprovision',
      ),
    ),
    access(
      path.join(
        home,
        'Library/Developer/Xcode/UserData/Provisioning Profiles/EXTENSION-UUID.mobileprovision',
      ),
    ),
  ]);
});
