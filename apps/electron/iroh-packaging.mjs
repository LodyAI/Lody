import { existsSync } from 'node:fs'
import path from 'node:path'

const platforms = { '--mac': 'darwin', '--win': 'win32', '--linux': 'linux' }

/** The electron-builder target platform: an explicit flag, else the host. */
export function irohTargetPlatform(args, hostPlatform = process.platform) {
  const selected = Object.entries(platforms)
    .filter(([flag]) => args.includes(flag))
    .map(([, platform]) => platform)
  if (selected.length > 1) throw new Error('iroh packaging needs one target platform per run')
  return selected[0] ?? hostPlatform
}

/**
 * No IO or package changes unless the build carries Lody iroh relays. With relays,
 * every selected architecture must have its prebuilt module, built by
 * build-iroh.mjs into `LODY_IROH_ADDON_DIR/<arch>/lody-iroh.<platform>-<arch>.node`.
 */
export function irohPackagingPlan({ relays, addonDirectory, platform, architectures }) {
  if (!relays?.trim()) return undefined
  if (!addonDirectory) throw new Error('VITE_IROH_RELAYS requires LODY_IROH_ADDON_DIR')
  if (!['darwin', 'win32', 'linux'].includes(platform))
    throw new Error(`No iroh module for ${platform}`)
  if (!architectures?.length || architectures.some((arch) => !['arm64', 'x64'].includes(arch)))
    throw new Error('iroh packaging requires explicit arm64/x64 targets; universal is unsupported')
  return {
    addons: architectures.map((arch) => ({
      arch,
      file: path.resolve(addonDirectory, arch, `lody-iroh.${platform}-${arch}.node`)
    })),
    resource: {
      from: path.resolve(addonDirectory, '${arch}', `lody-iroh.${platform}-\${arch}.node`),
      to: `lody-iroh.${platform}-\${arch}.node`
    }
  }
}

export function applyIrohPackaging({ config, plan }) {
  if (!plan) return
  for (const { arch, file } of plan.addons)
    if (!existsSync(file)) throw new Error(`Missing iroh module for ${arch}: ${file}`)
  config.extraResources = [...(config.extraResources ?? []), plan.resource]
}
