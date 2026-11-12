import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { buildRelease } from './build.mjs'
import { signManifest, sha256 } from './protocol.mjs'
import { readObject, putObject, collectObjects } from './cas.mjs'
import { stageRelease } from './download.mjs'

async function assertOnlyVerifiedCache(storeRoot, manifest) {
  const sizes = new Map(manifest.tree.map((entry) => [entry.sha256, entry.size]))
  for (const name of await fs.readdir(storeRoot)) {
    assert.equal(name, '.objects', 'failed transfer must not publish a snapshot or retain staging')
    for (const hash of await fs.readdir(path.join(storeRoot, name))) {
      assert.ok(sizes.has(hash), 'cache contains only completed target objects')
      const file = path.join(storeRoot, name, hash)
      assert.ok((await fs.lstat(file)).isFile())
      const bytes = await fs.readFile(file)
      assert.equal(bytes.length, sizes.get(hash))
      assert.equal(sha256(bytes), hash)
    }
  }
}

test('signed build stages 401 files, reuses content across skipped releases and isolates HTTP failures', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ota-test-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const input = path.join(root, 'input')
  await fs.mkdir(input)
  for (let i = 0; i < 401; i++)
    await fs.writeFile(path.join(input, `${i}.js`), `export default ${i % 7};`)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const applicability = {
    hostRequirements: {},
    hostAbi: 'abi1',
    channel: 'nightly',
    platform: 'linux',
    arch: 'x64'
  }
  const built = await buildRelease({
    ...applicability,
    input,
    output: path.join(root, 'output'),
    release: 'r3',
    seq: 3,
    privateKey
  })
  let mode = 'range'
  let requests = 0
  let onTransfer

  const server = createServer((req, res) => {
    requests++
    if (mode === 'cancel') {
      res.writeHead(200)
      res.write(Buffer.from('x'))
      onTransfer()
      return
    }
    const pack = built.packs.find((p) => '/' + p.path === req.url)
    if (mode === 'unauthorized') {
      res.writeHead(401).end()
      return
    }
    if (!pack) {
      res.writeHead(404).end()
      return
    }
    if (req.headers.range && mode !== 'full') {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(req.headers.range).map(Number)
      res.writeHead(206, {
        'Content-Range': `bytes ${mode === 'bad-range' ? start + 1 : start}-${end}/${pack.bytes.length}`
      })
      res.end(pack.bytes.subarray(start, end + 1))
    } else {
      res.writeHead(200)
      res.end(mode === 'tamper' ? Buffer.alloc(pack.bytes.length) : pack.bytes)
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const options = {
    ...applicability,
    manifest: built.manifest,
    publicKey,
    baseUrl: `http://127.0.0.1:${server.address().port}/`,
    storeRoot: path.join(root, 'store')
  }
  const staged = await stageRelease(options)
  assert.equal((await fs.readdir(staged.directory)).length, 401)
  assert.equal(
    await fs.readFile(path.join(staged.directory, '400.js'), 'utf8'),
    'export default 1;'
  )
  const concurrent = await Promise.all([stageRelease(options), stageRelease(options)])
  assert.equal(concurrent[0].directory, staged.directory)
  const before = requests
  const reused = await stageRelease({
    ...options,
    storeRoot: path.join(root, 'reuse'),
    localRoots: [staged.directory]
  })
  assert.equal(requests, before)
  assert.equal(reused.stats.reusedObjects, 7)
  const invalid = structuredClone(built.manifest)
  invalid.seq++
  await assert.rejects(
    stageRelease({ ...options, manifest: invalid, storeRoot: path.join(root, 'invalid') })
  )
  await assert.rejects(fs.stat(path.join(root, 'invalid')), { code: 'ENOENT' })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    stageRelease({ ...options, signal: controller.signal, storeRoot: path.join(root, 'cancel') })
  )
  const activeCancel = new AbortController()
  let observed
  const started = new Promise((resolve) => {
    observed = resolve
  })
  onTransfer = observed
  mode = 'cancel'
  const cancelledStore = path.join(root, 'mid-cancel')
  const pending = stageRelease({
    ...options,
    storeRoot: cancelledStore,
    signal: activeCancel.signal
  })
  const rejected = assert.rejects(pending)
  await started
  activeCancel.abort()
  await rejected
  await assertOnlyVerifiedCache(cancelledStore, built.manifest)
  const alias = path.join(root, 'alias')
  await fs.symlink(staged.directory, alias)
  await assert.rejects(stageRelease({ ...options, localRoots: [alias] }), /Unsafe local root/)
  const partial = path.join(root, 'partial')
  await fs.mkdir(partial)
  await fs.copyFile(path.join(input, '0.js'), path.join(partial, '0.js'))
  mode = 'bad-range'
  await assert.rejects(
    stageRelease({ ...options, localRoots: [partial], storeRoot: path.join(root, 'bad-range') }),
    /Content-Range/
  )
  const fromSha256 = sha256(await fs.readFile(path.join(partial, '0.js')))
  const target = built.manifest.tree.find((f) => f.sha256 !== fromSha256).sha256
  const corrupt = Buffer.from([0])
  const corruptHash = sha256(corrupt)
  built.packs.push({ path: `packs/${corruptHash}.pack`, bytes: corrupt })
  const { signature, ...unsigned } = built.manifest
  const patched = signManifest(
    {
      ...unsigned,
      packs: [
        ...unsigned.packs,
        { path: `packs/${corruptHash}.pack`, sha256: corruptHash, size: 1 }
      ],
      patches: [
        {
          fromSha256,
          toSha256: target,
          packSha256: corruptHash,
          offset: 0,
          length: 1,
          compressedSha256: corruptHash
        }
      ]
    },
    privateKey
  )
  mode = 'range'
  const recovered = await stageRelease({
    ...options,
    manifest: patched,
    localRoots: [partial],
    storeRoot: path.join(root, 'patch-fallback')
  })
  assert.equal(
    await fs.readFile(path.join(recovered.directory, '1.js'), 'utf8'),
    'export default 1;'
  )
  mode = 'full'
  const full = await stageRelease({
    ...options,
    localRoots: [partial],
    storeRoot: path.join(root, 'full')
  })
  assert.equal(full.stats.requests, 1)
  for (const failure of ['unauthorized', 'tamper']) {
    mode = failure
    const storeRoot = path.join(root, failure)
    await assert.rejects(stageRelease({ ...options, storeRoot }))
    await assertOnlyVerifiedCache(storeRoot, built.manifest)
  }
})

test('previousInput builds a real dictionary frame and transfer replays exact base', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ota-dict-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const previous = path.join(root, 'previous'),
    input = path.join(root, 'input')
  await fs.mkdir(previous)
  await fs.mkdir(input)
  const base = randomBytes(16000),
    target = Buffer.from(base)
  target[8000] ^= 1
  await fs.writeFile(path.join(previous, 'main.js'), base)
  await fs.writeFile(path.join(input, 'main.js'), target)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const applicability = {
    hostRequirements: {},
    hostAbi: 'abi1',
    channel: 'nightly',
    platform: 'linux',
    arch: 'x64'
  }
  const built = await buildRelease({
    ...applicability,
    input,
    previousInput: previous,
    output: path.join(root, 'output'),
    release: 'dictionary',
    seq: 8,
    privateKey
  })
  assert.equal(built.manifest.patches.length, 1)
  const server = createServer((req, res) => {
    const pack = built.packs[0]
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(req.headers.range).map(Number)
    res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${pack.bytes.length}` })
    res.end(pack.bytes.subarray(a, b + 1))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const result = await stageRelease({
    ...applicability,
    manifest: built.manifest,
    publicKey,
    localRoots: [previous],
    storeRoot: path.join(root, 'store'),
    baseUrl: `http://127.0.0.1:${server.address().port}/`
  })
  assert.deepEqual(await fs.readFile(path.join(result.directory, 'main.js')), target)
  assert.equal(result.stats.requests, 1)
  assert.equal(result.stats.downloadedBytes, built.manifest.patches[0].length)
})

test('401 unique tiny objects merge into one bounded range around locally reused bulk content', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ota-plan-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const input = path.join(root, 'input'),
    local = path.join(root, 'local')
  await fs.mkdir(input)
  await fs.mkdir(local)
  for (let i = 0; i < 401; i++)
    await fs.writeFile(path.join(input, `${i}.js`), `export default ${i};`)
  const bulk = randomBytes(1024 * 1024)
  await fs.writeFile(path.join(input, 'bulk'), bulk)
  await fs.writeFile(path.join(local, 'bulk'), bulk)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const applicability = {
    hostRequirements: {},
    hostAbi: 'abi',
    channel: 'nightly',
    platform: 'linux',
    arch: 'x64'
  }
  const built = await buildRelease({
    ...applicability,
    input,
    output: path.join(root, 'out'),
    release: 'many',
    seq: 9,
    privateKey
  })
  const observed = []
  const server = createServer((req, res) => {
    const bytes = built.packs[0].bytes
    observed.push(req.headers.range)
    if (!req.headers.range) {
      res.writeHead(200, { 'Content-Length': bytes.length })
      res.end(bytes)
      return
    }
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(req.headers.range).map(Number)
    res.writeHead(206, {
      'Content-Length': b - a + 1,
      'Content-Range': `bytes ${a}-${b}/${bytes.length}`
    })
    res.end(bytes.subarray(a, b + 1))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  const result = await stageRelease({
    ...applicability,
    manifest: built.manifest,
    publicKey,
    localRoots: [local],
    storeRoot: path.join(root, 'store'),
    baseUrl: `http://127.0.0.1:${server.address().port}/`
  })
  assert.ok(observed.length < 401)
  assert.ok(observed.every((r) => r?.startsWith('bytes=')))
  for (let i = 0; i < 401; i++)
    assert.equal(
      await fs.readFile(path.join(result.directory, `${i}.js`), 'utf8'),
      `export default ${i};`
    )
  assert.deepEqual(await fs.readFile(path.join(result.directory, 'bulk')), bulk)
  assert.ok(result.stats.downloadedBytes < built.packs[0].bytes.length)
})

test('completed objects survive interruption, corrupt cache is fetched again, and GC only removes cache', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ota-resume-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const input = path.join(root, 'input')
  await fs.mkdir(input)
  await fs.writeFile(path.join(input, 'a'), randomBytes(128))
  await fs.writeFile(path.join(input, 'b'), randomBytes(128))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const applicability = {
    hostRequirements: {},
    hostAbi: 'abi1',
    channel: 'nightly',
    platform: 'linux',
    arch: 'x64'
  }
  const built = await buildRelease({
    ...applicability,
    input,
    output: path.join(root, 'out'),
    release: 'r1',
    seq: 1,
    privateKey,
    maxPackBytes: 150
  })
  let requests = 0
  let interrupt = true
  const options = {
    ...applicability,
    manifest: built.manifest,
    publicKey,
    storeRoot: path.join(root, 'store'),
    baseUrl: 'https://synthetic.invalid/',
    fetchImpl: async (url) => {
      requests++
      if (interrupt && requests === 2) throw new Error('interrupted')
      const pack = built.packs.find((p) => url.pathname === '/' + p.path)
      return new Response(pack.bytes, { status: 200 })
    }
  }
  await assert.rejects(stageRelease(options), /interrupted/)
  await assertOnlyVerifiedCache(options.storeRoot, built.manifest)
  assert.equal((await fs.readdir(path.join(options.storeRoot, '.objects'))).length, 1)
  interrupt = false
  requests = 0
  const result = await stageRelease(options)
  assert.equal(requests, 1)
  requests = 0
  await stageRelease(options)
  assert.equal(requests, 0)
  const hash = built.manifest.tree[0].sha256
  await fs.writeFile(path.join(options.storeRoot, '.objects', hash), Buffer.alloc(128))
  await stageRelease({ ...options, cacheBytes: 0 })
  assert.equal(requests, 1)
  assert.deepEqual(await fs.readdir(path.join(options.storeRoot, '.objects')), [])
  assert.equal(sha256(await fs.readFile(path.join(result.directory, 'a'))), hash)
  interrupt = true
  requests = 0
  const failedStore = path.join(root, 'zero-budget')
  await assert.rejects(
    stageRelease({ ...options, storeRoot: failedStore, cacheBytes: 0 }),
    /interrupted/
  )
  await assertOnlyVerifiedCache(failedStore, built.manifest)
  assert.deepEqual(await fs.readdir(path.join(failedStore, '.objects')), [])
})

test('cache GC evicts least recently verified objects and protects active references', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ota-lru-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const objects = []
  for (const text of ['first', 'other', 'third']) {
    const bytes = Buffer.from(text)
    const hash = sha256(bytes)
    const file = await putObject(root, hash, bytes)
    await fs.utimes(file, new Date(1000), new Date(1000))
    objects.push({ hash, file })
  }
  await readObject(objects[0].file, objects[0].hash, 5, { now: () => 3000 })
  await collectObjects(root, new Set([objects[2].hash]), 10)
  await assert.rejects(fs.stat(objects[1].file), { code: 'ENOENT' })
  assert.equal((await fs.stat(objects[0].file)).mtimeMs, 3000)
  await assert.rejects(readObject(objects[0].file, objects[0].hash, 5, { maxBytes: 4 }), {
    code: 'INVALID_OBJECT'
  })
  await collectObjects(root, new Set(), 0)
  assert.deepEqual(await fs.readdir(root), [])
})

test('stream spool budgets and corrupt HTTP frames leave no partial files', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ota-stream-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const input = path.join(root, 'input')
  await fs.mkdir(input)
  await fs.writeFile(path.join(input, 'large'), randomBytes(512 * 1024))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const applicability = {
    hostRequirements: {},
    hostAbi: 'abi',
    channel: 'nightly',
    platform: 'linux',
    arch: 'x64'
  }
  const output = path.join(root, 'output')
  const { manifest } = await buildRelease({
    ...applicability,
    input,
    output,
    release: 'r',
    seq: 1,
    privateKey,
    returnPackBytes: false
  })
  assert.deepEqual((await fs.readdir(output)).sort(), ['manifest.json', 'packs'])
  let corrupt = false
  const server = createServer(async (req, res) => {
    const pack = await fs.readFile(path.join(output, manifest.packs[0].path))
    if (corrupt) pack[0] ^= 255
    res.writeHead(200, { 'Content-Length': pack.length }).end(pack)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}/`
  let clock = 0
  const options = { ...applicability, manifest, publicKey, baseUrl, now: () => ++clock }
  const storeRoot = path.join(root, 'store')
  await assert.rejects(stageRelease({ ...options, storeRoot, maxSpoolBytes: 1 }), /disk budget/)
  await assertOnlyVerifiedCache(storeRoot, manifest)
  corrupt = true
  await assert.rejects(stageRelease({ ...options, storeRoot }), /hash mismatch/)
  await assertOnlyVerifiedCache(storeRoot, manifest)
  corrupt = false
  const result = await stageRelease({ ...options, storeRoot })
  assert.equal(result.stats.usefulBytes + result.stats.wasteBytes, result.stats.downloadedBytes)
  assert.equal(result.stats.peakSpoolBytes, manifest.packs[0].size)
  assert.ok(result.stats.elapsedMs > 0)
  assert.deepEqual(
    await fs.readFile(path.join(result.directory, 'large')),
    await fs.readFile(path.join(input, 'large'))
  )
})

test('measured latency replans the next missing pack with a synthetic clock', async (t) => {
  const { zstdCompressSync } = await import('node:zlib')
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ota-plan-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const applicability = {
    hostRequirements: {},
    hostAbi: 'abi',
    channel: 'nightly',
    platform: 'linux',
    arch: 'x64'
  }
  const data = [randomBytes(1024), randomBytes(1024), randomBytes(1024)]
  const frames = data.map((b) => zstdCompressSync(b))
  const gap = Buffer.alloc(1024 * 1024)
  const bytes = [frames[0], Buffer.concat([frames[1], gap, frames[2]])]
  const packs = bytes.map((b, i) => ({
    sha256: sha256(b),
    size: b.length,
    path: `packs/${i}.pack`
  }))
  const tree = data.map((b, i) => ({ path: String(i), sha256: sha256(b), size: b.length }))
  const objects = Object.fromEntries(
    tree.map((f, i) => [
      f.sha256,
      {
        packSha256: packs[i ? 1 : 0].sha256,
        offset: i === 2 ? frames[1].length + gap.length : 0,
        length: frames[i].length,
        compressedSha256: sha256(frames[i])
      }
    ])
  )
  const manifest = signManifest(
    {
      ...applicability,
      schemaVersion: 2,
      releaseId: 'r',
      seq: 1,
      tree,
      objects,
      packs,
      patches: []
    },
    privateKey
  )
  const requests = []
  let clock = 0
  const fetchImpl = async (url, options) => {
    const i = Number(new URL(url).pathname.match(/(\d).pack/)[1])
    requests.push(options.headers.Range ?? 'full')
    clock += 100000
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes[i])
          controller.close()
        }
      }),
      { headers: { 'Content-Length': String(bytes[i].length) } }
    )
  }
  const result = await stageRelease({
    ...applicability,
    manifest,
    publicKey,
    storeRoot: path.join(root, 'store'),
    baseUrl: 'http://planner.test/',
    fetchImpl,
    now: () => clock++
  })
  assert.equal(requests.length, 2)
  assert.equal(
    requests[1],
    'full',
    'latency sample makes one complete pack cheaper than two ranges'
  )
  assert.equal(result.stats.wasteBytes, gap.length)
})

test('authenticated invalid zstd and output overflow clean decoder temporaries', async (t) => {
  const { zstdCompressSync } = await import('node:zlib')
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ota-decode-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const applicability = {
    hostRequirements: {},
    hostAbi: 'abi',
    channel: 'nightly',
    platform: 'linux',
    arch: 'x64'
  }
  let bytes
  const server = createServer((req, res) =>
    res.writeHead(200, { 'Content-Length': bytes.length }).end(bytes)
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  for (const [i, frame] of [
    Buffer.from('invalid-zstd'),
    zstdCompressSync(Buffer.alloc(1024))
  ].entries()) {
    bytes = frame
    const hash = sha256(Buffer.from('target'))
    const packHash = sha256(frame)
    const manifest = signManifest(
      {
        ...applicability,
        schemaVersion: 2,
        releaseId: 'r',
        seq: 1,
        tree: [{ path: 'file', sha256: hash, size: 6 }],
        packs: [{ sha256: packHash, path: 'packs/a.pack', size: frame.length }],
        objects: {
          [hash]: {
            packSha256: packHash,
            offset: 0,
            length: frame.length,
            compressedSha256: packHash
          }
        },
        patches: []
      },
      privateKey
    )
    const storeRoot = path.join(root, String(i))
    await assert.rejects(
      stageRelease({
        ...applicability,
        manifest,
        publicKey,
        storeRoot,
        baseUrl: `http://127.0.0.1:${server.address().port}/`
      })
    )
    await assertOnlyVerifiedCache(storeRoot, manifest)
  }
})

test('multiple packs recycle disk spool within a one-pack budget', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ota-recycle-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const input = path.join(root, 'input')
  await fs.mkdir(input)
  for (let i = 0; i < 4; i++) await fs.writeFile(path.join(input, String(i)), randomBytes(1024))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const applicability = {
    hostRequirements: {},
    hostAbi: 'abi',
    channel: 'nightly',
    platform: 'linux',
    arch: 'x64'
  }
  const output = path.join(root, 'output')
  const { manifest } = await buildRelease({
    ...applicability,
    input,
    output,
    release: 'r',
    seq: 1,
    privateKey,
    maxPackBytes: 1100,
    returnPackBytes: false
  })
  assert.equal(manifest.packs.length, 4)
  const storeRoot = path.join(root, 'store')
  await fs.mkdir(storeRoot)
  const orphans = ['.download-Ab12xy', '.stage-Z987ab']
  const preserved = ['.download-unrelated', '.stage-1234567', 'release-123', 'a'.repeat(64)]
  for (const name of [...orphans, ...preserved]) {
    await fs.mkdir(path.join(storeRoot, name))
    await fs.writeFile(path.join(storeRoot, name, 'sentinel'), 'preserve or reap')
  }
  await fs.symlink(input, path.join(storeRoot, '.download-Link12'), 'dir')
  const remainingFiles = []
  const server = createServer(async (req, res) => {
    const spool = (await fs.readdir(storeRoot)).find(
      (name) => /^\.download-[a-zA-Z0-9]{6}$/.test(name) && name !== '.download-Link12'
    )
    remainingFiles.push((await fs.readdir(path.join(storeRoot, spool))).length)
    const bytes = await fs.readFile(path.join(output, req.url))
    res.writeHead(200, { 'Content-Length': bytes.length }).end(bytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const result = await stageRelease({
    ...applicability,
    manifest,
    publicKey,
    storeRoot,
    maxSpoolBytes: 1100,
    baseUrl: `http://127.0.0.1:${server.address().port}/`
  })
  assert.deepEqual(remainingFiles, [0, 0, 0, 0])
  for (const name of orphans)
    await assert.rejects(fs.lstat(path.join(storeRoot, name)), { code: 'ENOENT' })
  for (const name of preserved)
    assert.equal(
      await fs.readFile(path.join(storeRoot, name, 'sentinel'), 'utf8'),
      'preserve or reap'
    )
  assert.ok((await fs.lstat(path.join(storeRoot, '.download-Link12'))).isSymbolicLink())

  assert.equal(result.stats.peakSpoolBytes, Math.max(...manifest.packs.map((p) => p.size)))
  assert.equal(result.stats.planModes.full, 4)
  assert.equal(result.stats.wasteBytes, 0)
  assert.equal(
    (await fs.readdir(storeRoot)).some(
      (name) => /^\.download-[a-zA-Z0-9]{6}$/.test(name) && name !== '.download-Link12'
    ),
    false
  )
  for (const entry of manifest.tree)
    assert.equal(sha256(await fs.readFile(path.join(result.directory, entry.path))), entry.sha256)
})

test('latency switches remaining cross-pack patches to consolidated objects before decode', async (t) => {
  const { zstdCompressSync } = await import('node:zlib')
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ota-mode-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const base = randomBytes(1024 * 1024)
  const targets = [Buffer.from(base), Buffer.from(base)]
  targets[0][0] ^= 1
  targets[1][1] ^= 1
  const data = [randomBytes(1024), ...targets]
  const compressed = data.map((bytes) => zstdCompressSync(bytes))
  const patchFrames = targets.map((bytes) => zstdCompressSync(bytes, { dictionary: base }))
  const bodies = [
    Buffer.concat([compressed[0], Buffer.alloc(1024)]),
    Buffer.concat([compressed[1], compressed[2], Buffer.alloc(1024)]),
    ...patchFrames
  ]
  const packs = bodies.map((bytes, i) => ({
    sha256: sha256(bytes),
    size: bytes.length,
    path: `packs/${i}.pack`
  }))
  const tree = data.map((bytes, i) => ({
    path: String(i),
    size: bytes.length,
    sha256: sha256(bytes)
  }))
  const objects = Object.fromEntries(
    tree.map((f, i) => [
      f.sha256,
      {
        packSha256: packs[i ? 1 : 0].sha256,
        offset: i === 2 ? compressed[1].length : 0,
        length: compressed[i].length,
        compressedSha256: sha256(compressed[i])
      }
    ])
  )
  const patches = patchFrames.map((bytes, i) => ({
    fromSha256: sha256(base),
    toSha256: tree[i + 1].sha256,
    packSha256: packs[i + 2].sha256,
    offset: 0,
    length: bytes.length,
    compressedSha256: sha256(bytes)
  }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const applicability = {
    hostRequirements: {},
    hostAbi: 'abi',
    channel: 'nightly',
    platform: 'linux',
    arch: 'x64'
  }
  const manifest = signManifest(
    { ...applicability, schemaVersion: 2, releaseId: 'r', seq: 1, tree, packs, objects, patches },
    privateKey
  )
  const local = path.join(root, 'local')
  await fs.mkdir(local)
  await fs.writeFile(path.join(local, 'base'), base)
  let clock = 0
  const requests = []
  const fetchImpl = async (url, options) => {
    const i = Number(new URL(url).pathname.match(/(\d).pack/)[1])
    requests.push(i)
    clock += 100000
    const range = options.headers.Range?.match(/bytes=(\d+)-(\d+)/)
    const start = range ? Number(range[1]) : 0,
      end = range ? Number(range[2]) + 1 : bodies[i].length
    return new Response(bodies[i].subarray(start, end), {
      status: range ? 206 : 200,
      headers: {
        'Content-Length': String(end - start),
        ...(range ? { 'Content-Range': `bytes ${start}-${end - 1}/${bodies[i].length}` } : {})
      }
    })
  }
  const result = await stageRelease({
    ...applicability,
    manifest,
    publicKey,
    storeRoot: path.join(root, 'store'),
    localRoots: [local],
    baseUrl: 'http://mode-switch.test/',
    fetchImpl,
    maxSpoolBytes: compressed[1].length + compressed[2].length,
    now: () => clock++
  })
  assert.deepEqual(requests, [0, 1])
  assert.equal(result.stats.planModes.mixed, 1)
  assert.equal(result.stats.planModes.object, 1)
  assert.ok(result.stats.peakSpoolBytes <= compressed[1].length + compressed[2].length)
  for (const entry of tree)
    assert.equal(sha256(await fs.readFile(path.join(result.directory, entry.path))), entry.sha256)
})
