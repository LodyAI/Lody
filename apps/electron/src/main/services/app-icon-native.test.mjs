import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setMacApplicationIcon } from './app-icon-native.ts'

void test(
  'macOS persists a custom icon without changing sealed contents and clears it',
  {
    skip: process.platform !== 'darwin'
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-icon-test-'))
    const bundle = join(directory, 'Icon Test.app')
    const info = join(bundle, 'Contents/Info.plist')
    try {
      await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true })
      await copyFile('/usr/bin/true', join(bundle, 'Contents/MacOS/probe'))
      await writeFile(
        info,
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.lody.icon-test</string><key>CFBundleExecutable</key><string>probe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>'
      )
      execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { stdio: 'pipe' })
      const seal = await readFile(join(bundle, 'Contents/_CodeSignature/CodeResources'))
      const originalInfo = await readFile(info)
      await setMacApplicationIcon(
        bundle,
        fileURLToPath(new URL('../../../resources/app-icons/aqua.png', import.meta.url))
      )
      const finderInfo = execFileSync('/usr/bin/xattr', ['-px', 'com.apple.FinderInfo', bundle], {
        encoding: 'utf8'
      })
      const flags = Buffer.from(finderInfo.replace(/\s/g, ''), 'hex').readUInt16BE(8)
      assert.ok(flags & 0x0400, 'Finder custom icon flag persists on disk')
      assert.deepEqual(await readFile(info), originalInfo)
      assert.deepEqual(await readFile(join(bundle, 'Contents/_CodeSignature/CodeResources')), seal)
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', bundle], { stdio: 'pipe' })
      await assert.rejects(setMacApplicationIcon(bundle, join(directory, 'missing.png')))
      await setMacApplicationIcon(bundle, null)
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {
        stdio: 'pipe'
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
