import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { platforms, publishDaemonRelease } from './sea-publish.mjs';
import { selectDaemonBuildArtifact, SEA_FREEZE_STEP } from './sea-retry.mjs';
import {
  makeMacSigningKeychainSearchable,
  requireAcceptedNotarization,
  selectMacSigningIdentity,
} from './sea-signing.mjs';

test('macOS daemon signing accepts the Electron certificate qualifier and signs by its P12 fingerprint', () => {
  const fingerprint = 'a'.repeat(40);
  const identities = `  1) ${fingerprint} "Developer ID Application: Example Company (TEAM123456)"\n     1 valid identities found\n`;
  assert.equal(
    selectMacSigningIdentity(identities, ' Example Company (TEAM123456)\n'),
    fingerprint.toUpperCase()
  );
  assert.equal(selectMacSigningIdentity(identities, fingerprint), fingerprint.toUpperCase());
});

test('macOS daemon publication rejects missing, ambiguous or development-only signing identities', () => {
  const first = `  1) ${'a'.repeat(40)} "Developer ID Application: Example Company (TEAM123456)"\n`;
  const second = `  2) ${'b'.repeat(40)} "Developer ID Application: Example Company (TEAM123456)"\n`;
  const development = `  1) ${'c'.repeat(40)} "Apple Development: Example Company (TEAM123456)"\n`;
  for (const identities of ['', development, first + second])
    assert.throws(
      () => selectMacSigningIdentity(identities, 'Example Company'),
      /exactly one valid Developer ID Application/
    );
  assert.throws(
    () => selectMacSigningIdentity(first, 'Another Company'),
    /exactly one valid Developer ID Application/
  );
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture(version = '1.2.3-nightly.2') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-sea-publish-'));
  const source = 'a'.repeat(40),
    channel = 'nightly';
  for (const platform of platforms) {
    const dir = path.join(directory, platform);
    fs.mkdirSync(dir);
    const raw = Buffer.from('synthetic frozen executable'),
      bytes = gzipSync(raw);
    fs.writeFileSync(path.join(dir, 'daemon.gz'), bytes);
    fs.writeFileSync(path.join(dir, 'node.gz'), bytes);
    const artifact = {
      file: 'daemon.gz',
      sha256: sha(bytes),
      size: bytes.length,
      contentSha256: sha(raw),
      contentSize: raw.length,
    };
    const manifest = {
      format: 1,
      product: 'lody-cloud',
      distribution: 'lody-cloud-daemon',
      version,
      channel,
      platform,
      source,
      serviceProtocol: 1,
      dataFormat: 1,
      capsule: artifact,
      node: { ...artifact, file: 'node.gz' },
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  }
  const objects = new Map();
  let revision = 0;
  const store = {
    async get(key) {
      return objects.get(key) ?? null;
    },
    async put(key, bytes, condition) {
      const current = objects.get(key);
      if (condition.absent && current) throw new Error('PreconditionFailed');
      if (condition.etag && condition.etag !== current?.etag) throw new Error('PreconditionFailed');
      objects.set(key, { bytes, etag: String(++revision) });
    },
  };
  return { directory, source, channel, version, store, objects };
}
test('unsigned Windows artifacts publish with the full matrix, immutable retries preserve bytes, older nightly cannot downgrade', async () => {
  const f = fixture(),
    old = fixture('1.2.3-nightly.1');
  try {
    await publishDaemonRelease(f);
    assert.equal(f.objects.size, 24);
    const frozen = new Map(f.objects);
    await publishDaemonRelease(f);
    assert.deepEqual(f.objects, frozen);
    await publishDaemonRelease({ ...old, store: f.store });
    for (const platform of platforms)
      assert.equal(
        JSON.parse(
          f.objects.get(`runtimes/lody-cloud-daemon/channels/${platform}/nightly.json`).bytes
        ).version,
        f.version
      );
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
    fs.rmSync(old.directory, { recursive: true, force: true });
  }
});
test('an incomplete matrix or failed upload never advances a channel', async () => {
  const f = fixture();
  try {
    const put = f.store.put;
    f.store.put = async (key, ...args) => {
      if (key.includes('linux-x64/node.gz')) throw new Error('upload failed');
      return put(key, ...args);
    };
    await assert.rejects(publishDaemonRelease(f), /upload failed/);
    assert.equal(
      [...f.objects.keys()].some((key) => key.includes('/channels/')),
      false
    );
    fs.rmSync(path.join(f.directory, 'win32-arm64', 'manifest.json'));
    await assert.rejects(publishDaemonRelease(f));
    assert.equal(
      [...f.objects.keys()].some((key) => key.includes('/channels/')),
      false
    );
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
test('tampered frozen files and same-version conflicts cannot overwrite released bytes', async () => {
  const f = fixture();
  try {
    await publishDaemonRelease(f);
    const key = `runtimes/lody-cloud-daemon/${f.version}/darwin-arm64/daemon.gz`,
      original = f.objects.get(key).bytes;
    fs.writeFileSync(path.join(f.directory, 'darwin-arm64', 'daemon.gz'), 'different');
    await assert.rejects(publishDaemonRelease(f), /Frozen artifact/);
    assert.deepEqual(f.objects.get(key).bytes, original);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test('a transient pre-freeze failure can retry without rebuilding an existing frozen platform', () => {
  const input = {
    artifacts: [],
    jobs: [],
    artifactName: 'daemon-sea-1-linux-x64',
    jobName: 'SEA build linux-x64',
    runAttempt: 1,
  };
  assert.equal(selectDaemonBuildArtifact(input), 0);
  const jobs = [
    {
      name: 'publish-daemon / SEA build linux-x64',
      run_attempt: 1,
      conclusion: 'failure',
      steps: [
        {
          name: 'Build exact cloud composition and stage complete runtime closure',
          conclusion: 'failure',
        },
        { name: SEA_FREEZE_STEP, conclusion: 'skipped' },
      ],
    },
  ];
  assert.equal(selectDaemonBuildArtifact({ ...input, jobs, runAttempt: 2 }), 0);
  assert.equal(
    selectDaemonBuildArtifact({
      ...input,
      jobs: [{ name: 'validate', run_attempt: 1, conclusion: 'failure', steps: [] }],
      runAttempt: 2,
    }),
    0
  );
  const artifacts = [{ name: input.artifactName, id: 101, expired: false }];
  assert.equal(selectDaemonBuildArtifact({ ...input, artifacts, jobs, runAttempt: 2 }), 101);
});

test('lost frozen bytes and unprovable freeze history never authorize a same-version rebuild', () => {
  const input = {
    artifacts: [],
    jobs: [],
    artifactName: 'daemon-sea-1-linux-x64',
    jobName: 'SEA build linux-x64',
    runAttempt: 2,
  };
  const frozen = {
    name: input.jobName,
    run_attempt: 1,
    conclusion: 'failure',
    steps: [{ name: SEA_FREEZE_STEP, conclusion: 'success' }],
  };
  assert.throws(() => selectDaemonBuildArtifact({ ...input, jobs: [frozen] }), /Previously frozen/);
  assert.throws(
    () =>
      selectDaemonBuildArtifact({
        ...input,
        jobs: [{ ...frozen, conclusion: 'success', steps: [] }],
      }),
    /Previously frozen/
  );
  assert.throws(() => selectDaemonBuildArtifact(input), /unavailable/);
  assert.throws(
    () =>
      selectDaemonBuildArtifact({
        ...input,
        jobs: [{ name: input.jobName, run_attempt: 1, conclusion: 'failure' }],
      }),
    /Incomplete/
  );
  const artifact = { name: input.artifactName, id: 101, expired: false };
  assert.throws(
    () => selectDaemonBuildArtifact({ ...input, artifacts: [{ ...artifact, expired: true }] }),
    /expired/
  );
  assert.throws(
    () => selectDaemonBuildArtifact({ ...input, artifacts: [artifact, { ...artifact, id: 102 }] }),
    /Ambiguous/
  );
});

test('macOS daemon publication requires Apple Accepted status even when notarytool exits successfully', () => {
  requireAcceptedNotarization(JSON.stringify({ id: 'synthetic-submission', status: 'Accepted' }));
  for (const status of ['Invalid', 'Rejected', 'In Progress', undefined])
    assert.throws(() => requireAcceptedNotarization(JSON.stringify({ status })), /not accepted/);
  assert.throws(() => requireAcceptedNotarization('not JSON'));
});

test('macOS daemon signing exposes its temporary keychain and cleanup preserves other search entries', () => {
  const existing = '/synthetic/login.keychain-db';
  const own = '/synthetic/temporary signing.keychain-db';
  let search = [existing];
  const security = (args) => {
    if (args.includes('-s')) search = args.slice(args.indexOf('-s') + 1);
    return search.map((item) => `    ${JSON.stringify(item)}`).join('\n') + '\n';
  };
  const cleanup = makeMacSigningKeychainSearchable(own, security);
  assert.deepEqual(search, [own, existing]);
  search.push('/synthetic/another-task.keychain-db');
  cleanup();
  assert.deepEqual(search, [existing, '/synthetic/another-task.keychain-db']);
  cleanup();
  assert.deepEqual(search, [existing, '/synthetic/another-task.keychain-db']);
});
