import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const quiet = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function profileGrants(granted, requested) {
  if (granted === undefined) return false
  if (Array.isArray(requested)) return requested.every((value) => profileGrants(granted, value))
  if (Array.isArray(granted)) return granted.some((value) => profileGrants(value, requested))
  if (typeof granted === 'string' && granted.endsWith('*')) {
    return typeof requested === 'string' && requested.startsWith(granted.slice(0, -1))
  }
  return granted === requested
}

/**
 * Reasons macOS would refuse the signed app at launch. `codesign --verify`, notarization
 * and Gatekeeper do not compare a signature with its embedded profile; AMFI does, and
 * kills the process when the profile does not authorize the signing certificate or an
 * entitlement outside `com.apple.security.*`.
 */
export function passkeyProfileFindings({ profile, signingCertificateSha256, entitlements, now }) {
  const findings = []
  if (!profile.certificateSha256.includes(signingCertificateSha256)) {
    findings.push(
      `signing certificate ${signingCertificateSha256} is not one the profile authorizes (${profile.certificateSha256.join(', ') || 'none'})`
    )
  }
  if (!(new Date(profile.expirationDate) > now)) {
    findings.push(`profile expired on ${profile.expirationDate}`)
  }
  if (!profile.provisionsAllDevices) {
    findings.push('profile is limited to registered devices; releases need a Developer ID profile')
  }
  for (const [key, value] of Object.entries(entitlements)) {
    if (key.startsWith('com.apple.security.')) continue
    if (!profileGrants(profile.entitlements[key], value)) {
      findings.push(`profile does not grant ${key}`)
    }
  }
  return findings
}

/** Reads a profile already decoded by `security cms -D`. Binary and date values rule out JSON conversion. */
export function readProvisioningProfile(plist) {
  const extract = (keyPath, format = 'raw') => {
    try {
      return execFileSync('plutil', ['-extract', keyPath, format, '-o', '-', plist], quiet).trim()
    } catch {
      return undefined
    }
  }
  return {
    name: extract('Name'),
    expirationDate: extract('ExpirationDate'),
    provisionsAllDevices: extract('ProvisionsAllDevices') === 'true',
    certificateSha256: Array.from(
      { length: Number(extract('DeveloperCertificates') ?? 0) },
      (_, i) => sha256(Buffer.from(extract(`DeveloperCertificates.${i}`), 'base64'))
    ),
    entitlements: JSON.parse(extract('Entitlements', 'json') ?? '{}')
  }
}

export function signedPasskeyAppFindings(app, now) {
  const directory = mkdtempSync(path.join(tmpdir(), 'passkey-signature-'))
  try {
    const plist = path.join(directory, 'profile.plist')
    const embedded = path.join(app, 'Contents/embedded.provisionprofile')
    execFileSync('security', ['cms', '-D', '-i', embedded, '-o', plist], quiet)
    const certificate = path.join(directory, 'certificate')
    execFileSync('codesign', ['-d', `--extract-certificates=${certificate}`, app], quiet)
    const signed = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', app], quiet)
    return passkeyProfileFindings({
      profile: readProvisioningProfile(plist),
      signingCertificateSha256: sha256(readFileSync(`${certificate}0`)),
      entitlements: JSON.parse(
        execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { ...quiet, input: signed })
      ),
      now
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const app = process.argv[2]
  if (!app) throw new Error('Usage: node passkey-packaging.mjs <path to signed Lody.app>')
  const findings = signedPasskeyAppFindings(app, new Date())
  for (const finding of findings) console.error(`${app}: ${finding}`)
  if (findings.length) process.exitCode = 1
}
