import { rememberDesktopE2eeFailure } from './e2ee-diagnostics.mjs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { Effect, Result } from 'effect'
import { z } from 'zod'
import {
  verifyWorkspaceInvitationSnapshot,
  type WorkspaceInvitation,
  type WorkspaceInvitationSnapshot
} from '@lody/e2ee-core'
import {
  Bytes,
  hashRecordBytes,
  decodeRecord,
  recordSigningBytes,
  verifySignature,
  prepareDeviceAdmission,
  prepareLedgerCommand,
  signLedgerRecord,
  signLedgerSnapshot,
  signDeviceCredentialBinding,
  verifyDeviceCredentialBinding,
  verifyLedgerEffect,
  type DeviceSigner,
  type LedgerView
} from '@lody/e2ee-core/protocol'
import type { DesktopE2eeCustody } from '../e2ee-custody.mjs'

const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex')
const raw = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'hex'))
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const session = z.string().regex(/^[0-9a-f]{32}$/)
const signature = z.string().regex(/^[0-9a-f]{128}$/)
const workspace = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const PersonalPairingOfferSchema = z
  .object({
    version: z.literal(1),
    workspaceId: workspace,
    genesisHash: hash,
    genesisRecordHex: z
      .string()
      .regex(/^(?:[0-9a-f]{2})+$/)
      .max(16384),
    endorser: hash,
    membershipId: session,
    pairingSessionId: session
  })
  .strict()
/** Independently transferred by the approving desktop; mailbox data never chooses these pins. */
export type PersonalPairingOffer = z.infer<typeof PersonalPairingOfferSchema>
const requestSchema = PersonalPairingOfferSchema.extend({
  signingPublicKey: hash,
  encryptionPublicKey: hash,
  credentialHash: hash,
  possessionSignature: signature,
  bindingSignature: signature,
  protection: z.literal('os-keystore')
}).strict()
export type PersonalPairingRequest = z.infer<typeof requestSchema>
const fail = (code: string): Error & { code: string } =>
  Object.assign(new Error(`e2ee_${code}`), { code })
function sql<A>(work: () => A): Effect.Effect<A, unknown> {
  return Effect.try({
    try: work,
    catch: (error) => {
      rememberDesktopE2eeFailure('personal-pairing-sql', error)
      return error instanceof Error && 'code' in error ? error : fail('storage')
    }
  })
}
function decodeRequest(value: string): PersonalPairingRequest {
  if (typeof value !== 'string' || value.length > 16384 || !/^(?:[0-9a-f]{2})+$/.test(value))
    throw fail('invalid-input')
  const parsed = requestSchema.safeParse(JSON.parse(Buffer.from(value, 'hex').toString('utf8')))
  if (!parsed.success) throw fail('invalid-input')
  return parsed.data
}
/** Versioned public transport bundle; signatures cover the original core bytes. */
export function encodePersonalInvitation(
  receipt: Parameters<typeof verifyWorkspaceInvitationSnapshot>[1]
): string {
  return hex(
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        workspaceId: receipt.workspaceId,
        snapshot: Buffer.from(receipt.snapshot).toString('base64'),
        head: hex(receipt.head.toBytes()),
        length: receipt.length,
        headSignature: hex(receipt.headSignature.toBytes()),
        offset: receipt.offset
      })
    )
  )
}
const invitationSchema = z
  .object({
    version: z.literal(1),
    workspaceId: workspace,
    snapshot: z
      .string()
      .min(4)
      .max(2796204)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    head: hash,
    length: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    headSignature: signature,
    offset: z.string().min(1).max(1024)
  })
  .strict()
export function decodePersonalInvitation(value: string): WorkspaceInvitationSnapshot {
  if (
    typeof value !== 'string' ||
    value.length > 6 * 1024 * 1024 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(value)
  )
    throw fail('invalid-input')
  const parsed = invitationSchema.safeParse(JSON.parse(Buffer.from(value, 'hex').toString('utf8')))
  if (!parsed.success) throw fail('invalid-input')
  const data = parsed.data,
    snapshot = Buffer.from(data.snapshot, 'base64')
  if (snapshot.length > 2 * 1024 * 1024 || snapshot.toString('base64') !== data.snapshot)
    throw fail('invalid-input')
  return {
    workspaceId: data.workspaceId,
    snapshot: new Uint8Array(snapshot),
    head: Result.getOrThrow(Bytes.recordHash(raw(data.head))),
    length: data.length,
    headSignature: Result.getOrThrow(Bytes.signature(raw(data.headSignature))),
    offset: data.offset
  }
}
function invitationPin(pin: PersonalPairingOffer): WorkspaceInvitation {
  return {
    workspaceId: pin.workspaceId,
    genesis: Result.getOrThrow(Bytes.genesisHash(raw(pin.genesisHash))),
    endorser: Result.getOrThrow(Bytes.signingPublicKey(raw(pin.endorser)))
  }
}

interface PersonalJoinPrepared {
  workspaceId: string
  pairingSessionId: string
  signingPublicKey: string
  credentialHash: string
  requestHex: string
}
interface PersonalJoinOrigin {
  genesisHash: string
  record: Uint8Array
  epochBlob: null
  invitation: Result.Result.Success<ReturnType<typeof verifyWorkspaceInvitationSnapshot>>
  invitationHex: string
}
interface PersonalJoins {
  pending(workspaceId: string): Effect.Effect<
    {
      offer: PersonalPairingOffer
      pairingSessionId: string
      signingPublicKey?: string
      credentialHash?: string
      requestHex?: string
    } | null,
    unknown
  >
  prepare(offer: PersonalPairingOffer): Effect.Effect<PersonalJoinPrepared, unknown>
  retire(workspaceId: string, pairingSessionId: string): Effect.Effect<void, unknown>
  accept(workspaceId: string, invitationHex: string): Effect.Effect<void, unknown>
  origin(workspaceId: string, supplied?: string): Effect.Effect<PersonalJoinOrigin, unknown>
}
interface PersonalPairing {
  offer(): Effect.Effect<PersonalPairingOffer, unknown>
  preview(requestHex: string): Effect.Effect<
    {
      pairingSessionId: string
      signingPublicKey: string
      encryptionPublicKey: string
      credentialHash: string
      protection: 'os-keystore'
    },
    unknown
  >
  approve(requestHex: string): Effect.Effect<
    {
      workspaceId: string
      pairingSessionId: string
      requestId: string
      recordHex: string
      credentialHash: string
    },
    unknown
  >
  invitation(session: string): Effect.Effect<{ invitationHex: string }, unknown>
  retire(session: string): Effect.Effect<void, unknown>
  /** Only after the main process reconciles the service's terminal non-reservation response. */
  cancel(session: string): Effect.Effect<void, unknown>
}
type PersonalJoinRow = { pin: string; request_hex: string | null; invitation_hex: string | null }

/** Local recipient journal, serialized by bootstrap's account mutex. No network is performed. */
export function makeDesktopPersonalJoins(input: {
  db: DatabaseSync
  custody: DesktopE2eeCustody
}): PersonalJoins {
  const { db, custody } = input
  db.exec(
    'CREATE TABLE IF NOT EXISTS personal_joins(workspace_id TEXT PRIMARY KEY, pin TEXT NOT NULL, request_hex TEXT, invitation_hex TEXT); CREATE TABLE IF NOT EXISTS retired_personal_joins(workspace_id TEXT NOT NULL, pin TEXT NOT NULL, request_hex TEXT, PRIMARY KEY(workspace_id,pin))'
  )
  const rowFor = (workspaceId: string): PersonalJoinRow | undefined =>
    db.prepare('SELECT * FROM personal_joins WHERE workspace_id=?').get(workspaceId) as
      | { pin: string; request_hex: string | null; invitation_hex: string | null }
      | undefined
  const prepare = Effect.fnUntraced(function* (source: PersonalPairingOffer) {
    const parsed = PersonalPairingOfferSchema.safeParse(source)
    if (!parsed.success || custody.protection !== 'os-keystore')
      return yield* Effect.fail(fail('invalid-input'))
    const pin = parsed.data
    const genesis = Result.getOrThrow(Bytes.genesisHash(raw(pin.genesisHash)))
    const originalGenesis = raw(pin.genesisRecordHex)
    if (hex(hashRecordBytes(originalGenesis).toBytes()) !== pin.genesisHash)
      return yield* Effect.fail(fail('invalid-input'))
    yield* verifyLedgerEffect({
      anchor: genesis,
      records: [originalGenesis],
      checkpoint: { head: hashRecordBytes(originalGenesis), length: 1 }
    })
    const encoded = JSON.stringify(pin)
    const row = yield* sql(() => {
      const retired = db
        .prepare(
          'SELECT pin,request_hex FROM retired_personal_joins WHERE workspace_id=? ORDER BY rowid DESC LIMIT 1'
        )
        .get(pin.workspaceId)
      if (retired) {
        const previous = PersonalPairingOfferSchema.parse(JSON.parse(String(retired.pin)))
        if (
          Object.keys(previous).some(
            (key) =>
              key !== 'pairingSessionId' &&
              previous[key as keyof PersonalPairingOffer] !== pin[key as keyof PersonalPairingOffer]
          )
        )
          throw fail('conflict')
        if (previous.pairingSessionId === pin.pairingSessionId) throw fail('conflict')
      }
      const old = rowFor(pin.workspaceId)
      if (old && old.pin !== encoded) throw fail('conflict')
      db.prepare('INSERT OR IGNORE INTO personal_joins(workspace_id,pin) VALUES(?,?)').run(
        pin.workspaceId,
        encoded
      )
      const stored = rowFor(pin.workspaceId)!
      if (stored.pin !== encoded) throw fail('conflict')
      return {
        ...stored,
        retiredRequest: retired?.request_hex ? decodeRequest(String(retired.request_hex)) : null
      }
    })
    // Both originals are durable before the signed public request can leave this host.
    const device = yield* row.request_hex || row.retiredRequest
      ? custody.openDevice(genesis)
      : custody.createDevice(genesis)
    const credential =
      row.request_hex || row.retiredRequest
        ? yield* custody.deviceCredential(genesis, device.publicKey).pipe(
            Effect.map((value) => ({
              credentialHash: createHash('sha256').update(raw(value)).digest('hex')
            }))
          )
        : yield* custody.prepareDeviceCredential(genesis, device.publicKey)
    if (
      row.retiredRequest &&
      (hex(device.publicKey.toBytes()) !== row.retiredRequest.signingPublicKey ||
        hex(device.enc.toBytes()) !== row.retiredRequest.encryptionPublicKey ||
        credential.credentialHash !== row.retiredRequest.credentialHash)
    )
      return yield* Effect.fail(fail('corrupt'))
    if (!row.request_hex) {
      const admission = yield* prepareDeviceAdmission({
        genesis,
        membershipId: Result.getOrThrow(Bytes.membershipId(raw(pin.membershipId))),
        encryptionPublicKey: device.enc,
        kind: 'personal',
        signer: device
      })
      const bound = yield* signDeviceCredentialBinding({
        genesis,
        pairingSessionId: raw(pin.pairingSessionId),
        signingPublicKey: device.publicKey,
        credentialHash: raw(credential.credentialHash),
        signer: device
      })
      const request: PersonalPairingRequest = {
        ...pin,
        signingPublicKey: hex(device.publicKey.toBytes()),
        encryptionPublicKey: hex(device.enc.toBytes()),
        credentialHash: credential.credentialHash,
        possessionSignature: hex(admission.possessionSignature.toBytes()),
        bindingSignature: hex(bound.toBytes()),
        protection: 'os-keystore'
      }
      const requestHex = hex(new TextEncoder().encode(JSON.stringify(request)))
      yield* sql(() =>
        db
          .prepare(
            'UPDATE personal_joins SET request_hex=? WHERE workspace_id=? AND request_hex IS NULL'
          )
          .run(requestHex, pin.workspaceId)
      )
    }
    const original = yield* sql(() => rowFor(pin.workspaceId)!.request_hex!)
    const request = yield* sql(() => decodeRequest(original))
    if (
      request.signingPublicKey !== hex(device.publicKey.toBytes()) ||
      request.encryptionPublicKey !== hex(device.enc.toBytes()) ||
      request.credentialHash !== credential.credentialHash
    )
      return yield* Effect.fail(fail('corrupt'))
    yield* Effect.fromResult(
      verifyDeviceCredentialBinding(
        {
          genesis,
          pairingSessionId: raw(pin.pairingSessionId),
          signingPublicKey: device.publicKey,
          credentialHash: raw(request.credentialHash)
        },
        raw(request.bindingSignature)
      )
    )
    return {
      workspaceId: pin.workspaceId,
      pairingSessionId: pin.pairingSessionId,
      signingPublicKey: request.signingPublicKey,
      credentialHash: request.credentialHash,
      requestHex: original
    }
  })
  const origin = Effect.fnUntraced(function* (workspaceId: string, supplied?: string) {
    const row = yield* sql(() => rowFor(workspaceId))
    if (!row || !row.request_hex || (!row.invitation_hex && supplied === undefined))
      return yield* Effect.fail(fail('missing-binding'))
    const pin = yield* sql(() => PersonalPairingOfferSchema.parse(JSON.parse(row.pin)))
    const request = yield* sql(() => decodeRequest(row.request_hex!))
    const receipt = yield* sql(() => decodePersonalInvitation(supplied ?? row.invitation_hex!))
    if (row.invitation_hex && supplied !== undefined && row.invitation_hex !== supplied)
      return yield* Effect.fail(fail('conflict'))
    const checked = yield* Effect.fromResult(
      verifyWorkspaceInvitationSnapshot(invitationPin(pin), receipt)
    )
    const device = yield* custody.openDevice(checked.pin.genesis)
    const state = checked.view.inspectState()
    const admitted = state.devices.get(hex(device.publicKey.toBytes()))
    if (
      !admitted ||
      admitted.kind !== 'personal' ||
      hex(admitted.membershipId.toBytes()) !== pin.membershipId ||
      hex(admitted.encryptionPublicKey.toBytes()) !== request.encryptionPublicKey ||
      hex(device.publicKey.toBytes()) !== request.signingPublicKey ||
      hex(device.enc.toBytes()) !== request.encryptionPublicKey
    )
      return yield* Effect.fail(fail('invalid-ledger'))
    const credential = yield* custody.deviceCredential(checked.pin.genesis, device.publicKey)
    if (createHash('sha256').update(raw(credential)).digest('hex') !== request.credentialHash)
      return yield* Effect.fail(fail('corrupt'))
    return {
      genesisHash: pin.genesisHash,
      record: raw(pin.genesisRecordHex),
      epochBlob: null,
      invitation: checked,
      invitationHex: supplied ?? row.invitation_hex!
    }
  })
  return {
    pending: (workspaceId: string) =>
      sql(() => {
        const row = rowFor(workspaceId)
        if (!row || row.invitation_hex) return null
        const offer = PersonalPairingOfferSchema.parse(JSON.parse(row.pin))
        if (offer.workspaceId !== workspaceId) throw fail('corrupt')
        const request = row.request_hex ? decodeRequest(row.request_hex) : undefined
        if (
          request &&
          Object.keys(offer).some(
            (key) =>
              offer[key as keyof PersonalPairingOffer] !==
              request[key as keyof PersonalPairingOffer]
          )
        )
          throw fail('corrupt')
        return {
          offer,
          pairingSessionId: offer.pairingSessionId,
          ...(request
            ? {
                signingPublicKey: request.signingPublicKey,
                credentialHash: request.credentialHash,
                requestHex: row.request_hex!
              }
            : {})
        }
      }),
    prepare,
    retire: (workspaceId: string, pairingSessionId: string) =>
      sql(() => {
        const row = rowFor(workspaceId)
        if (!row) return
        const pin = PersonalPairingOfferSchema.parse(JSON.parse(row.pin))
        if (pin.pairingSessionId !== pairingSessionId || row.invitation_hex) throw fail('conflict')
        db.exec('BEGIN IMMEDIATE')
        try {
          db.prepare(
            'INSERT OR IGNORE INTO retired_personal_joins(workspace_id,pin,request_hex) VALUES(?,?,?)'
          ).run(workspaceId, row.pin, row.request_hex)
          const saved = db
            .prepare(
              'SELECT request_hex FROM retired_personal_joins WHERE workspace_id=? AND pin=?'
            )
            .get(workspaceId, row.pin)
          if (!saved || saved.request_hex !== row.request_hex) throw fail('corrupt')
          db.prepare('DELETE FROM personal_joins WHERE workspace_id=? AND pin=?').run(
            workspaceId,
            row.pin
          )
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      }),
    accept: Effect.fnUntraced(function* (workspaceId: string, invitationHex: string) {
      yield* origin(workspaceId, invitationHex)
      yield* sql(() => {
        db.prepare(
          'UPDATE personal_joins SET invitation_hex=? WHERE workspace_id=? AND invitation_hex IS NULL'
        ).run(invitationHex, workspaceId)
        if (rowFor(workspaceId)?.invitation_hex !== invitationHex) throw fail('conflict')
      })
    }),
    origin
  }
}

/** Approver journal: explicit approval signs once; transport retries get the saved original. */
export function makeDesktopPersonalPairing(input: {
  db: DatabaseSync
  workspaceId: string
  genesis: Bytes.GenesisHash
  genesisRecord: Uint8Array
  signer: DeviceSigner
  current: () => Effect.Effect<LedgerView, unknown>
  offset: () => Effect.Effect<string, unknown>
}): PersonalPairing {
  const { db } = input
  db.exec(
    'CREATE TABLE IF NOT EXISTS personal_pairing(session TEXT PRIMARY KEY,pin TEXT NOT NULL,request_hex TEXT,request_id TEXT,record BLOB,invitation_hex TEXT,retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN(0,1)))'
  )
  type Row = {
    pin: string
    request_hex: string | null
    request_id: string | null
    record: Uint8Array | null
    invitation_hex: string | null
    retired: number
  }
  const rowFor = (sessionId: string): Row | undefined =>
    db.prepare('SELECT * FROM personal_pairing WHERE session=?').get(sessionId) as Row | undefined
  const manager = (view: LedgerView): Bytes.MembershipId => {
    const state = view.inspectState(),
      own = state.devices.get(hex(input.signer.publicKey.toBytes()))
    const member = own && state.members.get(hex(own.membershipId.toBytes()))
    if (!own || own.kind !== 'personal' || !member || !['owner', 'admin'].includes(member.role))
      throw fail('invalid-input')
    return own.membershipId
  }
  // Only original records below the verified endpoint can settle a signed CAS.
  // A later head or absent target device alone says nothing about an unknown result.
  const disposition = (
    row: Row,
    view: LedgerView
  ): 'unsigned' | 'unknown' | 'committed' | 'lost' => {
    if (!row.record && !row.request_id) return 'unsigned'
    if (!row.record || !row.request_id) throw fail('corrupt')
    const signed = Result.getOrThrow(decodeRecord(row.record))
    if (
      signed.body.type !== 'ordinary' ||
      !signed.body.signer.equals(input.signer.publicKey) ||
      Result.isFailure(
        verifySignature(
          signed.body.signer.toBytes(),
          recordSigningBytes(signed.bodyBytes),
          signed.signature.toBytes()
        )
      )
    )
      throw fail('corrupt')
    const originalHash = hashRecordBytes(row.record)
    const originals = db.prepare('SELECT record FROM records WHERE position < ?').all(view.length)
    if (
      originals.some(
        (item) =>
          item.record instanceof Uint8Array && hashRecordBytes(item.record).equals(originalHash)
      )
    )
      return 'committed'
    const previousHash = signed.body.previousHash
    if (
      originals.some((item) => {
        if (!(item.record instanceof Uint8Array)) throw fail('corrupt')
        const body = Result.getOrThrow(decodeRecord(item.record)).body
        return body.type === 'ordinary' && body.previousHash.equals(previousHash)
      })
    )
      return 'lost'
    return 'unknown'
  }
  const markRetired = (pairingSessionId: string): void => {
    db.prepare('UPDATE personal_pairing SET retired=1 WHERE session=?').run(pairingSessionId)
    if (rowFor(pairingSessionId)?.retired !== 1) throw fail('corrupt')
  }
  const offer = Effect.fnUntraced(function* () {
    const view = yield* input.current()
    return yield* sql(() => {
      const membershipId = hex(manager(view).toBytes())
      const old = db
        .prepare(
          'SELECT * FROM personal_pairing WHERE invitation_hex IS NULL AND retired=0 ORDER BY rowid DESC LIMIT 1'
        )
        .get()
      if (old) {
        const pin = PersonalPairingOfferSchema.parse(JSON.parse(String(old.pin)))
        if (disposition(old as Row, view) !== 'lost') return pin
        markRetired(pin.pairingSessionId)
      }
      const pin: PersonalPairingOffer = {
        version: 1,
        workspaceId: input.workspaceId,
        genesisHash: hex(input.genesis.toBytes()),
        genesisRecordHex: hex(input.genesisRecord),
        endorser: hex(input.signer.publicKey.toBytes()),
        membershipId,
        pairingSessionId: randomBytes(16).toString('hex')
      }
      db.prepare('INSERT INTO personal_pairing(session,pin) VALUES(?,?)').run(
        pin.pairingSessionId,
        JSON.stringify(pin)
      )
      return pin
    })
  })
  const preview = Effect.fnUntraced(function* (requestHex: string) {
    const request = yield* sql(() => decodeRequest(requestHex))
    const view = yield* input.current()
    yield* sql(() => {
      const row = rowFor(request.pairingSessionId)
      const pin = row && PersonalPairingOfferSchema.parse(JSON.parse(row.pin))
      if (
        !row ||
        row.retired ||
        !pin ||
        Object.keys(pin).some(
          (key) =>
            pin[key as keyof PersonalPairingOffer] !== request[key as keyof PersonalPairingOffer]
        ) ||
        hex(manager(view).toBytes()) !== request.membershipId ||
        (row.request_hex && row.request_hex !== requestHex)
      )
        throw fail('conflict')
    })
    const signingPublicKey = Result.getOrThrow(
      Bytes.signingPublicKey(raw(request.signingPublicKey))
    )
    yield* Effect.fromResult(
      verifyDeviceCredentialBinding(
        {
          genesis: input.genesis,
          pairingSessionId: raw(request.pairingSessionId),
          signingPublicKey,
          credentialHash: raw(request.credentialHash)
        },
        raw(request.bindingSignature)
      )
    )
    const admitted = view.inspectState().devices.get(request.signingPublicKey)
    if (admitted) {
      if (
        admitted.kind !== 'personal' ||
        hex(admitted.membershipId.toBytes()) !== request.membershipId ||
        hex(admitted.encryptionPublicKey.toBytes()) !== request.encryptionPublicKey
      )
        return yield* Effect.fail(fail('conflict'))
    } else {
      yield* Effect.fromResult(
        prepareLedgerCommand(view, input.signer.publicKey, {
          _tag: 'AdmitDevice',
          kind: 'personal',
          signingPublicKey,
          encryptionPublicKey: Result.getOrThrow(
            Bytes.encryptionPublicKey(raw(request.encryptionPublicKey))
          ),
          possessionSignature: Result.getOrThrow(Bytes.signature(raw(request.possessionSignature)))
        })
      )
    }
    yield* sql(() => {
      db.prepare(
        'UPDATE personal_pairing SET request_hex=? WHERE session=? AND request_hex IS NULL'
      ).run(requestHex, request.pairingSessionId)
      if (rowFor(request.pairingSessionId)?.request_hex !== requestHex) throw fail('conflict')
    })
    return {
      pairingSessionId: request.pairingSessionId,
      signingPublicKey: request.signingPublicKey,
      encryptionPublicKey: request.encryptionPublicKey,
      credentialHash: request.credentialHash,
      protection: request.protection
    }
  })
  const approve = Effect.fnUntraced(function* (requestHex: string) {
    yield* preview(requestHex)
    const request = yield* sql(() => decodeRequest(requestHex))
    const view = yield* input.current()
    const row = yield* sql(() => {
      const stored = rowFor(request.pairingSessionId)
      const pin = stored && PersonalPairingOfferSchema.parse(JSON.parse(stored.pin))
      if (
        !stored ||
        stored.retired ||
        !pin ||
        Object.keys(pin).some(
          (key) =>
            pin[key as keyof PersonalPairingOffer] !== request[key as keyof PersonalPairingOffer]
        ) ||
        hex(manager(view).toBytes()) !== request.membershipId ||
        (stored.request_hex && stored.request_hex !== requestHex)
      )
        throw fail('conflict')
      return stored
    })
    const signingPublicKey = Result.getOrThrow(
      Bytes.signingPublicKey(raw(request.signingPublicKey))
    )
    yield* Effect.fromResult(
      verifyDeviceCredentialBinding(
        {
          genesis: input.genesis,
          pairingSessionId: raw(request.pairingSessionId),
          signingPublicKey,
          credentialHash: raw(request.credentialHash)
        },
        raw(request.bindingSignature)
      )
    )
    if (!row.record) {
      const proposal = yield* Effect.fromResult(
        prepareLedgerCommand(view, input.signer.publicKey, {
          _tag: 'AdmitDevice',
          kind: 'personal',
          signingPublicKey,
          encryptionPublicKey: Result.getOrThrow(
            Bytes.encryptionPublicKey(raw(request.encryptionPublicKey))
          ),
          possessionSignature: Result.getOrThrow(Bytes.signature(raw(request.possessionSignature)))
        })
      )
      const record = yield* signLedgerRecord(proposal, input.signer)
      yield* sql(() =>
        db
          .prepare(
            'UPDATE personal_pairing SET request_hex=?,request_id=?,record=? WHERE session=? AND record IS NULL'
          )
          .run(requestHex, `personal-device-${randomUUID()}`, record, request.pairingSessionId)
      )
    }
    const original = yield* sql(() => rowFor(request.pairingSessionId)!)
    if (!original.request_id || !original.record || original.request_hex !== requestHex)
      return yield* Effect.fail(fail('corrupt'))
    return {
      workspaceId: input.workspaceId,
      pairingSessionId: request.pairingSessionId,
      requestId: original.request_id,
      recordHex: hex(original.record),
      credentialHash: request.credentialHash
    }
  })
  const invitation = Effect.fnUntraced(function* (pairingSessionId: string) {
    const row = yield* sql(() => rowFor(pairingSessionId))
    if (!row?.record || !row.request_hex) return yield* Effect.fail(fail('missing-binding'))
    const view = yield* input.current()
    yield* sql(() => {
      manager(view)
      const request = decodeRequest(row.request_hex!)
      const admitted = view.inspectState().devices.get(request.signingPublicKey)
      const originals = db.prepare('SELECT record FROM records WHERE position < ?').all(view.length)
      if (
        !admitted ||
        admitted.kind !== 'personal' ||
        hex(admitted.membershipId.toBytes()) !== request.membershipId ||
        hex(admitted.encryptionPublicKey.toBytes()) !== request.encryptionPublicKey ||
        !originals.some(
          (r) => r.record instanceof Uint8Array && Buffer.from(r.record).equals(row.record!)
        )
      )
        throw fail('local-evidence-conflict')
    })
    if (!row.invitation_hex) {
      const signed = yield* signLedgerSnapshot({ signer: input.signer, ledger: input.current })
      const receipt = {
        workspaceId: input.workspaceId,
        snapshot: signed.snapshot,
        head: signed.head,
        length: signed.length,
        headSignature: signed.headSignature,
        offset: yield* input.offset()
      }
      const pin = yield* sql(() => PersonalPairingOfferSchema.parse(JSON.parse(row.pin)))
      yield* Effect.fromResult(verifyWorkspaceInvitationSnapshot(invitationPin(pin), receipt))
      const encoded = encodePersonalInvitation(receipt)
      yield* sql(() =>
        db
          .prepare(
            'UPDATE personal_pairing SET invitation_hex=? WHERE session=? AND invitation_hex IS NULL'
          )
          .run(encoded, pairingSessionId)
      )
    }
    return { invitationHex: yield* sql(() => rowFor(pairingSessionId)!.invitation_hex!) }
  })
  return {
    offer,
    preview,
    approve,
    invitation,
    retire: Effect.fnUntraced(function* (pairingSessionId: string) {
      const view = yield* input.current()
      yield* sql(() => {
        const row = rowFor(pairingSessionId)
        if (!row) return
        if (row.invitation_hex) throw fail('conflict')
        if (row.retired) return
        const state = disposition(row, view)
        if (state !== 'unsigned' && state !== 'lost') throw fail('conflict')
        markRetired(pairingSessionId)
      })
    }),
    cancel: Effect.fnUntraced(function* (pairingSessionId: string) {
      const view = yield* input.current()
      yield* sql(() => {
        const row = rowFor(pairingSessionId)
        if (!row) return
        if (row.invitation_hex) throw fail('conflict')
        if (row.retired) return
        if (disposition(row, view) === 'committed') throw fail('conflict')
        // The service terminal-cancel contract fences every later reservation of
        // this session. This archives local intent; it neither deletes a signed
        // original nor claims to revoke a signature or replace device identity.
        markRetired(pairingSessionId)
      })
    })
  }
}
