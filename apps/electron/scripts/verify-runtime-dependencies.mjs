import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const builderDir = path.dirname(builderRequire.resolve('app-builder-lib'))
// Use the builder's installed traversal fallback, including transitive and optional dependencies.
const { TraversalNodeModulesCollector } = builderRequire(
  path.join(builderDir, 'node-module-collector/traversalNodeModulesCollector.js')
)
const { TmpDir } = builderRequire('temp-file')
const result = await new TraversalNodeModulesCollector(appDir, new TmpDir()).getNodeModules({
  packageName: '@lody/electron'
})
const names = new Set()
function visit(dependencies) {
  for (const dependency of dependencies) {
    names.add(dependency.name)
    visit(dependency.dependencies ?? [])
  }
}
visit(result.nodeModules)
for (const name of ['@tanstack/react-router', 'jotai']) {
  assert(!names.has(name), `${name} must stay in the renderer bundle`)
}
for (const name of ['better-sqlite3', 'electron-sparkle-updater', 'react', '@devframes/hub-ui']) {
  assert(names.has(name), `${name} must remain available to packaged runtime loaders`)
}
console.log(
  `Verified ${names.size} production packages using electron-builder's dependency collector`
)
