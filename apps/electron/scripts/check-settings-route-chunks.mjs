import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { resolveConfig } from 'electron-vite'

process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const { config } = await resolveConfig({ mode: 'oss' }, 'build', 'oss')
assert(config?.renderer)
const renderer = config.renderer
renderer.plugins = [
  ...(renderer.plugins ?? []),
  {
    name: 'check-settings-route-chunks',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((entry) => entry.type === 'chunk')
      const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
      const entry = chunks.find(
        (chunk) => chunk.isEntry && chunk.facadeModuleId?.endsWith('/index.html')
      )
      assert(entry, 'Missing main renderer entry')
      const initial = new Set()
      function visit(name) {
        if (initial.has(name)) return
        initial.add(name)
        for (const dependency of byName.get(name)?.imports ?? []) visit(dependency)
      }
      visit(entry.fileName)
      const evidence = {}
      for (const module of [
        'desktop-settings-modal.tsx',
        'stats-setting.tsx',
        'mcp-setting.tsx',
        'lody-agent-setting.tsx'
      ]) {
        const owners = chunks.filter((chunk) =>
          Object.keys(chunk.modules).some((id) => id.endsWith(`/${module}`))
        )
        assert(owners.length, `Missing ${module}`)
        for (const owner of owners)
          assert(!initial.has(owner.fileName), `${module} is in the initial graph`)
        evidence[module] = owners.map((owner) => owner.fileName)
      }
      console.log(
        JSON.stringify({ initialChunks: [...initial], deferredSettings: evidence }, null, 2)
      )
    }
  }
]
await build({ ...renderer, configFile: false, build: { ...renderer.build, write: false } })
