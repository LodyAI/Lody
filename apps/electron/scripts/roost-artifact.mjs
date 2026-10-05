import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const electronAppRoot = path.resolve(__dirname, '..')
const cliAppRoot = path.resolve(electronAppRoot, '../cli')
// Roost is a sibling checkout of Lody. The Electron app lives at
// Lody/apps/electron, so the sibling is three levels up from this app root.
const roostRoot = path.resolve(electronAppRoot, '../../../roost')
const stagedRoostDir = path.join(electronAppRoot, 'resources', 'roost')
const require = createRequire(path.join(cliAppRoot, 'package.json'))

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function resolveConfiguredPath(value, label) {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const resolved = path.resolve(trimmed)
  if (!fileExists(resolved)) {
    throw new Error(`Configured ${label} does not exist: ${resolved}`)
  }
  return resolved
}

function resolveClientSource(artifactDir) {
  const configured = resolveConfiguredPath(
    process.env.LODY_ROOST_NODE_CLIENT,
    'LODY_ROOST_NODE_CLIENT'
  )
  if (configured) return configured

  const candidates = [
    ...(artifactDir ? [path.join(artifactDir, 'client.mjs')] : []),
    path.join(roostRoot, 'ts', 'node', 'client.mjs'),
    path.join(roostRoot, 'node', 'client.mjs')
  ]
  try {
    candidates.push(require.resolve('@loro-dev/roost/node/client.mjs'))
  } catch {
    // The sibling checkout is the normal source while the package is local.
  }
  const resolved = candidates.find(fileExists)
  if (!resolved) {
    throw new Error(
      'Roost Node client is missing. Build or install @loro-dev/roost@0.1.1, or set ' +
        'LODY_ROOST_NODE_CLIENT to its published node/client.mjs.'
    )
  }
  return resolved
}

function binaryFileName(platform) {
  return platform === 'win32' ? 'roost-node-owner.exe' : 'roost-node-owner'
}

function resolveOwnerBinary({ artifactDir, platform, arch, development }) {
  const configured = resolveConfiguredPath(
    process.env.LODY_ROOST_NODE_OWNER,
    'LODY_ROOST_NODE_OWNER'
  )
  if (configured) return configured

  const name = binaryFileName(platform)
  const target = `${platform}-${arch}`
  const candidates = []
  if (artifactDir) {
    candidates.push(
      path.join(artifactDir, target, name),
      path.join(artifactDir, `roost-node-owner-${target}`),
      path.join(artifactDir, name)
    )
  }

  const configuration = development ? 'debug' : 'release'
  candidates.push(path.join(roostRoot, 'target', configuration, name))

  const resolved = candidates.find(fileExists)
  if (!resolved) {
    const source = artifactDir ?? roostRoot
    throw new Error(
      `Roost owner binary for ${target} is missing. Build ${configuration} ` +
        `roost-node-owner or provide a target artifact under ${source}/${target}/, ` +
        'then rerun the Electron build.'
    )
  }
  return resolved
}

function resolveArtifactDirectory() {
  const configured = process.env.LODY_ROOST_ARTIFACT_DIR?.trim()
  return configured ? path.resolve(configured) : undefined
}

/**
 * Stage the exact Roost runtime used by the embedded CLI. This is a product
 * resource, so a missing or stale owner is a build error rather than a runtime
 * fallback to a developer checkout.
 */
export function stageRoostArtifact({
  platform = process.platform,
  arch = process.arch,
  development = false
} = {}) {
  const artifactDir = resolveArtifactDirectory()
  const client = resolveClientSource(artifactDir)
  const owner = resolveOwnerBinary({ artifactDir, platform, arch, development })

  fs.rmSync(stagedRoostDir, { recursive: true, force: true })
  fs.mkdirSync(stagedRoostDir, { recursive: true })
  const stagedClient = path.join(stagedRoostDir, 'client.mjs')
  const stagedOwner = path.join(stagedRoostDir, binaryFileName(platform))
  fs.copyFileSync(client, stagedClient)
  fs.copyFileSync(owner, stagedOwner)
  if (platform !== 'win32') fs.chmodSync(stagedOwner, 0o755)

  console.log(`Staged Roost runtime for ${platform}-${arch}: ${stagedClient} and ${stagedOwner}`)
}

export { stagedRoostDir }
