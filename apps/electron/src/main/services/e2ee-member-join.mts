import { verifyPersonalHistory } from '@lody/e2ee-client/history'
import { PersonalHostError } from '@lody/e2ee-client/errors'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { Effect, Result } from 'effect'
import { z } from 'zod'
import type { E2eeMemberOffer, E2eeWorkspaceHistoryPage } from '@lody/cloud-api'
import {
  Bytes,
  decodeCbor,
  decodeRecord,
  encodeCbor,
  hashRecordBytes,
  prepareJoinRequest,
  prepareLedgerCommand,
  signLedgerRecord,
  signDeviceCredentialBinding,
  verifyDeviceCredentialBinding,
  verifyLedgerEffect,
  type DeviceSigner,
  type JoinRequest,
  type LedgerView
} from '@lody/e2ee-core/protocol'
import type { DesktopE2eeCustody } from '../e2ee-custody.mjs'
import { rememberDesktopE2eeFailure } from './e2ee-diagnostics.mjs'

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const bytes = z.string().regex(/^(?:[0-9a-f]{2})+$/)
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')
const raw = (value: string) => new Uint8Array(Buffer.from(value, 'hex'))
const ok = Result.getOrThrow
const fail = (code: string) => Object.assign(new Error(`e2ee_${code}`), { code })
export const MemberOfferSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    genesisHash: hash,
    genesisRecordHex: bytes.max(16384),
    endorser: hash,
    token: hash,
    mode: z.enum(['email', 'link']),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
const packageSchema = z
  .object({
    version: z.literal(1),
    requestHex: bytes.max(1024),
    credentialHash: hash,
    bindingSignature: z.string().regex(/^[0-9a-f]{128}$/)
  })
  .strict()
const encode = (value: unknown) => hex(new TextEncoder().encode(JSON.stringify(value)))
function sql<A>(work: () => A): Effect.Effect<A, unknown> {
  return Effect.try({
    try: work,
    catch: (cause) => {
      rememberDesktopE2eeFailure('member-join', cause)
      return cause instanceof Error && 'code' in cause ? cause : fail('storage')
    }
  })
}

/** Decode public proof only. Genuine ledger admission verifies the consent signature. */
export function decodeMemberKeyPackage(source: string) {
  if (!bytes.max(8192).safeParse(source).success) throw fail('invalid-input')
  const value = packageSchema.parse(JSON.parse(Buffer.from(source, 'hex').toString('utf8')))
  const fields = ok(decodeCbor(raw(value.requestHex)))
  if (!Array.isArray(fields) || fields.length !== 6) throw fail('invalid-input')
  const request: JoinRequest = {
    requestId: ok(Bytes.requestId(fields[0])),
    userId: ok(Bytes.userId(fields[1])),
    signingPublicKey: ok(Bytes.signingPublicKey(fields[2])),
    encryptionPublicKey: ok(Bytes.encryptionPublicKey(fields[3])),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(fields[4]),
    signature: ok(Bytes.signature(fields[5]))
  }
  if (hex(ok(encodeCbor(fields))) !== value.requestHex) throw fail('invalid-input')
  return { ...value, request }
}

/** Shared fixed full-history verification, preserving the native host's public error vocabulary. */
export const verifyMemberHistory = Effect.fnUntraced(function* (
  offer: Pick<E2eeMemberOffer, 'workspaceId' | 'genesisHash' | 'genesisRecordHex'>,
  pages: readonly E2eeWorkspaceHistoryPage[]
) {
  return yield* verifyPersonalHistory(offer, pages).pipe(
    Effect.mapError((error) =>
      error instanceof PersonalHostError ? fail('invalid-ledger') : error
    )
  )
})

type JoinRow = { offer: string; key_package: string | null; history: string | null }
/** Account-bootstrap-owned native journal. Every public request is saved before it can leave the host. */
export function makeDesktopMemberJoins(input: { db: DatabaseSync; custody: DesktopE2eeCustody }) {
  const { db, custody } = input
  db.exec(
    'CREATE TABLE IF NOT EXISTS member_joins(workspace_id TEXT PRIMARY KEY,offer TEXT NOT NULL,key_package TEXT,history TEXT)'
  )
  const rowFor = (id: string) =>
    db.prepare('SELECT * FROM member_joins WHERE workspace_id=?').get(id) as JoinRow | undefined
  const pending = (workspaceId: string) =>
    sql(() => {
      const row = rowFor(workspaceId)
      if (!row || row.history) return null
      const offer = MemberOfferSchema.parse(JSON.parse(row.offer))
      return { offer, keyPackageHex: row.key_package }
    })
  const origin = Effect.fnUntraced(function* (workspaceId: string) {
    const row = yield* sql(() => rowFor(workspaceId))
    if (!row?.history || !row.key_package) return yield* Effect.fail(fail('missing-binding'))
    const offer = yield* sql(() => MemberOfferSchema.parse(JSON.parse(row.offer)))
    const historyPages = yield* sql(() => JSON.parse(row.history!) as E2eeWorkspaceHistoryPage[])
    const view = yield* verifyMemberHistory(offer, historyPages)
    const proof = yield* sql(() => decodeMemberKeyPackage(row.key_package!))
    const device = yield* custody.openDevice(ok(Bytes.genesisHash(raw(offer.genesisHash))))
    const own = view.inspectState().devices.get(hex(device.publicKey.toBytes()))
    const member = own && view.inspectState().members.get(hex(own.membershipId.toBytes()))
    if (
      !own ||
      own.kind !== 'personal' ||
      !member ||
      !member.userId.equals(proof.request.userId) ||
      !device.publicKey.equals(proof.request.signingPublicKey) ||
      !device.enc.equals(proof.request.encryptionPublicKey) ||
      !own.encryptionPublicKey.equals(device.enc)
    )
      return yield* Effect.fail(fail('invalid-ledger'))
    const credential = yield* custody.deviceCredential(
      ok(Bytes.genesisHash(raw(offer.genesisHash))),
      device.publicKey
    )
    if (createHash('sha256').update(raw(credential)).digest('hex') !== proof.credentialHash)
      return yield* Effect.fail(fail('corrupt'))
    return {
      genesisHash: offer.genesisHash,
      record: raw(offer.genesisRecordHex),
      epochBlob: null,
      invitation: undefined,
      historyPages
    }
  })
  return {
    pending,
    retire: (expected: { offer: E2eeMemberOffer; keyPackageHex: string | null }) =>
      sql(() => {
        const row = rowFor(expected.offer.workspaceId)
        if (
          !row ||
          row.history ||
          row.offer !== JSON.stringify(expected.offer) ||
          row.key_package !== expected.keyPackageHex
        )
          throw fail('conflict')
        db.prepare('DELETE FROM member_joins WHERE workspace_id=?').run(expected.offer.workspaceId)
      }),
    has: (workspaceId: string) => sql(() => Boolean(rowFor(workspaceId)?.history)),
    prepare: Effect.fnUntraced(function* (source: E2eeMemberOffer, cryptoUserId: string) {
      const offer = yield* sql(() => MemberOfferSchema.parse(source))
      const genesis = ok(Bytes.genesisHash(raw(offer.genesisHash)))
      if (
        custody.protection !== 'os-keystore' ||
        hex(hashRecordBytes(raw(offer.genesisRecordHex)).toBytes()) !== offer.genesisHash
      )
        return yield* Effect.fail(fail('invalid-input'))
      yield* verifyLedgerEffect({
        anchor: genesis,
        records: [raw(offer.genesisRecordHex)],
        checkpoint: { length: 1, head: ok(Bytes.recordHash(raw(offer.genesisHash))) }
      })
      const encoded = JSON.stringify(offer)
      const row = yield* sql(() => {
        const old = rowFor(offer.workspaceId)
        if (old && old.offer !== encoded) throw fail('conflict')
        db.prepare('INSERT OR IGNORE INTO member_joins(workspace_id,offer) VALUES(?,?)').run(
          offer.workspaceId,
          encoded
        )
        return rowFor(offer.workspaceId)!
      })
      if (row.key_package) return { offer, keyPackageHex: row.key_package }
      const device = yield* custody.createDevice(genesis)
      const credential = yield* custody.prepareDeviceCredential(genesis, device.publicKey)
      const request = yield* prepareJoinRequest({
        genesis,
        requestId: ok(Bytes.requestId(randomBytes(16))),
        userId: ok(Bytes.userId(raw(cryptoUserId))),
        encryptionPublicKey: device.enc,
        expiresAt: offer.expiresAt,
        signer: device
      })
      const binding = yield* signDeviceCredentialBinding({
        genesis,
        pairingSessionId: request.requestId.toBytes(),
        signingPublicKey: device.publicKey,
        credentialHash: raw(credential.credentialHash),
        signer: device
      })
      const keyPackageHex = encode({
        version: 1,
        requestHex: hex(
          ok(
            encodeCbor([
              request.requestId.toBytes(),
              request.userId.toBytes(),
              request.signingPublicKey.toBytes(),
              request.encryptionPublicKey.toBytes(),
              request.expiresAt,
              request.signature.toBytes()
            ])
          )
        ),
        credentialHash: credential.credentialHash,
        bindingSignature: hex(binding.toBytes())
      })
      yield* sql(() => {
        db.prepare(
          'UPDATE member_joins SET key_package=? WHERE workspace_id=? AND key_package IS NULL'
        ).run(keyPackageHex, offer.workspaceId)
        if (rowFor(offer.workspaceId)?.key_package !== keyPackageHex) throw fail('corrupt')
      })
      return { offer, keyPackageHex }
    }),
    accept: Effect.fnUntraced(function* (
      workspaceId: string,
      pages: readonly E2eeWorkspaceHistoryPage[]
    ) {
      const row = yield* sql(() => rowFor(workspaceId))
      if (!row?.key_package) return yield* Effect.fail(fail('missing-binding'))
      // Store only a fully verified, self-admitting endpoint. Existing originals remain immutable.
      const offer = yield* sql(() => MemberOfferSchema.parse(JSON.parse(row.offer)))
      const view = yield* verifyMemberHistory(offer, pages)
      const proof = yield* sql(() => decodeMemberKeyPackage(row.key_package!))
      const own = view.inspectState().devices.get(hex(proof.request.signingPublicKey.toBytes()))
      const member = own && view.inspectState().members.get(hex(own.membershipId.toBytes()))
      if (
        !own ||
        own.kind !== 'personal' ||
        !member?.userId.equals(proof.request.userId) ||
        !own.encryptionPublicKey.equals(proof.request.encryptionPublicKey)
      )
        return yield* Effect.fail(fail('invalid-ledger'))
      yield* sql(() => {
        if (row.history) return
        db.prepare(
          'UPDATE member_joins SET history=? WHERE workspace_id=? AND history IS NULL'
        ).run(JSON.stringify(pages), workspaceId)
      })
      yield* origin(workspaceId)
      return undefined
    }),
    origin
  }
}

/** Runtime-owned approval journal, shared with the existing serialized ledger owner. */
export function makeDesktopMemberApprovals(input: {
  db: DatabaseSync
  workspaceId: string
  genesis: Bytes.GenesisHash
  genesisRecord: Uint8Array
  signer: DeviceSigner
  current: () => Effect.Effect<LedgerView, unknown>
}) {
  const { db } = input
  db.exec(
    'CREATE TABLE IF NOT EXISTS member_admissions(submission_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,key_package TEXT NOT NULL,record BLOB NOT NULL); CREATE INDEX IF NOT EXISTS member_admissions_by_request ON member_admissions(request_id)'
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS member_previews(request_id TEXT PRIMARY KEY,key_package TEXT NOT NULL)'
  )
  return {
    inspect: Effect.fnUntraced(function* (keyPackageHex: string) {
      const proof = yield* sql(() => decodeMemberKeyPackage(keyPackageHex))
      const view = yield* input.current()
      yield* Effect.fromResult(
        verifyDeviceCredentialBinding(
          {
            genesis: input.genesis,
            pairingSessionId: proof.request.requestId.toBytes(),
            signingPublicKey: proof.request.signingPublicKey,
            credentialHash: raw(proof.credentialHash)
          },
          raw(proof.bindingSignature)
        )
      )
      if (!view.inspectState().devices.has(hex(proof.request.signingPublicKey.toBytes())))
        yield* Effect.fromResult(
          prepareLedgerCommand(view, input.signer.publicKey, {
            _tag: 'AdmitMember',
            membershipId: ok(Bytes.membershipId(proof.request.requestId.toBytes())),
            request: proof.request
          })
        )
      yield* sql(() => {
        const id = hex(proof.request.requestId.toBytes())
        db.prepare('INSERT OR IGNORE INTO member_previews(request_id,key_package) VALUES(?,?)').run(
          id,
          keyPackageHex
        )
        if (
          db.prepare('SELECT key_package FROM member_previews WHERE request_id=?').get(id)
            ?.key_package !== keyPackageHex
        )
          throw fail('conflict')
      })
    }),
    offer: Effect.fnUntraced(function* (mode: 'email' | 'link', expiresAt: number) {
      const view = yield* input.current()
      const device = view.inspectState().devices.get(hex(input.signer.publicKey.toBytes()))
      const member = device && view.inspectState().members.get(hex(device.membershipId.toBytes()))
      if (device?.kind !== 'personal' || !member || !['owner', 'admin'].includes(member.role))
        return yield* Effect.fail(fail('unauthorized'))
      return {
        version: 1 as const,
        workspaceId: input.workspaceId,
        genesisHash: hex(input.genesis.toBytes()),
        genesisRecordHex: hex(input.genesisRecord),
        endorser: hex(input.signer.publicKey.toBytes()),
        token: randomBytes(32).toString('hex'),
        mode,
        expiresAt
      }
    }),
    prepare: Effect.fnUntraced(function* (keyPackageHex: string) {
      const proof = yield* sql(() => decodeMemberKeyPackage(keyPackageHex))
      const requestId = hex(proof.request.requestId.toBytes())
      yield* sql(() => {
        if (
          db.prepare('SELECT key_package FROM member_previews WHERE request_id=?').get(requestId)
            ?.key_package !== keyPackageHex
        )
          throw fail('conflict')
      })
      yield* Effect.fromResult(
        verifyDeviceCredentialBinding(
          {
            genesis: input.genesis,
            pairingSessionId: proof.request.requestId.toBytes(),
            signingPublicKey: proof.request.signingPublicKey,
            credentialHash: raw(proof.credentialHash)
          },
          raw(proof.bindingSignature)
        )
      )
      const view = yield* input.current()
      const admitted = view
        .inspectState()
        .devices.get(hex(proof.request.signingPublicKey.toBytes()))
      if (admitted) {
        const member = view.inspectState().members.get(hex(admitted.membershipId.toBytes()))
        if (
          !member?.userId.equals(proof.request.userId) ||
          !admitted.encryptionPublicKey.equals(proof.request.encryptionPublicKey)
        )
          return yield* Effect.fail(fail('conflict'))
        return null
      }
      const previous = yield* sql(() =>
        db
          .prepare('SELECT * FROM member_admissions WHERE request_id=? ORDER BY rowid DESC LIMIT 1')
          .get(requestId)
      )
      if (previous) {
        if (previous.key_package !== keyPackageHex || !(previous.record instanceof Uint8Array))
          return yield* Effect.fail(fail('conflict'))
        const signed = ok(decodeRecord(previous.record))
        if (signed.body.type !== 'ordinary') return yield* Effect.fail(fail('corrupt'))
        const oldParent = signed.body.previousHash
        const oldHash = hashRecordBytes(previous.record)
        const disposition = yield* sql(() => {
          let occupied = false
          for (const row of db
            .prepare('SELECT record FROM records WHERE position < ?')
            .all(view.length)) {
            if (!(row.record instanceof Uint8Array)) throw fail('corrupt')
            if (hashRecordBytes(row.record).equals(oldHash)) return 'committed'
            const body = ok(decodeRecord(row.record)).body
            if (body.type === 'ordinary' && body.previousHash.equals(oldParent)) occupied = true
          }
          return occupied ? 'lost' : 'unknown'
        })
        if (disposition === 'committed') return yield* Effect.fail(fail('unauthorized'))
        if (disposition === 'unknown')
          return {
            workspaceId: input.workspaceId,
            requestId: String(previous.submission_id),
            recordHex: hex(previous.record),
            credentialHash: proof.credentialHash
          }
        // Only this new approval invocation, after verified competing bytes, may
        // prepare another parent. Every prior submission remains in the journal.
      }
      const proposal = yield* Effect.fromResult(
        prepareLedgerCommand(view, input.signer.publicKey, {
          _tag: 'AdmitMember',
          membershipId: ok(Bytes.membershipId(proof.request.requestId.toBytes())),
          request: proof.request
        })
      )
      const record = yield* signLedgerRecord(proposal, input.signer)
      const submissionId = `member-${randomUUID()}`
      yield* sql(() =>
        db
          .prepare(
            'INSERT INTO member_admissions(request_id,key_package,submission_id,record) VALUES(?,?,?,?)'
          )
          .run(requestId, keyPackageHex, submissionId, record)
      )
      return {
        workspaceId: input.workspaceId,
        requestId: submissionId,
        recordHex: hex(record),
        credentialHash: proof.credentialHash
      }
    })
  }
}
