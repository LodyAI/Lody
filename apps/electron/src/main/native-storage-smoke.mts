// Built in the SAME main-process graph as application.ts. Never compile this
// separately: that would miss the application's inlined native loaders.
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Effect, Layer, Result } from 'effect'
import { Bytes } from '@lody/e2ee-core/protocol'
import { LedgerPinStore, WorkspaceScope } from '@lody/e2ee-core/services'
import { sqliteLedgerPinStore } from '@lody/e2ee-core/adapters/node-sqlite'
import { makeNodeE2eeCustody } from '@lody/e2ee-core/adapters/node-custody'

/** Packaged main's native loaders, real SQLite persistence and encrypted custody.
 * Uses synthetic state in a fresh directory; this is not an OS-keychain probe. */
export async function runNativeStorageSmoke(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'lody-main-storage-smoke-'))
  const wrappingKey = randomBytes(32)
  const genesis = Result.getOrThrow(Bytes.genesisHash(new Uint8Array(32).fill(17)))
  const head = Result.getOrThrow(Bytes.recordHash(new Uint8Array(32).fill(23)))
  // Authenticated synthetic wrapper, never a production custody selection.
  const wrapper = {
    protection: 'file' as const,
    wrap: async (value: string) => {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce)
      return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()])
    },
    unwrap: async (value: Uint8Array) => {
      const cipher = createDecipheriv('aes-256-gcm', wrappingKey, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(-16))
      return {
        result: Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString(),
        shouldReEncrypt: false
      }
    }
  }
  const ledger = (mode: 'create' | 'open') =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          sqliteLedgerPinStore({ path: join(directory, 'pin.sqlite'), mode }).pipe(
            Layer.provide(Layer.succeed(WorkspaceScope, { genesis }))
          )
        )
        const store = Context.get(context, LedgerPinStore)
        if (mode === 'create') {
          assert.equal(yield* store.read(), null)
          yield* store.write({ head, length: 7 })
        }
        const saved = yield* store.read()
        assert.ok(saved)
        assert.ok(saved.head.equals(head))
        assert.equal(saved.length, 7)
      })
    )
  try {
    await Effect.runPromise(ledger('create'))
    await Effect.runPromise(ledger('open'))
    const deviceKey = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* makeNodeE2eeCustody({
            directory: join(directory, 'custody'),
            wrapper
          })
          const device = yield* owner.createDevice(genesis, 'machine')
          return device.publicKey.toBytes()
        })
      )
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* makeNodeE2eeCustody({
            directory: join(directory, 'custody'),
            wrapper
          })
          const device = yield* owner.openDevice(genesis, 'machine')
          assert.deepEqual(device.publicKey.toBytes(), deviceKey)
          assert.equal(device.encryption.privateKey.extractable, false)
        })
      )
    )
  } finally {
    wrappingKey.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
}
