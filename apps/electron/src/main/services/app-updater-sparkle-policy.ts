import path from 'node:path'

export const DEFAULT_SPARKLE_APPCAST_URL =
  'https://github.com/LodyAI/Lody/releases/latest/download/appcast.xml'

const SPARKLE_ADDON_RELATIVE_PATH = path.join('native', 'build', 'Release', 'sparkle_bridge.node')

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

export function shouldConstructUpdaterEnabled(input: {
  localPlatform: boolean
  forceEnable: boolean
}): boolean {
  return input.forceEnable || !input.localPlatform
}

export function shouldUseSparkleUpdater(input: {
  platform: string
  isPackaged: boolean
  sparkleAvailable: boolean
}): boolean {
  return input.platform === 'darwin' && input.isPackaged && input.sparkleAvailable
}

export function resolveSparkleAppcastUrl(input: { configuredAppcastUrl?: string } = {}): string {
  return readNonEmptyString(input.configuredAppcastUrl) ?? DEFAULT_SPARKLE_APPCAST_URL
}

export function sparklePackageJsonPathFromModuleEntry(moduleEntryPath: string): string {
  return path.join(path.dirname(moduleEntryPath), '..', 'package.json')
}

export function resolveSparkleAddonPath(input: {
  isPackaged: boolean
  resourcesPath: string
  resolvedPackageJsonPath?: string
  exists: (candidate: string) => boolean
}): string | null {
  const candidates: string[] = []
  if (input.resolvedPackageJsonPath) {
    const fromPackage = path.join(
      path.dirname(input.resolvedPackageJsonPath),
      SPARKLE_ADDON_RELATIVE_PATH
    )
    candidates.push(
      fromPackage.replace(
        `${path.sep}app.asar${path.sep}`,
        `${path.sep}app.asar.unpacked${path.sep}`
      )
    )
    if (!candidates.includes(fromPackage)) candidates.push(fromPackage)
  }
  if (input.isPackaged) {
    candidates.push(
      path.join(
        input.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'electron-sparkle-updater',
        SPARKLE_ADDON_RELATIVE_PATH
      )
    )
  }
  return candidates.find((candidate) => input.exists(candidate)) ?? null
}

function readXmlTagValue(itemXml: string, tagName: string): string | undefined {
  const match = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'u').exec(itemXml)
  return readNonEmptyString(match?.[1])
}

function readEnclosureAttribute(itemXml: string, attributeName: string): string | undefined {
  const enclosureMatch = /<enclosure\b([^>]*)\/?>/u.exec(itemXml)
  if (!enclosureMatch?.[1]) return undefined
  const attrMatch = new RegExp(`\\b${attributeName}="([^"]+)"`, 'u').exec(enclosureMatch[1])
  return readNonEmptyString(attrMatch?.[1])
}

export function findLatestSparkleFeedVersion(
  xml: string,
  options: { arch?: string } = {}
): string | undefined {
  const stripped = xml
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/gu, '')
    .replace(/<sparkle:deltas\b[^>]*>[\s\S]*?<\/sparkle:deltas>/gu, '')
  const itemPattern = /<item\b[^>]*>([\s\S]*?)<\/item>/gu
  for (const match of stripped.matchAll(itemPattern)) {
    const itemXml = match[1]
    const hardware = readXmlTagValue(itemXml, 'sparkle:hardwareRequirements')
    if (hardware && options.arch) {
      const supportedArches = hardware.split(/[\s,]+/u).filter(Boolean)
      if (supportedArches.length > 0 && !supportedArches.includes(options.arch)) {
        continue
      }
    }
    const version =
      readXmlTagValue(itemXml, 'sparkle:shortVersionString') ??
      readEnclosureAttribute(itemXml, 'sparkle:shortVersionString') ??
      readXmlTagValue(itemXml, 'sparkle:version') ??
      readEnclosureAttribute(itemXml, 'sparkle:version')
    if (version) return version
  }
  return undefined
}
