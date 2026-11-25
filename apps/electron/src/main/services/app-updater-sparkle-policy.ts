import path from 'node:path'

export const DEFAULT_SPARKLE_APPCAST_URL =
  'https://github.com/LodyAI/Lody/releases/latest/download/appcast.xml'

const SPARKLE_ADDON_RELATIVE_PATH = path.join('native', 'build', 'Release', 'sparkle_bridge.node')
const FAIL_CLOSED_SPARKLE_HOST = 'invalid.invalid'

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
}

function stripXmlCommentsAndCdata(xml: string): string {
  return xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/gu, '')
}

function parseVersionSegment(segment: string): { numeric: boolean; num: number; raw: string } {
  if (/^[0-9]+$/u.test(segment)) {
    return { numeric: true, num: Number(segment), raw: segment }
  }
  return { numeric: false, num: Number.NaN, raw: segment }
}

function compareDotSegments(left: string, right: string): number {
  const leftParts = left.split('.')
  const rightParts = right.split('.')
  const maxLength = Math.max(leftParts.length, rightParts.length)
  for (let i = 0; i < maxLength; i++) {
    const a = leftParts[i]
    const b = rightParts[i]
    if (a === undefined && b === undefined) return 0
    if (a === undefined) return /^[0-9]+$/u.test(b) && Number(b) === 0 ? 0 : -1
    if (b === undefined) return /^[0-9]+$/u.test(a) && Number(a) === 0 ? 0 : 1
    const pa = parseVersionSegment(a)
    const pb = parseVersionSegment(b)
    if (pa.numeric && pb.numeric) {
      if (pa.num !== pb.num) return pa.num < pb.num ? -1 : 1
      continue
    }
    if (pa.raw !== pb.raw) return pa.raw < pb.raw ? -1 : 1
  }
  return 0
}

export function compareSparkleVersions(left: string, right: string): number {
  const a = left.trim()
  const b = right.trim()
  if (a === b) return 0

  const [aCore, aPre] = a.split('-', 2)
  const [bCore, bPre] = b.split('-', 2)
  const coreOrder = compareDotSegments(aCore, bCore)
  if (coreOrder !== 0) return coreOrder

  if (aPre === undefined && bPre === undefined) return 0
  if (aPre === undefined) return 1
  if (bPre === undefined) return -1
  return compareDotSegments(aPre, bPre)
}

export function readSparkleFeedUrlFromInfoPlist(plistXml: string): string | undefined {
  if (typeof plistXml !== 'string' || !plistXml.trim()) return undefined
  const withoutComments = plistXml.replace(/<!--[\s\S]*?-->/gu, '')
  const match = /<key>\s*SUFeedURL\s*<\/key>\s*<string>([^<]+)<\/string>/u.exec(withoutComments)
  if (!match?.[1]) return undefined
  const candidate = readNonEmptyString(decodeXmlEntities(match[1]))
  if (!candidate) return undefined
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
    if (parsed.hostname.toLowerCase() === FAIL_CLOSED_SPARKLE_HOST) return undefined
    return parsed.href
  } catch {
    return undefined
  }
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

export function resolveSparkleAppcastUrl(
  input: { configuredAppcastUrl?: string; plistAppcastUrl?: string } = {}
): string {
  return (
    readNonEmptyString(input.configuredAppcastUrl) ??
    readNonEmptyString(input.plistAppcastUrl) ??
    DEFAULT_SPARKLE_APPCAST_URL
  )
}

function readFirstTagText(itemXml: string, tagName: string): string | undefined {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([^<]+)<\\/${tagName}>`, 'u')
  const match = pattern.exec(itemXml)
  return match?.[1] ? readNonEmptyString(decodeXmlEntities(match[1])) : undefined
}

function readMainEnclosureAttribute(itemXml: string, attributeName: string): string | undefined {
  const withoutDeltas = itemXml.replace(/<sparkle:deltas\b[^>]*>[\s\S]*?<\/sparkle:deltas>/gu, '')
  const enclosureMatch = /<enclosure\b([^>]*)\/?>/u.exec(withoutDeltas)
  if (!enclosureMatch?.[1]) return undefined
  const attrPattern = new RegExp(`\\b${attributeName}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`, 'u')
  const attrMatch = attrPattern.exec(enclosureMatch[1])
  const raw = attrMatch?.[1] ?? attrMatch?.[2]
  return raw ? readNonEmptyString(decodeXmlEntities(raw)) : undefined
}

export function readLatestSparkleAppcastVersion(input: {
  appcastXml: string
  currentOsVersion?: string
}): string | undefined {
  if (typeof input.appcastXml !== 'string' || !input.appcastXml.trim()) return undefined
  const sanitized = stripXmlCommentsAndCdata(input.appcastXml)
  if (/<!(?:DOCTYPE|ENTITY)\b/iu.test(sanitized)) return undefined

  const currentOs = readNonEmptyString(input.currentOsVersion)
  let latest: string | undefined

  const itemPattern = /<item\b[^>]*>([\s\S]*?)<\/item>/gu
  for (const match of sanitized.matchAll(itemPattern)) {
    const itemXml = match[1]
    if (!itemXml) continue
    if (/<sparkle:informationalUpdate\b/u.test(itemXml)) continue

    const minOs = readFirstTagText(itemXml, 'sparkle:minimumSystemVersion')
    if (currentOs && minOs && compareSparkleVersions(currentOs, minOs) < 0) continue

    const shortVersion =
      readFirstTagText(itemXml, 'sparkle:shortVersionString') ??
      readMainEnclosureAttribute(itemXml, 'sparkle:shortVersionString')
    const buildVersion =
      readFirstTagText(itemXml, 'sparkle:version') ??
      readMainEnclosureAttribute(itemXml, 'sparkle:version')
    const displayVersion = shortVersion ?? buildVersion
    if (!displayVersion) continue

    if (!latest || compareSparkleVersions(displayVersion, latest) > 0) {
      latest = displayVersion
    }
  }

  return latest
}

export function shouldRefreshStaleSparkleDownload(input: {
  appcastXml: string
  downloadedVersion?: string
  currentOsVersion?: string
}): boolean {
  const downloaded = readNonEmptyString(input.downloadedVersion)
  if (!downloaded) return false
  const latest = readLatestSparkleAppcastVersion({
    appcastXml: input.appcastXml,
    currentOsVersion: input.currentOsVersion
  })
  if (!latest) return false
  return compareSparkleVersions(latest, downloaded) > 0
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
