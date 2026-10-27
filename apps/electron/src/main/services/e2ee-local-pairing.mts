import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { Effect, Result } from 'effect'
import {
  Bytes,
  hashRecordBytes,
  decodeRecord,
  prepareLedgerCommand,
  possessionSigningBytes,
  verifySignature,
  signLedgerRecord,
  verifyDeviceCredentialBinding,
  type DeviceSigner,
  type LedgerView
} from '@lody/e2ee-core/protocol'
import {
  LocalE2eePrepareResponseSchema,
  type LocalE2eePrepareResponse
} from '@lody/shared/e2ee-local-pairing'
import type { E2eeAppendRecordRequest } from '@lody/cloud-api'

const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')
const raw = (value: string) => new Uint8Array(Buffer.from(value, 'hex'))
const failure = (code: string, cause?: unknown) =>
  Object.assign(new Error(`e2ee_${code}`, { cause }), { code })
type PairingRow = {
  session: string
  material: string | null
  request_id: string | null
  record: Uint8Array | null
}

/** Workspace-local approval journal. The owning host serializes these local
 * operations and closes its database only after admitted native signing ends.
 * No cloud call occurs here, and cancellation before approval signs nothing. */
export function makeDesktopLocalPairing(input: {
  db: DatabaseSync
  journal?: 'remote'
  workspaceId: string
  genesis: Bytes.GenesisHash
  genesisRecord: Uint8Array
  signer: DeviceSigner
  current: () => Effect.Effect<LedgerView, unknown>
}) {
  const pairingTable = input.journal === 'remote' ? 'remote_local_pairing' : 'local_pairing'
  const retiredTable =
    input.journal === 'remote' ? 'retired_remote_local_pairings' : 'retired_local_pairings'
  function sql<A>(work: () => A) {
    return Effect.try({
      try: work,
      catch: (error) =>
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        ['conflict', 'corrupt', 'invalid-input', 'local-evidence-conflict'].includes(error.code)
          ? error
          : failure('storage', error)
    })
  }
  input.db.exec(
    `CREATE TABLE IF NOT EXISTS ${pairingTable}(id INTEGER PRIMARY KEY CHECK(id=1), session TEXT NOT NULL, material TEXT, request_id TEXT, record BLOB)`
  )
  // Only empty unsigned attempts enter this archive. Machine originals remain in CLI.
  input.db.exec(`CREATE TABLE IF NOT EXISTS ${retiredTable}(session TEXT PRIMARY KEY)`)
  const read = () =>
    input.db.prepare(`SELECT * FROM ${pairingTable} WHERE id=1`).get() as PairingRow | undefined
  const membership = (view: LedgerView) => {
    const state = view.inspectState()
    const device = state.devices.get(hex(input.signer.publicKey.toBytes()))
    if (
      !device ||
      device.kind !== 'personal' ||
      !state.members.has(hex(device.membershipId.toBytes()))
    )
      throw failure('invalid-input')
    return device.membershipId
  }
  const material = (row: PairingRow): LocalE2eePrepareResponse => {
    if (!row.material) throw failure('invalid-input')
    const parsed = LocalE2eePrepareResponseSchema.safeParse(JSON.parse(row.material))
    if (!parsed.success || parsed.data.pairingSessionId !== row.session) throw failure('corrupt')
    return parsed.data
  }
  const checkedMaterial = (row: PairingRow, view: LedgerView) => {
    const value = material(row)
    const publicKey = Result.getOrThrow(Bytes.signingPublicKey(raw(value.signingPublicKey)))
    const binding = verifyDeviceCredentialBinding(
      {
        genesis: input.genesis,
        pairingSessionId: raw(row.session),
        signingPublicKey: publicKey,
        credentialHash: raw(value.credentialHash)
      },
      raw(value.bindingSignature)
    )
    if (Result.isFailure(binding)) throw failure('invalid-input')
    return { value, publicKey, ownMembership: membership(view) }
  }
  const check = (row: PairingRow, view: LedgerView) => {
    const { value, publicKey, ownMembership } = checkedMaterial(row, view)
    const admitted = view.inspectState().devices.get(value.signingPublicKey)
    if (admitted) {
      if (
        admitted.kind !== 'machine' ||
        !admitted.membershipId.equals(ownMembership) ||
        hex(admitted.encryptionPublicKey.toBytes()) !== value.encryptionPublicKey
      )
        throw failure('conflict')
      return { value, admitted: true, proposal: null }
    }
    const command = {
      _tag: 'AdmitDevice' as const,
      kind: 'machine' as const,
      signingPublicKey: publicKey,
      encryptionPublicKey: Result.getOrThrow(
        Bytes.encryptionPublicKey(raw(value.encryptionPublicKey))
      ),
      possessionSignature: Result.getOrThrow(Bytes.signature(raw(value.possessionSignature)))
    }
    // The CLI uses prepareDeviceAdmission; this core gate independently checks
    // its possession proof, membership and the approver's current authority.
    const proposal = prepareLedgerCommand(view, input.signer.publicKey, command)
    if (Result.isFailure(proposal)) throw failure('invalid-input')
    return {
      value,
      admitted: false,
      proposal: proposal.success
    }
  }
  // Only verified original history can settle a signed journal. A missing
  // device/current head alone cannot prove that an uncertain append lost CAS.
  const settled = (row: PairingRow, view: LedgerView) => {
    const originals = input.db
      .prepare('SELECT record FROM records WHERE position < ?')
      .all(view.length)
    if (!row.record && !row.request_id) {
      const { value, publicKey, ownMembership } = checkedMaterial(row, view)
      // A real admission settles unsigned staging even if the device was later
      // revoked. Bind the retained proof to this member before consulting history;
      // a used key or another member's admission alone cannot settle this session.
      const proofInput = {
        genesis: input.genesis,
        targetMembershipId: ownMembership,
        signingPublicKey: publicKey,
        encryptionPublicKey: Result.getOrThrow(
          Bytes.encryptionPublicKey(raw(value.encryptionPublicKey))
        ),
        kind: 'machine' as const,
        machineId: value.machineId
      }
      const proof = Result.getOrThrow(possessionSigningBytes(proofInput))
      if (
        Result.isFailure(
          verifySignature(publicKey.toBytes(), proof, raw(value.possessionSignature))
        )
      )
        throw failure('invalid-input')
      if (view.inspectState().devices.has(value.signingPublicKey)) return check(row, view).admitted
      return originals.some((item) => {
        const body = Result.getOrThrow(decodeRecord(item.record as Uint8Array)).body
        return (
          body.type === 'ordinary' &&
          body.operation.type === 'admitDevice' &&
          body.operation.kind === 'machine' &&
          hex(body.operation.signingPublicKey.toBytes()) === value.signingPublicKey &&
          hex(body.operation.encryptionPublicKey.toBytes()) === value.encryptionPublicKey &&
          hex(body.operation.possessionSignature.toBytes()) === value.possessionSignature
        )
      })
    }
    if (!row.record || !row.request_id) throw failure('corrupt')
    const signed = Result.getOrThrow(decodeRecord(row.record)).body
    if (signed.type !== 'ordinary') throw failure('corrupt')
    const hash = hex(hashRecordBytes(row.record).toBytes())
    return originals.some((item) => {
      const record = item.record as Uint8Array
      if (hex(hashRecordBytes(record).toBytes()) === hash) return true
      const body = Result.getOrThrow(decodeRecord(record)).body
      return body.type === 'ordinary' && body.previousHash.equals(signed.previousHash)
    })
  }
  const context = Effect.fnUntraced(function* () {
    const view = yield* input.current()
    const membershipId = yield* sql(() => hex(membership(view).toBytes()))
    const row = yield* sql(() => {
      input.db
        .prepare(`INSERT OR IGNORE INTO ${pairingTable}(id,session) VALUES(1,?)`)
        .run(randomBytes(16).toString('hex'))
      const stored = read()!
      if (stored.material && settled(stored, view)) {
        input.db
          .prepare(
            `UPDATE ${pairingTable} SET session=?,material=NULL,request_id=NULL,record=NULL WHERE id=1`
          )
          .run(randomBytes(16).toString('hex'))
        return read()!
      }
      return stored
    })
    return {
      workspaceId: input.workspaceId,
      genesisHash: hex(input.genesis.toBytes()),
      genesisRecordHex: hex(input.genesisRecord),
      membershipId,
      frontendSigningPublicKey: hex(input.signer.publicKey.toBytes()),
      pairingSessionId: row.session
    }
  })
  const retireSuperseded = Effect.fnUntraced(function* (session: string) {
    yield* input.current()
    return yield* sql(() => {
      input.db.exec('BEGIN IMMEDIATE')
      try {
        const row = read()
        if (
          !row ||
          row.session !== session ||
          row.material !== null ||
          row.record !== null ||
          row.request_id !== null
        )
          throw failure('conflict')
        input.db.prepare(`INSERT OR IGNORE INTO ${retiredTable}(session) VALUES(?)`).run(session)
        input.db
          .prepare(`UPDATE ${pairingTable} SET session=? WHERE id=1 AND session=?`)
          .run(randomBytes(16).toString('hex'), session)
        input.db.exec('COMMIT')
      } catch (cause) {
        try {
          input.db.exec('ROLLBACK')
        } catch (cleanup) {
          throw failure(
            'storage',
            new AggregateError([cause, cleanup], 'pairing retirement and rollback failed', {
              cause
            })
          )
        }
        throw cause
      }
    })
  })
  const stage = Effect.fnUntraced(function* (response: LocalE2eePrepareResponse) {
    const parsed = LocalE2eePrepareResponseSchema.safeParse(response)
    if (!parsed.success) return yield* Effect.fail(failure('invalid-input'))
    const view = yield* input.current()
    return yield* sql(() => {
      const row = read()
      if (!row || row.session !== parsed.data.pairingSessionId) throw failure('conflict')
      const original = JSON.stringify(parsed.data)
      if (row.material && row.material !== original) throw failure('conflict')
      const checked = check({ ...row, material: original }, view)
      input.db.prepare(`UPDATE ${pairingTable} SET material=? WHERE id=1`).run(original)
      return {
        pairingSessionId: row.session,
        protection: checked.value.protection,
        admitted: checked.admitted
      }
    })
  })
  const approve = Effect.fnUntraced(function* (session: string) {
    const view = yield* input.current()
    const row = yield* sql(read)
    if (!row || row.session !== session) return yield* Effect.fail(failure('conflict'))
    const checked = yield* sql(() => check(row, view))
    if (checked.admitted) return null
    if (row.record && row.request_id)
      return {
        workspaceId: input.workspaceId,
        requestId: row.request_id,
        recordHex: hex(row.record),
        credentialHash: checked.value.credentialHash
      } satisfies E2eeAppendRecordRequest
    if (row.record || row.request_id || !checked.proposal)
      return yield* Effect.fail(failure('corrupt'))
    const record = yield* signLedgerRecord(checked.proposal, input.signer)
    const requestId = `local-device-${randomUUID()}`
    // FULL/WAL durability precedes the first HTTP call. A retry returns these
    // exact bytes, including when the original parent no longer is the tail.
    yield* sql(() =>
      input.db
        .prepare(`UPDATE ${pairingTable} SET request_id=?,record=? WHERE id=1`)
        .run(requestId, record)
    )
    return {
      workspaceId: input.workspaceId,
      requestId,
      recordHex: hex(record),
      credentialHash: checked.value.credentialHash
    } satisfies E2eeAppendRecordRequest
  })
  const confirmed = Effect.fnUntraced(function* (session: string) {
    const view = yield* input.current()
    return yield* sql(() => {
      const row = read()
      if (!row || row.session !== session) throw failure('conflict')
      const checked = check(row, view)
      if (!checked.admitted) throw failure('invalid-input')
      if (row.record) {
        const hash = hex(hashRecordBytes(row.record).toBytes())
        const originals = input.db.prepare('SELECT record FROM records').all()
        if (
          !originals.some(
            (value) =>
              value.record instanceof Uint8Array &&
              hex(hashRecordBytes(value.record).toBytes()) === hash
          )
        )
          throw failure('local-evidence-conflict')
      }
      return {
        machineId: checked.value.machineId,
        pairingSessionId: row.session,
        frontendSigningPublicKey: hex(input.signer.publicKey.toBytes()),
        genesisHash: hex(input.genesis.toBytes()),
        signingPublicKey: checked.value.signingPublicKey
      }
    })
  })
  return { context, retireSuperseded, stage, approve, confirmed }
}
