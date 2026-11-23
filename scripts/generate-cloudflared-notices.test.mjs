import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { collectCloudflaredNotices } from './generate-cloudflared-notices.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lody-notices-'));
  t.after(() => rm(root, { recursive: true }));
  const put = async (name, content) => {
    const file = join(root, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  await put('source/LICENSE', 'upstream license\n');
  await put('source/go.mod', 'module example.test/cloudflared\n');
  await put('source/go.sum', 'synthetic module checksums\n');
  await put('go/VERSION', 'go-test\ntime synthetic\n');
  await put('go/LICENSE', 'Go runtime license\n');
  await put('go/src/vendor/example.test/LICENSE', 'vendor license\n');
  await put('go/src/vendor/example.test/PATENTS', 'vendor patent grant\n');
  await put('go/src/vendor/example.test/source.go', 'not a license');
  await put('go-next/VERSION', 'go-next\n');
  await put('go-next/LICENSE', 'Next Go runtime license\n');
  await put('go-next/src/vendor/new.test/NOTICE', 'new vendored notice\n');
  await put('darwin/github.com/cloudflare/cloudflared/LICENSE', 'upstream license\n');
  await put('linux/github.com/cloudflare/cloudflared/LICENSE', 'upstream license\n');
  await put('darwin/example.test/mac/NOTICE', 'darwin-specific notice\n');
  await put('linux/example.test/linux/COPYING', 'linux-specific license\n');
  return {
    root,
    put,
    options: {
      version: 'test',
      source: 'https://example.test/source/test',
      sourceDir: join(root, 'source'),
      goRoots: [join(root, 'go'), join(root, 'go-next')],
      licenseDirs: [join(root, 'darwin'), join(root, 'linux')],
    },
  };
}

test('merges platform notices deterministically, retaining exact text and source fingerprints', async (t) => {
  const { root, options } = await fixture(t);
  const actual = await collectCloudflaredNotices(options);
  assert.deepEqual(actual, {
    version: 'test',
    source: 'https://example.test/source/test',
    sourceGoModSha256: createHash('sha256')
      .update(await readFile(join(root, 'source/go.mod')))
      .digest('hex'),
    sourceGoSumSha256: createHash('sha256')
      .update(await readFile(join(root, 'source/go.sum')))
      .digest('hex'),
    goVersions: ['go-next', 'go-test'],
    files: [
      { name: 'Go/go-next/LICENSE', content: 'Next Go runtime license\n' },
      { name: 'Go/go-next/vendor/new.test/NOTICE', content: 'new vendored notice\n' },
      { name: 'Go/go-test/LICENSE', content: 'Go runtime license\n' },
      { name: 'Go/go-test/vendor/example.test/LICENSE', content: 'vendor license\n' },
      { name: 'Go/go-test/vendor/example.test/PATENTS', content: 'vendor patent grant\n' },
      { name: 'example.test/linux/COPYING', content: 'linux-specific license\n' },
      { name: 'example.test/mac/NOTICE', content: 'darwin-specific notice\n' },
      { name: 'github.com/cloudflare/cloudflared/LICENSE', content: 'upstream license\n' },
    ],
  });
  assert.deepEqual(
    await collectCloudflaredNotices({
      ...options,
      goRoots: [...options.goRoots].reverse(),
      licenseDirs: [...options.licenseDirs].reverse(),
    }),
    actual
  );
});

test('rejects disagreeing platform copies instead of silently taking the last license', async (t) => {
  const { put, options } = await fixture(t);
  await put('linux/github.com/cloudflare/cloudflared/LICENSE', 'different license');
  await assert.rejects(collectCloudflaredNotices(options), /Conflicting notices/);
});

test('rejects conflicting toolchain notices under the same Go version', async (t) => {
  const { put, options } = await fixture(t);
  await put('go-next/VERSION', 'go-test\n');
  await assert.rejects(
    collectCloudflaredNotices(options),
    /Conflicting notices: Go\/go-test\/LICENSE/
  );
});

test('requires at least one reviewed toolchain', async (t) => {
  const { options } = await fixture(t);
  await assert.rejects(
    collectCloudflaredNotices({ ...options, goRoots: [] }),
    /Expected Go source directories/
  );
});

test('rejects missing or stale upstream notices', async (t) => {
  const { put, options } = await fixture(t);
  await put('source/LICENSE', 'new release license');
  await assert.rejects(collectCloudflaredNotices(options), /does not match the source checkout/);
  await assert.rejects(
    collectCloudflaredNotices({ ...options, licenseDirs: [] }),
    /Expected collected platform license directories/
  );
});
