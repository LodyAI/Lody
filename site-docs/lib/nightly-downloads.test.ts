import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNightlyRelease, resolveNightlyDownloadBase } from './nightly-downloads.ts';

const base = 'https://downloads.example.test/production/nightly';
const version = '0.89.4-nightly.42';
const files = ['arm64.dmg', 'x64.dmg', 'x64-setup.exe', 'x64.AppImage', 'x64.deb', 'x64.snap'].map(
  (suffix) => `Lody-${version}-${suffix.replace(/\.([^.]+)$/u, '-nightly.$1')}`
);
const manifest = {
  minimumStableVersion: '0.100.1',
  schema: 1,
  channel: 'nightly',
  version,
  files,
  downloads: Object.fromEntries(files.map((file) => [file, file])),
};

void test('Nightly download links cover the full published matrix at immutable URLs', () => {
  const release = parseNightlyRelease(manifest, `${base}/`);
  assert.equal(release.version, version);
  assert.equal(release.minimumStableVersion, '0.100.1');
  assert.deepEqual(
    release.downloads.map((item) => item.href),
    files.map((file) => `${base}/${file}`)
  );
  assert.deepEqual(
    release.downloads.map((item) => item.platform),
    ['mac', 'mac', 'win', 'linux', 'linux', 'linux']
  );
});

void test('Nightly refuses missing, mixed, mutable or external installers', () => {
  for (const replacement of [
    'https://evil.example/installer',
    '../latest.exe',
    'Lody-latest-x64.dmg',
    `Lody-0.89.4-nightly.41-arm64-nightly.dmg`,
  ]) {
    assert.throws(() =>
      parseNightlyRelease(
        { ...manifest, downloads: { ...manifest.downloads, [files[0]!]: replacement } },
        base
      )
    );
  }
  assert.throws(() => parseNightlyRelease({ ...manifest, files: files.slice(1) }, base));
  assert.throws(() => parseNightlyRelease({ ...manifest, downloads: {} }, base));
  for (const changed of [
    { channel: 'stable' },
    { schema: 2 },
    { version: '0.89.4' },
    { version: '../../bad' },
    { version: '0.89.4-nightly.0' },
    { minimumStableVersion: undefined },
    { minimumStableVersion: '0.100.1-nightly.1' },
  ]) {
    assert.throws(() => parseNightlyRelease({ ...manifest, ...changed }, base));
  }
});

void test('Nightly download configuration must select a dedicated HTTPS path', () => {
  assert.equal(resolveNightlyDownloadBase(`${base}/`), base);
  for (const invalid of [
    undefined,
    '',
    'http://downloads.example/nightly',
    'https://downloads.example/production',
    'https://user:secret@downloads.example/nightly',
    `${base}?token=x`,
    `${base}#x`,
    'javascript:alert(1)',
  ]) {
    assert.equal(resolveNightlyDownloadBase(invalid), null);
    assert.throws(() => parseNightlyRelease(manifest, String(invalid)));
  }
});
