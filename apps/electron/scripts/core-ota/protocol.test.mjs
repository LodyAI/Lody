import { computeHostBuildId } from './host-build.mjs'
import { HOST_ABI, assertHostCompatible } from './compatibility.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { buildRelease, buildDesktopRelease } from './build.mjs'
import {
  canonicalJson,
  sha256,
  signManifest,
  verifyManifest,
  validateManifest
} from './protocol.mjs'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'core-ota-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'input')
  await mkdir(input)
  await writeFile(join(input, 'main.js'), 'export const version = 5;')
  await writeFile(join(input, 'renamed.js'), 'export const version = 5;')
  await writeFile(join(input, 'empty'), '')
  const options = {
    input,
    output: join(root, 'out'),
    release: 'r5',
    seq: 5,
    channel: 'nightly',
    platform: 'darwin',
    arch: 'arm64',
    hostAbi: 'abi1',
    hostRequirements: {},
    privateKey
  }
  return { root, input, options, ...(await buildRelease(options)) }
}
test('signed complete target reconstructs independently and deduplicates renamed contents', async (t) => {
  const f = await fixture(t)
  assert.equal(verifyManifest(f.manifest, publicKey), f.manifest)
  assert.equal(Object.keys(f.manifest.objects).length, 2)
  for (const item of f.manifest.tree) {
    const frame = f.manifest.objects[item.sha256],
      pack = f.packs.find((p) => sha256(p.bytes) === frame.packSha256)
    const compressed = pack.bytes.subarray(frame.offset, frame.offset + frame.length)
    assert.equal(sha256(compressed), frame.compressedSha256)
    const decoded = zstdDecompressSync(compressed, { maxOutputLength: 256 * 2 ** 20 })
    assert.equal(decoded.length, item.size)
    assert.equal(sha256(decoded), item.sha256)
  }
  const again = await buildRelease({ ...f.options, output: join(f.root, 'again') })
  assert.equal(canonicalJson(again.manifest), canonicalJson(f.manifest))
  assert.deepEqual(again.packs, f.packs)
})
test('signed metadata and frame tampering cannot pass authentication', async (t) => {
  const f = await fixture(t)
  for (const mutate of [
    (m) => m.seq++,
    (m) => (m.hostAbi = 'other'),
    (m) => (m.tree[0].sha256 = '0'.repeat(64)),
    (m) => (m.objects[Object.keys(m.objects)[0]].compressedSha256 = '0'.repeat(64)),
    (m) => (m.signature = 'A'.repeat(86) + '==')
  ]) {
    const m = structuredClone(f.manifest)
    mutate(m)
    assert.throws(() => verifyManifest(m, publicKey))
  }
  const altered = Buffer.from(f.packs[0].bytes)
  altered[0] ^= 1
  assert.notEqual(sha256(altered), f.manifest.packs[0].sha256)
  assert.throws(() => verifyManifest(f.manifest, generateKeyPairSync('ed25519').publicKey))
})
test('unsafe trees, missing fallback, overlaps and unbounded indices are rejected before signing', async (t) => {
  const { manifest } = await fixture(t)
  for (const p of ['../escape', '/root', 'C:/x', 'a\\b', 'CON.txt', 'trailing.', 'e\u0301']) {
    const m = structuredClone(manifest)
    m.tree[0].path = p
    assert.throws(() => signManifest(m, privateKey))
  }
  for (const mutate of [
    (m) => (m.tree[1].path = m.tree[0].path.toUpperCase()),
    (m) => (m.tree[1].path = m.tree[0].path + '/child'),
    (m) => delete m.objects[m.tree[0].sha256],
    (m) => (m.seq = Number.MAX_SAFE_INTEGER + 1),
    (m) => (m.unknown = true),
    (m) => {
      Object.values(m.objects)[1].offset = 0
    },
    (m) => (m.tree[0].size = -1)
  ]) {
    const m = structuredClone(manifest)
    mutate(m)
    assert.throws(() => validateManifest(m))
  }
})
test('builder refuses symlinks and output nested in input', async (t) => {
  const f = await fixture(t)
  await symlink(join(f.input, 'main.js'), join(f.input, 'link'))
  await assert.rejects(buildRelease({ ...f.options, output: join(f.root, 'bad') }), /Symlinks/)
  await assert.rejects(buildRelease({ ...f.options, output: join(f.input, 'out') }), /outside/)
})
test('CLI signs disk artifacts using a PEM key without printing it', async (t) => {
  const f = await fixture(t)
  const { execFileSync } = await import('node:child_process')
  const { readFile } = await import('node:fs/promises')
  const keyFile = join(f.root, 'key.pem')
  await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const requirementsFile = join(f.root, 'requirements.json')
  await writeFile(requirementsFile, '{}')
  const output = join(f.root, 'cli')
  const result = execFileSync(
    process.execPath,
    [
      new URL('./build.mjs', import.meta.url).pathname,
      '--input',
      f.input,
      '--output',
      output,
      '--release',
      'r5',
      '--seq',
      '5',
      '--channel',
      'nightly',
      '--platform',
      'darwin',
      '--arch',
      'arm64',
      '--host-abi',
      'abi1',
      '--host-requirements',
      requirementsFile,
      '--key-file',
      keyFile
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result, '')
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
  verifyManifest(manifest, publicKey)
  for (const pack of manifest.packs)
    assert.equal(sha256(await readFile(join(output, pack.path))), pack.sha256)
})
test('dictionary patch is smaller, replays exact target, retains full fallback and retries idempotently', async (t) => {
  const f = await fixture(t),
    previousInput = join(f.root, 'previous')
  await mkdir(previousInput)
  const base = Buffer.from(
    Array.from(
      { length: 12000 },
      (_, i) => `export const item${i} = {label: "resource ${sha256(String(i))}", enabled: true};\n`
    ).join('')
  )
  const target = Buffer.from(base)
  target.write('false', 1000)
  await writeFile(join(previousInput, 'main.js'), base)
  await writeFile(join(f.input, 'main.js'), target)
  const options = { ...f.options, previousInput, output: join(f.root, 'patched') }
  const result = await buildRelease(options)
  const patch = result.manifest.patches.find((p) => p.toSha256 === sha256(target))
  assert.ok(patch)
  const full = result.manifest.objects[patch.toSha256]
  assert.ok(patch.length + 256 < full.length)
  const bytes = result.packs[0].bytes.subarray(patch.offset, patch.offset + patch.length)
  assert.equal(patch.fromSha256, sha256(base))
  assert.equal(sha256(bytes), patch.compressedSha256)
  assert.deepEqual(
    zstdDecompressSync(bytes, { dictionary: base, maxOutputLength: target.length }),
    target
  )
  const fallback = result.packs[0].bytes.subarray(full.offset, full.offset + full.length)
  assert.deepEqual(zstdDecompressSync(fallback), target)
  assert.equal(
    canonicalJson((await buildRelease(options)).manifest),
    canonicalJson(result.manifest)
  )
  await assert.rejects(buildRelease({ ...options, seq: 6 }), /Existing output differs/)
})

test('budget-split disk packs reconstruct the signed target without returned buffers', async (t) => {
  const f = await fixture(t)
  const output = join(f.root, 'split')
  const result = await buildRelease({
    ...f.options,
    output,
    maxPackBytes: 40,
    returnPackBytes: false
  })
  assert.ok(result.manifest.packs.length > 1)
  verifyManifest(result.manifest, publicKey)
  for (const pack of result.packs) assert.equal(pack.bytes, undefined)
  for (const item of result.manifest.tree) {
    const frame = result.manifest.objects[item.sha256]
    const pack = result.manifest.packs.find((p) => p.sha256 === frame.packSha256)
    assert.ok(pack.size <= 40)
    const bytes = await readFile(join(output, pack.path))
    assert.equal(sha256(bytes), pack.sha256)
    const compressed = bytes.subarray(frame.offset, frame.offset + frame.length)
    assert.equal(sha256(compressed), frame.compressedSha256)
    assert.equal(sha256(zstdDecompressSync(compressed)), item.sha256)
  }
  await assert.rejects(
    buildRelease({ ...f.options, output: join(f.root, 'tiny'), maxPackBytes: 1 }),
    /Frame exceeds/
  )
})

test('desktop publisher retains nested Core closure under out and excludes Host-only artifacts', async (t) => {
  const f = await fixture(t)
  const out = join(f.root, 'desktop')
  await mkdir(join(out, 'main', 'deps'), { recursive: true })
  await mkdir(join(out, 'preload'))
  await mkdir(join(out, 'renderer'))
  await writeFile(join(out, 'main', 'application.js'), "import './deps/shared.js'")
  await writeFile(join(out, 'main', 'deps', 'shared.js'), 'export const shared = 1')
  await writeFile(join(out, 'main', 'host.js'), 'host only')
  await writeFile(join(out, 'main', 'window.js'), 'export {}')
  for (const name of ['devbar', 'pr-image', 'recovery'])
    await writeFile(join(out, 'renderer', `${name}.html`), '<html></html>')
  await writeFile(
    join(out, 'main', 'core-artifacts.json'),
    JSON.stringify({
      version: 1,
      hostAbi: 'abi1',
      hostRequirements: {},
      main: ['application.js', 'deps/shared.js', 'window.js']
    })
  )
  await writeFile(join(out, 'preload', 'index.js'), 'preload')
  await writeFile(join(out, 'renderer', 'index.html'), '<html></html>')
  const { input, ...options } = f.options
  const result = await buildDesktopRelease({
    ...options,
    output: join(f.root, 'published'),
    buildOutput: out
  })
  // Missing resources must fail before any signed release is published.
  for (const resource of ['main/window.js', 'renderer/recovery.html']) {
    const file = join(out, resource)
    const bytes = await readFile(file)
    await rm(file)
    const output = join(f.root, `missing-${resource.replaceAll('/', '-')}`)
    await assert.rejects(buildDesktopRelease({ ...options, output, buildOutput: out }), {
      code: 'ENOENT'
    })
    await assert.rejects(stat(output), { code: 'ENOENT' })
    await writeFile(file, bytes)
  }
  verifyManifest(result.manifest, publicKey)
  assert.deepEqual(
    result.manifest.tree.map((entry) => entry.path),
    [
      'out/main/application.js',
      'out/main/deps/shared.js',
      'out/main/window.js',
      'out/preload/index.js',
      'out/renderer/devbar.html',
      'out/renderer/index.html',
      'out/renderer/pr-image.html',
      'out/renderer/recovery.html'
    ]
  )
  for (const entry of result.manifest.tree) {
    const frame = result.manifest.objects[entry.sha256]
    const pack = result.packs.find((p) => sha256(p.bytes) === frame.packSha256)
    assert.equal(
      sha256(zstdDecompressSync(pack.bytes.subarray(frame.offset, frame.offset + frame.length))),
      entry.sha256
    )
  }
})

test('Host build changes do not alter signed Core capability eligibility', async (t) => {
  const f = await fixture(t)
  const host = {
    hostAbi: HOST_ABI,
    channel: 'nightly',
    platform: 'darwin',
    arch: 'arm64',
    hostCapabilities: {
      electron: '44.9.3',
      node: '24.22.0',
      nodeApi: '10.0.0',
      'packages/native-fixture': '13.0.3'
    }
  }
  const target = signManifest(
    {
      ...f.manifest,
      hostAbi: HOST_ABI,
      hostRequirements: {
        electron: { minimum: '44.0.0', before: '45.0.0' },
        node: { minimum: '24.0.0', before: '25.0.0' },
        nodeApi: { minimum: '10.0.0', before: null },
        'packages/native-fixture': { minimum: '13.0.0', before: '14.0.0' }
      }
    },
    privateKey
  )
  const metadataFile = join(f.input, 'core-ota-host.json')
  const first = await computeHostBuildId(f.input, metadataFile, host)
  await writeFile(join(f.input, 'unrelated-icon'), 'different renderer/icon/lock content')
  const second = await computeHostBuildId(f.input, metadataFile, {
    ...host,
    feedUrl: 'https://another.example/feed'
  })
  assert.notEqual(first, second)
  assertHostCompatible(verifyManifest(target, publicKey), { ...host, hostBuildId: first })
  assertHostCompatible(target, {
    ...host,
    hostBuildId: second,
    hostCapabilities: {
      ...host.hostCapabilities,
      electron: '44.10.0',
      'packages/native-fixture': '13.1.0'
    }
  })
  for (const patch of [
    { hostAbi: 'lody.core-host.v2' },
    { hostCapabilities: { ...host.hostCapabilities, electron: '45.0.0' } },
    { hostCapabilities: { ...host.hostCapabilities, nodeApi: '9.0.0' } },
    { hostCapabilities: { ...host.hostCapabilities, 'packages/native-fixture': '14.0.0' } },
    { hostCapabilities: {} }
  ])
    assert.throws(() => assertHostCompatible(target, { ...host, ...patch }), /Incompatible/)
  assert.throws(() => verifyManifest({ ...target, hostRequirements: {} }, publicKey), /signature/i)
})
