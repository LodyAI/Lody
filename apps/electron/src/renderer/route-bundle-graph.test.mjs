import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const electronRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const repositoryRoot = resolve(electronRoot, '../..')
const componentsRoot = resolve(repositoryRoot, 'packages/components/src')

function normalizeModuleId(moduleId) {
  return moduleId.replaceAll('\\', '/')
}

function isRouteComponentModule(moduleId, routePath) {
  const normalized = normalizeModuleId(moduleId)
  return normalized.startsWith(`${routePath}?`) && normalized.includes('tsr-split=')
}

function getChunkForRoute(chunks, routePath) {
  const chunk = chunks.find((candidate) =>
    candidate.moduleIds.some((moduleId) => isRouteComponentModule(moduleId, routePath))
  )
  assert.ok(chunk, `expected an emitted component chunk for ${routePath}`)
  return chunk
}

function getStaticClosure(chunks, roots) {
  const chunksByFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
  const closure = new Map()
  const pending = [...roots]

  while (pending.length > 0) {
    const chunk = pending.pop()
    if (!chunk || closure.has(chunk.fileName)) continue
    closure.set(chunk.fileName, chunk)
    for (const importedFileName of chunk.imports) {
      pending.push(chunksByFileName.get(importedFileName))
    }
  }

  return [...closure.values()]
}

function hasModule(closure, predicate) {
  return closure.some((chunk) => chunk.moduleIds.some(predicate))
}

function summarize(closure) {
  return {
    chunks: closure.map((chunk) => chunk.fileName).sort(),
    rawBytes: closure.reduce((total, chunk) => total + chunk.rawBytes, 0),
    gzipBytes: closure.reduce((total, chunk) => total + chunk.gzipBytes, 0)
  }
}

void test(
  'the Electron host code-splits public routes away from the workspace runtime graph',
  { timeout: 300_000 },
  async () => {
    const outputDirectory = await mkdtemp(resolve(tmpdir(), 'lody-route-bundle-graph-'))
    const graphPath = resolve(outputDirectory, 'graph.json')

    try {
      execFileSync(
        'pnpm',
        ['--dir', 'apps/electron', 'exec', 'electron-vite', 'build', '--mode', 'oss'],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            LODY_ROUTE_BUNDLE_GRAPH_PATH: graphPath
          },
          stdio: 'pipe'
        }
      )

      const graph = JSON.parse(await readFile(graphPath, 'utf8'))
      const entry = graph.chunks.find((chunk) =>
        chunk.moduleIds.some((moduleId) =>
          normalizeModuleId(moduleId).endsWith('/src/renderer/src/main.tsx')
        )
      )
      assert.ok(entry, 'expected the renderer entry chunk')

      const joinRoute = getChunkForRoute(graph.chunks, `${componentsRoot}/routes/join/$token.tsx`)
      const loginRoute = getChunkForRoute(graph.chunks, `${componentsRoot}/routes/login.tsx`)
      const workspaceRoute = getChunkForRoute(
        graph.chunks,
        `${componentsRoot}/routes/$workspaceName.tsx`
      )

      const publicRoots = [entry]
      const joinClosure = getStaticClosure(graph.chunks, [...publicRoots, joinRoute])
      const loginClosure = getStaticClosure(graph.chunks, [...publicRoots, loginRoute])
      const workspaceClosure = getStaticClosure(graph.chunks, [...publicRoots, workspaceRoute])

      const runtimeProvider = (moduleId) =>
        normalizeModuleId(moduleId) ===
        `${componentsRoot.replaceAll('\\', '/')}/providers/runtime-provider.tsx`
      const workspaceRuntime = (moduleId) =>
        normalizeModuleId(moduleId) ===
        `${componentsRoot.replaceAll('\\', '/')}/providers/create-workspace-runtime.ts`
      const streamsCrdt = (moduleId) =>
        normalizeModuleId(moduleId).includes('/@loro-dev/streams-crdt/')
      const flockWasm = (moduleId) => normalizeModuleId(moduleId).includes('/@loro-dev/flock-wasm/')

      for (const [routeName, closure] of [
        ['join', joinClosure],
        ['login', loginClosure]
      ]) {
        assert.equal(
          hasModule(closure, runtimeProvider),
          false,
          `${routeName} loads RuntimeProvider`
        )
        assert.equal(
          hasModule(closure, workspaceRuntime),
          false,
          `${routeName} loads workspace runtime`
        )
        assert.equal(hasModule(closure, streamsCrdt), false, `${routeName} loads streams-crdt`)
        assert.equal(hasModule(closure, flockWasm), false, `${routeName} loads flock-wasm`)
      }

      assert.equal(hasModule(workspaceClosure, runtimeProvider), true)
      assert.equal(hasModule(workspaceClosure, workspaceRuntime), true)
      assert.equal(hasModule(workspaceClosure, streamsCrdt), true)
      assert.equal(hasModule(workspaceClosure, flockWasm), true)

      console.info(
        JSON.stringify({
          join: summarize(joinClosure),
          login: summarize(loginClosure),
          workspace: summarize(workspaceClosure)
        })
      )
    } finally {
      await rm(outputDirectory, { recursive: true, force: true })
    }
  }
)
