import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  fetchSparkleDeltaBases,
  findSparkleDeltaBaseUrls,
  verifySparkleArchive
} from './sparkle-delta-bases.mjs'

const feed = `<?xml version="1.0"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <item><enclosure url="https://updates.example.com/staging/Lody-2.0.0-arm64.zip" sparkle:shortVersionString="2.0.0" sparkle:edSignature="AA==" length="10" /></item>
    <item><enclosure url="https://updates.example.com/staging/Lody-2.0.0-x64.zip" sparkle:shortVersionString="2.0.0" sparkle:edSignature="AA==" length="10" /></item>
    <item><enclosure url="https://updates.example.com/staging/Lody-1.9.0-arm64.zip" sparkle:shortVersionString="1.9.0" sparkle:edSignature="AA==" length="10" /></item>
    <item><enclosure url="https://updates.example.com/staging/Lody-1.8.0-arm64.zip" sparkle:shortVersionString="1.8.0" sparkle:edSignature="AA==" length="10" /></item>
  </channel>
</rss>`

void test('selects every architecture from the newest two Sparkle versions', () => {
  assert.deepEqual(
    findSparkleDeltaBaseUrls(feed, 'https://updates.example.com/staging/appcast.xml', 2),
    [
      'https://updates.example.com/staging/Lody-2.0.0-arm64.zip',
      'https://updates.example.com/staging/Lody-2.0.0-x64.zip',
      'https://updates.example.com/staging/Lody-1.9.0-arm64.zip'
    ]
  )
})

void test('rejects rebuilding a version already present in the appcast', () => {
  assert.throws(
    () =>
      findSparkleDeltaBaseUrls(feed, 'https://updates.example.com/staging/appcast.xml', 2, '2.0.0'),
    /already exists; versioned releases are immutable/u
  )
})

void test('verifies a previous archive with its Sparkle Ed25519 signature', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const archive = Buffer.from('signed previous release')
  const signature = sign(null, archive, privateKey).toString('base64')
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)

  assert.equal(verifySparkleArchive(archive, signature, rawPublicKey.toString('base64')), true)
  assert.equal(
    verifySparkleArchive(
      Buffer.from('tampered release'),
      signature,
      rawPublicKey.toString('base64')
    ),
    false
  )
})

void test('rejects unsigned previous archives', () => {
  const unsignedFeed = feed.replace('sparkle:edSignature="AA==" length="10"', 'length="10"')
  assert.throws(
    () =>
      findSparkleDeltaBaseUrls(unsignedFeed, 'https://updates.example.com/staging/appcast.xml', 2),
    /no valid signature or length/u
  )
})

void test('rejects archives outside the selected update directory', () => {
  const poisonedFeed = feed.replace(
    'https://updates.example.com/staging/Lody-2.0.0-arm64.zip',
    'https://attacker.example/Lody-2.0.0-arm64.zip'
  )
  assert.throws(
    () =>
      findSparkleDeltaBaseUrls(poisonedFeed, 'https://updates.example.com/staging/appcast.xml', 2),
    /outside the configured update directory/u
  )
})

void test('rejects non-TLS remote appcasts', () => {
  assert.throws(
    () => findSparkleDeltaBaseUrls(feed, 'http://updates.example.com/staging/appcast.xml', 2),
    /must use HTTPS/u
  )
})

void test('requires an explicit first-release opt-in for a missing appcast', async () => {
  const originalFetch = globalThis.fetch
  const archiveDirectory = await mkdtemp(path.join(tmpdir(), 'sparkle-delta-bases-'))
  globalThis.fetch = async () => {
    const response = new Response('', { status: 404 })
    Object.defineProperty(response, 'url', {
      value: 'https://updates.example.com/staging/appcast.xml'
    })
    return response
  }
  try {
    await assert.rejects(
      fetchSparkleDeltaBases({
        appcastUrl: 'https://updates.example.com/staging/appcast.xml',
        archiveDirectory,
        publicKey: 'not-used-for-a-missing-feed',
        currentVersion: '2.1.0'
      }),
      /SPARKLE_ALLOW_MISSING_APPCAST=true only for the first release/u
    )
    assert.deepEqual(
      await fetchSparkleDeltaBases({
        appcastUrl: 'https://updates.example.com/staging/appcast.xml',
        archiveDirectory,
        publicKey: 'not-used-for-a-missing-feed',
        currentVersion: '2.1.0',
        allowMissingAppcast: true
      }),
      []
    )
  } finally {
    globalThis.fetch = originalFetch
    await rm(archiveDirectory, { recursive: true, force: true })
  }
})

const nightlyFeed = `<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
  <item>
    <title>0.89.4-nightly.7</title>
    <sparkle:version>1.0.7</sparkle:version>
    <sparkle:shortVersionString>0.89.4-nightly.7</sparkle:shortVersionString>
    <description><![CDATA[Example markup, not a release: <!DOCTYPE html>
      <item><sparkle:version>999</sparkle:version><enclosure url="https://untrusted.example/fake.zip" /></item>
    ]]></description>
    <sparkle:deltas><enclosure url="https://updates.example.com/production/nightly/arm64/previous.delta" sparkle:version="1.0.6" /></sparkle:deltas>
    <enclosure url="https://updates.example.com/production/nightly/arm64/Lody-Nightly-0.89.4-nightly.7-arm64.zip" sparkle:edSignature="AA==" length="10" />
  </item>
</channel></rss>`
const nightlyFeedUrl = 'https://updates.example.com/production/nightly/arm64/appcast.xml'

async function downloadFixture(t, archiveRequest) {
  const archiveDirectory = await mkdtemp(path.join(tmpdir(), 'sparkle-retry-'))
  t.after(() => rm(archiveDirectory, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const archive = Buffer.from('signed history archive')
  const signature = sign(null, archive, privateKey).toString('base64')
  const signedFeed = nightlyFeed.replace(
    'sparkle:edSignature="AA==" length="10"',
    `sparkle:edSignature="${signature}" length="${archive.length}"`
  )
  const filename = 'Lody-Nightly-0.89.4-nightly.7-arm64.zip'
  const waits = []
  const logs = []
  const signals = []
  let clock = 0
  const response = (body, status = 200, url = new URL(filename, nightlyFeedUrl).href, headers) => {
    const result = new Response(body, { status, headers })
    Object.defineProperty(result, 'url', { value: url })
    return result
  }
  const run = (options = {}) =>
    fetchSparkleDeltaBases({
      appcastUrl: nightlyFeedUrl,
      archiveDirectory,
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
      request: async (url, { signal }) => {
        if (String(url) === nightlyFeedUrl) return response(signedFeed, 200, nightlyFeedUrl)
        signals.push(signal)
        return archiveRequest({
          attempt: signals.length,
          archive,
          response,
          signal,
          advance: (ms) => {
            clock += ms
          }
        })
      },
      wait: async (ms) => {
        waits.push(ms)
      },
      now: () => clock,
      log: (line) => logs.push(line),
      ...options
    })
  return { run, archive, archiveDirectory, filename, waits, logs, signals }
}

void test('retries a timed out request with a fresh signal and stages verified bytes', async (t) => {
  const f = await downloadFixture(t, ({ attempt, archive, response, advance }) => {
    if (attempt === 1) {
      advance(600_000)
      throw new DOMException('download timed out', 'TimeoutError')
    }
    return response(archive)
  })
  await f.run()
  assert.deepEqual(await readFile(path.join(f.archiveDirectory, f.filename)), f.archive)
  assert.deepEqual(f.waits, [1000])
  assert.notEqual(f.signals[0], f.signals[1])
  assert.match(f.logs.join('\n'), /attempt 1\/3, 600000ms elapsed, 0\/22 bytes received/u)
})

void test('restarts a partial transfer after a network failure without appending stale bytes', async (t) => {
  const f = await downloadFixture(t, ({ attempt, archive, response }) => {
    if (attempt !== 1) return response(archive)
    return response(
      ReadableStream.from(
        (async function* () {
          yield archive.subarray(0, 5)
          throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
        })()
      )
    )
  })
  await f.run()
  assert.deepEqual(await readFile(path.join(f.archiveDirectory, f.filename)), f.archive)
  assert.deepEqual(f.waits, [1000])
  assert.match(f.logs.join('\n'), /5\/22 bytes received/u)
  assert.ok(!(await readdir(f.archiveDirectory)).some((name) => name.endsWith('.part')))
})

void test('retries body AbortError when its request deadline expired', async (t) => {
  const controllers = new Map()
  t.mock.method(AbortSignal, 'timeout', () => {
    const controller = new AbortController()
    controllers.set(controller.signal, controller)
    return controller.signal
  })
  const f = await downloadFixture(t, ({ attempt, archive, response, signal }) => {
    if (attempt !== 1) return response(archive)
    return response(
      ReadableStream.from(
        (async function* () {
          yield archive.subarray(0, 5)
          controllers.get(signal).abort(new DOMException('deadline expired', 'TimeoutError'))
          throw new DOMException('body aborted', 'AbortError')
        })()
      )
    )
  })
  await f.run()
  assert.deepEqual(await readFile(path.join(f.archiveDirectory, f.filename)), f.archive)
  assert.deepEqual(f.waits, [1000])
})

for (const status of [408, 429, 500, 502, 503, 504]) {
  void test(`recovers from HTTP ${status} and verifies the subsequent archive`, async (t) => {
    const f = await downloadFixture(t, ({ attempt, archive, response }) =>
      attempt === 1 ? response('temporary failure', status) : response(archive)
    )
    await f.run()
    assert.deepEqual(await readFile(path.join(f.archiveDirectory, f.filename)), f.archive)
    assert.deepEqual(f.waits, [1000])
  })
}

void test('stops after three transient HTTP failures and releases response bodies', async (t) => {
  const bodies = []
  const f = await downloadFixture(t, ({ response }) => {
    const result = response('unavailable', 503)
    bodies.push(result.body)
    return result
  })
  await assert.rejects(f.run(), /attempt 3\/3.*0\/22 bytes received: Error: HTTP 503/u)
  assert.deepEqual(f.waits, [1000, 2000])
  assert.equal(f.signals.length, 3)
  for (const body of bodies) assert.equal((await body.getReader().read()).done, true)
  assert.deepEqual(await readdir(f.archiveDirectory), ['appcast.xml'])
})

for (const failure of ['404', 'redirect', 'size', 'length', 'signature', 'disk']) {
  void test(`does not retry ${failure} failures or leave an unverified archive`, async (t) => {
    const f = await downloadFixture(t, ({ archive, response }) => {
      if (failure === '404') return response('missing', 404)
      if (failure === 'redirect') return response(archive, 200, 'https://other.example/archive.zip')
      if (failure === 'size')
        return response(archive, 200, undefined, { 'content-length': String(2 ** 31) })
      if (failure === 'length') return response(archive.subarray(0, 5))
      if (failure === 'signature') return response(Buffer.alloc(archive.length))
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    })
    await assert.rejects(f.run(), /Sparkle delta base .*attempt 1\/3/u)
    assert.equal(f.signals.length, 1)
    assert.deepEqual(f.waits, [])
    assert.deepEqual(await readdir(f.archiveDirectory), ['appcast.xml'])
  })
}

void test('reads generated Sparkle version elements without interpreting release-note markup or nested deltas', () => {
  assert.deepEqual(findSparkleDeltaBaseUrls(nightlyFeed, nightlyFeedUrl, 2, '0.89.4-nightly.8'), [
    'https://updates.example.com/production/nightly/arm64/Lody-Nightly-0.89.4-nightly.7-arm64.zip'
  ])
  assert.throws(
    () => findSparkleDeltaBaseUrls(nightlyFeed, nightlyFeedUrl, 2, '0.89.4-nightly.7'),
    /already exists/u
  )
  assert.throws(
    () =>
      findSparkleDeltaBaseUrls(nightlyFeed, nightlyFeedUrl, 2, 'another-display-version', '1.0.7'),
    /already exists/u
  )
})

void test('rejects malformed or DTD-bearing feeds instead of silently dropping update history', () => {
  for (const xml of [
    '<rss><channel><item></channel></rss>',
    '<html>not an appcast</html>',
    '<rss><channel /></rss>',
    '<!DOCTYPE rss [<!ENTITY release "1.0.0">]><rss><channel><item><sparkle:version>&release;</sparkle:version></item></channel></rss>'
  ]) {
    assert.throws(() => findSparkleDeltaBaseUrls(xml, nightlyFeedUrl), /appcast/u)
  }
  const duplicatedVersion = nightlyFeed.replace(
    '<sparkle:version>1.0.7</sparkle:version>',
    '<sparkle:version>1.0.7</sparkle:version><sparkle:version>1.0.8</sparkle:version>'
  )
  assert.throws(() => findSparkleDeltaBaseUrls(duplicatedVersion, nightlyFeedUrl), /build version/u)
})

void test('stages only signature-verified archives from a generated Nightly feed', async () => {
  const originalFetch = globalThis.fetch
  const archiveDirectory = await mkdtemp(path.join(tmpdir(), 'sparkle-nightly-history-'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const archive = Buffer.from('synthetic previous Nightly archive')
  const signature = sign(null, archive, privateKey).toString('base64')
  const signedFeed = nightlyFeed.replace(
    'sparkle:edSignature="AA==" length="10"',
    `sparkle:edSignature="${signature}" length="${archive.length}"`
  )
  const archiveUrl =
    'https://updates.example.com/production/nightly/arm64/Lody-Nightly-0.89.4-nightly.7-arm64.zip'
  globalThis.fetch = async (url) => {
    const address = String(url)
    assert.ok(address === nightlyFeedUrl || address === archiveUrl)
    const response = new Response(address === nightlyFeedUrl ? signedFeed : archive)
    Object.defineProperty(response, 'url', { value: address })
    return response
  }
  try {
    assert.deepEqual(
      await fetchSparkleDeltaBases({
        appcastUrl: nightlyFeedUrl,
        archiveDirectory,
        publicKey: publicKey
          .export({ format: 'der', type: 'spki' })
          .subarray(-32)
          .toString('base64'),
        currentVersion: '0.89.4-nightly.8',
        currentBuildVersion: '1.0.8'
      }),
      [archiveUrl]
    )
    assert.deepEqual(
      await readFile(path.join(archiveDirectory, path.basename(archiveUrl))),
      archive
    )
  } finally {
    globalThis.fetch = originalFetch
    await rm(archiveDirectory, { recursive: true, force: true })
  }
})

void test('bounds delta history by native build when display versions repeat', () => {
  const item = (build) => `<item><sparkle:version>1.0.${build}</sparkle:version>
    <sparkle:shortVersionString>0.89.4</sparkle:shortVersionString>
    <enclosure url="https://updates.example.com/production/nightly/arm64/Lody-Nightly-0.89.4-nightly.${build}-arm64.zip" sparkle:edSignature="AA==" length="10" /></item>`
  const xml = `<rss><channel>${item(7)}${item(6)}${item(5)}</channel></rss>`
  assert.deepEqual(findSparkleDeltaBaseUrls(xml, nightlyFeedUrl, 2, '0.89.4-nightly.8', '1.0.8'), [
    'https://updates.example.com/production/nightly/arm64/Lody-Nightly-0.89.4-nightly.7-arm64.zip',
    'https://updates.example.com/production/nightly/arm64/Lody-Nightly-0.89.4-nightly.6-arm64.zip'
  ])
})

const legacyFeed = feed.replaceAll(' sparkle:edSignature="AA=="', '')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function legacyFixture(t, xml = legacyFeed) {
  const root = await mkdtemp(path.join(tmpdir(), 'sparkle-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const archiveDirectory = path.join(root, 'archives')
  await mkdir(archiveDirectory)
  const requests = []
  const run = (options = {}) =>
    fetchSparkleDeltaBases({
      appcastUrl: 'https://updates.example.com/staging/appcast.xml',
      archiveDirectory,
      publicKey: 'unused-without-historical-archives',
      currentVersion: '2.1.0',
      request: async (url) => {
        requests.push(String(url))
        assert.equal(
          String(url),
          'https://updates.example.com/staging/appcast.xml',
          'legacy archives must never be requested'
        )
        const response = new Response(xml)
        Object.defineProperty(response, 'url', { value: String(url) })
        return response
      },
      log: () => {},
      ...options
    })
  return { root, archiveDirectory, requests, run }
}

void test('only an exact reviewed feed pin permits discarding unsigned history without downloading archives', async (t) => {
  for (const pin of ['', '0'.repeat(64)]) {
    const f = await legacyFixture(t)
    await assert.rejects(
      f.run({ expectedLegacyAppcastSha256: pin }),
      /no valid signature or length/u
    )
    assert.equal(f.requests.length, 1)
  }
  const f = await legacyFixture(t)
  await writeFile(path.join(f.archiveDirectory, 'appcast.xml'), 'stale generator feed')
  await writeFile(path.join(f.archiveDirectory, 'current.zip'), 'current release')
  assert.deepEqual(await f.run({ expectedLegacyAppcastSha256: sha256(legacyFeed) }), [])
  assert.equal(f.requests.length, 1)
  assert.deepEqual(await readdir(f.archiveDirectory), ['current.zip'])
  assert.deepEqual(
    await readFile(`${f.archiveDirectory}.legacy-appcast.xml`),
    Buffer.from(legacyFeed)
  )
})

void test('a reviewed feed pin authorizes discarding exact history regardless of signature presence', async (t) => {
  const f = await legacyFixture(t, feed)
  assert.deepEqual(await f.run({ expectedLegacyAppcastSha256: sha256(feed) }), [])
  assert.equal(f.requests.length, 1)
  assert.deepEqual(await readdir(f.archiveDirectory), [])
})

void test('a pinned legacy feed cannot bypass XML validity or current display/build version collisions', async (t) => {
  for (const [xml, options, error] of [
    ['<rss><channel><item></channel></rss>', {}, /Invalid Sparkle appcast XML/u],
    ['<!DOCTYPE rss><rss><channel><item /></channel></rss>', {}, /DTD/u],
    [legacyFeed, { currentVersion: '1.8.0' }, /already exists/u],
    [nightlyFeed, { currentBuildVersion: '1.0.7' }, /already exists/u]
  ]) {
    const f = await legacyFixture(t, xml)
    await assert.rejects(f.run({ expectedLegacyAppcastSha256: sha256(xml), ...options }), error)
    assert.deepEqual(await readdir(f.root), ['archives'])
  }
})

void test('a stale legacy pin permits subsequent signed history only through normal archive verification', async (t) => {
  const f = await downloadFixture(t, ({ archive, response }) => response(archive))
  await f.run({ expectedLegacyAppcastSha256: sha256(legacyFeed) })
  assert.equal(f.signals.length, 1)
  assert.deepEqual(await readFile(path.join(f.archiveDirectory, f.filename)), f.archive)
  const invalid = await downloadFixture(t, ({ archive, response }) =>
    response(Buffer.alloc(archive.length))
  )
  await assert.rejects(
    invalid.run({ expectedLegacyAppcastSha256: sha256(legacyFeed) }),
    /signature verification failed/u
  )
})

void test('an invalid migration pin fails before fetching release history', async (t) => {
  const f = await legacyFixture(t)
  await assert.rejects(f.run({ expectedLegacyAppcastSha256: 'not-a-digest' }), /SHA256 hex digest/u)
  assert.deepEqual(f.requests, [])
})
