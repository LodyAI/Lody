import type { DatabaseSync } from 'node:sqlite'
import { Effect, Exit, Result } from 'effect'
import type {
  E2eeAccountPairingReplies,
  E2eeAccountPairingRequests,
  E2eeAppendRecordRequest,
  E2eeDeviceAccess,
  E2eeWorkspaceHistoryPage,
  E2eeWorkspaceHistoryRequest
} from '@lody/cloud-api'
import { decodeRecord } from '@lody/e2ee-core/protocol'
import {
  makePortableAccountPairingRequester,
  type AccountPairingIdentityHost
} from '@lody/e2ee-client/account-requester'
import type { EpochStagingStore, KeyMailbox } from '@lody/e2ee-core/services'
import { rememberDesktopE2eeFailure } from './e2ee-diagnostics.mjs'
import {
  makeDesktopAccountPairing,
  type AccountPairingApproverFilter,
  type AccountPairingApproverWorkspace,
  type AccountPairingRequesterFilter
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
      history: KeyRoundServices['history'],
      mode?: 'full' | 'receive' | 'distribute'
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
    acceptPersonalHistory(
      workspaceId: string,
      pages: readonly E2eeWorkspaceHistoryPage[]
    ): Effect.Effect<unknown, unknown>
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

/** Inputs of the desktop account-pairing host. */
export interface DesktopAccountPairingHostInput {
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
  /** Starts the main-owned member key delivery (distribute-only key round, per-device
   * mailbox evidence, retry and status) for one device the verified ledger admitted.
   * Must return at once; the approval never waits for delivery. */
  deliverKeys?: (workspaceId: string, requestId: string, device: string) => void
  now?: () => number
}

/** Workspace inspections that run at once while listing approver or requester ports. */
const LISTING_CONCURRENCY = 4

/**
 * The approver and requester ports of the shared workflow over this account's
 * per-workspace owners. The requester side is the shared portable requester; this
 * module supplies the desktop identity, join journal and activation.
 */
export function makeDesktopAccountPairingWorkspaces(
  input: Omit<DesktopAccountPairingHostInput, 'deviceName' | 'db' | 'now'>
) {
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

  /** Opens the newly installed workspace, pulls its ledger forward and receives this
   * device's own current key with its own credential, all outside any owner turn. The
   * remaining report, distribution and repair work stays with the next full round. */
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
            current.host.keyRound(
              workspaceId,
              services.mailbox,
              services.staging,
              services.history,
              'receive'
            )
          )
        )
        yield* promise(() => input.run(round))
      })
    )

  type Status = Effect.Success<ReturnType<AccountPairingOwner['host']['status']>>
  const approves = (hint: AccountPairingWorkspaceHint, status: Status | null) =>
    status?.deviceKind === 'personal' &&
    status.genesisHash === hint.genesisHash &&
    !!status.signingPublicKey
  const approverWorkspace = (
    hint: AccountPairingWorkspaceHint,
    signingPublicKey: string
  ): AccountPairingApproverWorkspace => {
    const workspaceId = hint.workspaceId
    return {
      workspaceId,
      name: hint.name,
      genesis: raw(hint.genesisHash),
      signingPublicKey: raw(signingPublicKey),
      // The workflow's `releasing` bracket closes every listed workspace once at
      // the end of inspection or approval, avoiding repeated SQLite reopen churn.
      refresh: () => refresh(workspaceId),
      sign: (row) =>
        owner(workspaceId, (current) => current.host.signAccountAdmission(workspaceId, row)),
      append: (requestId, record, credentialHash) =>
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
        }),
      invitation: (record) =>
        owner(workspaceId, (current) => current.host.accountInvitation(workspaceId, record)),
      access: () =>
        owner(workspaceId, (current) =>
          Effect.map(current.bootstrap.deviceCredential(workspaceId), (credential) => ({
            workspaceId,
            credential
          }))
        ),
      release: () => release(workspaceId),
      ...(input.deliverKeys
        ? {
            deliverKeys: (device: Uint8Array, requestId: string) =>
              Effect.sync(() => input.deliverKeys!(workspaceId, requestId, hex(device)))
          }
        : {})
    }
  }

  const approverWorkspaces = (filter?: AccountPairingApproverFilter) => {
    const listed = input
      .workspaces()
      .filter(
        (hint) =>
          (!filter?.workspaceIds || filter.workspaceIds.has(hint.workspaceId)) &&
          (!filter?.geneses || filter.geneses.has(hint.genesisHash))
      )
    // Every inspection that leaves its workspace open is recorded the moment it exits;
    // any other exit, including interruption, closes it again. A failed or interrupted
    // listing therefore releases every workspace opened by any concurrent inspection.
    const opened: string[] = []
    return Effect.forEach(
      listed,
      (hint) =>
        owner(hint.workspaceId, (current) => current.host.status(hint.workspaceId)).pipe(
          Effect.orElseSucceed(() => null),
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) && approves(hint, exit.value)
              ? Effect.sync(() => void opened.push(hint.workspaceId))
              : release(hint.workspaceId)
          )
        ),
      { concurrency: LISTING_CONCURRENCY }
    ).pipe(
      Effect.map((statuses) =>
        listed.flatMap((hint, index) => {
          const status = statuses[index] ?? null
          return approves(hint, status) ? [approverWorkspace(hint, status!.signingPublicKey!)] : []
        })
      ),
      Effect.onError(() =>
        Effect.forEach(opened, (workspaceId) => release(workspaceId), { discard: true })
      )
    )
  }

  /** The desktop identity and join journal of one workspace, as the shared requester
   * uses them. The pin of a later install keeps the membership and genesis record that
   * this listing's identity step proved possession for. */
  const identityHost = (hint: AccountPairingWorkspaceHint): AccountPairingIdentityHost => {
    const workspaceId = hint.workspaceId
    let proven: { membershipId: string; genesisRecordHex: string } | undefined
    const install = (
      pin: {
        endorser: string
        membershipId: string
        genesisRecordHex: string
        pairingSessionId: string
      },
      accept: (current: AccountPairingOwner) => Effect.Effect<unknown, unknown>
    ) =>
      Effect.gen(function* () {
        yield* owner(
          workspaceId,
          (current) =>
            current.bootstrap.preparePersonalJoin({
              version: 1,
              workspaceId,
              genesisHash: hint.genesisHash,
              genesisRecordHex: proven?.genesisRecordHex ?? pin.genesisRecordHex,
              // The signer of the tag-authenticated admission record in the verified ledger.
              endorser: pin.endorser,
              membershipId: proven?.membershipId ?? pin.membershipId,
              // A stable, request-independent session for the existing join journal.
              pairingSessionId: pin.pairingSessionId
            }),
          true
        )
        yield* owner(workspaceId, accept)
      })
    return {
      workspaceId,
      genesisHash: hint.genesisHash,
      prepareAccountIdentity: (pin) => {
        proven = { membershipId: pin.membershipId, genesisRecordHex: pin.genesisRecordHex }
        return owner(
          workspaceId,
          (current) =>
            current.bootstrap.accountPairingIdentity({
              genesisHash: hint.genesisHash,
              genesisRecordHex: pin.genesisRecordHex,
              membershipId: pin.membershipId
            }),
          true
        )
      },
      // An unrelated unfinished per-workspace exchange keeps its own journal row: the
      // shared requester reports this workspace as blocked instead of overwriting it.
      pendingPersonalJoin: () =>
        Effect.map(
          owner(workspaceId, (current) => current.bootstrap.pendingPersonalJoin(workspaceId)),
          (pending) => (pending ? { pairingSessionId: pending.offer.pairingSessionId } : null)
        ),
      acceptAccountInvitation: (accepted) =>
        Effect.asVoid(
          install(accepted, (current) =>
            current.bootstrap.acceptPersonalJoin(workspaceId, accepted.invitationHex)
          )
        ),
      // A Member approver sends no invitation: install from the verified full history.
      acceptAccountHistory: (accepted) =>
        accepted.endorser
          ? Effect.asVoid(
              install({ ...accepted, endorser: accepted.endorser }, (current) =>
                current.bootstrap.acceptPersonalHistory(workspaceId, accepted.pages)
              )
            )
          : Effect.fail(fail('invalid-ledger')),
      // Like the per-workspace claim: open, refresh and install current keys now. Best
      // effort: the shared requester only records a failure, and opening repeats this.
      activate: () => Effect.asVoid(activate(workspaceId))
    }
  }

  const portableRequester = makePortableAccountPairingRequester({
    accountId: input.accountId,
    workspaces: input.workspaces,
    history: (request) => cloud.history(request),
    verifyHistory: verifyMemberHistory,
    diagnostics: rememberDesktopE2eeFailure,
    // Workspaces where this device already holds an active personal identity need no
    // pairing. Each status read opens its store, so it is released right after.
    host: (workspaceId, hint) =>
      Effect.map(statusOf(workspaceId), (status) =>
        status?.deviceKind === 'personal' ? null : identityHost(hint)
      )
  })
  /** Routing hints come only from this account's workspace list, never from the caller. */
  const requesterWorkspaces = (_hints?: unknown, filter?: AccountPairingRequesterFilter) =>
    portableRequester(undefined, filter)

  return { approverWorkspaces, requesterWorkspaces }
}

export function makeDesktopAccountPairingHost(input: DesktopAccountPairingHostInput) {
  const { cloud } = input
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
    ...makeDesktopAccountPairingWorkspaces(input),
    ...(input.now ? { now: input.now } : {})
  })
}
