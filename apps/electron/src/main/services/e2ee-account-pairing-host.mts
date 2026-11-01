import type { DatabaseSync } from 'node:sqlite'
import { Effect, Result } from 'effect'
import type {
  E2eeAccountPairingReplies,
  E2eeAccountPairingRequests,
  E2eeAppendRecordRequest,
  E2eeDeviceAccess,
  E2eeWorkspaceHistoryPage,
  E2eeWorkspaceHistoryRequest
} from '@lody/cloud-api'
import { decodeRecord, hashRecordBytes } from '@lody/e2ee-core/protocol'
import type { EpochStagingStore, KeyMailbox } from '@lody/e2ee-core/services'
import { rememberDesktopE2eeFailure } from './e2ee-diagnostics.mjs'
import {
  makeDesktopAccountPairing,
  type AccountPairingApproverWorkspace,
  type AccountPairingRequesterWorkspace
} from './e2ee-account-pairing.mjs'
import { verifyMemberHistory } from './e2ee-member-join.mjs'

/**
 * Connects the account-wide pairing workflow to the desktop's per-workspace hosts.
 * Every port step takes its own account-owner turn and runs network work outside
 * it. Authority still comes only from the workflow's tag checks, the verified
 * ledger and the existing per-workspace join verification.
 */

const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex')
const raw = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'hex'))
const fail = (code: string) => Object.assign(new Error(`e2ee_${code}`), { code })

/** The cloud calls this host needs; the desktop cloud client implements them. */
export interface AccountPairingCloud {
  accountIdentity(): Effect.Effect<{ accountId: string; cryptoUserId: string }, unknown>
  history(request: E2eeWorkspaceHistoryRequest): Effect.Effect<E2eeWorkspaceHistoryPage, unknown>
  appendRecord(request: E2eeAppendRecordRequest): Effect.Effect<unknown, unknown>
  /** Key-round services for one device, bound to the current signed-in client. */
  keyServices(access: E2eeDeviceAccess): Effect.Effect<KeyRoundServices, unknown>
  pairingSubmit(
    request: E2eeAccountPairingRequests['submit']
  ): Effect.Effect<E2eeAccountPairingReplies['submit'], unknown>
  pairingRead(
    request: E2eeAccountPairingRequests['read']
  ): Effect.Effect<E2eeAccountPairingReplies['read'], unknown>
  pairingDecline(request: E2eeAccountPairingRequests['decline']): Effect.Effect<unknown, unknown>
  pairingPublish(request: E2eeAccountPairingRequests['publish']): Effect.Effect<unknown, unknown>
  pairingClaim(
    request: E2eeAccountPairingRequests['claim']
  ): Effect.Effect<E2eeAccountPairingReplies['claim'], unknown>
}

export interface KeyRoundServices {
  mailbox: (signal: AbortSignal) => KeyMailbox['Service']
  staging: (signal: AbortSignal) => EpochStagingStore['Service']
  history: (
    signal: AbortSignal
  ) => (request: E2eeWorkspaceHistoryRequest) => Effect.Effect<E2eeWorkspaceHistoryPage, unknown>
}
/** The parts of an account owner this host uses. */
export interface AccountPairingOwner {
  readonly accountId: string
  /** Window readers per workspace; an entry nobody reads is closed after use. */
  readonly readers: ReadonlyMap<string, ReadonlyMap<number, number>>
  readonly host: {
    status(workspaceId: string): Effect.Effect<
      {
        genesisHash?: string | null
        deviceKind?: string | null
        signingPublicKey?: string | null
        position?: string | null
      },
      unknown
    >
    signAccountAdmission(
      workspaceId: string,
      row: {
        signingPublicKey: Uint8Array
        encryptionPublicKey: Uint8Array
        possessionProof: Uint8Array
      }
    ): Effect.Effect<{ requestId: string; record: Uint8Array }, unknown>
    accountInvitation(
      workspaceId: string,
      record: Uint8Array
    ): Effect.Effect<Uint8Array | null, unknown>
    ingestLedgerRecords(
      workspaceId: string,
      page: E2eeWorkspaceHistoryPage
    ): Effect.Effect<unknown, unknown>
    ledgerView(workspaceId: string): Effect.Effect<{ recordsHex: readonly string[] }, unknown>
    open(workspaceId: string): Effect.Effect<unknown, unknown>
    closeWorkspace(workspaceId: string): Effect.Effect<unknown, unknown>
    keyRound(
      workspaceId: string,
      mailbox: KeyRoundServices['mailbox'],
      staging: KeyRoundServices['staging'],
      history: KeyRoundServices['history']
    ): Effect.Effect<unknown, unknown>
  }
  readonly bootstrap: {
    deviceCredential(workspaceId: string): Effect.Effect<string, unknown>
    accountPairingIdentity(pin: {
      genesisHash: string
      genesisRecordHex: string
      membershipId: string
    }): Effect.Effect<
      {
        signingPublicKey: Uint8Array
        encryptionPublicKey: Uint8Array
        possessionProof: Uint8Array
        credentialHash: Uint8Array
      },
      unknown
    >
    preparePersonalJoin(pin: {
      version: 1
      workspaceId: string
      genesisHash: string
      genesisRecordHex: string
      endorser: string
      membershipId: string
      pairingSessionId: string
    }): Effect.Effect<unknown, unknown>
    acceptPersonalJoin(workspaceId: string, invitationHex: string): Effect.Effect<unknown, unknown>
    pendingPersonalJoin(
      workspaceId: string
    ): Effect.Effect<{ offer: { pairingSessionId: string } } | null, unknown>
  }
}

export interface AccountPairingWorkspaceHint {
  workspaceId: string
  name: string
  genesisHash: string
}

export function makeDesktopAccountPairingHost(input: {
  accountId: string
  deviceName: string
  db: DatabaseSync
  cloud: AccountPairingCloud
  /** One account-owner turn for one workspace; `create` allows a new identity directory. */
  withOwner: <A>(
    workspaceId: string,
    work: (owner: AccountPairingOwner) => Effect.Effect<A, unknown>,
    create: boolean
  ) => Promise<A>
  /** Runs an effect returned from an owner turn, outside that turn. */
  run: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>
  /** Display and routing hints for the account's encrypted workspaces. Every
   * workspace's genesis is still verified against its own ledger or request tag. */
  workspaces: () => readonly AccountPairingWorkspaceHint[]
  now?: () => number
}) {
  const { cloud } = input
  function promise<A>(work: () => Promise<A>): Effect.Effect<A, unknown> {
    return Effect.tryPromise({ try: work, catch: (error) => error })
  }
  function owner<A>(
    workspaceId: string,
    work: (current: AccountPairingOwner) => Effect.Effect<A, unknown>,
    create = false
  ): Effect.Effect<A, unknown> {
    return promise(() =>
      input.withOwner(
        workspaceId,
        (current) =>
          current.accountId === input.accountId
            ? work(current)
            : Effect.fail(fail('account_mismatch')),
        create
      )
    )
  }
  /** Closes the runtime entry this workflow opened, unless a window is reading it. */
  const release = (workspaceId: string) =>
    owner(workspaceId, (current) =>
      current.readers.get(workspaceId)?.size
        ? Effect.void
        : current.host.closeWorkspace(workspaceId)
    ).pipe(Effect.ignore)
  function transient<A>(workspaceId: string, work: Effect.Effect<A, unknown>) {
    return Effect.ensuring(work, release(workspaceId))
  }
  const statusOf = (workspaceId: string) =>
    transient(
      workspaceId,
      owner(workspaceId, (current) => current.host.status(workspaceId))
    ).pipe(Effect.orElseSucceed(() => null))

  /** The complete signed history, read with the account session. */
  const history = Effect.fnUntraced(function* (workspaceId: string) {
    const pages: E2eeWorkspaceHistoryPage[] = []
    let cursor: string | undefined
    for (let index = 0; index < 256; index++) {
      const page = yield* cloud.history({
        workspaceId,
        ...(cursor ? { cursor } : {}),
        ...(pages[0] ? { checkpoint: pages[0].checkpoint } : {})
      })
      pages.push(page)
      if (page.nextCursor === null) return pages
      cursor = page.nextCursor
    }
    return yield* Effect.fail(fail('ledger_budget_exceeded'))
  })
  /** Verifies the whole ledger from the genesis the caller already trusts. */
  const verified = Effect.fnUntraced(function* (hint: AccountPairingWorkspaceHint) {
    const pages = yield* history(hint.workspaceId)
    const genesisRecordHex = pages[0]?.recordsHex[0]
    if (!genesisRecordHex) return yield* Effect.fail(fail('invalid-ledger'))
    const pin = { workspaceId: hint.workspaceId, genesisHash: hint.genesisHash, genesisRecordHex }
    const view = yield* verifyMemberHistory(pin, pages)
    return { pin, pages, view }
  })
  /** This account's single active membership in a verified view. */
  const ownMembership = Effect.fnUntraced(function* (
    view: import('@lody/e2ee-core/protocol').LedgerView
  ) {
    const { cryptoUserId } = yield* cloud.accountIdentity()
    const mine = [...view.inspectState().members.entries()].filter(
      ([, member]) => hex(member.userId.toBytes()) === cryptoUserId
    )
    if (mine.length !== 1) return yield* Effect.fail(fail('missing-binding'))
    return mine[0]![0]
  })
  /** Pulls the verified ledger forward after an append, outside any owner turn. */
  const refresh = Effect.fnUntraced(function* (workspaceId: string) {
    const status = yield* owner(workspaceId, (current) => current.host.status(workspaceId))
    let cursor: string | undefined
    let checkpoint: E2eeWorkspaceHistoryPage['checkpoint'] | undefined
    const after = status.position ?? undefined
    do {
      const page = yield* cloud.history({
        workspaceId,
        ...(cursor ? { cursor, checkpoint } : after ? { after } : {})
      })
      checkpoint ??= page.checkpoint
      const ingest = yield* owner(workspaceId, (current) =>
        Effect.succeed(current.host.ingestLedgerRecords(workspaceId, page))
      )
      yield* promise(() => input.run(ingest))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  })

  /** Where an original stands in the verified ledger: in it, displaced by another
   * record at the same position, or not yet decided. */
  const disposition = Effect.fnUntraced(function* (workspaceId: string, record: Uint8Array) {
    const ledger = yield* owner(workspaceId, (current) => current.host.ledgerView(workspaceId))
    const original = decodeRecord(record)
    if (Result.isFailure(original) || original.success.body.type !== 'ordinary')
      return yield* Effect.fail(fail('corrupt'))
    const previous = hex(original.success.body.previousHash.toBytes())
    let displaced = false
    for (const recordHex of ledger.recordsHex) {
      if (recordHex === hex(record)) return 'committed' as const
      const other = decodeRecord(raw(recordHex))
      if (
        Result.isSuccess(other) &&
        other.success.body.type === 'ordinary' &&
        hex(other.success.body.previousHash.toBytes()) === previous
      )
        displaced = true
    }
    return displaced ? ('lost' as const) : ('unknown' as const)
  })

  /** Opens the newly installed workspace, pulls its ledger forward and runs one key
   * round with this device's own credential, all outside any owner turn. */
  const activate = (workspaceId: string) =>
    transient(
      workspaceId,
      Effect.gen(function* () {
        yield* owner(workspaceId, (current) => current.host.open(workspaceId))
        yield* refresh(workspaceId)
        const credential = yield* owner(workspaceId, (current) =>
          current.bootstrap.deviceCredential(workspaceId)
        )
        const services = yield* cloud.keyServices({ workspaceId, credential })
        const round = yield* owner(workspaceId, (current) =>
          Effect.succeed(
            current.host.keyRound(workspaceId, services.mailbox, services.staging, services.history)
          )
        )
        yield* promise(() => input.run(round))
      })
    )

  const approverWorkspaces = Effect.fnUntraced(function* () {
    const result: AccountPairingApproverWorkspace[] = []
    for (const hint of input.workspaces()) {
      const status = yield* statusOf(hint.workspaceId)
      if (
        status?.deviceKind !== 'personal' ||
        status.genesisHash !== hint.genesisHash ||
        !status.signingPublicKey
      )
        continue
      const workspaceId = hint.workspaceId
      result.push({
        workspaceId,
        name: hint.name,
        genesis: raw(hint.genesisHash),
        signingPublicKey: raw(status.signingPublicKey),
        // Pull the verified head forward before signing; the workflow then checks
        // the request's tag and expiry again before calling `sign`.
        refresh: () => transient(workspaceId, refresh(workspaceId)),
        sign: (row) =>
          transient(
            workspaceId,
            owner(workspaceId, (current) => current.host.signAccountAdmission(workspaceId, row))
          ),
        append: (requestId, record, credentialHash) =>
          transient(
            workspaceId,
            Effect.gen(function* () {
              const appended = yield* Effect.result(
                cloud.appendRecord({
                  workspaceId,
                  requestId,
                  recordHex: hex(record),
                  credentialHash: hex(credentialHash)
                })
              )
              // Verified reads beat lost acknowledgements: settle from the ledger.
              yield* refresh(workspaceId)
              const settled = yield* disposition(workspaceId, record)
              if (settled === 'committed') return undefined
              if (settled === 'lost') return yield* Effect.fail(fail('admission-lost'))
              if (Result.isFailure(appended)) return yield* Effect.fail(appended.failure)
              return yield* Effect.fail(fail('append_unconfirmed'))
            })
          ),
        invitation: (record) =>
          transient(
            workspaceId,
            owner(workspaceId, (current) => current.host.accountInvitation(workspaceId, record))
          ),
        access: () =>
          owner(workspaceId, (current) =>
            Effect.map(current.bootstrap.deviceCredential(workspaceId), (credential) => ({
              workspaceId,
              credential
            }))
          )
      })
    }
    return result
  })

  const requesterWorkspaces = Effect.fnUntraced(function* () {
    const result: AccountPairingRequesterWorkspace[] = []
    for (const hint of input.workspaces()) {
      // Workspaces where this device already holds an active personal identity
      // need no pairing.
      const status = yield* statusOf(hint.workspaceId)
      if (status?.deviceKind === 'personal') continue
      const workspaceId = hint.workspaceId
      let membershipId: string | undefined
      let genesisRecordHex: string | undefined
      result.push({
        workspaceId,
        name: hint.name,
        genesis: raw(hint.genesisHash),
        identity: () =>
          Effect.gen(function* () {
            const checked = yield* verified(hint)
            const ownId = yield* ownMembership(checked.view)
            membershipId = ownId
            genesisRecordHex = checked.pin.genesisRecordHex
            const pin = {
              genesisHash: hint.genesisHash,
              genesisRecordHex: checked.pin.genesisRecordHex,
              membershipId: ownId
            }
            return yield* owner(
              workspaceId,
              (current) => current.bootstrap.accountPairingIdentity(pin),
              true
            )
          }),
        accept: (invitation, admissionRecordHash) =>
          Effect.gen(function* () {
            // The approval tag authenticated this record hash; the endorser is the
            // signer of exactly that record in the verified ledger.
            const checked = yield* verified(hint)
            const record = checked.pages
              .flatMap((page) => page.recordsHex)
              .map(raw)
              .find((bytes) => hex(hashRecordBytes(bytes).toBytes()) === hex(admissionRecordHash))
            if (!record) return yield* Effect.fail(fail('missing-binding'))
            const decoded = decodeRecord(record)
            if (Result.isFailure(decoded) || decoded.success.body.type !== 'ordinary')
              return yield* Effect.fail(fail('invalid-ledger'))
            const memberId = membershipId ?? (yield* ownMembership(checked.view))
            const pin = {
              version: 1 as const,
              workspaceId,
              genesisHash: hint.genesisHash,
              genesisRecordHex: genesisRecordHex ?? checked.pin.genesisRecordHex,
              endorser: hex(decoded.success.body.signer.toBytes()),
              membershipId: memberId,
              // A stable, request-independent session for the existing join journal.
              pairingSessionId: hex(admissionRecordHash).slice(0, 32)
            }
            // An unrelated unfinished per-workspace exchange keeps its own journal
            // row: report this workspace as blocked instead of overwriting it.
            const pending = yield* owner(workspaceId, (current) =>
              current.bootstrap.pendingPersonalJoin(workspaceId)
            )
            if (pending && pending.offer.pairingSessionId !== pin.pairingSessionId)
              return yield* Effect.fail(fail('pairing-journal-busy'))
            yield* owner(workspaceId, (current) => current.bootstrap.preparePersonalJoin(pin), true)
            yield* owner(workspaceId, (current) =>
              current.bootstrap.acceptPersonalJoin(workspaceId, hex(invitation))
            )
            // Like the per-workspace claim: open, refresh and install current keys
            // now. Best effort: opening the workspace later repeats this.
            yield* activate(workspaceId).pipe(
              Effect.catch((error) =>
                Effect.sync(() => rememberDesktopE2eeFailure('account-pairing-activate', error))
              )
            )
            return undefined
          })
      })
    }
    return result
  })

  return makeDesktopAccountPairing({
    db: input.db,
    account: input.accountId,
    deviceName: input.deviceName,
    relay: {
      submit: (request) => cloud.pairingSubmit(request),
      read: (lookupId) => cloud.pairingRead({ lookupId }),
      decline: (requestId) => cloud.pairingDecline({ requestId }),
      publish: (request) => cloud.pairingPublish(request),
      claim: (lookupId) => cloud.pairingClaim({ lookupId })
    },
    approverWorkspaces,
    requesterWorkspaces,
    ...(input.now ? { now: input.now } : {})
  })
}
