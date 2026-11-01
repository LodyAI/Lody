import { defineConfig } from 'electron-vite'
import original from '../electron.vite.config'
import { resolve } from 'node:path'
import { assertTestBuildOutput, testOutputBoundary } from './test-output-boundary.mjs'

// Explicit test entry point. Release builds continue to load the original config.
export default defineConfig(async (env) => {
  const config = await (typeof original === 'function' ? original(env) : original)
  for (const name of ['main', 'preload', 'renderer'] as const) {
    const section = config[name]
    if (!section) continue
    const checkout = resolve(__dirname, '../../..')
    const outDir = resolve(checkout, '.test-build/electron/out', name)
    await assertTestBuildOutput(checkout, outDir)
    section.build = {
      ...section.build,
      outDir,
      ...(name === 'renderer' ? { target: 'esnext' } : {}),
      emptyOutDir: false,
      minify: false,
      cssMinify: false,
      sourcemap: false,
      reportCompressedSize: false
    }
    section.plugins = [
      testOutputBoundary(checkout),
      ...(section.plugins ?? []),
      {
        name: 'lody-test-build-marker',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'test-build.json',
            source: JSON.stringify({ profile: 'test-build', version: 1 }) + '\n'
          })
        }
      }
    ]
  }
  return config
})
