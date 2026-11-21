import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  githubApi,
  inspectNightlyPublication,
  validateNightlyCandidate,
  validateStoredNightlyCandidate
} from './nightly-candidate.mjs'
import { createNightlyR2Store } from './nightly-r2.mjs'
import {
  assertNightlyVersionReservation,
  NIGHTLY_VERSION_SCHEME,
  reserveNightlyVersion
} from './nightly-version.mjs'
import {
  parseCompatibleStableVersion,
  verifyCompatibleStableRelease
} from './nightly-stable-compatibility.mjs'
import {
  commitNightlyMetadata,
  NIGHTLY_METADATA_KEYS,
  recoverNightlyMetadata
} from './nightly-publication.mjs'

const IMMUTABLE_UPLOAD_CONCURRENCY = 4

/** Runs `fn` over `items` with bounded concurrency; stops scheduling after the first failure. */
export async function mapWithConcurrency(items, limit, fn) {
  let next = 0
  let failure
  const worker = async () => {
    while (failure === undefined && next < items.length) {
      const item = items[next++]
      try {
        await fn(item)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failure !== undefined) throw failure.error
}

export async function verifyNightlyStablePrerequisite({ store, ...options }) {
  await recoverNightlyMetadata(store)
  return verifyCompatibleStableRelease(options)
}

export async function prepareNightlyPublication({ store, candidate, api, allowBootstrap = false }) {
  validateNightlyCandidate(candidate)
  await recoverNightlyMetadata(store)
  const previous = await store.get('version.json')
  const release = previous === null ? undefined : JSON.parse(previous)
  const published = release?.candidate
  if (previous !== null) {
    validateStoredNightlyCandidate(published)
    if (release.schema !== 1 || release.channel !== 'nightly')
      throw new Error('Invalid prior Nightly release manifest')
  }
  for (const key of NIGHTLY_METADATA_KEYS) {
    const bytes = key === 'version.json' ? previous : await store.get(key)
    const exists = bytes !== null
    if (key === 'nightly-linux-arm64.yml' && !exists && !release?.assets?.[key]) continue
    if (exists !== (previous !== null))
      throw new Error('Incomplete Nightly feeds without a recoverable transaction')
    if (exists && key !== 'version.json') {
      assert.equal(
        bytes.length,
        release.assets?.[key]?.size,
        `Prior Nightly metadata size changed: ${key}`
      )
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        release.assets?.[key]?.sha256,
        `Prior Nightly metadata changed: ${key}`
      )
    }
  }
  if (previous === null && !allowBootstrap)
    throw new Error('First Nightly publication requires explicit bootstrap configuration')
  return {
    ...(await inspectNightlyPublication({ candidate, published, api })),
    bootstrap: previous === null
  }
}

export async function prepareNightlyBuild(options) {
  const result = await prepareNightlyPublication(options)
  if (!result.publish && result.reason !== 'already-published') return result
  await inspectNightlyPublication({ candidate: options.candidate, api: options.api })
  return { ...result, ...(await reserveNightlyVersion(options)) }
}

export async function publishNightlyRelease({
  directory,
  candidate,
  baseVersion,
  displayVersion,
  baseUrl,
  publicKey,
  store,
  api,
  allowBootstrap = false,
  minimumStableVersion
}) {
  parseCompatibleStableVersion(minimumStableVersion)
  const { verifyNightlyArtifacts } = await import('./nightly-artifacts.mjs')
  const { default: semver } = await import('semver')
  const initial = await prepareNightlyPublication({ store, candidate, api, allowBootstrap })
  if (!initial.publish) return initial
  await assertNightlyVersionReservation({ store, candidate, displayVersion })
  const manifests = []
  for (const target of ['mac', 'win', 'linux', 'linux-arm64']) {
    manifests.push(
      await verifyNightlyArtifacts({
        directory: path.join(directory, target),
        target,
        candidate,
        baseVersion,
        displayVersion,
        baseUrl,
        publicKey
      })
    )
  }
  const previousBytes = await store.get('version.json')
  if (
    previousBytes !== null &&
    !semver.gt(manifests[0].profile.version, JSON.parse(previousBytes).version)
  ) {
    throw new Error('Nightly display version must increase for fallback updaters')
  }
  const assets = {}
  const metadata = {}
  const downloads = []
  for (const manifest of manifests) {
    for (const [key, file] of Object.entries(manifest.files)) {
      assert.equal(assets[key], undefined, `Duplicate cross-platform asset ${key}`)
      assets[key] = file
    }
  }
  const immutables = []
  for (const manifest of manifests) {
    for (const [key, file] of Object.entries(manifest.files)) {
      const filename = path.join(directory, manifest.target, key)
      if (NIGHTLY_METADATA_KEYS.includes(key)) metadata[key] = await readFile(filename)
      else {
        immutables.push({ key, filename, sha256: file.sha256 })
        if (/\.(?:dmg|exe|AppImage|deb|snap|apk)$/u.test(key)) downloads.push(key)
      }
    }
  }
  await mapWithConcurrency(immutables, IMMUTABLE_UPLOAD_CONCURRENCY, ({ key, filename, sha256 }) =>
    store.ensureImmutable(key, filename, sha256)
  )
  metadata['version.json'] = Buffer.from(
    `${JSON.stringify(
      {
        schema: 1,
        channel: 'nightly',
        versionScheme: NIGHTLY_VERSION_SCHEME,
        version: manifests[0].profile.version,
        minimumStableVersion,
        releaseDate: candidate.builtAt,
        candidate,
        profile: manifests[0].profile,
        files: downloads.sort(),
        downloads: Object.fromEntries(downloads.map((key) => [key, key])),
        assets
      },
      null,
      2
    )}\n`
  )
  const latest = await prepareNightlyPublication({ store, candidate, api, allowBootstrap })
  if (!latest.publish) return latest
  await assertNightlyVersionReservation({ store, candidate, displayVersion })
  await commitNightlyMetadata({ store, candidate, metadata })
  return { publish: true, reason: 'published' }
}

async function main() {
  const [command, candidatePath, directory] = process.argv.slice(2)
  const candidate = validateNightlyCandidate(JSON.parse(await readFile(candidatePath, 'utf8')))
  const api = githubApi(process.env.GH_TOKEN)
  let result
  const store = createNightlyR2Store()
  const minimumStableVersion = await verifyNightlyStablePrerequisite({
    store,
    minimumVersion: process.env.NIGHTLY_MINIMUM_STABLE_VERSION,
    manifestUrl: process.env.STABLE_ELECTRON_VERSION_URL
  })
  const options = {
    minimumStableVersion,
    candidate,
    baseVersion: JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
      .version,
    api,
    store,
    allowBootstrap: process.env.NIGHTLY_ALLOW_BOOTSTRAP === 'true'
  }
  if (command === 'prepare') result = await prepareNightlyBuild(options)
  else if (command === 'publish')
    result = await publishNightlyRelease({
      ...options,
      directory,
      displayVersion: process.env.LODY_NIGHTLY_VERSION,
      baseUrl: process.env.VITE_ELECTRON_UPDATE_URL,
      publicKey: process.env.SPARKLE_ED_PUBLIC_KEY
    })
  else
    throw new Error(
      'Usage: nightly-release.mjs prepare|publish <candidate.json> [artifacts-directory]'
    )
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}\n`)
        .join('')
    )
  }
  console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
