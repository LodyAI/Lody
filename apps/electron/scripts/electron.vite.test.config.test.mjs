import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfigFromFile, build } from 'vite'
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

void test('test config retains main externalization, native probes and renderer entry points', async () => {
  const directory = fileURLToPath(new URL('../', import.meta.url))
  const load = async (name) => {
    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'oss' },
      fileURLToPath(new URL(name, import.meta.url)),
      directory,
      'silent'
    )
    assert.ok(loaded)
    return loaded.config
  }
  const release = await load('../electron.vite.config.ts')
  const profile = await load('electron.vite.test.config.ts')
  assert.deepEqual(profile.main.build.externalizeDeps, release.main.build.externalizeDeps)
  assert.deepEqual(profile.main.build.lib, release.main.build.lib)
  assert.deepEqual(
    profile.renderer.build.rollupOptions.input,
    release.renderer.build.rollupOptions.input
  )
  for (const id of ['react', '/node_modules/mermaid/dist/mermaid.js', '/app.tsx']) {
    assert.equal(
      profile.renderer.build.rollupOptions.output.manualChunks(id),
      release.renderer.build.rollupOptions.output.manualChunks(id)
    )
  }
  const definitions = (config) =>
    Object.fromEntries(
      Object.entries(config.renderer.define).filter(([key]) => key !== '__BUILD_DATE__')
    )
  assert.deepEqual(definitions(profile), definitions(release))
  for (const name of ['main', 'preload', 'renderer']) {
    const options = profile[name].build
    assert.ok(options.outDir.endsWith(join('.test-build', 'electron', 'out', name)))
    assert.equal(options.minify, false)
    assert.equal(options.cssMinify, false)
    assert.equal(options.sourcemap, false)
    assert.equal(options.reportCompressedSize, false)
    const marker = profile[name].plugins.find((plugin) => plugin?.name === 'lody-test-build-marker')
    assert.ok(marker)
  }
  assert.equal(profile.renderer.build.target, 'esnext')
  assert.equal(release.renderer.build.minify, true)
  assert.equal(release.renderer.build.cssMinify, true)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lody-test-profile-')))
  try {
    await writeFile(join(root, 'index.html'), '<script type="module" src="/entry.js"></script>')
    await writeFile(join(root, 'entry.js'), 'globalThis.answer = await Promise.resolve(42)')
    await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: profile.renderer.plugins.filter(
        (plugin) => plugin?.name === 'lody-test-build-marker'
      ),
      build: {
        ...profile.renderer.build,
        outDir: join(root, 'dist'),
        rollupOptions: { input: join(root, 'index.html') }
      }
    })
    assert.deepEqual(JSON.parse(await readFile(join(root, 'dist/test-build.json'), 'utf8')), {
      profile: 'test-build',
      version: 1
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
