import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfigFromFile, build } from 'vite'
import { mkdtemp, writeFile, readFile, rm, realpath, mkdir } from 'node:fs/promises'
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

void test('each isolated section removes a deleted entry on the next build', async () => {
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'oss' },
    fileURLToPath(new URL('electron.vite.test.config.ts', import.meta.url)),
    fileURLToPath(new URL('../', import.meta.url)),
    'silent'
  )
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lody-clean-test-output-')))
  try {
    const source = join(root, 'source')
    await mkdir(source)
    const current = join(source, 'current.js')
    const probe = join(source, 'probe.js')
    await writeFile(current, 'globalThis.current = 1')
    await writeFile(probe, 'globalThis.probe = 1')
    const sentinel = join(root, 'do-not-delete.txt')
    await writeFile(sentinel, 'sibling')
    for (const name of ['main', 'preload', 'renderer']) {
      const section = loaded.config[name]
      const output = join(root, 'isolated', name)
      const compile = (input) =>
        build({
          configFile: false,
          root: source,
          logLevel: 'silent',
          plugins: section.plugins.filter((plugin) => plugin?.name === 'lody-test-build-marker'),
          build: {
            ...section.build,
            outDir: output,
            lib: undefined,
            rollupOptions: { input, output: { entryFileNames: '[name].js' } }
          }
        })
      await compile({ current, 'native-storage-smoke': probe })
      await readFile(join(output, 'native-storage-smoke.js'))
      await compile({ current })
      await readFile(join(output, 'current.js'))
      await readFile(join(output, 'test-build.json'))
      await assert.rejects(readFile(join(output, 'native-storage-smoke.js')), { code: 'ENOENT' })
      assert.equal(await readFile(sentinel, 'utf8'), 'sibling')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
