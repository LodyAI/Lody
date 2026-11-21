import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  candidateProfile,
  stageNightlyArtifacts,
  verifyNightlyArtifacts
} from './nightly-artifacts.mjs'
import {
  commitNightlyMetadata,
  NIGHTLY_JOURNAL_KEY,
  NIGHTLY_METADATA_KEYS,
  recoverNightlyMetadata
} from './nightly-publication.mjs'
import { createNightlyR2Store, hashFile, safeNightlyKey } from './nightly-r2.mjs'
import {
  mapWithConcurrency,
  prepareNightlyBuild,
  prepareNightlyPublication,
  publishNightlyRelease,
  verifyNightlyStablePrerequisite
} from './nightly-release.mjs'
import { verifyCompatibleStableRelease } from './nightly-stable-compatibility.mjs'
import { NIGHTLY_VERSION_KEY, nightlyVersionBase } from './nightly-version.mjs'
import {
  androidVersionCode,
  androidVersionCodeForRun
} from '../../.github/scripts/android-version-code.mjs'
import {
  androidNightlyIdentity,
  mobileNightlyVersion,
  publishNightlyAndroid,
  stageNightlyAndroid,
  verifyNightlyAndroid
} from './nightly-mobile.mjs'

void test('Nightly requires an explicitly verified and already published Stable support floor', async () => {
  const options = {
    minimumVersion: '0.100.2',
    manifestUrl: 'https://updates.example.test/production/version.json'
  }
  for (const version of ['0.100.2', '0.100.10', '0.101.0', '1.0.0']) {
    assert.equal(
      await verifyCompatibleStableRelease({
        ...options,
        request: async () => Response.json({ version })
      }),
      options.minimumVersion
    )
  }
  for (const version of ['0.100.1', '0.99.999', '0.100.2-nightly.1', '00.100.2', undefined]) {
    await assert.rejects(
      verifyCompatibleStableRelease({
        ...options,
        request: async () => Response.json({ version })
      })
    )
  }
  for (const minimumVersion of [undefined, '', '0.100.2-next.1']) {
    await assert.rejects(
      verifyCompatibleStableRelease({ ...options, minimumVersion }),
      /verified minimum Stable/u
    )
  }
  for (const manifestUrl of [
    undefined,
    'http://updates.example.test/version.json',
    'https://updates.example.test/nightly/version.json',
    'https://user:secret@updates.example.test/version.json'
  ]) {
    await assert.rejects(
      verifyCompatibleStableRelease({ ...options, manifestUrl }),
      /Invalid Stable/u
    )
  }
  await assert.rejects(
    verifyCompatibleStableRelease({
      ...options,
      request: async () => new Response('', { status: 503 })
    }),
    /HTTP 503/u
  )
  await assert.rejects(
    verifyCompatibleStableRelease({
      ...options,
      request: async () => Response.json({ version: '0.100.2', channel: 'nightly' })
    }),
    /Invalid Stable/u
  )
})

const candidate = {
  schema: 1,
  sourceSha: 'a'.repeat(40),
  buildNumber: '42',
  runId: '100',
  builtAt: '2026-09-23T00:00:00.000Z',
  trigger: { repository: 'LodyAI/Lody', sha: 'a'.repeat(40) }
}
const baseVersion = '0.89.4'
const baseUrl = 'https://updates.example.test/production/nightly'
const profile = candidateProfile(candidate, baseVersion, '0.90.0-nightly.0')
const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('base64')
const api = async (endpoint) => ({
  ref: 'refs/heads/main',
  object: {
    type: 'commit',
    sha: endpoint.includes('LodyAI/Lody') ? candidate.sourceSha : candidate.sourceSha
  }
})

function memoryStore(initial = {}) {
  const objects = new Map(Object.entries(initial).map(([key, bytes]) => [key, Buffer.from(bytes)]))
  return {
    objects,
    async get(key) {
      return objects.has(key) ? Buffer.from(objects.get(key)) : null
    },
    async put(key, bytes) {
      objects.set(key, Buffer.from(bytes))
    },
    async remove(key) {
      objects.delete(key)
    },
    async ensureImmutable(key, filename, sha256) {
      const bytes = await readFile(filename)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256)
      if (objects.has(key)) assert.deepEqual(objects.get(key), bytes, 'Immutable bytes differ')
      else objects.set(key, bytes)
    }
  }
}

function metadata(label) {
  return Object.fromEntries(
    NIGHTLY_METADATA_KEYS.map((key) => [
      key,
      Buffer.from(key === 'version.json' ? JSON.stringify({ candidate, label }) : `${label}:${key}`)
    ])
  )
}

void test('metadata transaction recovers crashes before and after every durable mutation', async () => {
  for (const bootstrap of [false, true]) {
    for (const phase of ['before', 'after']) {
      for (let failure = 1; failure <= NIGHTLY_METADATA_KEYS.length + 2; failure += 1) {
        const before = bootstrap ? {} : metadata('old')
        const after = metadata('new')
        const stable = memoryStore(before)
        let writes = 0
        let offline = false
        const unreliable = {
          ...stable,
          async get(key) {
            if (offline) throw new Error('Simulated runner/network loss')
            return stable.get(key)
          }
        }
        for (const method of ['put', 'remove']) {
          unreliable[method] = async (...args) => {
            if (offline) throw new Error('Still offline')
            writes += 1
            if (writes === failure && phase === 'before') {
              offline = true
              throw new Error('Crash before mutation')
            }
            await stable[method](...args)
            if (writes === failure && phase === 'after') {
              offline = true
              throw new Error('Crash after mutation')
            }
          }
        }
        await assert.rejects(
          commitNightlyMetadata({ store: unreliable, candidate, metadata: after })
        )
        await assert.rejects(
          verifyNightlyStablePrerequisite({ store: stable }),
          /verified minimum Stable/u
        )
        const committed =
          phase === 'after'
            ? failure >= NIGHTLY_METADATA_KEYS.length + 1
            : failure >= NIGHTLY_METADATA_KEYS.length + 2
        assert.deepEqual(
          Object.fromEntries(stable.objects),
          committed ? after : before,
          `bootstrap=${bootstrap}, phase=${phase}, mutation=${failure}`
        )
        assert.equal((await recoverNightlyMetadata(stable)).state, 'clean')
      }
    }
  }
})

void test('transient write failure restores prior feeds and an unrelated writer blocks recovery', async () => {
  const before = metadata('old')
  const stable = memoryStore(before)
  let failed = false
  await assert.rejects(
    commitNightlyMetadata({
      candidate,
      metadata: metadata('new'),
      store: {
        ...stable,
        async put(key, value) {
          if (key === 'arm64/appcast.xml' && !failed) {
            failed = true
            throw new Error('Transient failure')
          }
          await stable.put(key, value)
        }
      }
    }),
    /Transient failure/u
  )
  assert.deepEqual(Object.fromEntries(stable.objects), before)
  let blocked = false
  await assert.rejects(
    commitNightlyMetadata({
      candidate,
      metadata: metadata('new'),
      store: {
        ...stable,
        async put(key, value) {
          if (key === 'nightly-linux.yml') {
            await stable.put('nightly.yml', Buffer.from('another publisher'))
            blocked = true
            throw new Error('Concurrent write')
          }
          await stable.put(key, value)
        }
      }
    }),
    /durable recovery is pending/u
  )
  assert.equal(blocked, true)
  assert.ok(stable.objects.has(NIGHTLY_JOURNAL_KEY))
  await assert.rejects(recoverNightlyMetadata(stable), /outside the pending transaction/u)
  assert.equal((await stable.get('nightly.yml')).toString(), 'another publisher')
})

async function fixture(t, build = candidate, version = baseVersion) {
  const displayVersion = `${nightlyVersionBase(version)}-nightly.${Number(build.buildNumber) - 42}`
  const fixtureProfile = candidateProfile(build, version, displayVersion)
  const directory = await mkdtemp(path.join(tmpdir(), 'lody-nightly-release-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const dist = path.join(directory, 'dist')
  await mkdir(dist)
  await mkdir(path.join(directory, 'out/main'), { recursive: true })
  await writeFile(
    path.join(directory, 'out/main/electron-update-config.json'),
    JSON.stringify({
      url: baseUrl,
      channel: 'nightly',
      releaseProfile: fixtureProfile
    })
  )
  const stem = `Lody-${fixtureProfile.version}`
  const installerNames = [
    `${stem}-arm64-nightly.dmg`,
    `${stem}-x64-nightly.dmg`,
    `${stem}-arm64-nightly.zip`,
    `${stem}-x64-nightly.zip`,
    `${stem}-x64-setup-nightly.exe`,
    `${stem}-x64-nightly.AppImage`,
    `${stem}-x64-nightly.deb`,
    `${stem}-x64-nightly.snap`,
    `${stem}-arm64-nightly.AppImage`,
    `${stem}-arm64-nightly.deb`
  ]
  for (const name of installerNames) await writeFile(path.join(dist, name), `synthetic ${name}`)
  for (const architecture of ['arm64', 'x64']) {
    await mkdir(path.join(dist, architecture))
    const zip = `${stem}-${architecture}-nightly.zip`
    const bytes = await readFile(path.join(dist, zip))
    await writeFile(path.join(dist, architecture, zip), bytes)
    const delta = `Lody Nightly${fixtureProfile.nativeVersion}-1.0.41.delta`
    const deltaBytes = Buffer.from(`synthetic delta ${architecture}`)
    await writeFile(path.join(dist, architecture, delta), deltaBytes)
    const enclosure = (name, contents) =>
      `<enclosure url="${baseUrl}/${architecture}/${encodeURIComponent(name)}" length="${contents.length}" sparkle:edSignature="${sign(null, contents, keys.privateKey).toString('base64')}"/>`
    await writeFile(
      path.join(dist, architecture, 'appcast.xml'),
      `<?xml version="1.0"?><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><sparkle:version>${fixtureProfile.nativeVersion}</sparkle:version><sparkle:shortVersionString>${fixtureProfile.version}</sparkle:shortVersionString>${enclosure(zip, bytes)}<sparkle:deltas>${enclosure(delta, deltaBytes)}</sparkle:deltas></item></channel></rss>`
    )
  }
  const updater = async (names, filename) => {
    const files = []
    for (const name of names) {
      const bytes = await readFile(path.join(dist, name))
      files.push({
        url: name,
        sha512: createHash('sha512').update(bytes).digest('base64'),
        size: bytes.length
      })
    }
    await writeFile(
      path.join(dist, filename),
      stringifyYaml({
        version: fixtureProfile.version,
        files,
        path: names[0],
        sha512: files[0].sha512
      })
    )
  }
  await updater([`${stem}-arm64-nightly.zip`, `${stem}-x64-nightly.zip`], 'nightly-mac.yml')
  await updater([`${stem}-x64-setup-nightly.exe`], 'nightly.yml')
  await updater([`${stem}-x64-nightly.AppImage`, `${stem}-x64-nightly.deb`], 'nightly-linux.yml')
  await updater(
    [`${stem}-arm64-nightly.AppImage`, `${stem}-arm64-nightly.deb`],
    'nightly-linux-arm64.yml'
  )
  const artifactDirectory = path.join(directory, 'artifacts')
  for (const target of ['mac', 'win', 'linux', 'linux-arm64'])
    await stageNightlyArtifacts({
      target,
      dist,
      output: path.join(artifactDirectory, target),
      candidate: build,
      baseVersion: version,
      displayVersion,
      baseUrl,
      publicKey
    })
  const apk = path.join(directory, 'app.apk')
  await writeFile(apk, `signed apk fixture ${displayVersion}`)
  await stageNightlyAndroid({
    apk,
    directory: path.join(artifactDirectory, 'android'),
    candidate: build,
    displayVersion,
    inspect: () => androidNightlyIdentity(build, displayVersion)
  })
  return {
    directory: artifactDirectory,
    minimumStableVersion: '0.100.1',
    candidate: build,
    baseVersion: version,
    displayVersion,
    baseUrl,
    publicKey,
    api,
    allowBootstrap: true
  }
}

async function preparedStore(options) {
  const store = memoryStore()
  const result = await prepareNightlyBuild({ ...options, store })
  assert.equal(result.version, options.displayVersion)
  return store
}

void test('artifact entry points reject invalid candidates before accessing artifacts', async () => {
  for (const invalid of [
    { ...candidate, schema: 2 },
    { ...candidate, trigger: { ...candidate.trigger, repository: 'untrusted/repository' } }
  ]) {
    for (const entryPoint of [stageNightlyArtifacts, verifyNightlyArtifacts]) {
      await assert.rejects(
        entryPoint({ candidate: invalid, baseVersion, baseUrl }),
        /Unsupported Nightly candidate schema|Invalid candidate trigger repository/u
      )
    }
  }
})

void test('complete matrix is signed, hashed, uploaded before metadata and deduplicated on retry', async (t) => {
  const options = await fixture(t)
  const store = await preparedStore(options)
  const put = store.put
  store.put = async (key, value) => {
    if (key === NIGHTLY_JOURNAL_KEY) {
      const win = `Lody-${profile.version}-x64-setup-nightly.exe`
      assert.ok(store.objects.has(win), 'Installers must precede the transaction')
      assert.ok(store.objects.has(`Lody-${profile.version}-x64-nightly.snap`))
    }
    await put(key, value)
  }
  assert.equal((await publishNightlyRelease({ ...options, store })).reason, 'published')
  const version = JSON.parse(await store.get('version.json'))
  assert.deepEqual(version.candidate, candidate)
  assert.equal(version.minimumStableVersion, options.minimumStableVersion)
  assert.equal(version.profile.nativeVersion, '1.0.42')
  assert.equal(version.files.length, 8)
  assert.ok(!version.files.includes(`Lody-${profile.version}-android.apk`))
  for (const key of version.files) assert.ok(store.objects.has(key))
  const snapshot = new Map(store.objects)
  assert.equal((await publishNightlyRelease({ ...options, store })).reason, 'already-published')
  assert.deepEqual(store.objects, snapshot)
})

void test('a Linux feed missing the deb entry cannot publish even with valid artifact digests', async (t) => {
  const options = await fixture(t)
  const directory = path.join(options.directory, 'linux')
  const metadataPath = path.join(directory, 'nightly-linux.yml')
  const linuxMetadata = parseYaml(await readFile(metadataPath, 'utf8'))
  linuxMetadata.files = linuxMetadata.files.filter((file) => !file.url.endsWith('.deb'))
  const bytes = Buffer.from(stringifyYaml(linuxMetadata))
  await writeFile(metadataPath, bytes)
  const manifestPath = path.join(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.files['nightly-linux.yml'] = {
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
  await writeFile(manifestPath, JSON.stringify(manifest))
  const store = await preparedStore(options)
  await assert.rejects(publishNightlyRelease({ ...options, store }), /Updater is missing .*\.deb/u)
  assert.deepEqual([...store.objects.keys()], [NIGHTLY_VERSION_KEY])
})

void test('missing targets and tampered installers cannot move any live feed', async (t) => {
  const options = await fixture(t)
  const store = await preparedStore(options)
  const installer = path.join(
    options.directory,
    'linux',
    `Lody-${profile.version}-x64-nightly.snap`
  )
  await rm(installer)
  await assert.rejects(publishNightlyRelease({ ...options, store }))
  assert.deepEqual([...store.objects.keys()], [NIGHTLY_VERSION_KEY])
  await writeFile(installer, 'tampered')
  await assert.rejects(publishNightlyRelease({ ...options, store }), /digest or size mismatch/u)
  assert.deepEqual([...store.objects.keys()], [NIGHTLY_VERSION_KEY])
})

void test('a newer source pair replaces all feeds together and preserves the prior installers', async (t) => {
  const first = await fixture(t)
  const store = await preparedStore(first)
  await publishNightlyRelease({ ...first, store })
  const prior = JSON.parse(await store.get('version.json'))
  const nextCandidate = {
    ...candidate,
    sourceSha: 'c'.repeat(40),
    trigger: { repository: 'LodyAI/Lody', sha: 'c'.repeat(40) },
    buildNumber: '43',
    runId: '101'
  }
  const next = await fixture(t, nextCandidate)
  const nextApi = async (endpoint) =>
    endpoint.includes('/compare/')
      ? { status: 'ahead', merge_base_commit: { sha: candidate.sourceSha } }
      : {
          ref: 'refs/heads/main',
          object: {
            type: 'commit',
            sha: endpoint.includes('LodyAI/Lody')
              ? nextCandidate.sourceSha
              : nextCandidate.sourceSha
          }
        }
  const before = new Map(store.objects)
  await assert.rejects(
    prepareNightlyBuild({ ...next, baseVersion: '0.88.9', store, api: nextApi }),
    /display version must increase/u
  )
  assert.deepEqual(store.objects, before)
  assert.equal(
    (await prepareNightlyBuild({ ...next, store, api: nextApi })).version,
    next.displayVersion
  )
  assert.equal(
    (await publishNightlyRelease({ ...next, store, api: nextApi, allowBootstrap: false })).reason,
    'published'
  )
  const current = JSON.parse(await store.get('version.json'))
  assert.equal(current.version, '0.90.0-nightly.1')
  for (const key of prior.files) assert.ok(store.objects.has(key))
  assert.equal(
    (await prepareNightlyPublication({ store, candidate: nextCandidate, api: nextApi })).reason,
    'already-published'
  )
  await store.put('nightly.yml', Buffer.from('unexpected modification'))
  await assert.rejects(
    prepareNightlyPublication({ store, candidate: nextCandidate, api: nextApi }),
    /metadata size changed/u
  )
})

void test('matching a tampered manifest digest cannot bypass Sparkle signature validation', async (t) => {
  const options = await fixture(t)
  const directory = path.join(options.directory, 'mac')
  const key = `arm64/Lody Nightly${profile.nativeVersion}-1.0.41.delta`
  const bytes = await readFile(path.join(directory, key))
  bytes[0] ^= 1
  await writeFile(path.join(directory, key), bytes)
  const manifestPath = path.join(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath))
  manifest.files[key].sha256 = await hashFile(path.join(directory, key))
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(
    verifyNightlyArtifacts({ ...options, directory, target: 'mac' }),
    /signature/u
  )
})

void test('partial uploads and feed rollback consume the reservation and fence off superseded retries', async (t) => {
  for (const phase of ['upload', 'metadata']) {
    const first = await fixture(t)
    const store = await preparedStore(first)
    const reserved = await store.get(NIGHTLY_VERSION_KEY)
    const immutable = store.ensureImmutable
    const put = store.put
    let fail = true
    store.ensureImmutable = async (...args) => {
      await immutable(...args)
      if (phase === 'upload') throw new Error('simulated upload failure')
    }
    store.put = async (key, bytes) => {
      if (phase === 'metadata' && key === 'nightly-linux.yml' && fail) {
        fail = false
        throw new Error('simulated metadata failure')
      }
      await put(key, bytes)
    }
    await assert.rejects(publishNightlyRelease({ ...first, store }), /simulated/u)
    for (const key of NIGHTLY_METADATA_KEYS) assert.equal(await store.get(key), null)
    assert.deepEqual(await store.get(NIGHTLY_VERSION_KEY), reserved)
    assert.ok(store.objects.size > 1, 'Partial immutable uploads must survive the failure')
    store.put = put
    store.ensureImmutable = immutable
    assert.equal((await prepareNightlyBuild({ ...first, store })).version, first.displayVersion)

    const nextCandidate = {
      ...candidate,
      sourceSha: 'c'.repeat(40),
      trigger: { repository: 'LodyAI/Lody', sha: 'c'.repeat(40) },
      buildNumber: '43',
      runId: '101'
    }
    const nextApi = async (endpoint) =>
      endpoint.includes('/compare/')
        ? { status: 'ahead', merge_base_commit: { sha: candidate.sourceSha } }
        : {
            ref: 'refs/heads/main',
            object: {
              type: 'commit',
              sha: endpoint.includes('LodyAI/Lody')
                ? nextCandidate.sourceSha
                : nextCandidate.sourceSha
            }
          }
    const next = await fixture(t, nextCandidate)
    assert.equal(
      (await prepareNightlyBuild({ ...next, store, api: nextApi })).version,
      '0.90.0-nightly.1'
    )
    const snapshot = new Map(store.objects)
    await assert.rejects(publishNightlyRelease({ ...first, store }), /another candidate/u)
    assert.deepEqual(store.objects, snapshot)
    assert.equal(
      (await publishNightlyRelease({ ...next, store, api: nextApi })).reason,
      'published'
    )
    const published = JSON.parse(await store.get('version.json'))
    assert.equal(published.version, '0.90.0-nightly.1')
    assert.equal(published.profile.nativeVersion, '1.0.43')
  }
})

void test('unapproved source advances during upload do not cancel an approved publication', async (t) => {
  const options = await fixture(t)
  const store = await preparedStore(options)
  let advanced = false
  const immutable = store.ensureImmutable
  store.ensureImmutable = async (...args) => {
    await immutable(...args)
    advanced = true
  }
  const movingApi = async (endpoint) => {
    if (endpoint.includes('/compare/'))
      return { status: 'ahead', merge_base_commit: { sha: candidate.sourceSha } }
    const response = await api(endpoint)
    if (advanced && endpoint.includes('LodyAI/Lody')) response.object.sha = 'c'.repeat(40)
    return response
  }
  assert.equal(
    (await publishNightlyRelease({ ...options, store, api: movingApi })).reason,
    'published'
  )
  const published = JSON.parse(await store.get('version.json'))
  assert.deepEqual(published.candidate, candidate)
  for (const key of NIGHTLY_METADATA_KEYS) assert.notEqual(await store.get(key), null)
})

void test('bootstrap and incomplete feeds fail closed, and storage keys cannot escape Nightly', async () => {
  await assert.rejects(
    prepareNightlyPublication({ store: memoryStore(), candidate, api }),
    /bootstrap/u
  )
  await assert.rejects(
    prepareNightlyPublication({
      store: memoryStore({ 'nightly.yml': 'orphan' }),
      candidate,
      api,
      allowBootstrap: true
    }),
    /Incomplete/u
  )
  assert.equal(safeNightlyKey(NIGHTLY_JOURNAL_KEY), NIGHTLY_JOURNAL_KEY)
  for (const key of ['../latest.yml', 'arm64/../latest.yml', '/nightly.yml', 'x64\\appcast.xml'])
    assert.throws(() => safeNightlyKey(key))
  const env = {
    R2_NIGHTLY_BUCKET: 'nightly-releases',
    R2_STABLE_BUCKET: 'stable-releases',
    R2_NIGHTLY_PREFIX: 'production/nightly',
    R2_ACCOUNT_ID: 'a'.repeat(32),
    AWS_ACCESS_KEY_ID: 'synthetic',
    AWS_SECRET_ACCESS_KEY: 'synthetic',
    VITE_ELECTRON_UPDATE_URL: baseUrl
  }
  assert.doesNotThrow(() => createNightlyR2Store(env))
  assert.doesNotThrow(() =>
    createNightlyR2Store({ ...env, R2_NIGHTLY_BUCKET: env.R2_STABLE_BUCKET })
  )
  assert.throws(() => createNightlyR2Store({ ...env, R2_NIGHTLY_PREFIX: 'production' }))
  assert.throws(() =>
    createNightlyR2Store({ ...env, VITE_ELECTRON_UPDATE_URL: `${baseUrl}/elsewhere` })
  )
})

void test('immutable uploads run with bounded concurrency and stop scheduling after a failure', async () => {
  const gates = new Map()
  const started = []
  let active = 0
  let peak = 0
  let observe
  const run = mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
    started.push(item)
    active += 1
    peak = Math.max(peak, active)
    try {
      await new Promise((resolve, reject) => gates.set(item, { resolve, reject }))
    } finally {
      active -= 1
    }
  })
  const settled = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }
  await settled()
  assert.deepEqual(started, [1, 2])
  gates.get(1).resolve()
  await settled()
  assert.deepEqual(started, [1, 2, 3])
  gates.get(3).reject(new Error('upload failed'))
  await settled()
  run.catch((error) => (observe = error))
  await settled()
  assert.equal(observe, undefined)
  assert.deepEqual(started, [1, 2, 3])
  gates.get(2).resolve()
  await assert.rejects(run, /upload failed/u)
  assert.equal(peak, 2)
  assert.deepEqual(started, [1, 2, 3])
})

void test('mobile uses the shared Nightly cycle with numeric iOS marketing versions', () => {
  for (const version of ['0.104.0-nightly.0', '0.104.0-nightly.9', '0.105.0-nightly.0']) {
    assert.deepEqual(mobileNightlyVersion(version), {
      android: version,
      ios: version.split('-')[0]
    })
  }
  for (const version of ['0.104.0', '0.104.0-nightly.01', '0.104.1-nightly.0', 'bad\nvalue']) {
    assert.throws(() => mobileNightlyVersion(version))
  }
})

void test('Android missing, tampered, wrong-version and foreign-source artifacts cannot publish', async (t) => {
  for (const mutation of ['missing', 'bytes', 'version', 'candidate']) {
    const options = await fixture(t)
    const store = await preparedStore(options)
    const directory = path.join(options.directory, 'android')
    const manifestPath = path.join(directory, 'manifest.json')
    if (mutation === 'missing') await rm(directory, { recursive: true })
    else if (mutation === 'bytes')
      await writeFile(
        path.join(directory, `Lody-${options.displayVersion}-android.apk`),
        'tampered'
      )
    else {
      const manifest = JSON.parse(await readFile(manifestPath))
      if (mutation === 'version') manifest.identity.versionName = '0.90.0'
      else manifest.candidate.sourceSha = 'c'.repeat(40)
      await writeFile(manifestPath, JSON.stringify(manifest))
    }
    await assert.rejects(publishNightlyAndroid({ ...options, directory, store }))
    assert.deepEqual([...store.objects.keys()], [NIGHTLY_VERSION_KEY])
    await publishNightlyRelease({ ...options, store })
    assert.ok(await store.get('version.json'), 'Broken Android must not block desktop')
  }
})

void test('Android staging checks packaged identity and signature before freezing an artifact', async (t) => {
  const options = await fixture(t)
  const directory = path.join(options.directory, 'rejected-android')
  for (const inspect of [
    () => ({ ...androidNightlyIdentity(candidate, options.displayVersion), versionCode: '1' }),
    () => {
      throw new Error('APK signature invalid')
    }
  ]) {
    await assert.rejects(stageNightlyAndroid({ ...options, directory, apk: 'unused', inspect }))
    await assert.rejects(readFile(path.join(directory, 'manifest.json')), { code: 'ENOENT' })
  }
  const cached = await verifyNightlyAndroid({
    ...options,
    directory: path.join(options.directory, 'android')
  })
  assert.equal(cached.identity.versionName, options.displayVersion)
})

void test('Android codes follow source-run chronology across workflows and survive recovery', () => {
  const stable = {
    head_sha: candidate.sourceSha,
    created_at: '2026-09-22T23:00:00Z',
    run_number: 3715
  }
  const nightly = { head_sha: candidate.sourceSha, created_at: candidate.builtAt, run_number: 97 }
  const nextStable = { ...stable, created_at: '2026-09-24T00:00:00Z' }
  const code = (run) => Number(androidVersionCodeForRun(run, candidate.sourceSha))
  assert.ok(code(stable) > stable.run_number)
  assert.ok(code(nightly) > code(stable))
  assert.ok(code(nextStable) > code(nightly))
  assert.equal(code({ ...nightly, run_attempt: 2 }), code(nightly))
  assert.equal(
    androidNightlyIdentity(candidate, '0.90.0-nightly.0').versionCode,
    String(code(nightly))
  )
  assert.throws(() => androidVersionCodeForRun(nightly, 'c'.repeat(40)), /checkout/u)
  for (const timestamp of [undefined, '', 'bad', '2019-01-01T00:00:00Z', '2100-01-01T00:00:00Z']) {
    assert.throws(() => androidVersionCode(timestamp))
  }
})

void test('Android publishes without desktop artifacts and retries independently of desktop success', async (t) => {
  const options = await fixture(t)
  const store = await preparedStore(options)
  const directory = path.join(options.directory, 'android')
  for (const target of ['mac', 'win', 'linux', 'linux-arm64']) {
    await rm(path.join(options.directory, target), { recursive: true })
  }
  const put = store.put
  store.put = async (key, bytes) => {
    if (key === 'android-version.json') {
      assert.ok(store.objects.has(`Lody-${options.displayVersion}-android.apk`))
    }
    await put(key, bytes)
  }
  assert.equal((await publishNightlyAndroid({ ...options, directory, store })).reason, 'published')
  assert.equal(await store.get('version.json'), null)
  const snapshot = new Map(store.objects)
  assert.equal(
    (await publishNightlyAndroid({ ...options, directory, store })).reason,
    'already-published'
  )
  assert.deepEqual(store.objects, snapshot)
})

void test('desktop success preserves the reserved version for mobile recovery', async (t) => {
  const options = await fixture(t)
  const store = await preparedStore(options)
  await publishNightlyRelease({ ...options, store })
  const desktop = await store.get('version.json')
  const result = await prepareNightlyBuild({ ...options, store })
  assert.equal(result.publish, true)
  assert.equal(result.version, options.displayVersion)
  const directory = path.join(options.directory, 'android')
  const put = store.put
  store.put = async (key, bytes) => {
    if (key === 'android-version.json') throw new Error('simulated Android metadata failure')
    await put(key, bytes)
  }
  await assert.rejects(publishNightlyAndroid({ ...options, directory, store }), /simulated/u)
  assert.deepEqual(await store.get('version.json'), desktop)
  store.put = put
  await publishNightlyAndroid({ ...options, directory, store })
  assert.deepEqual(await store.get('version.json'), desktop)
})

void test('Android rejects a newer candidate with a non-increasing install code before upload', async (t) => {
  const options = await fixture(t)
  const store = await preparedStore(options)
  const directory = path.join(options.directory, 'android')
  await publishNightlyAndroid({ ...options, directory, store })
  const newer = {
    ...candidate,
    sourceSha: 'c'.repeat(40),
    trigger: { repository: 'LodyAI/Lody', sha: 'c'.repeat(40) },
    buildNumber: '43',
    runId: '101'
  }
  const displayVersion = '0.90.0-nightly.1'
  await store.put(
    NIGHTLY_VERSION_KEY,
    Buffer.from(JSON.stringify({ schema: 1, candidate: newer, version: displayVersion }))
  )
  const snapshot = new Map(store.objects)
  const nextApi = async (endpoint) =>
    endpoint.includes('/compare/')
      ? { status: 'ahead', merge_base_commit: { sha: candidate.sourceSha } }
      : {
          ref: 'refs/heads/main',
          object: {
            type: 'commit',
            sha: endpoint.includes('LodyAI/Lody') ? newer.sourceSha : newer.sourceSha
          }
        }
  await assert.rejects(
    publishNightlyAndroid({ directory, candidate: newer, displayVersion, store, api: nextApi }),
    /version code must increase/u
  )
  assert.deepEqual(store.objects, snapshot)
})

void test('pre-ARM64 journals recover both interrupted and committed transactions', async () => {
  for (const committed of [false, true]) {
    const before = metadata('old')
    const after = metadata('new')
    delete before['nightly-linux-arm64.yml']
    delete after['nightly-linux-arm64.yml']
    const entries = Object.fromEntries(
      Object.keys(after).map((key) => [
        key,
        { before: before[key].toString('base64'), after: after[key].toString('base64') }
      ])
    )
    const store = memoryStore({
      ...(committed ? after : before),
      'nightly.yml': after['nightly.yml'],
      [NIGHTLY_JOURNAL_KEY]: Buffer.from(JSON.stringify({ schema: 1, candidate, entries }))
    })
    assert.equal(
      (await recoverNightlyMetadata(store)).state,
      committed ? 'committed' : 'rolled-back'
    )
    assert.deepEqual(Object.fromEntries(store.objects), committed ? after : before)
  }
})

void test('pre-ARM64 releases remain readable but an advertised ARM64 feed cannot disappear', async (t) => {
  const options = await fixture(t)
  const store = await preparedStore(options)
  await publishNightlyRelease({ ...options, store })
  const manifest = JSON.parse(await store.get('version.json'))
  await store.remove('nightly-linux-arm64.yml')
  await assert.rejects(
    prepareNightlyPublication({ ...options, store }),
    /Incomplete Nightly feeds/u
  )
  delete manifest.assets['nightly-linux-arm64.yml']
  await store.put('version.json', Buffer.from(JSON.stringify(manifest)))
  assert.equal((await prepareNightlyPublication({ ...options, store })).publish, false)
})

void test('missing ARM64 artifacts cannot publish any part of the desktop matrix', async (t) => {
  const options = await fixture(t)
  const store = await preparedStore(options)
  await rm(path.join(options.directory, 'linux-arm64'), { recursive: true })
  await assert.rejects(publishNightlyRelease({ ...options, store }))
  assert.deepEqual([...store.objects.keys()], [NIGHTLY_VERSION_KEY])
})

void test('historical two-repository journals recover without querying either repository', async () => {
  const { sourceSha, ...rest } = candidate
  const historical = {
    ...rest,
    privateSha: '8'.repeat(40),
    ossSha: sourceSha,
    trigger: { repository: 'loro-dev/lody', sha: '8'.repeat(40) }
  }
  for (const committed of [false, true]) {
    const before = metadata('old')
    const after = metadata('new')
    after['version.json'] = Buffer.from(JSON.stringify({ candidate: historical, label: 'new' }))
    const entries = Object.fromEntries(
      NIGHTLY_METADATA_KEYS.map((key) => [
        key,
        { before: before[key].toString('base64'), after: after[key].toString('base64') }
      ])
    )
    const store = memoryStore({
      ...(committed ? after : before),
      'nightly.yml': after['nightly.yml'],
      [NIGHTLY_JOURNAL_KEY]: Buffer.from(
        JSON.stringify({ schema: 1, candidate: historical, entries })
      )
    })
    assert.equal(
      (await recoverNightlyMetadata(store)).state,
      committed ? 'committed' : 'rolled-back'
    )
    assert.deepEqual(Object.fromEntries(store.objects), committed ? after : before)
  }
})
