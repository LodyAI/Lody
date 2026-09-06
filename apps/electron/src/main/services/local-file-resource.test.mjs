import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm, open, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFileResources } from './local-file-resource.ts'

async function fixture(t, name, content) {
  const dir = await mkdtemp(join(tmpdir(), 'lody-resource-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, name)
  await writeFile(path, content)
  return { status: 'local-file', path: name, absolutePath: path, external: false }
}

void test('small UTF-8 documents retain full content and a save-compatible digest', async (t) => {
  const file = await fixture(t, 'small.txt', '\ufeff中文\r\n')
  const result = await new LocalFileResources().preview(1, file)
  assert.equal(result.status, 'ok')
  assert.equal(result.content.text, '\ufeff中文\r\n')
  assert.deepEqual(result.format, { bom: true, eol: 'crlf' })
  assert.match(result.digest, /^sha256:[0-9a-f]{64}$/)
})

void test('a multi-gigabyte sparse file opens as a resource and only requested bytes are returned', async (t) => {
  const file = await fixture(t, 'large.txt', 'header\n'.repeat(1200))
  const handle = await open(file.absolutePath, 'r+')
  await handle.truncate(3 * 1024 ** 3)
  await handle.write(Buffer.from('tail'), 0, 4, 3 * 1024 ** 3 - 4)
  await handle.close()
  const resources = new LocalFileResources()
  const result = await resources.preview(1, file)
  assert.equal(result.status, 'resource')
  assert.equal(result.kind, 'text')
  assert.equal(result.sizeBytes, 3 * 1024 ** 3)
  assert.equal((await resources.respond(new Request(result.url))).status, 416)
  const response = await resources.respond(
    new Request(result.url, { headers: { Range: `bytes=${result.sizeBytes - 4}-` } })
  )
  assert.equal(response.status, 206)
  assert.equal(await response.text(), 'tail')
  const excessive = await resources.respond(
    new Request(result.url, { headers: { Range: 'bytes=0-1000000' } })
  )
  assert.equal(excessive.status, 416)
})

void test('binary resources stream raw bytes, support ranges, and expire with their owner', async (t) => {
  const bytes = syntheticPng(1024 * 1024)
  const file = await fixture(t, 'image.png', bytes)
  const resources = new LocalFileResources()
  const result = await resources.preview(8, file)
  assert.equal(result.status, 'resource')
  assert.equal(result.kind, 'binary')
  const response = await resources.respond(
    new Request(result.url, { headers: { Range: 'bytes=10-19' } })
  )
  assert.equal(response.status, 206)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(10, 20))
  assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox")
  resources.releaseOwner(9)
  assert.equal((await resources.respond(new Request(result.url, { method: 'HEAD' }))).status, 200)
  resources.releaseOwner(8)
  assert.equal((await resources.respond(new Request(result.url))).status, 404)
})

void test('replacing a file invalidates every existing resource URL', async (t) => {
  const file = await fixture(t, 'large.txt', 'a'.repeat(600_000))
  const resources = new LocalFileResources()
  const result = await resources.preview(1, file)
  await writeFile(file.absolutePath + '.new', 'b'.repeat(600_000))
  await rename(file.absolutePath + '.new', file.absolutePath)
  assert.equal(
    (await resources.respond(new Request(result.url, { headers: { Range: 'bytes=0-10' } }))).status,
    409
  )
})

void test('cancelling a binary stream releases it without reading the remaining file', async (t) => {
  const file = await fixture(t, 'image.png', syntheticPng(1024 * 1024))
  const resources = new LocalFileResources()
  const result = await resources.preview(1, file)
  const response = await resources.respond(new Request(result.url))
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(first.value.length, 64 * 1024)
  await reader.cancel()
  assert.equal((await reader.read()).done, true)
})

function syntheticPng(length, width = 16, height = 16) {
  const bytes = Buffer.alloc(length)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

void test('image decode budget is based on dimensions, not encoded file length', async (t) => {
  const file = await fixture(t, 'huge.png', syntheticPng(32, 32768, 32768))
  const result = await new LocalFileResources().preview(1, file)
  assert.equal(result.status, 'error')
  assert.equal(result.code, 'too_large')
  assert.match(result.message, /dimensions/)
})
