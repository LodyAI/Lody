import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Effect, Exit, Result, Scope } from 'effect'
import { decodeRecoveryVaultCiphertext } from '@lody/e2ee-core/host'
import { vaultCiphertextDigest } from '@lody/e2ee-core/protocol'
import { makeE2eeCloudClient } from './e2ee-cloud-client.mts'
import {
  createAccountRecoveryVault,
  inspectRecoveryFile,
  recoveryVaultEnabled,
  recoveryVaultFailure
} from './e2ee-recovery-vault.mts'

const response = (value) => Response.json({ status: 'success', value })

// Synthetic Convex service: one account's immutable entries plus index CAS with
// referenced-entry checks, exactly as the declared `e2eeRecoveryVault` contract.
function syntheticService() {
  const entries = new Map(),
    index = new Map(),
    calls = []
  const key = (vaultId, entryId) => `${vaultId}/${entryId}`
  const fetch = async (_url, init) => {
    const {
      path,
      args: [args]
    } = JSON.parse(init.body)
    calls.push(path)
    switch (path) {
      case 'e2eeRecoveryVault:putImmutable': {
        const before = entries.get(key(args.vaultId, args.entry.entryId))
        if (before && JSON.stringify(before) !== JSON.stringify(args.entry))
          throw new Error('immutable')
        entries.set(key(args.vaultId, args.entry.entryId), args.entry)
        return response({ ok: true })
      }
      case 'e2eeRecoveryVault:readEntry':
        return response(entries.get(key(args.vaultId, args.entryId)) ?? null)
      case 'e2eeRecoveryVault:readIndex':
        return response(index.get(args.vaultId)?.entry ?? null)
      case 'e2eeRecoveryVault:compareAndSwapIndex': {
        const current = index.get(args.vaultId) ?? null
        const same =
          args.expected === null
            ? current === null
            : current?.revision === args.expected.revision &&
              current?.digest === args.expected.digest
        if (!same || args.referencedEntryIds.some((id) => !entries.has(key(args.vaultId, id))))
          return response({ outcome: 'Conflict' })
        const next = Result.getOrThrow(decodeRecoveryVaultCiphertext(args.next))
        index.set(args.vaultId, {
          entry: args.next,
          revision: next.revision,
          digest: vaultCiphertextDigest(next)
        })
        return response({ outcome: 'Committed' })
      }
      default:
        throw new Error(`unexpected endpoint ${path}`)
    }
  }
  return { entries, index, calls, fetch }
}

async function withClient(service, work) {
  const scope = await Effect.runPromise(Scope.make())
  try {
    const client = await Effect.runPromise(
      makeE2eeCloudClient({
        platformKind: 'cloud',
        deploymentUrl: 'https://synthetic.convex.cloud',
        convexToken: async () => ({ data: { token: 'synthetic-auth-jwt' } }),
        fetch: service.fetch
      }).pipe(Scope.provide(scope))
    )
    return await work(client.recoveryVault())
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

void test('the recovery vault gate is off unless explicitly enabled', () => {
  assert.equal(recoveryVaultEnabled({}), false)
  assert.equal(recoveryVaultEnabled({ LODY_E2EE_RECOVERY_VAULT: 'true' }), false)
  assert.equal(recoveryVaultEnabled({ LODY_E2EE_RECOVERY_VAULT: '1' }), true)
})

void test('creates an account vault, reopens it from the saved file through the wire, and rejects a foreign file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    const filePath = join(dir, 'lody-recovery.lodyrecovery')
    const journalPath = join(dir, 'recovery-vault.sqlite')
    const created = await withClient(service, (store) =>
      Effect.runPromise(
        createAccountRecoveryVault({
          journalPath,
          store,
          locator: 'https://synthetic.convex.cloud',
          persist: (file) =>
            Effect.sync(() => {
              writeFileSync(filePath, file, { mode: 0o600 })
              return new Uint8Array(readFileSync(filePath))
            })
        })
      )
    )
    assert.match(created.vaultId, /^[0-9a-f]{64}$/)
    const file = new Uint8Array(readFileSync(filePath))
    // The service only ever saw opaque ciphertext: the unlock secret is absent.
    const unlock = file.subarray(file.length - 32)
    for (const entry of service.entries.values())
      assert.equal(Buffer.from(entry.ciphertext, 'hex').includes(Buffer.from(unlock)), false)
    assert.equal(readFileSync(journalPath).includes(Buffer.from(unlock)), false)

    const inspected = await withClient(service, (store) =>
      Effect.runPromise(inspectRecoveryFile({ journalPath, store, file }))
    )
    assert.deepEqual(inspected, { vaultId: created.vaultId, workspaces: 0 })

    // Same structure, different unlock secret: authentication fails, nothing is created.
    const forged = new Uint8Array(file)
    forged[forged.length - 1] ^= 1
    const before = service.calls.filter((path) => path.endsWith('putImmutable')).length
    const failed = await withClient(service, (store) =>
      Effect.runPromise(Effect.exit(inspectRecoveryFile({ journalPath, store, file: forged })))
    )
    assert.equal(Exit.isFailure(failed), true)
    assert.equal(
      recoveryVaultFailure(Exit.isFailure(failed) ? failed.cause.reasons[0]?.error : null).message,
      'e2ee_recovery_authentication'
    )
    assert.equal(service.calls.filter((path) => path.endsWith('putImmutable')).length, before)

    const oversized = await withClient(service, (store) =>
      Effect.runPromise(
        Effect.exit(inspectRecoveryFile({ journalPath, store, file: new Uint8Array(4097) }))
      )
    )
    assert.equal(Exit.isFailure(oversized), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('a save whose read-back differs fails before the vault is reported created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    const exit = await withClient(service, (store) =>
      Effect.runPromise(
        Effect.exit(
          createAccountRecoveryVault({
            journalPath: join(dir, 'recovery-vault.sqlite'),
            store,
            locator: 'https://synthetic.convex.cloud',
            persist: (file) => Effect.sync(() => file.subarray(0, file.length - 1))
          })
        )
      )
    )
    assert.equal(Exit.isFailure(exit), true)
    assert.equal(
      recoveryVaultFailure(Exit.isFailure(exit) ? exit.cause.reasons[0]?.error : null).message,
      'e2ee_recovery_storage'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
