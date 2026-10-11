import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Run against the actual unpacked package, so relative Worker/addon paths and
// SQLite persistence are checked under the packaged Electron Node runtime.
export async function probeRoostRuntime(packageDir) {
  const { RoostNativeClient } = await import(
    pathToFileURL(path.join(packageDir, 'client.mjs')).href
  )
  const seed = new Uint8Array(32).fill(17)
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8'
  })
  const owner = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)
  const directory = await mkdtemp(path.join(tmpdir(), 'lody-roost-probe-'))
  const options = {
    dbPath: path.join(directory, 'history.db'),
    seed,
    allowedOwners: [owner],
    clockMs: 1700000000000n,
    maxQueuedRequests: 8,
    maxQueuedBytes: 4096
  }
  let client
  try {
    client = new RoostNativeClient(options)
    await client.ready
    const stream = client.stream('packaging-probe')
    const content = '{"text":"packaged Roost history"}'
    const id = (await stream.create([], content)).updates[0].turnId
    await stream.seal(id, 1n)
    await client.close()
    assert.deepEqual(await client.exited, { code: 0, signal: null })
    client = new RoostNativeClient(options)
    await client.ready
    const result = await client.stream('packaging-probe').readTurn(id)
    assert.equal(result.kind, 'found')
    assert.equal(result.turn.contentJson, content)
    assert.equal(result.turn.hashVerified, true)
    assert.equal(result.turn.nextSeq, 2n)
  } finally {
    await client?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Expected the unpacked Roost package directory')
  await probeRoostRuntime(path.resolve(process.argv[2]))
  console.log('roost-binding-ok')
}
