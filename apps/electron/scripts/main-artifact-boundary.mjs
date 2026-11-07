import {
  HOST_ABI,
  CORE_RUNTIME_REQUIREMENTS,
  dependencyRequirement
} from './core-ota/compatibility.mjs'
import { isBuiltin } from 'node:module'

export function mainArtifactBoundary({ hostDependencies = [], readHostPackageVersion } = {}) {
  const allowed = new Set(['electron', ...hostDependencies])
  return {
    name: 'lody-main-artifact-boundary',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((item) => item.type === 'chunk')
      const entry = (name) =>
        chunks.find((item) => item.facadeModuleId?.endsWith(`/src/main/${name}.ts`))
      const host = entry('index')
      const core = entry('application')
      if (!host || host.fileName !== 'index.js' || !core || core.fileName !== 'application.js') {
        throw new Error('Installed main entry paths must be index.js and application.js')
      }
      function closure(start, dynamic) {
        const seen = new Set()
        function visit(name) {
          if (seen.has(name)) return
          const chunk = bundle[name]
          if (!chunk) throw new Error(`Missing main artifact: ${name}`)
          seen.add(name)
          if (chunk.type !== 'chunk') return
          for (const dependency of [
            ...chunk.imports,
            ...chunk.referencedFiles,
            ...(dynamic ? chunk.dynamicImports : [])
          ]) {
            if (bundle[dependency]) visit(dependency)
            else {
              const packageName = dependency.startsWith('@')
                ? dependency.split('/').slice(0, 2).join('/')
                : dependency.split('/')[0]
              if (!isBuiltin(dependency) && !allowed.has(dependency) && !allowed.has(packageName))
                throw new Error(`Undeclared Host external dependency: ${dependency}`)
            }
          }
        }
        visit(start)
        return seen
      }
      const startup = closure(host.fileName, false)
      for (const name of startup) {
        for (const id of Object.keys(bundle[name].modules ?? {})) {
          if (
            /\/src\/main\/(application\.ts|auth-storage\.ts|settings-store\.ts|ipc\/)/u.test(id)
          ) {
            throw new Error(`Business module in preownership Host closure: ${id}`)
          }
        }
      }
      const coreFiles = closure(core.fileName, true)
      const hostFiles = closure(host.fileName, true)
      const externals = [
        ...new Set(
          [...coreFiles]
            .flatMap((name) => [
              ...(bundle[name].imports ?? []),
              ...(bundle[name].dynamicImports ?? [])
            ])
            .filter((name) => !bundle[name])
        )
      ].sort()
      const hostRequirements = { ...CORE_RUNTIME_REQUIREMENTS }
      for (const id of externals) {
        if (id === 'electron' || isBuiltin(id)) continue
        const name = id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0]
        if (!readHostPackageVersion) throw new Error(`Missing Host dependency version: ${name}`)
        hostRequirements[`packages/${name}`] = dependencyRequirement(readHostPackageVersion(name))
      }
      this.emitFile({
        type: 'asset',
        fileName: 'core-artifacts.json',
        source:
          JSON.stringify(
            {
              version: 1,
              hostAbi: HOST_ABI,
              hostRequirements,
              main: [...coreFiles].sort(),
              hostDependencies: [
                ...new Set(
                  [...coreFiles]
                    .flatMap((name) => [
                      ...(bundle[name].imports ?? []),
                      ...(bundle[name].dynamicImports ?? [])
                    ])
                    .filter((name) => !bundle[name])
                )
              ].sort(),
              hostOnly: [...hostFiles].filter((name) => !coreFiles.has(name)).sort(),
              preload: '../preload',
              renderer: '../renderer'
            },
            null,
            2
          ) + '\n'
      })
    }
  }
}

export function mainEntryFileName(chunk) {
  if (chunk.facadeModuleId?.endsWith('/src/main/index.ts')) return 'index.js'
  if (chunk.facadeModuleId?.endsWith('/src/main/application.ts')) return 'application.js'
  // Window resource paths are relative to the selected Core's main directory.
  if (chunk.facadeModuleId?.endsWith('/src/main/window.ts')) return 'window.js'
  if (chunk.facadeModuleId?.endsWith('/src/main/native-storage-smoke.mts'))
    return 'native-storage-smoke.js'
  // Builder treats node_modules directories as dependency inputs and drops them
  // from ordinary file collection. These chunks are bundled code, so give them
  // a separate namespace; Rollup connects imports and disambiguates collisions.
  const parts = chunk.name.split('/')
  const dependency = parts.includes('node_modules')
  const name = parts
    .map((part) => (part === 'node_modules' ? 'packages' : part === '.pnpm' ? 'store' : part))
    .join('/')
  return `${dependency ? 'dependencies' : 'modules'}/${name}.js`
}
