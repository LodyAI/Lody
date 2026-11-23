import { randomBytes } from 'node:crypto'
import { Clock, Effect, Result } from 'effect'
import { decodeRecord, hashRecordBytes, signVerified } from '@lody/e2ee-core/protocol'
import {
  RemoteMachineOfferSchema,
  remoteMachineOfferBytes,
  remoteMachineSummary,
  type RemoteMachineOffer
} from '@lody/shared/e2ee-remote-pairing'
import type { LocalE2eePrepareResponse } from '@lody/shared/e2ee-local-pairing'
import { makeDesktopLocalPairing } from './e2ee-local-pairing.mjs'
// Coded so the host boundary reports a conflict or bad input, not a ledger failure.
const fail = (code: 'conflict' | 'invalid-input' = 'conflict') =>
  Object.assign(
    new Error(code === 'conflict' ? 'e2ee_machine_pairing_conflict' : 'e2ee_invalid-input'),
    { code }
  )
const OfferEndpointsSchema = RemoteMachineOfferSchema.pick({
  deploymentUrl: true,
  ingressUrl: true
})
/** Same native owner/serialization as local approval, with a separate journal and command pins. */
export function makeDesktopRemotePairing(input: Parameters<typeof makeDesktopLocalPairing>[0]) {
  const pairing = makeDesktopLocalPairing({ ...input, journal: 'remote' })
  input.db.exec(
    'CREATE TABLE IF NOT EXISTS remote_machine_offers(session TEXT PRIMARY KEY, offer TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0)'
  )
  input.db.exec(
    'CREATE TABLE IF NOT EXISTS remote_pairing_archive(session TEXT PRIMARY KEY, material TEXT, request_id TEXT, record BLOB)'
  )
  function sql<A>(work: () => A) {
    return Effect.try({ try: work, catch: () => fail() })
  }

  const saved = (session?: string): RemoteMachineOffer => {
    const row = session
      ? input.db
          .prepare('SELECT offer FROM remote_machine_offers WHERE session=? AND retired=0')
          .get(session)
      : input.db.prepare('SELECT offer FROM remote_machine_offers WHERE retired=0').get()
    if (typeof row?.offer !== 'string') throw fail()
    return RemoteMachineOfferSchema.parse(JSON.parse(row.offer))
  }
  const offer = Effect.fnUntraced(function* (args: {
    accountId: string
    deploymentUrl: string
    ingressUrl: string
  }) {
    const previous = yield* sql(() =>
      input.db.prepare('SELECT session FROM remote_machine_offers WHERE retired=0').get()
    )
    if (previous) return yield* sql(() => saved())
    // The signed command only carries HTTPS origins; refuse before signing.
    if (
      !OfferEndpointsSchema.safeParse({
        deploymentUrl: args.deploymentUrl,
        ingressUrl: args.ingressUrl
      }).success
    )
      return yield* Effect.fail(fail('invalid-input'))
    const context = yield* pairing.context()
    const now = yield* Clock.currentTimeMillis
    const unsigned = {
      version: 1 as const,
      ...context,
      ...args,
      expiresAt: now + 10 * 60_000,
      token: randomBytes(32).toString('hex')
    }
    const signature = yield* signVerified(input.signer, remoteMachineOfferBytes(unsigned))
    const result = yield* sql(() =>
      RemoteMachineOfferSchema.parse({
        ...unsigned,
        signature: Buffer.from(signature.toBytes()).toString('hex')
      })
    )
    yield* sql(() =>
      input.db
        .prepare('INSERT INTO remote_machine_offers(session,offer) VALUES(?,?)')
        .run(result.pairingSessionId, JSON.stringify(result))
    )
    return result
  })
  const stage = Effect.fnUntraced(function* (session: string, material: LocalE2eePrepareResponse) {
    const command = yield* sql(() => saved(session))
    if (material.pairingSessionId !== command.pairingSessionId) return yield* Effect.fail(fail())
    yield* pairing.stage(material)
    return yield* Effect.tryPromise({
      try: () => remoteMachineSummary(command, material),
      catch: () => fail()
    })
  })
  const approve = Effect.fnUntraced(function* (session: string, summary: string) {
    const command = yield* sql(() => saved(session))
    const material = yield* sql(() => {
      const row = input.db
        .prepare('SELECT session,material FROM remote_local_pairing WHERE id=1')
        .get()
      if (row?.session !== session || typeof row?.material !== 'string') throw fail()
      return JSON.parse(row.material) as LocalE2eePrepareResponse
    })
    const expected = yield* Effect.tryPromise({
      try: () => remoteMachineSummary(command, material),
      catch: () => fail()
    })
    if (summary !== expected) return yield* Effect.fail(fail())
    const request = yield* pairing.approve(session)
    return request ? { ...request, machinePairingSessionId: session } : null
  })
  /** Called only after the server confirms a terminal state. Archive evidence, never erase originals. */
  const retire = Effect.fnUntraced(function* (session: string, noAdmissionReserved = false) {
    const view = yield* input.current()
    yield* sql(() => {
      saved(session)
      const signed = input.db
        .prepare('SELECT record FROM remote_local_pairing WHERE session=?')
        .get(session)?.record
      if (signed instanceof Uint8Array && !noAdmissionReserved) {
        const body = Result.getOrThrow(decodeRecord(signed)).body
        if (body.type !== 'ordinary') throw fail()
        const originals = input.db
          .prepare('SELECT record FROM records WHERE position < ?')
          .all(view.length)
        if (
          !originals.some((row) => {
            if (!(row.record instanceof Uint8Array)) return false
            if (hashRecordBytes(row.record).equals(hashRecordBytes(signed))) return true
            const next = Result.getOrThrow(decodeRecord(row.record)).body
            return next.type === 'ordinary' && next.previousHash.equals(body.previousHash)
          })
        )
          throw fail()
      }
      input.db.exec('BEGIN IMMEDIATE')
      try {
        input.db
          .prepare(
            'INSERT OR IGNORE INTO remote_pairing_archive SELECT session,material,request_id,record FROM remote_local_pairing WHERE session=?'
          )
          .run(session)
        input.db.prepare('UPDATE remote_machine_offers SET retired=1 WHERE session=?').run(session)
        input.db.prepare('DELETE FROM remote_local_pairing WHERE session=?').run(session)
        input.db.exec('COMMIT')
      } catch (error) {
        input.db.exec('ROLLBACK')
        throw error
      }
    })
  })
  return { offer, stage, approve, confirmed: pairing.confirmed, retire }
}
