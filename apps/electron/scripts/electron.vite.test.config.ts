import { defineConfig } from 'electron-vite'
import original from '../electron.vite.config'
import { resolve } from 'node:path'

// Explicit test entry point. Release builds continue to load the original config.
export default defineConfig(async (env) => {
  const config = await (typeof original === 'function' ? original(env) : original)
  for (const name of ['main', 'preload', 'renderer'] as const) {
    const section = config[name]
    if (!section) continue
    section.build = {
      ...section.build,
      outDir: resolve(__dirname, '../../../.test-build/electron/out', name),
      ...(name === 'renderer' ? { target: 'esnext' } : {}),
      emptyOutDir: true,
      minify: false,
      cssMinify: false,
      sourcemap: false,
      reportCompressedSize: false
    }
    section.plugins = [
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
