import { createWriteStream } from 'node:fs'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

const MAX_APPCAST_BYTES = 5 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
const APPCAST_TIMEOUT_MS = 30_000
const ARCHIVE_TIMEOUT_MS = 10 * 60_000
const ARCHIVE_ATTEMPTS = 3
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function readXmlString(value, label) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid Sparkle ${label}`)
  }
  return value.trim()
}

export function readAppcastItems(xml) {
  if (typeof xml !== 'string' || XMLValidator.validate(xml) !== true) {
    throw new Error('Invalid Sparkle appcast XML')
  }
  const declarations = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/gu, '')
  if (/<!(?:DOCTYPE|ENTITY)\b/iu.test(declarations)) {
    throw new Error('Sparkle appcasts cannot contain DTD/entity declarations')
  }
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (name) => name === 'item' || name === 'enclosure'
  }).parse(xml)
  const items = parsed?.rss?.channel?.item
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Sparkle appcast has no update items')
  }
  return items
}

function safeArchiveFilename(url) {
  const filename = decodeURIComponent(path.posix.basename(url.pathname))
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*\.zip$/u.test(filename)) {
    throw new Error(`Unsafe Sparkle archive filename: ${JSON.stringify(filename)}`)
  }
  return filename
}

export function findSparkleDeltaBases(
  xml,
  appcastUrl,
  maxVersions = 2,
  currentVersion,
  currentBuildVersion
) {
  if (!Number.isInteger(maxVersions) || maxVersions < 0) {
    throw new Error('maxVersions must be a non-negative integer')
  }

  const feedUrl = new URL(appcastUrl)
  if (feedUrl.protocol !== 'https:') {
    throw new Error('Remote Sparkle appcasts must use HTTPS')
  }
  const feedDirectory = new URL('.', feedUrl)
  const selectedVersions = new Set()
  const selectedUrls = []
  const seenUrls = new Set()
  const filenames = new Map()

  for (const item of readAppcastItems(xml)) {
    const enclosures = item.enclosure ?? []
    const mainEnclosure = enclosures[0]
    const displayVersion = readXmlString(
      item['sparkle:shortVersionString'] ?? mainEnclosure?.['@_sparkle:shortVersionString'],
      'display version'
    )
    const buildVersion = readXmlString(
      item['sparkle:version'] ?? mainEnclosure?.['@_sparkle:version'],
      'build version'
    )
    const version = buildVersion ?? displayVersion
    if (!version) continue
    if (
      (currentVersion && (displayVersion ?? buildVersion) === currentVersion) ||
      (currentBuildVersion && buildVersion === currentBuildVersion)
    ) {
      throw new Error(
        `Sparkle release ${currentVersion ?? currentBuildVersion} already exists; versioned releases are immutable`
      )
    }
    if (!selectedVersions.has(version)) {
      if (selectedVersions.size >= maxVersions) continue
      selectedVersions.add(version)
    }

    for (const enclosure of enclosures) {
      const rawUrl = readXmlString(enclosure['@_url'], 'archive URL')
      if (!rawUrl) continue
      const url = new URL(rawUrl, feedUrl)
      if (!url.pathname.endsWith('.zip')) continue
      if (url.origin !== feedDirectory.origin || !url.pathname.startsWith(feedDirectory.pathname)) {
        throw new Error(`Sparkle delta base is outside the configured update directory: ${url}`)
      }
      const filename = safeArchiveFilename(url)
      const existingUrl = filenames.get(filename)
      if (existingUrl && existingUrl !== url.href) {
        throw new Error(`Conflicting Sparkle delta base URLs use the same filename: ${filename}`)
      }
      filenames.set(filename, url.href)
      if (seenUrls.has(url.href)) continue
      const signature = readXmlString(enclosure['@_sparkle:edSignature'], 'archive signature')
      const lengthValue = readXmlString(enclosure['@_length'], 'archive length')
      const length = Number(lengthValue)
      if (!signature || !Number.isSafeInteger(length) || length <= 0) {
        throw new Error(`Sparkle delta base has no valid signature or length: ${url}`)
      }
      seenUrls.add(url.href)
      selectedUrls.push({ url: url.href, filename, signature, length })
    }
  }

  return selectedUrls
}

export function findSparkleDeltaBaseUrls(
  xml,
  appcastUrl,
  maxVersions = 2,
  currentVersion,
  currentBuildVersion
) {
  return findSparkleDeltaBases(
    xml,
    appcastUrl,
    maxVersions,
    currentVersion,
    currentBuildVersion
  ).map((entry) => entry.url)
}

function assertResponseStayedInUpdateDirectory(response, appcastUrl, label) {
  const feedDirectory = new URL('.', appcastUrl)
  const responseUrl = new URL(response.url)
  if (
    responseUrl.origin !== feedDirectory.origin ||
    !responseUrl.pathname.startsWith(feedDirectory.pathname)
  ) {
    throw new Error(`${label} redirected outside the configured update directory: ${responseUrl}`)
  }
}

function assertContentLength(response, maximumBytes, label) {
  const rawLength = response.headers.get('content-length')
  if (!rawLength) return
  const length = Number(rawLength)
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
    throw new Error(`${label} has an invalid or excessive Content-Length: ${rawLength}`)
  }
}

function byteLimit(maximumBytes, label, onBytes = () => {}) {
  let receivedBytes = 0
  return new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length
      onBytes(receivedBytes)
      if (receivedBytes > maximumBytes) {
        callback(new Error(`${label} exceeds the ${maximumBytes}-byte limit`))
        return
      }
      callback(null, chunk)
    }
  })
}

async function readBytesWithLimit(response, maximumBytes, label) {
  if (!response.body) throw new Error(`${label} response has no body`)
  const chunks = []
  let receivedBytes = 0
  for await (const chunk of Readable.fromWeb(response.body)) {
    receivedBytes += chunk.length
    if (receivedBytes > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function verifySparkleArchive(data, signature, publicKey) {
  const rawPublicKey = Buffer.from(publicKey.trim(), 'base64')
  const rawSignature = Buffer.from(signature.trim(), 'base64')
  if (rawPublicKey.length !== 32 || rawSignature.length !== 64) return false
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
    format: 'der',
    type: 'spki'
  })
  return verify(null, data, key, rawSignature)
}

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function isTransientDownloadError(error) {
  return (
    error?.name === 'TimeoutError' ||
    [
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET'
    ].includes(error?.code ?? error?.cause?.code)
  )
}

async function downloadAndVerifyArchive(entry, archiveDirectory, appcastUrl, publicKey, io) {
  const destination = path.join(archiveDirectory, entry.filename)

  if (!(await pathExists(destination))) {
    const temporaryDestination = `${destination}.part`
    for (let attempt = 1; attempt <= ARCHIVE_ATTEMPTS; attempt++) {
      const started = io.now()
      let receivedBytes = 0
      let response
      let retryableStatus = false
      const signal = AbortSignal.timeout(ARCHIVE_TIMEOUT_MS)
      io.log(
        `[sparkle] downloading ${entry.filename} (${entry.url}), attempt ${attempt}/${ARCHIVE_ATTEMPTS}`
      )
      try {
        response = await io.request(entry.url, { signal })
        assertResponseStayedInUpdateDirectory(response, appcastUrl, 'Sparkle delta base')
        if (!response.ok || !response.body) {
          retryableStatus = [408, 429, 500, 502, 503, 504].includes(response.status)
          throw new Error(`HTTP ${response.status}`)
        }
        assertContentLength(response, MAX_ARCHIVE_BYTES, 'Sparkle delta base')
        await pipeline(
          Readable.fromWeb(response.body),
          byteLimit(MAX_ARCHIVE_BYTES, 'Sparkle delta base', (bytes) => {
            receivedBytes = bytes
          }),
          createWriteStream(temporaryDestination)
        )
        await verifyArchiveFile(temporaryDestination, entry, publicKey)
        await rename(temporaryDestination, destination)
        io.log(
          `[sparkle] downloaded ${entry.filename}: ${receivedBytes} bytes in ${io.now() - started}ms`
        )
        return
      } catch (error) {
        await rm(temporaryDestination, { force: true })
        const diagnostic = `Sparkle delta base ${entry.filename} (${entry.url}), attempt ${attempt}/${ARCHIVE_ATTEMPTS}, ${io.now() - started}ms elapsed, ${receivedBytes}/${entry.length} bytes received: ${error.name}: ${error.message}`
        const timedOut = error.name === 'AbortError' && signal.reason?.name === 'TimeoutError'
        if (
          attempt === ARCHIVE_ATTEMPTS ||
          !(retryableStatus || timedOut || isTransientDownloadError(error))
        ) {
          throw new Error(diagnostic, { cause: error })
        }
        io.log(`[sparkle] ${diagnostic}; retrying in ${attempt * 1000}ms`)
      } finally {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
      }
      await io.wait(attempt * 1000)
    }
  }

  await verifyArchiveFile(destination, entry, publicKey)
}

async function verifyArchiveFile(destination, entry, publicKey) {
  const archiveStat = await stat(destination)
  if (archiveStat.size !== entry.length || archiveStat.size > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `Sparkle delta base length mismatch for ${entry.filename}: expected ${entry.length}, got ${archiveStat.size}`
    )
  }
  const archive = await readFile(destination)
  if (!verifySparkleArchive(archive, entry.signature, publicKey)) {
    throw new Error(`Sparkle delta base signature verification failed: ${entry.filename}`)
  }
}

export async function fetchSparkleDeltaBases({
  appcastUrl,
  archiveDirectory,
  publicKey,
  currentVersion,
  currentBuildVersion,
  allowMissingAppcast = false,
  expectedLegacyAppcastSha256 = '',
  maxVersions = 2,
  request = fetch,
  wait = delay,
  now = () => performance.now(),
  log = console.log
}) {
  if (typeof publicKey !== 'string' || !publicKey.trim()) {
    throw new Error('SPARKLE_ED_PUBLIC_KEY is required to verify delta bases')
  }
  if (
    typeof expectedLegacyAppcastSha256 !== 'string' ||
    (expectedLegacyAppcastSha256 !== '' && !/^[a-fA-F0-9]{64}$/u.test(expectedLegacyAppcastSha256))
  ) {
    throw new Error('expectedLegacyAppcastSha256 must be a SHA256 hex digest')
  }
  const parsedAppcastUrl = new URL(appcastUrl)
  if (parsedAppcastUrl.protocol !== 'https:') {
    throw new Error('Remote Sparkle appcasts must use HTTPS')
  }
  await mkdir(archiveDirectory, { recursive: true })
  const response = await request(parsedAppcastUrl, {
    signal: AbortSignal.timeout(APPCAST_TIMEOUT_MS)
  })
  assertResponseStayedInUpdateDirectory(response, appcastUrl, 'Sparkle appcast')
  if (response.status === 404) {
    if (!allowMissingAppcast) {
      throw new Error(
        'Sparkle appcast is missing; set SPARKLE_ALLOW_MISSING_APPCAST=true only for the first release'
      )
    }
    console.log('[sparkle] no previous appcast found; generating the first feed')
    return []
  }
  if (!response.ok) {
    throw new Error(`Failed to download previous Sparkle appcast: HTTP ${response.status}`)
  }
  assertContentLength(response, MAX_APPCAST_BYTES, 'Sparkle appcast')

  const feedBytes = await readBytesWithLimit(response, MAX_APPCAST_BYTES, 'Sparkle appcast')
  const xml = feedBytes.toString('utf8')
  if (
    expectedLegacyAppcastSha256 &&
    createHash('sha256').update(feedBytes).digest('hex') ===
      expectedLegacyAppcastSha256.toLowerCase()
  ) {
    findSparkleDeltaBases(xml, appcastUrl, 0, currentVersion, currentBuildVersion)
    const backupPath = `${path.resolve(archiveDirectory)}.legacy-appcast.xml`
    await writeFile(backupPath, feedBytes)
    await rm(path.join(archiveDirectory, 'appcast.xml'), { force: true })
    log(
      `[sparkle] pinned legacy feed backed up to ${backupPath}; generating a full-only feed without historical archives`
    )
    return []
  }
  await writeFile(path.join(archiveDirectory, 'appcast.xml'), xml, 'utf8')
  const entries = findSparkleDeltaBases(
    xml,
    appcastUrl,
    maxVersions,
    currentVersion,
    currentBuildVersion
  )
  for (const entry of entries) {
    await downloadAndVerifyArchive(entry, archiveDirectory, appcastUrl, publicKey, {
      request,
      wait,
      now,
      log
    })
  }
  console.log(`[sparkle] staged ${entries.length} verified previous archive(s) from ${appcastUrl}`)
  return entries.map((entry) => entry.url)
}

async function main() {
  const [
    appcastUrl,
    archiveDirectory,
    publicKey,
    currentVersion,
    allowMissingAppcastValue = 'false',
    maxVersionsValue = '2',
    currentBuildVersion
  ] = process.argv.slice(2)
  if (!appcastUrl || !archiveDirectory || !publicKey || !currentVersion) {
    throw new Error(
      'Usage: node sparkle-delta-bases.mjs <appcast-url> <archive-directory> <public-key> <current-version> [allow-missing-appcast] [max-versions] [current-build-version]'
    )
  }
  if (!['true', 'false'].includes(allowMissingAppcastValue)) {
    throw new Error('allow-missing-appcast must be true or false')
  }
  const maxVersions = Number(maxVersionsValue)
  await fetchSparkleDeltaBases({
    appcastUrl,
    archiveDirectory,
    publicKey,
    currentVersion,
    currentBuildVersion,
    allowMissingAppcast: allowMissingAppcastValue === 'true',
    expectedLegacyAppcastSha256: process.env.SPARKLE_LEGACY_APPCAST_SHA256 ?? '',
    maxVersions
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main()
}
