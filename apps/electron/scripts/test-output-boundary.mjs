import * as fs from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const inside = (root, path) => {
  const part = relative(root, path)
  return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)
}

// Read-only validation before any deletion/copy. Check ancestors too: rm does
// not follow its final symlink, but it does follow symlinks in parent paths.
export async function assertTestBuildOutput(checkout, output, io = fs) {
  const unsafe = () => new Error('unsafe_test_build_output')
  if (
    typeof output !== 'string' ||
    !output.trim() ||
    !isAbsolute(output) ||
    output.split(/[\\/]/u).includes('..')
  )
    throw unsafe()
  if (typeof checkout !== 'string' || !checkout.trim() || !isAbsolute(checkout)) throw unsafe()
  const base = resolve(checkout)
  const target = resolve(output)
  const roots = ['.test-build'].map((path) => resolve(base, path))
  const root = roots.find((path) => inside(path, target))
  if (!root) throw unsafe()
  const physicalBase = await io.realpath(base)
  let existing = base
  const parts = relative(base, target).split(sep)
  let missing = []
  for (let i = 0; i < parts.length; i++) {
    const path = join(existing, parts[i])
    let info
    try {
      info = await io.lstat(path)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      missing = parts.slice(i)
      break
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw unsafe()
    existing = path
  }
  const physicalTarget = resolve(await io.realpath(existing), ...missing)
  const physicalRoot = resolve(physicalBase, relative(base, root))
  if (
    !inside(physicalRoot, physicalTarget) ||
    physicalTarget !== resolve(physicalBase, relative(base, target))
  )
    throw unsafe()
  return target
}

export async function cleanTestBuildOutput(checkout, output) {
  const target = await assertTestBuildOutput(checkout, output)
  await fs.rm(target, { recursive: true, force: true })
}

// Vite never empties test output. Configuration resolution is read-only,
// including when a prerender preview resolves the build configuration again.
export function testOutputBoundary(checkout) {
  let output
  return {
    name: 'lody-test-output-boundary',
    enforce: 'pre',
    async configResolved(config) {
      output = resolve(config.root, config.build.outDir)
      await assertTestBuildOutput(checkout, output)
    },
    async buildStart() {
      await assertTestBuildOutput(checkout, output)
    }
  }
}
