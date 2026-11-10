import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import beforePack from './scripts/eb-before-pack.mjs'
import afterPack from './scripts/eb-after-pack.mjs'

const input = JSON.parse(readFileSync(process.env.LODY_RELEASE_CONFIG, 'utf8'))
const overrides =
  input.packaging[process.env.LODY_RELEASE_TARGET === 'linux-arm64' ? 'arm64' : 'x64']
const publish = { provider: 'generic', url: input.env.VITE_ELECTRON_UPDATE_URL, channel: 'nightly' }
if (
  input.profile.channel !== 'nightly' ||
  overrides.extraMetadata.lodyBuild.version !== input.profile.version
)
  throw new Error('Unsigned packaging requires the approved Nightly profile')

export default {
  extends: fileURLToPath(new URL('./electron-builder.yml', import.meta.url)),
  ...overrides,
  extraMetadata: {
    ...overrides.extraMetadata,
    version: input.profile.version,
    homepage: 'https://lody.ai'
  },
  publish: [publish],
  linux: { ...overrides.linux, maintainer: 'lody.ai' },
  // No Developer ID, notarization or publishing credentials are available here.
  mac: { ...overrides.mac, identity: null, notarize: false },
  beforePack: async (context) => {
    // electron-builder concatenates inherited arrays; replace Stable/OSS protocols.
    context.packager.config.protocols = overrides.protocols
    context.packager.config.publish = publish
    await beforePack(context)
  },
  afterPack: async (context) => {
    if (context.electronPlatformName === 'darwin') {
      const arch = { 1: 'x64', 3: 'arm64' }[context.arch]
      if (!arch) throw new Error('Unsigned macOS packaging requires separate arm64/x64 apps')
      const plist = path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        'Contents/Info.plist'
      )
      const result = spawnSync(
        'plutil',
        ['-replace', 'SUFeedURL', '-string', `${publish.url}/${arch}/appcast.xml`, plist],
        { encoding: 'utf8' }
      )
      if (result.error || result.status !== 0)
        throw new Error(`Cannot set Sparkle feed: ${result.error?.message ?? result.stderr}`)
    }
    await afterPack(context)
  }
}
