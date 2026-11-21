import assert from 'node:assert/strict'
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { nightlyCandidateEnvironment } from './nightly-candidate.mjs'
import { resolveElectronReleaseProfile } from './release-profile.mjs'
import { resolveCloudElectronUpdateConfig } from './sparkle-packaging.mjs'
import { readAppcastItems, verifySparkleArchive } from './sparkle-delta-bases.mjs'
import { hashFile, safeNightlyKey } from './nightly-r2.mjs'

export function candidateProfile(candidate, baseVersion, displayVersion) {
  return resolveElectronReleaseProfile({
    environment: 'production',
    baseVersion,
    env: { ...nightlyCandidateEnvironment(candidate), LODY_NIGHTLY_VERSION: displayVersion }
  })
}

function updateBase(url) {
  return resolveCloudElectronUpdateConfig({
    environment: 'production',
    releaseChannel: 'nightly',
    updateBaseUrl: url,
    configuredChannel: 'nightly'
  }).url
}

function targetFiles(target, version) {
  const stem = `Lody-${version}`
  if (target === 'mac')
    return [
      `${stem}-arm64-nightly.dmg`,
      `${stem}-x64-nightly.dmg`,
      `${stem}-arm64-nightly.zip`,
      `${stem}-x64-nightly.zip`,
      `arm64/${stem}-arm64-nightly.zip`,
      `x64/${stem}-x64-nightly.zip`,
      'nightly-mac.yml',
      'arm64/appcast.xml',
      'x64/appcast.xml'
    ]
  if (target === 'win') return [`${stem}-x64-setup-nightly.exe`, 'nightly.yml']
  if (target === 'linux')
    return [
      `${stem}-x64-nightly.AppImage`,
      `${stem}-x64-nightly.deb`,
      `${stem}-x64-nightly.snap`,
      'nightly-linux.yml'
    ]
  if (target === 'linux-arm64')
    return [
      `${stem}-arm64-nightly.AppImage`,
      `${stem}-arm64-nightly.deb`,
      'nightly-linux-arm64.yml'
    ]
  throw new Error('Unknown Nightly build target')
}

function enclosureKey(enclosure, baseUrl, architecture) {
  const url = new URL(enclosure['@_url'])
  const prefix = `${baseUrl}/${architecture}/`
  if (!url.href.startsWith(prefix) || url.search || url.hash)
    throw new Error('Sparkle enclosure escaped Nightly feed')
  const key = `${architecture}/${decodeURIComponent(url.href.slice(prefix.length))}`
  safeNightlyKey(key)
  return key
}

async function currentSparkleEnclosures(directory, architecture, profile, baseUrl) {
  const items = readAppcastItems(
    await readFile(path.join(directory, architecture, 'appcast.xml'), 'utf8')
  )
  const current = items.filter((item) => item['sparkle:version'] === profile.nativeVersion)
  if (current.length !== 1 || current[0]['sparkle:shortVersionString'] !== profile.version) {
    throw new Error('Sparkle feed does not identify the exact Nightly build')
  }
  const main = current[0].enclosure
  if (main?.length !== 1) throw new Error('Expected one current Sparkle archive')
  assert.equal(
    enclosureKey(main[0], baseUrl, architecture),
    `${architecture}/Lody-${profile.version}-${architecture}-nightly.zip`
  )
  const enclosures = [...main, ...(current[0]['sparkle:deltas']?.enclosure ?? [])]
  const keys = enclosures.map((enclosure) => enclosureKey(enclosure, baseUrl, architecture))
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate Sparkle enclosure')
  return enclosures
}

async function describeFile(directory, key) {
  safeNightlyKey(key)
  const filename = path.join(directory, key)
  const info = await lstat(filename)
  if (!info.isFile() || info.size <= 0 || info.size > 5 * 1024 ** 3)
    throw new Error(`Invalid release asset: ${key}`)
  return { size: info.size, sha256: await hashFile(filename) }
}

export async function stageNightlyArtifacts({
  target,
  dist,
  output,
  candidate,
  baseVersion,
  displayVersion,
  baseUrl,
  publicKey
}) {
  const profile = candidateProfile(candidate, baseVersion, displayVersion)
  baseUrl = updateBase(baseUrl)
  const built = JSON.parse(
    await readFile(path.join(dist, '../out/main/electron-update-config.json'), 'utf8')
  )
  assert.deepEqual(built.releaseProfile, profile)
  assert.equal(built.url, baseUrl)
  assert.equal(built.channel, 'nightly')
  const keys = new Set(targetFiles(target, profile.version))
  for (const entry of await readdir(dist, { withFileTypes: true })) {
    if (entry.name.startsWith(`Lody-${profile.version}-`) && entry.name.endsWith('.blockmap'))
      keys.add(entry.name)
  }
  if (target === 'mac') {
    for (const architecture of ['arm64', 'x64']) {
      for (const enclosure of await currentSparkleEnclosures(
        dist,
        architecture,
        profile,
        baseUrl
      )) {
        keys.add(enclosureKey(enclosure, baseUrl, architecture))
      }
    }
  }
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw new Error('Nightly staging directory must be empty')
  const files = {}
  for (const key of [...keys].sort()) {
    files[key] = await describeFile(dist, key)
    await mkdir(path.dirname(path.join(output, key)), { recursive: true })
    await cp(path.join(dist, key), path.join(output, key), { errorOnExist: true, force: false })
  }
  const manifest = { schema: 1, target, candidate, baseVersion, profile, baseUrl, files }
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx'
  })
  return verifyNightlyArtifacts({
    directory: output,
    target,
    candidate,
    baseVersion,
    displayVersion,
    baseUrl,
    publicKey
  })
}

export async function verifyNightlyArtifacts({
  directory,
  target,
  candidate,
  baseVersion,
  displayVersion,
  baseUrl,
  publicKey
}) {
  const profile = candidateProfile(candidate, baseVersion, displayVersion)
  baseUrl = updateBase(baseUrl)
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 1)
  assert.equal(manifest.target, target)
  assert.deepEqual(manifest.candidate, candidate)
  assert.equal(manifest.baseVersion, baseVersion)
  assert.equal(manifest.baseUrl, baseUrl)
  assert.deepEqual(manifest.profile, profile)
  const requiredFiles = targetFiles(target, profile.version)
  for (const key of requiredFiles) assert.ok(manifest.files[key], `Missing required ${key}`)
  for (const [key, expected] of Object.entries(manifest.files)) {
    assert.deepEqual(
      await describeFile(directory, key),
      expected,
      `Asset digest or size mismatch: ${key}`
    )
    if (
      !requiredFiles.includes(key) &&
      !key.startsWith(`Lody-${profile.version}-`) &&
      !/^(?:arm64|x64)\/[^/]+\.delta$/u.test(key)
    ) {
      throw new Error('Unexpected release asset')
    }
  }
  const metadataName =
    target === 'mac'
      ? 'nightly-mac.yml'
      : target === 'win'
        ? 'nightly.yml'
        : target === 'linux-arm64'
          ? 'nightly-linux-arm64.yml'
          : 'nightly-linux.yml'
  const metadata = parseYaml(await readFile(path.join(directory, metadataName), 'utf8'))
  assert.equal(metadata.version, profile.version)
  if (!Array.isArray(metadata.files) || !metadata.files.length)
    throw new Error('Updater metadata has no files')
  const referenced = new Set()
  for (const file of metadata.files) {
    safeNightlyKey(file.url)
    if (file.url.includes('/') || !manifest.files[file.url])
      throw new Error('Updater references an unstaged file')
    assert.equal(file.sha512, await hashFile(path.join(directory, file.url), 'sha512', 'base64'))
    assert.equal(file.size, manifest.files[file.url].size)
    if (referenced.has(file.url)) throw new Error('Duplicate updater file')
    referenced.add(file.url)
  }
  for (const filename of requiredFiles.filter(
    (name) => !name.includes('/') && /\.(?:zip|exe|AppImage|deb)$/u.test(name)
  )) {
    assert.ok(referenced.has(filename), `Updater is missing ${filename}`)
  }
  assert.ok(referenced.has(metadata.path), 'Legacy updater path is not a verified asset')
  assert.equal(
    metadata.sha512,
    await hashFile(path.join(directory, metadata.path), 'sha512', 'base64')
  )
  if (target === 'mac') {
    for (const architecture of ['arm64', 'x64']) {
      const verified = new Set()
      for (const enclosure of await currentSparkleEnclosures(
        directory,
        architecture,
        profile,
        baseUrl
      )) {
        const key = enclosureKey(enclosure, baseUrl, architecture)
        assert.ok(manifest.files[key], `Unstaged Sparkle enclosure: ${key}`)
        assert.equal(Number(enclosure['@_length']), manifest.files[key].size)
        if (
          !verifySparkleArchive(
            await readFile(path.join(directory, key)),
            enclosure['@_sparkle:edSignature'],
            publicKey
          )
        ) {
          throw new Error('Invalid Sparkle release signature')
        }
        verified.add(key)
      }
      for (const key of Object.keys(manifest.files).filter(
        (name) => name.startsWith(`${architecture}/`) && name.endsWith('.delta')
      )) {
        assert.ok(verified.has(key), 'Unreferenced Sparkle delta')
      }
      assert.equal(
        manifest.files[`${architecture}/Lody-${profile.version}-${architecture}-nightly.zip`]
          .sha256,
        manifest.files[`Lody-${profile.version}-${architecture}-nightly.zip`].sha256
      )
    }
  }
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, target, candidatePath, directory] = process.argv.slice(2)
  const candidate = JSON.parse(await readFile(candidatePath, 'utf8'))
  const baseVersion = JSON.parse(
    await readFile(new URL('./package.json', import.meta.url), 'utf8')
  ).version
  const options = {
    target,
    candidate,
    baseVersion,
    displayVersion: process.env.LODY_NIGHTLY_VERSION,
    baseUrl: process.env.VITE_ELECTRON_UPDATE_URL,
    publicKey: process.env.SPARKLE_ED_PUBLIC_KEY
  }
  if (command === 'stage')
    await stageNightlyArtifacts({
      ...options,
      dist: 'apps/electron/dist',
      output: directory
    })
  else if (command === 'verify') await verifyNightlyArtifacts({ ...options, directory })
  else
    throw new Error(
      'Usage: nightly-artifacts.mjs stage|verify <target> <candidate.json> <artifact-directory>'
    )
}
