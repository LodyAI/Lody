import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertNightlyVersionReservation,
  NIGHTLY_VERSION_KEY,
  NIGHTLY_VERSION_SCHEME,
  nightlyVersionBase,
  reserveNightlyVersion,
  validateNightlyVersion
} from './nightly-version.mjs'

const candidate = (number) => ({
  schema: 1,
  sourceSha: number.toString(16).padStart(40, '0'),
  buildNumber: String(number),
  runId: String(number + 1000),
  builtAt: '2026-09-29T00:00:00.000Z',
  trigger: { repository: 'LodyAI/Lody', sha: number.toString(16).padStart(40, '0') }
})

const api = async (endpoint) => {
  if (endpoint.includes('/compare/')) {
    const [base, head] = endpoint.split('/compare/')[1].split('...')
    return {
      status: BigInt(`0x${head}`) > BigInt(`0x${base}`) ? 'ahead' : 'diverged',
      merge_base_commit: { sha: base }
    }
  }
  return { ref: 'refs/heads/main', object: { type: 'commit', sha: 'f'.repeat(40) } }
}

function memoryStore() {
  const objects = new Map()
  return {
    objects,
    async get(key) {
      return objects.get(key) ?? null
    },
    async put(key, bytes) {
      objects.set(key, Buffer.from(bytes))
    }
  }
}

const reserve = (store, number, baseVersion = '0.101.0') =>
  reserveNightlyVersion({ store, candidate: candidate(number), baseVersion, api })

void test('patch releases continue the cycle; minor and major releases start at zero', async () => {
  const store = memoryStore()
  for (const [number, baseVersion, expected] of [
    [42, '0.101.0', '0.102.0-nightly.0'],
    [90, '0.101.1', '0.102.0-nightly.1'],
    [91, '0.101.1', '0.102.0-nightly.2'],
    [92, '0.101.1-next.0', '0.102.0-nightly.3'],
    [93, '0.101.1-next.8', '0.102.0-nightly.4'],
    [99, '0.102.0', '0.103.0-nightly.0'],
    [110, '1.0.0', '1.1.0-nightly.0']
  ]) {
    assert.equal((await reserve(store, number, baseVersion)).version, expected)
    await assertNightlyVersionReservation({
      store,
      candidate: candidate(number),
      displayVersion: expected
    })
  }
})

void test('failed runs consume a number; retries reuse it even after an ambiguous write failure', async () => {
  for (const phase of ['before', 'after']) {
    const store = memoryStore()
    await reserve(store, 42)
    const put = store.put
    store.put = async (key, bytes) => {
      if (phase === 'after') await put(key, bytes)
      throw new Error('connection lost')
    }
    await assert.rejects(reserve(store, 50), /connection lost/u)
    store.put = put
    assert.equal((await reserve(store, 50)).version, '0.102.0-nightly.1')
    const snapshot = new Map(store.objects)
    assert.equal((await reserve(store, 50)).version, '0.102.0-nightly.1')
    assert.deepEqual(store.objects, snapshot)
    assert.equal((await reserve(store, 60)).version, '0.102.0-nightly.2')
    assert.deepEqual(await reserve(store, 50), {
      publish: false,
      reason: 'superseded-reservation'
    })
  }
})

void test('reservations bind provenance and display version and reject source/cycle rollback', async () => {
  const store = memoryStore()
  await reserve(store, 50)
  const snapshot = new Map(store.objects)
  await assert.rejects(
    reserveNightlyVersion({
      store,
      candidate: { ...candidate(50), builtAt: '2026-09-30T00:00:00.000Z' },
      baseVersion: '0.101.0',
      api
    }),
    /candidate changed/u
  )
  await assert.rejects(reserve(store, 50, '0.102.0'), /next minor/u)
  await assert.rejects(reserve(store, 60, '0.100.9'), /display version must increase/u)
  await assert.rejects(
    reserveNightlyVersion({
      store,
      candidate: { ...candidate(60), sourceSha: candidate(42).sourceSha },
      baseVersion: '0.101.0',
      api
    })
  )
  await assert.rejects(
    assertNightlyVersionReservation({
      store,
      candidate: candidate(60),
      displayVersion: '0.102.0-nightly.0'
    }),
    /another candidate/u
  )
  await assert.rejects(
    assertNightlyVersionReservation({
      store,
      candidate: candidate(50),
      displayVersion: '0.102.0-nightly.1'
    }),
    /differs/u
  )
  assert.deepEqual(store.objects, snapshot)
})

void test('migrates legacy published versions without rolling back and rejects lost/corrupt state', async () => {
  const store = memoryStore()
  const published = {
    schema: 1,
    channel: 'nightly',
    candidate: candidate(500),
    version: '0.101.7-nightly.500'
  }
  await store.put('version.json', Buffer.from(JSON.stringify(published)))
  assert.equal((await reserve(store, 600, '0.101.7')).version, '0.102.0-nightly.0')
  await store.put(
    'version.json',
    Buffer.from(
      JSON.stringify({
        ...published,
        candidate: candidate(600),
        version: '0.102.0-nightly.0',
        versionScheme: NIGHTLY_VERSION_SCHEME
      })
    )
  )
  const record = await store.get(NIGHTLY_VERSION_KEY)
  store.objects.delete(NIGHTLY_VERSION_KEY)
  await assert.rejects(reserve(store, 700), /reservation is missing/u)
  await store.put(NIGHTLY_VERSION_KEY, Buffer.from('{}'))
  await assert.rejects(reserve(store, 700))
  await store.put(NIGHTLY_VERSION_KEY, record)
  assert.equal((await reserve(store, 700, '0.101.8')).version, '0.102.0-nightly.1')
  const behind = JSON.parse(record)
  behind.candidate = candidate(550)
  await store.put(NIGHTLY_VERSION_KEY, Buffer.from(JSON.stringify(behind)))
  await assert.rejects(reserve(store, 800), /behind the published release/u)

  const legacy = memoryStore()
  await legacy.put(
    'version.json',
    Buffer.from(JSON.stringify({ ...published, version: '0.102.0-nightly.500' }))
  )
  await assert.rejects(reserve(legacy, 600), /display version must increase/u)
  assert.equal(await legacy.get(NIGHTLY_VERSION_KEY), null)
})

void test('invalid version input never falls back to the workflow run number', () => {
  assert.equal(nightlyVersionBase('0.101.99'), '0.102.0')
  for (const version of [
    undefined,
    '',
    '0.102.0',
    '0.102.1-nightly.0',
    '0.102.0-nightly.01',
    '0.102.0-nightly.-1',
    '0.102.0-nightly.100000000',
    '0.103.0-nightly.0'
  ])
    assert.throws(() => validateNightlyVersion(version, '0.101.0'), /LODY_NIGHTLY_VERSION/u)
  for (const base of [
    '0.101.0-next.01',
    '0.101.0-next',
    '0.101.0-beta.1',
    '0.101.0-nightly.1',
    'v0.101.0',
    '0.01.0',
    '0.99999999.0'
  ])
    assert.throws(() => nightlyVersionBase(base), /base version/u)
})

void test('first public reservation advances both legacy R2 records using only their public source', async () => {
  for (const sameRunId of [false, true]) {
    const store = memoryStore()
    const next = candidate(600)
    const legacy = {
      schema: 1,
      privateSha: 'e'.repeat(40),
      ossSha: candidate(500).sourceSha,
      buildNumber: '500',
      runId: sameRunId ? next.runId : '100',
      builtAt: '2026-09-28T00:00:00.000Z',
      trigger: { repository: 'loro-dev/lody', sha: 'e'.repeat(40) }
    }
    const version = '0.102.0-nightly.7'
    await store.put(
      NIGHTLY_VERSION_KEY,
      Buffer.from(JSON.stringify({ schema: 1, candidate: legacy, version }))
    )
    await store.put(
      'version.json',
      Buffer.from(
        JSON.stringify({
          schema: 1,
          channel: 'nightly',
          candidate: legacy,
          version,
          versionScheme: NIGHTLY_VERSION_SCHEME
        })
      )
    )
    const publicOnlyApi = async (endpoint) => {
      assert.ok(endpoint.startsWith('repos/LodyAI/Lody/'))
      assert.ok(
        !endpoint.includes(legacy.privateSha),
        'Private SHA must never enter a public compare request'
      )
      return api(endpoint)
    }
    const result = await reserveNightlyVersion({
      store,
      candidate: next,
      baseVersion: '0.101.0',
      api: publicOnlyApi
    })
    assert.deepEqual(result, { publish: true, version: '0.102.0-nightly.8' })
    assert.deepEqual(JSON.parse(await store.get(NIGHTLY_VERSION_KEY)).candidate, next)
    const snapshot = new Map(store.objects)
    assert.deepEqual(
      await reserveNightlyVersion({
        store,
        candidate: next,
        baseVersion: '0.101.0',
        api: publicOnlyApi
      }),
      result
    )
    assert.deepEqual(store.objects, snapshot, 'Exact retry must not change the reservation')
  }
})

void test('legacy R2 reservations still reject a divergent public source without writing', async () => {
  const store = memoryStore()
  const legacy = {
    schema: 1,
    privateSha: 'e'.repeat(40),
    ossSha: candidate(500).sourceSha,
    buildNumber: '500',
    runId: '100',
    builtAt: '2026-09-28T00:00:00.000Z',
    trigger: { repository: 'loro-dev/lody', sha: 'e'.repeat(40) }
  }
  await store.put(
    NIGHTLY_VERSION_KEY,
    Buffer.from(JSON.stringify({ schema: 1, candidate: legacy, version: '0.102.0-nightly.7' }))
  )
  const snapshot = new Map(store.objects)
  await assert.rejects(
    reserveNightlyVersion({
      store,
      candidate: candidate(600),
      baseVersion: '0.101.0',
      api: async (endpoint) => {
        assert.ok(!endpoint.includes(legacy.privateSha))
        return { status: 'diverged', merge_base_commit: { sha: 'd'.repeat(40) } }
      }
    }),
    /ancestor/u
  )
  assert.deepEqual(store.objects, snapshot)
})
