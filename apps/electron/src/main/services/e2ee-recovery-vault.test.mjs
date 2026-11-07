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
import { E2eePasskeyCancelled } from '@lody/platform/e2ee-passkey'
import { makeE2eeCloudClient } from './e2ee-cloud-client.mts'
import {
  abandonAccountVaultReplacement,
  beginAccountVaultReplacement,
  continueAccountVaultReplacement,
  createAccountRecoveryVault,
  defaultPasskeyLabel,
  enrollRecoveryPasskey,
  recentAccountSecurityEvents,
  listRecoveryPasskeys,
  removeRecoveryPasskey,
  passkeyLabel,
  inspectRecoveryFile,
  recoveryReplacementPlan,
  recoveryRestoreTarget,
  recoveryVaultEnabled,
  recoveryVaultFailure,
  restoreAccountWorkspaces,
  saveRecoveryFile,
  setupWorkspaceRecovery
} from './e2ee-recovery-vault.mts'

const response = (value) => Response.json({ status: 'success', value })

// Synthetic Convex service: one account's immutable entries plus index CAS with
// referenced-entry checks, exactly as the declared `e2eeRecoveryVault` contract.
function syntheticService() {
  const entries = new Map(),
    index = new Map(),
    calls = [],
    requests = [],
    replacement = { current: null, replacing: null }
  const key = (vaultId, entryId) => `${vaultId}/${entryId}`
  const fetch = async (_url, init) => {
    const {
      path,
      args: [args]
    } = JSON.parse(init.body)
    calls.push(path)
    requests.push(init.body)
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
          referenced: args.referencedEntryIds,
          entry: args.next,
          revision: next.revision,
          digest: vaultCiphertextDigest(next)
        })
        return response({ outcome: 'Committed' })
      }
      case 'accountSecurityEvents:list':
        return response({
          events: [
            { id: 'a', kind: 'vault_replacement_reserved', occurredAt: 1_000 },
            { id: 'b', kind: 'personal_device_recovered', occurredAt: 3_000 },
            { id: 'c', kind: 'some_future_kind', occurredAt: 2_000 }
          ],
          nextCursor: null
        })
      case 'e2eeRecoveryVault:deleteUnreferenced': {
        const current = index.get(args.vaultId)
        if (
          current?.revision !== args.expectedIndex.revision ||
          current?.digest !== args.expectedIndex.digest ||
          current.referenced.includes(args.entryId)
        )
          throw new Error('referenced')
        entries.delete(key(args.vaultId, args.entryId))
        return response({ ok: true })
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
  return { entries, index, calls, requests, fetch, replacement }
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

const fakeTarget = (log, outcome = 'Committed') => ({
  id: 'workspace',
  name: 'Workspace',
  append: () => Effect.succeed({ status: 'committed' }),
  refresh: () => Effect.void,
  mailbox: () => ({ fetch: () => Effect.succeed({ items: [] }) }),
  deliver: () => Effect.void,
  owner: () =>
    Effect.succeed({
      setup: () =>
        Effect.sync(() => {
          log.push('setup')
          return { outcome: 'Committed', status: { recoverable: true } }
        }),
      revokeOtherRecoveryDevices: (request) =>
        Effect.sync(() => {
          log.push(request?.compromised ? 'revoke-first' : 'revoke')
          return { outcome }
        })
    }),
  abandonOwner: () =>
    Effect.succeed({
      revokeOwnRecoveryDevice: () =>
        Effect.sync(() => {
          log.push('revoke-own')
          return { outcome }
        })
    })
})

const begunReplacement = async (dir, service) => {
  service.replacement.current = 'a'.repeat(64)
  let file
  const begun = await withClient(service, (store, client) =>
    Effect.runPromise(
      beginAccountVaultReplacement({
        journalPath: join(dir, 'recovery-vault.sqlite'),
        store,
        replacement: client.recoveryVaultReplacement(),
        locator: 'https://synthetic.convex.cloud',
        persist: (bytes) => {
          file = new Uint8Array(bytes)
          return memorySave(bytes)
        }
      })
    )
  )
  return { file, vaultId: begun.vaultId }
}

void test('continuing proves every workspace, revokes, then makes the new vault current', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    const { file, vaultId } = await begunReplacement(dir, service)
    const log = []
    const result = await withClient(service, (store, client) =>
      Effect.runPromise(
        continueAccountVaultReplacement({
          journalPath: join(dir, 'recovery-vault.sqlite'),
          store,
          file,
          compromised: false,
          replacement: client.recoveryVaultReplacement(),
          workspaces: [fakeTarget(log)]
        })
      )
    )
    assert.deepEqual(result, { outcome: 'Committed' })
    assert.deepEqual(log, ['setup', 'revoke'])
    assert.deepEqual(service.replacement, { current: vaultId, replacing: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('a suspected leak revokes before setup and still retires last', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    const { file } = await begunReplacement(dir, service)
    const log = []
    await withClient(service, (store, client) =>
      Effect.runPromise(
        continueAccountVaultReplacement({
          journalPath: join(dir, 'recovery-vault.sqlite'),
          store,
          file,
          compromised: true,
          replacement: client.recoveryVaultReplacement(),
          workspaces: [fakeTarget(log)]
        })
      )
    )
    assert.deepEqual(log, ['revoke-first', 'setup', 'revoke'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('a pending revocation keeps the old vault current', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    const { file, vaultId } = await begunReplacement(dir, service)
    const result = await withClient(service, (store, client) =>
      Effect.runPromise(
        continueAccountVaultReplacement({
          journalPath: join(dir, 'recovery-vault.sqlite'),
          store,
          file,
          compromised: false,
          replacement: client.recoveryVaultReplacement(),
          workspaces: [fakeTarget([], 'Pending')]
        })
      )
    )
    assert.equal(result.outcome, 'Pending')
    assert.deepEqual(service.replacement, { current: 'a'.repeat(64), replacing: vaultId })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('a file for another vault cannot continue the replacement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    const { file } = await begunReplacement(dir, service)
    service.replacement.replacing = 'c'.repeat(64)
    const log = []
    const failed = await withClient(service, (store, client) =>
      Effect.runPromise(
        Effect.exit(
          continueAccountVaultReplacement({
            journalPath: join(dir, 'recovery-vault.sqlite'),
            store,
            file,
            compromised: false,
            replacement: client.recoveryVaultReplacement(),
            workspaces: [fakeTarget(log)]
          })
        )
      )
    )
    assert.equal(
      recoveryVaultFailure(Exit.isFailure(failed) ? failed.cause.reasons[0]?.error : null).message,
      'e2ee_recovery_authentication'
    )
    assert.deepEqual(log, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('abandoning needs no file, revokes the new R and keeps the current vault', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    await begunReplacement(dir, service)
    const log = []
    const abandon = () =>
      withClient(service, (store, client) =>
        Effect.runPromise(
          abandonAccountVaultReplacement({
            journalPath: join(dir, 'recovery-vault.sqlite'),
            store,
            replacement: client.recoveryVaultReplacement(),
            workspaces: [fakeTarget(log)]
          })
        )
      )
    assert.deepEqual(await abandon(), { outcome: 'Committed' })
    assert.deepEqual(log, ['revoke-own'])
    assert.deepEqual(service.replacement, { current: 'a'.repeat(64), replacing: null })
    assert.deepEqual(await abandon(), { outcome: 'None' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('the plan names workspaces this device cannot act on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  const plan = await Effect.runPromise(
    recoveryReplacementPlan({
      journalPath: join(dir, 'recovery-vault.sqlite'),
      store: {},
      replacement: {
        state: () => Effect.succeed({ current: 'a'.repeat(64), replacing: null })
      },
      accountWorkspaces: Effect.succeed([
        { id: 'here', name: 'Here' },
        { id: 'elsewhere', name: 'Elsewhere' }
      ]),
      hasIdentity: (id) => Effect.succeed(id === 'here')
    })
  )
  assert.deepEqual(plan, {
    replaceable: true,
    replacing: false,
    covered: [{ id: 'here', name: 'Here' }],
    uncovered: [{ id: 'elsewhere', name: 'Elsewhere' }]
  })
  rmSync(dir, { recursive: true, force: true })
})

void test('setting up one workspace needs the current vault and reports a slow delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    const { file, vaultId } = await begunReplacement(dir, service)
    const run = () =>
      withClient(service, (store, client) =>
        Effect.runPromise(
          Effect.exit(
            setupWorkspaceRecovery({
              journalPath: join(dir, 'recovery-vault.sqlite'),
              store,
              unlock: { file },
              replacement: client.recoveryVaultReplacement(),
              target: {
                ...fakeTarget([]),
                owner: () =>
                  Effect.succeed({
                    setup: () =>
                      Effect.succeed({ outcome: 'Pending', status: { recoverable: false } })
                  })
              }
            })
          )
        )
      )
    const refused = await run()
    assert.equal(
      recoveryVaultFailure(Exit.isFailure(refused) ? refused.cause.reasons[0]?.error : null)
        .message,
      'e2ee_recovery_authentication'
    )
    service.replacement.current = vaultId
    const pending = await run()
    assert.deepEqual(Exit.isSuccess(pending) ? pending.value : null, {
      outcome: 'Pending',
      recoverable: false
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('a restore sends both credentials and names the R as endorser', async () => {
  const appended = []
  const adopted = []
  const target = recoveryRestoreTarget({
    id: 'workspace',
    name: 'Workspace',
    genesisHash: 'a'.repeat(64),
    append: (request) =>
      Effect.sync(() => {
        appended.push(request)
        return { status: 'committed' }
      }),
    hasIdentity: () => false,
    history: () =>
      Effect.succeed({ startIndex: 0, recordsHex: [], nextCursor: null, checkpoint: null }),
    mailbox: () => ({ fetch: () => Effect.succeed({ items: [] }) }),
    stagedGroup: () => Effect.succeed(null),
    identity: (pin) =>
      Effect.succeed({
        device: { enc: 'encryption', pin },
        credentialHash: 'c'.repeat(64)
      }),
    adopt: (join) =>
      Effect.sync(() => {
        adopted.push(join)
      })
  })
  const anchor = {
    genesis: { toBytes: () => new Uint8Array(32) },
    membershipId: { toBytes: () => new Uint8Array(16).fill(1) },
    recovery: { toBytes: () => new Uint8Array(32).fill(2) },
    genesisRecord: new Uint8Array([3])
  }
  const ports = await Effect.runPromise(Effect.scoped(target.connect(anchor)))
  assert.equal(ports.personal.encryptionPublicKey, 'encryption')
  const record = new Uint8Array(64).fill(4)
  const credential = new Uint8Array(32).fill(5)
  const result = await Effect.runPromise(
    ports.submitOriginalAsRecovery(record, undefined, credential)
  )
  assert.equal(result.outcome, 'Committed')
  assert.equal(appended[0].credentialHash, 'c'.repeat(64))
  assert.equal(appended[0].signerCredential, '05'.repeat(32))
  assert.deepEqual(credential, new Uint8Array(32))
  await Effect.runPromise(ports.adopt([]))
  assert.equal(adopted[0].endorser, '02'.repeat(32))
  assert.equal(adopted[0].pairingSessionId, appended[0].requestId.slice(0, 32))
})

void test('a file covering nothing here restores nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    const { file } = await begunReplacement(dir, service)
    const results = await withClient(service, (store) =>
      Effect.runPromise(
        restoreAccountWorkspaces({
          journalPath: join(dir, 'recovery-vault.sqlite'),
          store,
          unlock: { file },
          workspaces: []
        })
      )
    )
    assert.deepEqual(results, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const syntheticAuthenticator = (options = {}) => {
  const credentials = new Map()
  return {
    available: async () => true,
    register: async (request) => {
      const credentialId = `${options.prefix ?? 'credential'}${credentials.size}A`
      credentials.set(credentialId, new Uint8Array(request.userHandle))
      return { credentialId, prfEnabled: options.prf ?? true }
    },
    authenticate: async (request) => {
      const [credentialId, userHandle] = [...credentials].find(
        ([id]) => request.allowCredentialIds.length === 0 || request.allowCredentialIds.includes(id)
      )
      return {
        credentialId,
        userHandle,
        userVerified: true,
        prfFirst: new Uint8Array(32).fill(44)
      }
    }
  }
}

const createdVault = async (dir, service) => {
  let file
  const created = await withClient(service, (store) =>
    Effect.runPromise(
      createAccountRecoveryVault({
        journalPath: join(dir, 'recovery-vault.sqlite'),
        store,
        exists: Effect.succeed(false),
        locator: 'https://synthetic.convex.cloud',
        persist: (bytes) => {
          file = new Uint8Array(bytes)
          return memorySave(bytes)
        }
      })
    )
  )
  return { file, vaultId: created.vaultId }
}

void test('a passkey enrolled with the file then sets up a workspace without it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    const { file, vaultId } = await createdVault(dir, service)
    service.replacement.current = vaultId
    const port = syntheticAuthenticator()
    const enrolled = await withClient(service, (store) =>
      Effect.runPromise(
        enrollRecoveryPasskey({
          journalPath: join(dir, 'recovery-vault.sqlite'),
          store,
          file,
          port,
          label: 'iCloud Keychain'
        })
      )
    )
    assert.deepEqual(enrolled, { passkeys: 1, labels: ['iCloud Keychain'] })
    const log = []
    const result = await withClient(service, (store, client) =>
      Effect.runPromise(
        setupWorkspaceRecovery({
          journalPath: join(dir, 'recovery-vault.sqlite'),
          store,
          unlock: { passkey: port, locator: 'https://synthetic.convex.cloud' },
          replacement: client.recoveryVaultReplacement(),
          target: fakeTarget(log)
        })
      )
    )
    assert.deepEqual(result, { outcome: 'Committed', recoverable: true })
    assert.deepEqual(log, ['setup'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('a passkey without PRF is reported plainly and enrolls nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    const { file } = await createdVault(dir, service)
    const before = service.entries.size
    const failed = await withClient(service, (store) =>
      Effect.runPromise(
        Effect.exit(
          enrollRecoveryPasskey({
            journalPath: join(dir, 'recovery-vault.sqlite'),
            store,
            file,
            port: syntheticAuthenticator({ prf: false }),
            label: 'Other'
          })
        )
      )
    )
    assert.equal(
      recoveryVaultFailure(Exit.isFailure(failed) ? failed.cause.reasons[0]?.error : null).message,
      'e2ee_recovery_prf-unavailable'
    )
    assert.equal(service.entries.size, before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('a dismissed system prompt is a cancellation, not a failure', () => {
  assert.equal(
    recoveryVaultFailure(new E2eePasskeyCancelled('e2ee_passkey_cancelled')).message,
    'e2ee_recovery_cancelled'
  )
})

void test('account security events show known kinds, newest first, and nothing else', async () => {
  const service = syntheticService()
  const events = await withClient(service, (_store, client) =>
    Effect.runPromise(recentAccountSecurityEvents(client.accountSecurityEvents()))
  )
  assert.deepEqual(events, [
    { id: 'b', kind: 'personal_device_recovered', occurredAt: 3_000 },
    { id: 'a', kind: 'vault_replacement_reserved', occurredAt: 1_000 }
  ])
  assert.deepEqual(JSON.parse(service.requests.at(-1)).args[0], { limit: 20 })
})

void test('a passkey label is the user name for it, trimmed and bounded', () => {
  assert.equal(passkeyLabel('  Work   MacBook  '), 'Work MacBook')
  assert.equal(passkeyLabel('x'.repeat(64)), 'x'.repeat(64))
  assert.throws(() => passkeyLabel('   '), /invalid-input/)
  assert.throws(() => passkeyLabel('x'.repeat(65)), /invalid-input/)
  assert.throws(() => passkeyLabel(42), /invalid-input/)
})

void test('the default label describes the device without its host name', () => {
  assert.equal(
    defaultPasskeyLabel({ platform: 'darwin', systemVersion: '15.2' }),
    'Mac · macOS 15.2'
  )
  assert.equal(defaultPasskeyLabel({ platform: 'darwin', systemVersion: '' }), 'Mac')
  assert.equal(defaultPasskeyLabel({ platform: 'linux', systemVersion: '6.8' }), 'This device')
})

void test('an enrolled passkey keeps the name the user gave it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    const { file } = await createdVault(dir, service)
    const added = await withClient(service, (store) =>
      Effect.runPromise(
        enrollRecoveryPasskey({
          journalPath: join(dir, 'recovery-vault.sqlite'),
          store,
          file,
          port: syntheticAuthenticator(),
          label: 'Work MacBook'
        })
      )
    )
    assert.deepEqual(added, { passkeys: 1, labels: ['Work MacBook'] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('removing a passkey lists it no more and stops it unlocking the vault', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    const { file, vaultId } = await createdVault(dir, service)
    service.replacement.current = vaultId
    const io = (store) => ({ journalPath: join(dir, 'recovery-vault.sqlite'), store })
    const first = syntheticAuthenticator({ prefix: 'first' })
    const second = syntheticAuthenticator({ prefix: 'second' })
    for (const [port, label] of [
      [first, 'Work MacBook'],
      [second, 'iPhone']
    ])
      await withClient(service, (store) =>
        Effect.runPromise(enrollRecoveryPasskey({ ...io(store), file, port, label }))
      )
    const listed = await withClient(service, (store) =>
      Effect.runPromise(listRecoveryPasskeys({ ...io(store), unlock: { file } }))
    )
    assert.deepEqual(
      listed.map((row) => row.label),
      ['Work MacBook', 'iPhone']
    )
    const removed = listed.find((row) => row.label === 'Work MacBook')
    const left = await withClient(service, (store) =>
      Effect.runPromise(
        removeRecoveryPasskey({ ...io(store), unlock: { file }, entryId: removed.entryId })
      )
    )
    assert.deepEqual(
      left.map((row) => row.label),
      ['iPhone']
    )
    const unlockWith = (port) =>
      withClient(service, (store, client) =>
        Effect.runPromise(
          Effect.exit(
            setupWorkspaceRecovery({
              ...io(store),
              unlock: { passkey: port, locator: 'https://synthetic.convex.cloud' },
              replacement: client.recoveryVaultReplacement(),
              target: fakeTarget([])
            })
          )
        )
      )
    const refused = await unlockWith(first)
    assert.equal(
      recoveryVaultFailure(Exit.isFailure(refused) ? refused.cause.reasons[0]?.error : null)
        .message,
      'e2ee_recovery_prf-unavailable'
    )
    assert.equal(Exit.isSuccess(await unlockWith(second)), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

void test('removing an unknown passkey changes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lody-recovery-vault-'))
  try {
    const service = syntheticService()
    const { file } = await createdVault(dir, service)
    const before = service.entries.size
    const failed = await withClient(service, (store) =>
      Effect.runPromise(
        Effect.exit(
          removeRecoveryPasskey({
            journalPath: join(dir, 'recovery-vault.sqlite'),
            store,
            unlock: { file },
            entryId: 'a'.repeat(64)
          })
        )
      )
    )
    assert.equal(Exit.isFailure(failed), true)
    assert.equal(service.entries.size, before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
