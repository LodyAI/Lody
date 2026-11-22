import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import publicAfterPack from './scripts/eb-after-pack.mjs'
import { sparkleInfoPlistPath } from './scripts/sparkle-packaging.mjs'
import { resolveCloudSparkleAppcastUrl } from './sparkle-packaging.mjs'

const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

export function resolvePackagedSparkleAppcastUrl({ environment, updateBaseUrl, arch }) {
  if (environment !== 'staging' && environment !== 'production') {
    throw new Error(`Unsupported Sparkle package environment: ${JSON.stringify(environment)}`)
  }
  return resolveCloudSparkleAppcastUrl({
    updateBaseUrl,
    architecture: environment === 'production' ? arch : undefined
  })
}

export default async function afterPack(context) {
  const platform = context.electronPlatformName
  if (platform === 'darwin' || platform === 'mas') {
    const arch = ARCH_NAMES[context.arch]
    const appcastUrl = resolvePackagedSparkleAppcastUrl({
      environment: process.env.LODY_SPARKLE_PACKAGE_ENVIRONMENT,
      updateBaseUrl: process.env.LODY_SPARKLE_UPDATE_BASE_URL,
      arch
    })
    const plistPath = sparkleInfoPlistPath({
      appOutDir: context.appOutDir,
      productFilename: context.packager.appInfo.productFilename
    })
    if (!fs.existsSync(plistPath)) {
      throw new Error(`[sparkle] missing Info.plist: ${plistPath}`)
    }
    const injectResult = spawnSync(
      'plutil',
      ['-replace', 'SUFeedURL', '-string', appcastUrl, plistPath],
      { encoding: 'utf8' }
    )
    if (injectResult.error || injectResult.status !== 0) {
      throw new Error(
        `[sparkle] failed to inject SUFeedURL: ${injectResult.error?.message ?? injectResult.stderr ?? injectResult.stdout}`
      )
    }
    console.log(`[sparkle] configured ${arch} feed ${appcastUrl}`)
  }

  await publicAfterPack(context)
}
