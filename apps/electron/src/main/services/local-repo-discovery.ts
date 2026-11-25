import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DiscoveredLocalRepo, LocalRepoPromptHints } from '@lody/shared/electron-ipc'
import { runCommandTextLegacy } from '@lody/shared/node/process'

const ALLOWED_DEV_ROOT_NAMES = ['dev', 'code', 'Developer', 'projects'] as const
const MAX_DISCOVERED_REPOS = 24
const IGNORED_SCAN_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.next',
  '.turbo',
  '.venv',
  'venv'
])

async function hasGitMarker(dirPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(dirPath, '.git'))
    return true
  } catch {
    return false
  }
}

async function resolveRepoMtimeMs(dirPath: string): Promise<number> {
  for (const candidate of [
    path.join(dirPath, '.git', 'index'),
    path.join(dirPath, '.git', 'HEAD'),
    dirPath
  ]) {
    try {
      const stat = await fs.stat(candidate)
      return stat.mtimeMs
    } catch {}
  }
  return 0
}

export async function discoverRecentLocalRepos(
  homeDir = os.homedir()
): Promise<DiscoveredLocalRepo[]> {
  const seenPaths = new Set<string>()
  const discovered: DiscoveredLocalRepo[] = []

  const roots = ALLOWED_DEV_ROOT_NAMES.map((name) => path.join(homeDir, name))

  for (const root of roots) {
    let level1Entries: import('node:fs').Dirent[]
    try {
      level1Entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of level1Entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || IGNORED_SCAN_DIRS.has(entry.name)) {
        continue
      }
      const level1Path = path.join(root, entry.name)
      if (await hasGitMarker(level1Path)) {
        if (!seenPaths.has(level1Path)) {
          seenPaths.add(level1Path)
          discovered.push({
            name: entry.name,
            rootPath: level1Path,
            mtimeMs: await resolveRepoMtimeMs(level1Path)
          })
        }
        continue
      }

      let level2Entries: import('node:fs').Dirent[]
      try {
        level2Entries = await fs.readdir(level1Path, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of level2Entries) {
        if (
          !child.isDirectory() ||
          child.name.startsWith('.') ||
          IGNORED_SCAN_DIRS.has(child.name)
        ) {
          continue
        }
        const level2Path = path.join(level1Path, child.name)
        if (seenPaths.has(level2Path)) continue
        if (await hasGitMarker(level2Path)) {
          seenPaths.add(level2Path)
          discovered.push({
            name: child.name,
            rootPath: level2Path,
            mtimeMs: await resolveRepoMtimeMs(level2Path)
          })
        }
      }
    }
  }

  discovered.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
  return discovered.slice(0, MAX_DISCOVERED_REPOS)
}

async function detectRepoHasTests(rootPath: string): Promise<boolean> {
  try {
    const pkgRaw = await fs.readFile(path.join(rootPath, 'package.json'), 'utf8')
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, unknown> }
    const testScript = typeof pkg.scripts?.test === 'string' ? pkg.scripts.test.trim() : ''
    if (testScript && !testScript.includes('no test specified')) {
      return true
    }
  } catch {}

  for (const marker of [
    'pytest.ini',
    'conftest.py',
    'Cargo.toml',
    'go.mod',
    'vitest.config.ts',
    'vitest.config.js',
    'jest.config.ts',
    'jest.config.js'
  ]) {
    try {
      await fs.access(path.join(rootPath, marker))
      return true
    } catch {}
  }

  try {
    const pyproject = await fs.readFile(path.join(rootPath, 'pyproject.toml'), 'utf8')
    if (pyproject.includes('pytest')) return true
  } catch {}

  return false
}

async function detectRepoIsDirty(rootPath: string): Promise<boolean> {
  try {
    const output = await runCommandTextLegacy({
      command: 'git',
      args: ['-C', rootPath, 'status', '--porcelain', '--untracked-files=normal'],
      timeout: '1500 millis',
      check: 'none'
    })
    return output.code === 0 && output.stdout.trim().length > 0
  } catch {
    return false
  }
}

const SOURCE_FILE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.py',
  '.go',
  '.rs',
  '.swift',
  '.kt',
  '.java',
  '.rb',
  '.c',
  '.cc',
  '.cpp',
  '.h'
])

async function detectRepoHasTodos(rootPath: string): Promise<boolean> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }]
  let inspectedFiles = 0
  const maxFiles = 48
  const maxDepth = 3

  while (queue.length > 0 && inspectedFiles < maxFiles) {
    const current = queue.shift()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (inspectedFiles >= maxFiles) break
      if (entry.name.startsWith('.') || IGNORED_SCAN_DIRS.has(entry.name)) continue
      const fullPath = path.join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (current.depth < maxDepth) {
          queue.push({ dir: fullPath, depth: current.depth + 1 })
        }
        continue
      }
      if (!entry.isFile() || !SOURCE_FILE_EXTENSIONS.has(path.extname(entry.name))) {
        continue
      }
      try {
        const stat = await fs.stat(fullPath)
        if (stat.size > 96 * 1024) continue
        inspectedFiles += 1
        const content = await fs.readFile(fullPath, 'utf8')
        if (/\b(TODO|FIXME)\b/.test(content)) {
          return true
        }
      } catch {}
    }
  }

  return false
}

export async function inspectLocalRepoPromptHints(rootPath: string): Promise<LocalRepoPromptHints> {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
    return { hasTests: false, isDirty: false, hasTodos: false }
  }
  const [hasTests, isDirty, hasTodos] = await Promise.all([
    detectRepoHasTests(rootPath),
    detectRepoIsDirty(rootPath),
    detectRepoHasTodos(rootPath)
  ])
  return { hasTests, isDirty, hasTodos }
}
