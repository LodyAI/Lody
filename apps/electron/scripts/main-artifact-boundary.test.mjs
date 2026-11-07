import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { mainArtifactBoundary, mainEntryFileName } from './main-artifact-boundary.mjs'
import { assembleCoreSnapshot } from './assemble-core-snapshot.mjs'
const require = createRequire(
  process.env.LODY_ARTIFACT_TEST_DEPS
    ? join(process.env.LODY_ARTIFACT_TEST_DEPS, 'package.json')
    : import.meta.url
)
const { rollup } = createRequire(require.resolve('vite/package.json'))('rollup')

test('installed entries preserve ownership boundary and snapshot executes without Host files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lody-artifact-'))
  try {
    const source = join(root, 'src/main')
    await mkdir(source, { recursive: true })
    await writeFile(
      join(source, 'index.ts'),
      "import { shared } from './shared.js'; export async function start(owned) { if (owned) return (await import('./application.ts')).start(); return shared }"
    )
    const dependency = join(root, 'node_modules/.pnpm/synthetic@1/node_modules/synthetic')
    await mkdir(dependency, { recursive: true })
    await writeFile(join(dependency, 'index.js'), 'export const dependencyValue = 7')
    // Both inputs map to the same suggested output path. Rollup must keep
    // distinct modules and connect their imports after disambiguation.
    const collision = join(root, 'node_modules/store/synthetic@1/packages/synthetic')
    await mkdir(collision, { recursive: true })
    await writeFile(join(collision, 'index.js'), 'export const collisionValue = 1')
    await writeFile(
      join(source, 'shared.js'),
      "import { DatabaseSync } from 'node:sqlite'; import { dependencyValue } from '../../node_modules/.pnpm/synthetic@1/node_modules/synthetic/index.js'; import { collisionValue } from '../../node_modules/store/synthetic@1/packages/synthetic/index.js'; export const shared = typeof DatabaseSync === 'function' ? dependencyValue + collisionValue : 0"
    )
    await writeFile(
      join(source, 'auth-storage.ts'),
      'globalThis.businessEvaluated = true; export const value = 11'
    )
    await writeFile(
      join(source, 'application.ts'),
      "import { shared } from './shared.js'; import { value } from './auth-storage.ts'; export function start() { return shared + value }"
    )
    const build = await rollup({
      input: { index: join(source, 'index.ts'), application: join(source, 'application.ts') },
      external: ['node:sqlite'],
      plugins: [mainArtifactBoundary()]
    })
    const output = join(root, 'out')
    await build.write({
      dir: join(output, 'main'),
      format: 'cjs',
      preserveModules: true,
      preserveModulesRoot: source,
      entryFileNames: mainEntryFileName
    })
    await build.close()
    const { build: viteBuild } = await import(require.resolve('vite'))
    await viteBuild({
      configFile: false,
      logLevel: 'silent',
      plugins: [mainArtifactBoundary()],
      build: {
        outDir: join(root, 'vite/main'),
        minify: false,
        lib: {
          entry: { index: join(source, 'index.ts'), application: join(source, 'application.ts') },
          formats: ['cjs']
        },
        rollupOptions: {
          external: ['node:sqlite'],
          preserveEntrySignatures: 'strict',
          output: {
            preserveModules: true,
            preserveModulesRoot: source,
            entryFileNames: mainEntryFileName
          }
        }
      }
    })
    assert.equal(require(join(root, 'vite/main/index.js')).start instanceof Function, true)
    const catalog = JSON.parse(await readFile(join(output, 'main/core-artifacts.json'), 'utf8'))
    assert.ok(catalog.main.some((name) => name.startsWith('dependencies/')))
    assert.ok(
      catalog.main.every(
        (name) => !name.split('/').some((part) => ['node_modules', '.pnpm'].includes(part))
      )
    )
    const host = require(join(output, 'main/index.js'))
    assert.equal(await host.start(false), 8)
    assert.equal(globalThis.businessEvaluated, undefined)
    for (const section of ['preload', 'renderer']) {
      await mkdir(join(output, section))
      await writeFile(join(output, section, 'index.js'), section)
    }
    const snapshot = join(root, 'snapshot')
    await assembleCoreSnapshot(output, snapshot)
    await assert.rejects(access(join(snapshot, 'main/index.js')))
    assert.equal(require(join(snapshot, 'main/application.js')).start(), 19)
    assert.equal(await readFile(join(snapshot, 'preload/index.js'), 'utf8'), 'preload')
    assert.equal(await readFile(join(snapshot, 'renderer/index.js'), 'utf8'), 'renderer')
    await writeFile(
      join(source, 'index.ts'),
      "import './auth-storage.ts'; export const host = true"
    )
    const bad = await rollup({
      input: { index: join(source, 'index.ts'), application: join(source, 'application.ts') },
      plugins: [mainArtifactBoundary()]
    })
    await assert.rejects(
      bad.generate({
        format: 'cjs',
        preserveModules: true,
        preserveModulesRoot: source,
        entryFileNames: mainEntryFileName
      }),
      /Business module in preownership/
    )
    await bad.close()
    await writeFile(
      join(source, 'index.ts'),
      "import 'unlisted-host-package'; export const host = true"
    )
    const external = await rollup({
      input: { index: join(source, 'index.ts'), application: join(source, 'application.ts') },
      external: ['unlisted-host-package'],
      plugins: [mainArtifactBoundary()]
    })
    await assert.rejects(
      external.generate({
        format: 'cjs',
        preserveModules: true,
        preserveModulesRoot: source,
        entryFileNames: mainEntryFileName
      }),
      /Undeclared Host external/
    )
    await external.close()
  } finally {
    delete globalThis.businessEvaluated
    await rm(root, { recursive: true, force: true })
  }
})
