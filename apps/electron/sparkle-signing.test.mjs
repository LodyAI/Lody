import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  validateSparkleKeyPair,
  verifySparkleOutputs,
  verifySparkleSigningProof
} from './sparkle-signing.mjs'

function keys(byte = 7) {
  const seed = Buffer.alloc(32, byte)
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8'
  })
  const publicBytes = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
  return { seed, privateKey, publicBytes, publicKey: publicBytes.toString('base64') }
}

void test('release preflight proves a seed export belongs to the configured public key', () => {
  const key = keys()
  assert.deepEqual(
    validateSparkleKeyPair({ privateKey: key.seed.toString('base64'), publicKey: key.publicKey }),
    { format: 'seed32', requiresSigningProof: false }
  )
  assert.throws(
    () =>
      validateSparkleKeyPair({
        privateKey: keys(8).seed.toString('base64'),
        publicKey: key.publicKey
      }),
    /key pair does not match/u
  )
})

void test('legacy exports never claim cryptographic proof from their public suffix alone', () => {
  const key = keys()
  const legacy = Buffer.concat([Buffer.alloc(64), key.publicBytes]).toString('base64')
  assert.deepEqual(validateSparkleKeyPair({ privateKey: legacy, publicKey: key.publicKey }), {
    format: 'legacy96',
    requiresSigningProof: true
  })
  assert.throws(
    () => validateSparkleKeyPair({ privateKey: legacy, publicKey: keys(8).publicKey }),
    /key pair does not match/u
  )
})

void test('malformed signing secrets fail without revealing key material', () => {
  const key = keys()
  for (const privateKey of [
    Buffer.alloc(64).toString('base64'),
    `${key.seed.toString('base64')}!`,
    'PRIVATE-SECRET'
  ]) {
    assert.throws(
      () => validateSparkleKeyPair({ privateKey, publicKey: key.publicKey }),
      (error) => {
        assert.match(error.message, /Invalid Sparkle private key/u)
        assert.ok(!error.message.includes(privateKey))
        return true
      }
    )
  }
})

void test('an actual Sparkle signing challenge must verify under the shipped public key', () => {
  const key = keys()
  const archive = Buffer.from('challenge bytes')
  const signingOutput = `sparkle:edSignature="${sign(null, archive, key.privateKey).toString('base64')}" length="${archive.length}"`
  assert.equal(
    verifySparkleSigningProof({ archive, signingOutput, publicKey: key.publicKey }),
    true
  )
  assert.throws(
    () => verifySparkleSigningProof({ archive, signingOutput, publicKey: keys(8).publicKey }),
    /signature verification failed/u
  )
})

async function fixture(t) {
  const archiveDirectory = await mkdtemp(path.join(tmpdir(), 'sparkle-signing-'))
  t.after(() => rm(archiveDirectory, { force: true, recursive: true }))
  const key = keys()
  const base = 'https://updates.example.com/production/arm64/'
  const enclosure = async (filename) => {
    const bytes = Buffer.from(`release bytes for ${filename}`)
    await writeFile(path.join(archiveDirectory, filename), bytes)
    return `<enclosure url="${base}${encodeURIComponent(filename)}" sparkle:edSignature="${sign(null, bytes, key.privateKey).toString('base64')}" length="${bytes.length}" />`
  }
  const current = await enclosure('Lody-2-arm64.zip')
  const delta = await enclosure('Lody Nightly2-1.delta')
  const history = await enclosure('Lody-1-arm64.zip')
  const xml = `<rss><channel><item><sparkle:version>2</sparkle:version><sparkle:shortVersionString>2.0.0</sparkle:shortVersionString>${current}<sparkle:deltas>${delta}</sparkle:deltas></item><item><sparkle:version>1</sparkle:version><sparkle:shortVersionString>1.0.0</sparkle:shortVersionString>${history}</item></channel></rss>`
  return {
    xml,
    archiveDirectory,
    appcastUrl: `${base}appcast.xml`,
    currentFilename: 'Lody-2-arm64.zip',
    currentVersion: '2.0.0',
    currentBuildVersion: '2',
    publicKey: key.publicKey
  }
}

void test('publication verifies the current ZIP, every delta and retained historical archives', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await verifySparkleOutputs(f), [
    'Lody-2-arm64.zip',
    'Lody Nightly2-1.delta',
    'Lody-1-arm64.zip'
  ])
})

for (const filename of ['Lody-2-arm64.zip', 'Lody Nightly2-1.delta', 'Lody-1-arm64.zip']) {
  void test(`publication rejects tampering in ${filename}`, async (t) => {
    const f = await fixture(t)
    await writeFile(
      path.join(f.archiveDirectory, filename),
      Buffer.from(`release bytes for ${filename}`).fill(0)
    )
    await assert.rejects(verifySparkleOutputs(f), /signature verification failed/u)
  })
}

for (const filename of [
  '../escape.zip',
  '%2e%2e%2fescape.zip',
  'Lody%2F..%2Fescape.zip',
  'nested/Lody-2-arm64.zip',
  'Lody-2-arm64.zip?other=1',
  'Lody-2-arm64.zip#fragment'
]) {
  void test(`publication rejects enclosure path substitution ${filename}`, async (t) => {
    const f = await fixture(t)
    f.xml = f.xml.replace('Lody-2-arm64.zip', filename)
    await assert.rejects(
      verifySparkleOutputs(f),
      /outside the configured update directory|current release/u
    )
  })
}

void test('publication rejects cross-environment URLs and incorrect artifact lengths', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    verifySparkleOutputs({ ...f, xml: f.xml.replace('updates.example.com', 'other.example.com') }),
    /outside the configured update directory/u
  )
  await assert.rejects(
    verifySparkleOutputs({ ...f, xml: f.xml.replace(/length="[0-9]+"/u, 'length="1"') }),
    /length does not match/u
  )
})

void test('publication binds the current release to exactly one expected filename, display and build', async (t) => {
  const f = await fixture(t)
  for (const overrides of [
    { currentFilename: 'wrong.zip' },
    { currentVersion: '3.0.0' },
    { currentBuildVersion: '3' }
  ]) {
    await assert.rejects(
      verifySparkleOutputs({ ...f, ...overrides }),
      /current release filename\/version\/build does not match/u
    )
  }
  const currentItem = f.xml.match(/<item>[\s\S]*?<\/item>/u)[0]
  await assert.rejects(
    verifySparkleOutputs({ ...f, xml: f.xml.replace('</channel>', `${currentItem}</channel>`) }),
    /Duplicate Sparkle enclosure/u
  )
  await assert.rejects(
    verifySparkleOutputs({ ...f, xml: f.xml.replace(currentItem, '') }),
    /exactly one current release/u
  )
})

void test('publication rejects omitted generated deltas and symlinked release artifacts', async (t) => {
  const f = await fixture(t)
  const extra = path.join(f.archiveDirectory, 'unreferenced.delta')
  await writeFile(extra, 'unsigned delta')
  await assert.rejects(verifySparkleOutputs(f), /absent from appcast/u)
  await rm(extra)
  const current = path.join(f.archiveDirectory, f.currentFilename)
  await rm(current)
  await symlink(path.join(f.archiveDirectory, 'Lody-1-arm64.zip'), current)
  await assert.rejects(verifySparkleOutputs(f), /not a regular file/u)
})

void test('retained remote history does not require downloading archives beyond delta bases', async (t) => {
  const f = await fixture(t)
  await rm(path.join(f.archiveDirectory, 'Lody-1-arm64.zip'))
  assert.deepEqual(await verifySparkleOutputs(f), ['Lody-2-arm64.zip', 'Lody Nightly2-1.delta'])
})

for (const filename of ['Lody-2-arm64.zip', 'Lody Nightly2-1.delta']) {
  void test(`publication requires current release bytes for ${filename}`, async (t) => {
    const f = await fixture(t)
    await rm(path.join(f.archiveDirectory, filename))
    await assert.rejects(verifySparkleOutputs(f), { code: 'ENOENT' })
  })
}
