import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const triples = {
  darwin: { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' },
  win32: { arm64: 'aarch64-pc-windows-msvc', x64: 'x86_64-pc-windows-msvc' },
  linux: { arm64: 'aarch64-unknown-linux-gnu', x64: 'x86_64-unknown-linux-gnu' }
}
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
if (outIndex < 0 || !args[outIndex + 1]) throw new Error('--out <dir> is required')
const out = path.resolve(args[outIndex + 1])
const platform = process.platform
const architectures = ['arm64', 'x64'].filter((arch) => args.includes(`--${arch}`))
if (!architectures.length) architectures.push(process.arch)
const packageDir = path.join(repoRoot, 'packages', 'iroh-native')
for (const arch of architectures) {
  const target = triples[platform]?.[arch]
  if (!target) throw new Error(`No iroh target for ${platform}-${arch}`)
  execFileSync('node', ['scripts/build.mjs'], {
    cwd: packageDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      LODY_IROH_TARGET: target,
      LODY_IROH_PLATFORM: platform,
      LODY_IROH_ARCH: arch
    }
  })
  const name = `lody-iroh.${platform}-${arch}.node`
  mkdirSync(path.join(out, arch), { recursive: true })
  copyFileSync(path.join(packageDir, name), path.join(out, arch, name))
  console.log(`[build-iroh] ${arch}: ${path.join(out, arch, name)}`)
}
