import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readAppcastItems, verifySparkleArchive } from './sparkle-delta-bases.mjs'

function decodeKey(value, lengths, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  const bytes = Buffer.from(text, 'base64')
  if (!lengths.includes(bytes.length) || bytes.toString('base64') !== text) {
    throw new Error(
      `Invalid Sparkle ${label}: expected canonical Base64 (${lengths.join(' or ')} bytes)`
    )
  }
  return bytes
}

export function validateSparkleKeyPair({ privateKey, publicKey }) {
  const secret = decodeKey(privateKey, [32, 96], 'private key')
  const expected = decodeKey(publicKey, [32], 'public key')
  if (secret.length === 96) {
    if (!secret.subarray(64).equals(expected)) throw new Error('Sparkle key pair does not match')
    return { format: 'legacy96', requiresSigningProof: true }
  }
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), secret]),
    format: 'der',
    type: 'pkcs8'
  })
  const derived = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)
  if (!derived.equals(expected)) throw new Error('Sparkle key pair does not match')
  const challenge = Buffer.from('Lody Sparkle release signing key validation v1')
  if (!verifySparkleArchive(challenge, sign(null, challenge, key).toString('base64'), publicKey)) {
    throw new Error('Sparkle key pair signing proof failed')
  }
  return { format: 'seed32', requiresSigningProof: false }
}

export function verifySparkleSigningProof({ archive, signingOutput, publicKey }) {
  decodeKey(publicKey, [32], 'public key')
  const item = readAppcastItems(
    `<rss><channel><item><enclosure ${signingOutput.trim()} /></item></channel></rss>`
  )[0]
  const enclosure = item.enclosure?.[0]
  if (!enclosure || item.enclosure.length !== 1) throw new Error('Invalid Sparkle signing proof')
  verifyBytes(archive, enclosure, publicKey, 'signing proof')
  return true
}

function verifyBytes(bytes, enclosure, publicKey, label) {
  const length = enclosure['@_length']
  if (
    typeof length !== 'string' ||
    !/^[1-9][0-9]*$/u.test(length) ||
    Number(length) !== bytes.length
  ) {
    throw new Error(`Sparkle ${label} length does not match`)
  }
  const signature = enclosure['@_sparkle:edSignature']
  if (typeof signature !== 'string' || !verifySparkleArchive(bytes, signature, publicKey)) {
    throw new Error(`Sparkle ${label} signature verification failed`)
  }
}

function versionValue(item, enclosure, name) {
  const value = item[`sparkle:${name}`] ?? enclosure[`@_sparkle:${name}`]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid Sparkle ${name}`)
  return value.trim()
}

export async function verifySparkleOutputs({
  xml,
  archiveDirectory,
  appcastUrl,
  currentFilename,
  currentVersion,
  currentBuildVersion = currentVersion,
  publicKey
}) {
  decodeKey(publicKey, [32], 'public key')
  const feed = new URL(appcastUrl)
  if (feed.protocol !== 'https:' || feed.username || feed.password || feed.search || feed.hash) {
    throw new Error('Sparkle appcast URL must use HTTPS without credentials, query or fragment')
  }
  if (!currentFilename || !currentVersion || !currentBuildVersion) {
    throw new Error('Sparkle current filename, display version and build version are required')
  }
  const directory = new URL('.', feed)
  const verified = new Set()
  const seen = new Set()
  const localFiles = new Set(await readdir(archiveDirectory))
  let currentCount = 0
  for (const item of readAppcastItems(xml)) {
    const main = item.enclosure
    if (!Array.isArray(main) || main.length !== 1) {
      throw new Error('Sparkle update item must contain exactly one main enclosure')
    }
    const display = versionValue(item, main[0], 'shortVersionString')
    const build = versionValue(item, main[0], 'version')
    const deltas = item['sparkle:deltas']?.enclosure ?? []
    if (!Array.isArray(deltas)) throw new Error('Invalid Sparkle delta enclosures')
    for (const [index, enclosure] of [main[0], ...deltas].entries()) {
      const rawUrl = enclosure['@_url']
      if (typeof rawUrl !== 'string') throw new Error('Missing Sparkle enclosure URL')
      const url = new URL(rawUrl)
      let filename
      try {
        filename = decodeURIComponent(path.posix.basename(url.pathname))
      } catch {
        filename = ''
      }
      const extension = index === 0 ? 'zip' : 'delta'
      if (
        !new RegExp(`^[A-Za-z0-9][A-Za-z0-9 ._+-]*\\.${extension}$`, 'u').test(filename) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        new URL('.', url).href !== directory.href
      ) {
        throw new Error(
          'Sparkle enclosure URL is outside the configured update directory or has an unsafe filename'
        )
      }
      const isCurrent = display === currentVersion || build === currentBuildVersion
      if (index === 0 && (filename === currentFilename || isCurrent)) {
        if (
          filename !== currentFilename ||
          display !== currentVersion ||
          build !== currentBuildVersion
        ) {
          throw new Error('Sparkle current release filename/version/build does not match')
        }
        currentCount++
      }
      if (seen.has(filename)) throw new Error(`Duplicate Sparkle enclosure: ${filename}`)
      seen.add(filename)
      if (!isCurrent && !localFiles.has(filename)) continue
      const file = path.join(archiveDirectory, filename)
      if (!(await lstat(file)).isFile())
        throw new Error(`Sparkle enclosure is not a regular file: ${filename}`)
      verifyBytes(await readFile(file), enclosure, publicKey, filename)
      verified.add(filename)
    }
  }
  if (currentCount !== 1)
    throw new Error('Sparkle appcast must contain exactly one current release')
  for (const filename of localFiles) {
    if (/\.(?:zip|delta)$/u.test(filename) && !verified.has(filename)) {
      throw new Error(`Generated Sparkle archive is absent from appcast: ${filename}`)
    }
  }
  return [...verified]
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      [
        'private-key-file',
        'archive',
        'signature-file',
        'appcast',
        'archive-directory',
        'appcast-url',
        'current-filename',
        'current-version',
        'current-build-version'
      ].map((name) => [name, { type: 'string' }])
    )
  })
  const publicKey = process.env.SPARKLE_ED_PUBLIC_KEY
  let result
  if (positionals.length !== 1) throw new Error('Expected one mode: key-pair, proof or outputs')
  if (positionals[0] === 'key-pair') {
    result = validateSparkleKeyPair({
      privateKey: values['private-key-file']
        ? await readFile(values['private-key-file'], 'utf8')
        : process.env.SPARKLE_ED_PRIVATE_KEY,
      publicKey
    })
  } else if (positionals[0] === 'proof') {
    result = verifySparkleSigningProof({
      archive: await readFile(values.archive),
      signingOutput: await readFile(values['signature-file'], 'utf8'),
      publicKey
    })
  } else if (positionals[0] === 'outputs') {
    result = await verifySparkleOutputs({
      xml: await readFile(values.appcast, 'utf8'),
      archiveDirectory: values['archive-directory'],
      appcastUrl: values['appcast-url'],
      currentFilename: values['current-filename'],
      currentVersion: values['current-version'],
      currentBuildVersion: values['current-build-version'],
      publicKey
    })
  } else throw new Error('Expected mode: key-pair, proof or outputs')
  console.log(JSON.stringify(result))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
