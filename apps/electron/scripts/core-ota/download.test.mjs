import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { buildRelease } from './build.mjs'
import { signManifest, sha256 } from './protocol.mjs'
import { stageRelease } from './download.mjs'

test('signed build stages 401 files, reuses content across skipped releases and isolates HTTP failures', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ota-test-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const input = path.join(root, 'input')
  await fs.mkdir(input)
  for (let i = 0; i < 401; i++)
    await fs.writeFile(path.join(input, `${i}.js`), `export default ${i % 7};`)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const applicability = { hostAbi: 'abi1', channel: 'nightly', platform: 'linux', arch: 'x64' }
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
  assert.deepEqual(await fs.readdir(cancelledStore), [])
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
    assert.deepEqual(await fs.readdir(storeRoot), [])
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
  const applicability = { hostAbi: 'abi1', channel: 'nightly', platform: 'linux', arch: 'x64' }
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
  const applicability = { hostAbi: 'abi', channel: 'nightly', platform: 'linux', arch: 'x64' }
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
