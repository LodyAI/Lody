import { existsSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

/** No IO or package changes unless the owner explicitly selects this build. */
export function passkeyPackagingPlan({
  enabled,
  macPackaging,
  appId = 'ai.lody.desktop',
  addonDirectory,
  provisioningProfile,
  architectures
}) {
  if (enabled !== '1') return undefined
  if (!macPackaging || appId !== 'ai.lody.desktop') {
    throw new Error('Passkeys require a macOS ai.lody.desktop build')
  }
  if (!addonDirectory || !provisioningProfile) {
    throw new Error('Passkeys require LODY_PASSKEY_ADDON_DIR and LODY_PASSKEY_PROVISIONING_PROFILE')
  }
  if (!architectures?.length || architectures.some((arch) => !['arm64', 'x64'].includes(arch))) {
    throw new Error(
      'Passkeys require explicit arm64/x64 artifacts; universal builds are unsupported'
    )
  }
  return {
    addons: architectures.map((arch) => ({
      arch,
      file: path.resolve(addonDirectory, arch, 'passkey_bridge.node')
    })),
    resource: {
      from: path.resolve(addonDirectory, '${arch}', 'passkey_bridge.node'),
      to: 'passkey_bridge.node'
    },
    provisioningProfile: path.resolve(provisioningProfile)
  }
}

export function applyPasskeyPackaging({ config, plan, repoRoot, generatedDirectory }) {
  if (!plan) return
  for (const { arch, file } of plan.addons) {
    if (!existsSync(file)) throw new Error(`Missing passkey addon for ${arch}: ${file}`)
    execFileSync('lipo', [file, '-verify_arch', arch === 'x64' ? 'x86_64' : arch])
  }
  if (!existsSync(plan.provisioningProfile)) throw new Error('Missing passkey provisioning profile')
  const entitlements = path.join(generatedDirectory, 'entitlements.passkey.plist')
  const base = JSON.parse(
    execFileSync(
      'plutil',
      [
        '-convert',
        'json',
        '-o',
        '-',
        path.join(repoRoot, 'apps/electron/build/entitlements.mac.plist')
      ],
      { encoding: 'utf8' }
    )
  )
  writeFileSync(
    entitlements,
    JSON.stringify({
      ...base,
      'com.apple.developer.associated-domains': ['webcredentials:lody.ai'],
      'com.apple.application-identifier': 'YTRMX32C99.ai.lody.desktop',
      'com.apple.developer.team-identifier': 'YTRMX32C99'
    })
  )
  execFileSync('plutil', ['-convert', 'xml1', entitlements])
  config.mac = {
    ...config.mac,
    entitlements,
    provisioningProfile: plan.provisioningProfile,
    extraResources: [...(config.mac?.extraResources ?? []), plan.resource]
  }
}
