import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  githubApi,
  inspectNightlyPublication,
  validateNightlyCandidate,
  validateStoredNightlyCandidate
} from './nightly-candidate.mjs'
import { assertNightlyVersionReservation, validateNightlyVersion } from './nightly-version.mjs'
import { createNightlyR2Store, hashFile, NIGHTLY_ANDROID_METADATA_KEY } from './nightly-r2.mjs'
import { androidVersionCode } from '../../.github/scripts/android-version-code.mjs'

export function mobileNightlyVersion(version) {
  validateNightlyVersion(version)
  return { android: version, ios: version.split('-')[0] }
}

export function androidNightlyIdentity(candidate, version, { allowStored = false } = {}) {
  ;(allowStored ? validateStoredNightlyCandidate : validateNightlyCandidate)(candidate)
  return {
    versionName: mobileNightlyVersion(version).android,
    versionCode: androidVersionCode(candidate.builtAt),
    applicationId: 'ai.lody.android'
  }
}

function apkName(version) {
  return `Lody-${mobileNightlyVersion(version).android}-android.apk`
}

async function describeApk(filename) {
  const info = await lstat(filename)
  assert.ok(info.isFile() && info.size > 0 && info.size < 2 * 1024 ** 3, 'Invalid APK')
  return { size: info.size, sha256: await hashFile(filename) }
}

export function inspectAndroidApk(filename) {
  execFileSync(process.env.APKSIGNER, ['verify', '--verbose', filename], { stdio: 'pipe' })
  const manifest = (field) =>
    execFileSync(process.env.APKANALYZER, ['manifest', field, filename], {
      encoding: 'utf8'
    }).trim()
  return {
    versionName: manifest('version-name'),
    versionCode: manifest('version-code'),
    applicationId: manifest('application-id')
  }
}

export async function stageNightlyAndroid({
  apk,
  directory,
  candidate,
  displayVersion,
  inspect = inspectAndroidApk
}) {
  const identity = androidNightlyIdentity(candidate, displayVersion)
  assert.deepEqual(await inspect(apk), identity, 'Packaged Android identity differs')
  await mkdir(directory, { recursive: true })
  assert.equal((await readdir(directory)).length, 0, 'Android staging directory must be empty')
  const key = apkName(displayVersion)
  await cp(apk, path.join(directory, key), { force: false, errorOnExist: true })
  const manifest = {
    schema: 1,
    target: 'android',
    candidate,
    identity,
    files: { [key]: await describeApk(path.join(directory, key)) }
  }
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx'
  })
  return verifyNightlyAndroid({ directory, candidate, displayVersion })
}

export async function verifyNightlyAndroid({ directory, candidate, displayVersion }) {
  const identity = androidNightlyIdentity(candidate, displayVersion)
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 1)
  assert.equal(manifest.target, 'android')
  assert.deepEqual(manifest.candidate, candidate, 'APK belongs to another candidate')
  assert.deepEqual(manifest.identity, identity, 'APK version differs')
  const key = apkName(displayVersion)
  assert.deepEqual(Object.keys(manifest.files), [key], 'Unexpected Android assets')
  assert.deepEqual(
    await describeApk(path.join(directory, key)),
    manifest.files[key],
    'APK digest or size mismatch'
  )
  return manifest
}

export async function publishNightlyAndroid({ directory, candidate, displayVersion, store, api }) {
  await assertNightlyVersionReservation({ store, candidate, displayVersion })
  const previous = await store.get(NIGHTLY_ANDROID_METADATA_KEY)
  const published = previous === null ? undefined : JSON.parse(previous)
  if (published !== undefined) {
    assert.equal(published.schema, 1)
    assert.equal(published.channel, 'nightly')
    assert.equal(published.target, 'android')
    validateNightlyVersion(published.version)
  }
  const admission = await inspectNightlyPublication({
    candidate,
    published: published?.candidate,
    api
  })
  if (!admission.publish) return admission
  if (published !== undefined) {
    assert.ok(
      Number(androidNightlyIdentity(candidate, displayVersion).versionCode) >
        Number(
          androidNightlyIdentity(published.candidate, published.version, { allowStored: true })
            .versionCode
        ),
      'Android version code must increase'
    )
  }
  const manifest = await verifyNightlyAndroid({ directory, candidate, displayVersion })
  for (const [key, file] of Object.entries(manifest.files)) {
    await store.ensureImmutable(key, path.join(directory, key), file.sha256)
  }
  await inspectNightlyPublication({ candidate, api })
  await assertNightlyVersionReservation({ store, candidate, displayVersion })
  const files = Object.keys(manifest.files)
  const bytes = Buffer.from(
    `${JSON.stringify(
      {
        schema: 1,
        channel: 'nightly',
        target: 'android',
        version: displayVersion,
        candidate,
        releaseDate: candidate.builtAt,
        files,
        downloads: Object.fromEntries(files.map((key) => [key, key])),
        assets: manifest.files
      },
      null,
      2
    )}\n`
  )
  await store.put(NIGHTLY_ANDROID_METADATA_KEY, bytes)
  assert.deepEqual(
    await store.get(NIGHTLY_ANDROID_METADATA_KEY),
    bytes,
    'Android manifest readback failed'
  )
  return { publish: true, reason: 'published' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, candidatePath, directory, apk] = process.argv.slice(2)
  const candidate = JSON.parse(await readFile(candidatePath, 'utf8'))
  const displayVersion = process.env.LODY_NIGHTLY_VERSION
  if (command === 'stage') await stageNightlyAndroid({ apk, directory, candidate, displayVersion })
  else if (command === 'verify')
    await verifyNightlyAndroid({ directory, candidate, displayVersion })
  else if (command === 'publish')
    console.log(
      JSON.stringify(
        await publishNightlyAndroid({
          directory,
          candidate,
          displayVersion,
          store: createNightlyR2Store(),
          api: githubApi(process.env.GH_TOKEN)
        })
      )
    )
  else
    throw new Error(
      'Usage: nightly-mobile.mjs stage|verify|publish <candidate.json> <directory> [apk]'
    )
}
