import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Effect, Exit, Result, Scope } from 'effect'
import { decodeRecoveryVaultCiphertext } from '@lody/e2ee-core/host'
import { vaultCiphertextDigest } from '@lody/e2ee-core/protocol'
import { makeE2eeCloudClient } from './e2ee-cloud-client.mts'
import {
  abandonAccountVaultReplacement,
  beginAccountVaultReplacement,
  createAccountRecoveryVault,
  inspectRecoveryFile,
  recoveryReplacementPlan,
  recoveryVaultEnabled,
  recoveryVaultFailure,
  saveRecoveryFile
} from './e2ee-recovery-vault.mts'

const response = (value) => Response.json({ status: 'success', value })

// Synthetic Convex service: one account's immutable entries plus index CAS with
// referenced-entry checks, exactly as the declared `e2eeRecoveryVault` contract.
function syntheticService() {
  const entries = new Map(),
    index = new Map(),
    calls = [],
    replacement = { current: null, replacing: null }
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
      case 'e2eeRecoveryVault:replacementState':
        return response(replacement)
      case 'e2eeRecoveryVault:reserveReplacementVault':
        replacement.replacing = args.vaultId
        return response({ ok: true })
      case 'e2eeRecoveryVault:abandonReplacement':
        replacement.replacing = null
        return response({ ok: true })
      case 'e2eeRecoveryVault:finishReplacement':
        replacement.current = args.newVaultId
        replacement.replacing = null
        return response({ ok: true })
      case 'e2eeRecoveryVault:hasAccountVault':
        return response({ exists: entries.size > 0 })
      default:
        throw new Error(`unexpected endpoint ${path}`)
    }
  }
  return { entries, index, calls, fetch, replacement }
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
    return await work(client.recoveryVault(), client)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

void test('the recovery vault gate is off unless explicitly enabled', () => {
  assert.equal(recoveryVaultEnabled({}), false)
  assert.equal(recoveryVaultEnabled({ LODY_E2EE_RECOVERY_VAULT: '1' }), false)
  assert.equal(recoveryVaultEnabled({ LODY_E2EE_RECOVERY_VAULT: 'on' }), true)
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
          exists: Effect.succeed(false),
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
            exists: Effect.succeed(false),
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
    assert.equal(service.entries.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('an account with a vault creates nothing and writes no file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    service.entries.set('existing/entry', {})
    let saved = 0
    const failed = await withClient(service, (store, client) =>
      Effect.runPromise(
        Effect.exit(
          createAccountRecoveryVault({
            journalPath: join(dir, 'recovery-vault.sqlite'),
            store,
            exists: client.hasRecoveryVault(),
            locator: 'https://synthetic.convex.cloud',
            persist: (file) =>
              Effect.sync(() => {
                saved += 1
                return new Uint8Array(file)
              })
          })
        )
      )
    )
    assert.equal(Exit.isFailure(failed), true)
    assert.equal(
      recoveryVaultFailure(Exit.isFailure(failed) ? failed.cause.reasons[0]?.error : null).message,
      'e2ee_recovery_exists'
    )
    assert.equal(saved, 0)
    assert.equal(service.entries.size, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('a failed save uploads nothing, so the account can still create a vault', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    const failed = await withClient(service, (store) =>
      Effect.runPromise(
        Effect.exit(
          createAccountRecoveryVault({
            journalPath: join(dir, 'recovery-vault.sqlite'),
            store,
            exists: Effect.succeed(false),
            locator: 'https://synthetic.convex.cloud',
            persist: () => Effect.fail(new Error('synthetic disk full'))
          })
        )
      )
    )
    assert.equal(Exit.isFailure(failed), true)
    assert.equal(service.entries.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('saving over a readable file never exposes the new material at the old mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const path = join(dir, 'lody-recovery.lodyrecovery')
    writeFileSync(path, 'previous backup')
    chmodSync(path, 0o644)
    const secret = Buffer.from('new recovery material')
    let checked = false
    await saveRecoveryFile(path, secret, {
      write: async (handle, bytes) => {
        await handle.writeFile(bytes)
        // Fully written but not yet in place: the target is untouched, the copy private.
        assert.equal(readFileSync(path, 'utf8'), 'previous backup')
        const [temporary] = readdirSync(dir).filter((name) => name !== 'lody-recovery.lodyrecovery')
        assert.equal(statSync(join(dir, temporary)).mode & 0o777, 0o600)
        checked = true
      }
    })
    assert.equal(checked, true)
    assert.deepEqual(readFileSync(path), secret)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(dir), ['lody-recovery.lodyrecovery'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('a failed save keeps the existing file byte for byte and leaves no temporary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const path = join(dir, 'lody-recovery.lodyrecovery')
    writeFileSync(path, 'previous backup')
    await assert.rejects(
      saveRecoveryFile(path, Buffer.from('new recovery material'), {
        write: async (handle, bytes) => {
          await handle.write(bytes, 0, 4)
          throw new Error('synthetic disk failure')
        }
      }),
      /synthetic disk failure/
    )
    assert.equal(readFileSync(path, 'utf8'), 'previous backup')
    assert.deepEqual(readdirSync(dir), ['lody-recovery.lodyrecovery'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('a first save creates a private file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const path = join(dir, 'lody-recovery.lodyrecovery')
    await saveRecoveryFile(path, Buffer.from('new recovery material'))
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(dir), ['lody-recovery.lodyrecovery'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const memorySave = (bytes) => Effect.sync(() => new Uint8Array(bytes))

void test('a replacement reserves the new vault after its file is saved and before any upload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    service.replacement.current = 'a'.repeat(64)
    let saved
    const begun = await withClient(service, (store, client) =>
      Effect.runPromise(
        beginAccountVaultReplacement({
          journalPath: join(dir, 'recovery-vault.sqlite'),
          store,
          replacement: client.recoveryVaultReplacement(),
          locator: 'https://synthetic.convex.cloud',
          persist: (file) => {
            saved = new Uint8Array(file)
            return memorySave(file)
          }
        })
      )
    )
    assert.equal(service.replacement.replacing, begun.vaultId)
    assert.equal(service.replacement.current, 'a'.repeat(64))
    assert.ok(saved?.length)
    const reserved = service.calls.indexOf('e2eeRecoveryVault:reserveReplacementVault')
    assert.ok(reserved >= 0)
    assert.ok(reserved < service.calls.indexOf('e2eeRecoveryVault:putImmutable'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const [name, state, code] of [
  ['with no vault to replace', { current: null, replacing: null }, 'e2ee_recovery_missing'],
  [
    'while another replacement runs',
    { current: 'a'.repeat(64), replacing: 'b'.repeat(64) },
    'e2ee_recovery_replacing'
  ]
])
  void test(`a replacement ${name} writes nothing`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
    try {
      const service = syntheticService()
      Object.assign(service.replacement, state)
      let saved = 0
      const failed = await withClient(service, (store, client) =>
        Effect.runPromise(
          Effect.exit(
            beginAccountVaultReplacement({
              journalPath: join(dir, 'recovery-vault.sqlite'),
              store,
              replacement: client.recoveryVaultReplacement(),
              locator: 'https://synthetic.convex.cloud',
              persist: (file) => {
                saved += 1
                return memorySave(file)
              }
            })
          )
        )
      )
      assert.equal(
        recoveryVaultFailure(Exit.isFailure(failed) ? failed.cause.reasons[0]?.error : null)
          .message,
        code
      )
      assert.equal(saved, 0)
      assert.equal(service.entries.size, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

void test('a failed save during replacement reserves nothing and keeps the old vault', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    service.replacement.current = 'a'.repeat(64)
    await withClient(service, (store, client) =>
      Effect.runPromise(
        Effect.exit(
          beginAccountVaultReplacement({
            journalPath: join(dir, 'recovery-vault.sqlite'),
            store,
            replacement: client.recoveryVaultReplacement(),
            locator: 'https://synthetic.convex.cloud',
            persist: () => Effect.fail(new Error('synthetic disk full'))
          })
        )
      )
    )
    assert.equal(service.replacement.replacing, null)
    assert.equal(service.entries.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('abandoning retires the unfinished vault and keeps the current one', async () => {
  const service = syntheticService()
  Object.assign(service.replacement, { current: 'a'.repeat(64), replacing: 'b'.repeat(64) })
  const result = await withClient(service, (_store, client) =>
    Effect.runPromise(abandonAccountVaultReplacement(client.recoveryVaultReplacement()))
  )
  assert.deepEqual(result, { abandoned: true })
  assert.deepEqual(service.replacement, { current: 'a'.repeat(64), replacing: null })
  const again = await withClient(service, (_store, client) =>
    Effect.runPromise(abandonAccountVaultReplacement(client.recoveryVaultReplacement()))
  )
  assert.deepEqual(again, { abandoned: false })
})

void test('the plan names workspaces this device cannot act on', async () => {
  const plan = await Effect.runPromise(
    recoveryReplacementPlan({
      replacement: {
        state: () => Effect.succeed({ current: 'a'.repeat(64), replacing: null })
      },
      accountWorkspaces: Effect.succeed([
        { id: 'here', name: 'Here' },
        { id: 'elsewhere', name: 'Elsewhere' }
      ]),
      hasIdentity: (id) => id === 'here'
    })
  )
  assert.deepEqual(plan, {
    replaceable: true,
    replacing: false,
    covered: [{ id: 'here', name: 'Here' }],
    uncovered: [{ id: 'elsewhere', name: 'Elsewhere' }]
  })
})
