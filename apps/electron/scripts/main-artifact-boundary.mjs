import { builtinModules } from 'node:module'

export function mainArtifactBoundary({ hostDependencies = [] } = {}) {
  const allowed = new Set([
    'electron',
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
    ...hostDependencies
  ])
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
              if (!allowed.has(dependency) && !allowed.has(packageName))
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
      this.emitFile({
        type: 'asset',
        fileName: 'core-artifacts.json',
        source:
          JSON.stringify(
            {
              version: 1,
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
  if (chunk.facadeModuleId?.endsWith('/src/main/native-storage-smoke.mts'))
    return 'native-storage-smoke.js'
  return 'modules/[name].js'
}
