import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import { parse as parseYaml } from 'yaml'
import { nightlyBuilderOverrides } from './release-profile.mjs'

const MAX_RELEASE_NOTES_BYTES = 64 * 1024
const CHANGELOG_LOCALES = {
  en: 'en',
  zh_CN: 'zh'
}

function requireNonEmptyString(value, field, file) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing ${field} in ${file}`)
  }
  return value.trim()
}

function normalizeDate(value, file) {
  let normalized
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    normalized = value.toISOString().slice(0, 10)
  } else {
    normalized = requireNonEmptyString(value, 'date', file)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new Error(`Invalid date in ${file}: ${JSON.stringify(normalized)}`)
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`Invalid date in ${file}: ${JSON.stringify(normalized)}`)
  }
  return normalized
}

export function validateChangelogVersion(version) {
  const normalized = requireNonEmptyString(version, 'Electron package version', 'package.json')
  if (semver.valid(normalized) === null) {
    throw new Error(`Electron package version is not valid semver: ${JSON.stringify(version)}`)
  }
  return normalized
}

export function parseChangelogMdx(source, file = '<changelog>') {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(source)
  if (!match) {
    throw new Error(`Missing YAML frontmatter: ${file}`)
  }

  const frontmatter = parseYaml(match[1])
  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new Error(`Invalid YAML frontmatter: ${file}`)
  }

  const body = source.slice(match[0].length).trim()
  if (!body) {
    throw new Error(`Missing changelog body: ${file}`)
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_RELEASE_NOTES_BYTES) {
    throw new Error(`Changelog exceeds ${MAX_RELEASE_NOTES_BYTES} bytes: ${file}`)
  }

  return {
    version: requireNonEmptyString(frontmatter.version, 'version', file),
    date: normalizeDate(frontmatter.date, file),
    draft: frontmatter.draft === true,
    body
  }
}

function readChangelogIdentity(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(source)
  if (!match) return null

  try {
    const frontmatter = parseYaml(match[1])
    if (!frontmatter || typeof frontmatter !== 'object') return null
    if (typeof frontmatter.version !== 'string') return null
    const version = frontmatter.version.trim()
    if (!version) return null
    return { version, draft: frontmatter.draft === true }
  } catch {
    return null
  }
}

function findSiteChangelogEntry({ repoRoot, localeDirectory, version }) {
  const directory = path.join(repoRoot, 'site-docs', 'content', 'changelog', localeDirectory)
  const matches = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mdx'))
    .map((entry) => {
      const file = path.join(directory, entry.name)
      const source = readFileSync(file, 'utf8')
      return { file, source, identity: readChangelogIdentity(source) }
    })
    .filter(({ identity }) => identity?.version === version && !identity.draft)
    .map(({ file, source }) => parseChangelogMdx(source, file))

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one published ${localeDirectory} changelog for ${version}, found ${matches.length}`
    )
  }
  return matches[0]
}

export function loadElectronUpdateReleaseInfo({ repoRoot, version }) {
  const contentVersion = validateChangelogVersion(version)
  const entries = Object.fromEntries(
    Object.entries(CHANGELOG_LOCALES).map(([locale, localeDirectory]) => [
      locale,
      findSiteChangelogEntry({ repoRoot, localeDirectory, version: contentVersion })
    ])
  )

  const releaseDates = new Set(
    Object.values(entries)
      .map((entry) => entry.date)
      .filter(Boolean)
  )
  if (releaseDates.size > 1) {
    throw new Error(`Localized changelog dates disagree for ${contentVersion}`)
  }

  const locales = Object.fromEntries(
    Object.entries(entries).map(([locale, entry]) => [locale, entry.body])
  )
  const releaseDate = releaseDates.values().next().value

  return {
    releaseNotes: locales.en,
    ...(releaseDate ? { releaseDate } : {}),
    vendor: {
      lodyChangelog: {
        contentVersion,
        locales
      }
    }
  }
}

export function createElectronBuilderConfig({
  baseConfigPath,
  repoRoot,
  version,
  includeReleaseInfo = true,
  updateBaseUrl,
  updateChannel,
  sparkleAppcastUrl,
  releaseProfile,
  linuxArtifactArch = 'x64'
}) {
  const config = {
    extends: baseConfigPath,
    extraMetadata: { version, homepage: 'https://lody.ai' },
    publish: {
      provider: 'generic',
      url: requireNonEmptyString(updateBaseUrl, 'Electron update base URL', 'build environment'),
      channel: requireNonEmptyString(updateChannel, 'Electron update channel', 'build environment')
    },
    ...(sparkleAppcastUrl
      ? {
          mac: {
            extendInfo: {
              SUFeedURL: sparkleAppcastUrl
            }
          }
        }
      : {}),
    ...(includeReleaseInfo && releaseProfile?.channel !== 'nightly'
      ? { releaseInfo: loadElectronUpdateReleaseInfo({ repoRoot, version }) }
      : {})
  }
  if (releaseProfile?.channel !== 'nightly') return config

  const base = parseYaml(readFileSync(baseConfigPath, 'utf8'))
  const overrides = nightlyBuilderOverrides(releaseProfile, { linuxArtifactArch })
  const result = { ...base, ...config, ...overrides }
  delete result.extends
  for (const key of [
    'extraMetadata',
    'win',
    'nsis',
    'mac',
    'dmg',
    'linux',
    'appImage',
    'deb',
    'snap'
  ]) {
    result[key] = { ...base[key], ...config[key], ...overrides[key] }
  }
  result.mac.extendInfo = { ...base.mac?.extendInfo, ...config.mac?.extendInfo }
  return result
}
