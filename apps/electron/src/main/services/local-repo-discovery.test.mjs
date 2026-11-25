import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { discoverRecentLocalRepos, inspectLocalRepoPromptHints } from './local-repo-discovery.ts'

void test('discoverRecentLocalRepos scans allowed dev directories 1-2 levels deep and never touches TCC folders', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'lody-repo-scan-'))
  try {
    // Allowed 1st-level and 2nd-level git repos
    const repoA = path.join(home, 'code', 'alpha')
    const repoB = path.join(home, 'Developer', 'acme', 'beta')
    mkdirSync(path.join(repoA, '.git'), { recursive: true })
    mkdirSync(path.join(repoB, '.git'), { recursive: true })
    writeFileSync(path.join(repoA, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(path.join(repoB, '.git', 'HEAD'), 'ref: refs/heads/main\n')

    const older = new Date(Date.now() - 60_000)
    const newer = new Date()
    utimesSync(path.join(repoA, '.git', 'HEAD'), older, older)
    utimesSync(path.join(repoB, '.git', 'HEAD'), newer, newer)

    // TCC-protected directories must NEVER be scanned even if git repos exist inside them
    for (const forbidden of ['Documents', 'Desktop', 'Downloads']) {
      const secretRepo = path.join(home, forbidden, `secret-${forbidden}`)
      mkdirSync(path.join(secretRepo, '.git'), { recursive: true })
    }

    const repos = await discoverRecentLocalRepos(home)
    assert.deepEqual(
      repos.map((r) => r.name),
      ['beta', 'alpha']
    )
    for (const repo of repos) {
      assert.equal(repo.rootPath.includes('Documents'), false)
      assert.equal(repo.rootPath.includes('Desktop'), false)
      assert.equal(repo.rootPath.includes('Downloads'), false)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

void test('inspectLocalRepoPromptHints detects test scripts and TODO markers', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'lody-repo-hints-'))
  try {
    writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'sample', scripts: { test: 'vitest run' } })
    )
    mkdirSync(path.join(repo, 'src'), { recursive: true })
    writeFileSync(
      path.join(repo, 'src', 'index.ts'),
      '// TODO: wire onboarding\nexport const x = 1;\n'
    )

    const hints = await inspectLocalRepoPromptHints(repo)
    assert.equal(hints.hasTests, true)
    assert.equal(hints.hasTodos, true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
