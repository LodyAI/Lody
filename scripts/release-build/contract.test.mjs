import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { fixtureRequest } from './fixture.mjs';
import {
  canonical,
  validateRequest,
  readRequest,
  writeReceipt,
  payloadRoots,
  digest,
} from './contract.mjs';
import { releaseRendererPolicy } from './renderer-policy.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lody-release-build-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const request = fixtureRequest('a'.repeat(40));
  const file = join(dir, 'request.json');
  await writeFile(file, canonical(request) + '\n');
  return { dir, request, file };
}
test('release admission rejects secret fields, wrong channels, duplicate targets and noncanonical requests', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await readRequest(f.file), f.request);
  for (const change of [
    (r) => (r.env.APPLE_API_KEY = 'secret'),
    (r) => r.targets.push('linux'),
    (r) => (r.sourceSha = 'main'),
    (r) => (r.env.VITE_LODY_ENV = 'production'),
    (r) => (r.csp['connect-src'] = ['https:']),
    (r) => (r.env.VITE_SERVER_URL = 'https://user:password@example.invalid'),
  ]) {
    const r = structuredClone(f.request);
    change(r);
    assert.throws(() => validateRequest(r));
  }
  await writeFile(
    f.file,
    JSON.stringify(f.request).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')
  );
  await assert.rejects(readRequest(f.file), /canonical/);
});
test('compiled input receipt covers every byte and refuses linked or missing output trees', async (t) => {
  const f = await fixture(t);
  for (const path of payloadRoots('linux')) {
    if (path.endsWith('.html')) await writeFile(join(f.dir, path), 'built bytes');
    else {
      await mkdir(join(f.dir, path), { recursive: true });
      await writeFile(join(f.dir, path, 'entry.js'), 'built bytes');
    }
  }
  const receipt = await writeReceipt({
    root: f.dir,
    request: f.request,
    target: 'linux',
    runId: '1',
    runAttempt: 1,
    workflowSha: 'b'.repeat(40),
  });
  assert.equal(receipt.files.length, 4);
  assert.equal(receipt.requestSha256, digest(canonical(f.request)));
  assert.ok(receipt.files.every((f) => f.sha256 === digest('built bytes')));
  await symlink(join(f.dir, 'request.json'), join(f.dir, 'apps/cli/dist/link'));
  await assert.rejects(
    writeReceipt({
      root: f.dir,
      request: f.request,
      target: 'linux',
      runId: '1',
      runAttempt: 1,
      workflowSha: 'b'.repeat(40),
    }),
    /payload/
  );
});
test('release renderer policy extends audited sources but preserves isolated pages', () => {
  const r = fixtureRequest('a'.repeat(40));
  const plugin = releaseRendererPolicy(r.csp);
  const html =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"connect-src 'self'; img-src 'self'; frame-src 'self';\">";
  const out = plugin.transformIndexHtml(html, { path: '/index.html' });
  assert.ok(out.includes('https://server.example.invalid'));
  for (const page of ['/pr-image.html', '/recovery.html'])
    assert.equal(plugin.transformIndexHtml(html, { path: page }), html);
  assert.throws(() => plugin.transformIndexHtml('<html>', { path: '/index.html' }), /policy/);
});
test('release CLI compiles cloud identity and version without loading deployment files or credentials', async (t) => {
  const f = await fixture(t);
  f.request.targets = ['cli', 'linux'];
  f.request.cliVersion = '0.108.0-nightly.9';
  await writeFile(f.file, canonical(f.request) + '\n');
  const previous = process.env.LODY_RELEASE_REQUEST,
    target = process.env.LODY_RELEASE_TARGET;
  t.after(() => {
    if (previous === undefined) delete process.env.LODY_RELEASE_REQUEST;
    else process.env.LODY_RELEASE_REQUEST = previous;
    if (target === undefined) delete process.env.LODY_RELEASE_TARGET;
    else process.env.LODY_RELEASE_TARGET = target;
  });
  process.env.LODY_RELEASE_REQUEST = f.file;
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const require = createRequire(join(root, 'apps/cli/package.json'));
  const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve('vite')).href);
  const entry = join(f.dir, 'probe.mjs');
  await writeFile(join(f.dir, 'package.json'), '{"type":"module"}');
  await writeFile(
    entry,
    "import {version} from '@/pkg'; console.log(JSON.stringify({version,platform:process.env.LODY_PLATFORM,auth:process.env.LODY_AUTH_URL,clock:__LODY_E2E_CLOCK_BUILD__}));"
  );
  for (const target of ['cli', 'linux']) {
    process.env.LODY_RELEASE_TARGET = target;
    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'cli-runtime' },
      join(root, 'apps/cli/release.vite.config.mjs')
    );
    const output = join(f.dir, target);
    await build({
      ...loaded.config,
      configFile: false,
      logLevel: 'silent',
      build: {
        ...loaded.config.build,
        outDir: output,
        sourcemap: false,
        rollupOptions: { ...loaded.config.build.rollupOptions, input: { probe: entry } },
      },
    });
    const value = JSON.parse(
      execFileSync(process.execPath, [join(output, 'probe.js')], { encoding: 'utf8', env: {} })
    );
    assert.deepEqual(value, {
      version: target === 'cli' ? f.request.cliVersion : f.request.embeddedCliVersion,
      platform: 'cloud',
      ...(target === 'cli' ? { auth: f.request.env.VITE_CONVEX_DEPLOY_URL } : {}),
      clock: false,
    });
  }
});
