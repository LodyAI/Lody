import { Cause, Data, Effect, Exit } from 'effect'
import {
  LOCAL_E2EE_LEDGER_HANDOFF_MAX_HEX_CHARS,
  LOCAL_E2EE_LEDGER_HANDOFF_MAX_RECORDS,
  LocalE2eeRecoveryFailureSchema
} from '@lody/shared/e2ee-local-pairing'
import type { E2eeRefreshOptions } from '@lody/platform'
import type { CliService } from './cli-service'
import type { desktopE2eeCloudClient, withDesktopE2eeAccount } from './e2ee-account-runtime'

/**
 * Desktop local-agent and remote-machine pairing. `E2eeIpc` validates renderer input
 * and the sender, then passes the sender's reader id here; every account turn checks
 * that reader again. Raw causes stay in main through `remember`; only stable public
 * messages are thrown. Approval is verified through ledger readback, never assumed.
 *
 * Each method is one Effect pipeline, run once at its exported boundary (`runPublic`).
 * Network and CLI calls run between account turns, never inside one.
 */

type Owner = Parameters<Parameters<typeof withDesktopE2eeAccount>[0]>[0]

export interface DesktopAgentPairingPorts {
  withAccount: typeof withDesktopE2eeAccount
  cloud: typeof desktopE2eeCloudClient
  cli(): Pick<
    CliService,
    | 'getLocalMachineId'
    | 'prepareLocalE2eeDevice'
    | 'activateLocalE2eeDevice'
    | 'resetLocalE2eeIdentity'
  >
  /** Refusal for a sender that holds no reader of the workspace. */
  refuseUnopened(owner: Owner, workspaceId: string): Effect.Effect<never, Error>
  /** Retains the latest local diagnostic in main; `latestFailure` reads it back. */
  remember(cause: unknown): void
  latestFailure(): unknown
  /** The renderer-facing status and refresh of the same sender (`E2eeIpc`). */
  status(workspaceId: string): Promise<{ hasCurrentKey: boolean }>
  refresh(workspaceId: string, options?: E2eeRefreshOptions): Promise<unknown>
  /** Origins a remote machine offer names for this deployment. */
  remoteMachineEndpoints(): { deploymentUrl: string; ingressUrl: string }
}

/** The local agent's optional ledger handoff: this host's complete verified originals
 * from genesis and their resume position, only within the local IPC bounds. */
function localLedgerHandoff(view: {
  status: { length: number; position: string | null }
  recordsHex: readonly string[]
  recordPositions?: readonly number[]
}) {
  const { recordsHex, recordPositions, status } = view
  if (
    !status.position ||
    status.position.length > 1024 ||
    !/^p1:\S+$/.test(status.position) ||
    recordsHex.length === 0 ||
    recordsHex.length !== status.length ||
    recordsHex.length > LOCAL_E2EE_LEDGER_HANDOFF_MAX_RECORDS ||
    recordsHex.reduce((total, record) => total + record.length, 0) >
      LOCAL_E2EE_LEDGER_HANDOFF_MAX_HEX_CHARS ||
    (recordPositions !== undefined && recordPositions.some((position, index) => position !== index))
  )
    return undefined
  return { ledgerRecordsHex: [...recordsHex], ledgerPosition: status.position }
}

/** A refusal whose stable public code is the only thing that crosses IPC. Its
 * `diagnostic`, if any, is retained in main by `runPublic`; it is never attached. */
class AgentPairingPublicError extends Data.TaggedError('AgentPairingPublicError')<{
  readonly code: string
  readonly diagnostic?: unknown
}> {}
/** An older local agent's strict schema refused the optional ledger handoff. */
class LegacyHandoffRefused extends Data.TaggedError('LegacyHandoffRefused')<{
  readonly cause: unknown
}> {}
const publicError = (code: string, diagnostic?: unknown) =>
  new AgentPairingPublicError(diagnostic === undefined ? { code } : { code, diagnostic })
/** The older CLI wraps its schema refusal as `{ cause: Error('e2ee_invalid_input') }`. */
export function isLegacyInvalidInputRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('cause' in error)) return false
  const cause = (error as { cause?: unknown }).cause
  return (
    !!cause &&
    typeof cause === 'object' &&
    (cause as { message?: unknown }).message === 'e2ee_invalid_input'
  )
}
/** Public code for a failed local prepare: a typed recovery code, a pending agent, or
 * unavailable. */
function prepareFailureCode(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  if (LocalE2eeRecoveryFailureSchema.safeParse({ ok: false, error: message }).success)
    return `e2ee_machine_${message.slice(5)}`
  return message === 'e2ee_local_agent_pending'
    ? 'e2ee_local_agent_pending'
    : 'e2ee_local_agent_unavailable'
}
const REMOTE_STAGED = ['claimed', 'admitting', 'admitted', 'ready']

export function makeDesktopAgentPairing(ports: DesktopAgentPairingPorts) {
  /** A promise-returning port as an Effect; its rejection is the raw cause. */
  const promised = <A extends unknown>(work: () => Promise<A>) =>
    Effect.tryPromise({ try: work, catch: (cause) => cause })
  /** The one Promise boundary: a public refusal rejects with a fresh `Error(code)` and
   * its diagnostic stays in main; any other failure keeps its original identity for
   * the IPC boundary's own classification. */
  const runPublic = <A extends unknown>(work: Effect.Effect<A, unknown>) =>
    Effect.runPromise(
      work.pipe(
        Effect.catchIf(
          (error): error is AgentPairingPublicError => error instanceof AgentPairingPublicError,
          (error) =>
            Effect.suspend(() => {
              if (error.diagnostic !== undefined) ports.remember(error.diagnostic)
              return Effect.fail(new Error(error.code))
            })
        )
      )
    )
  const turn = <A extends unknown>(
    workspaceId: string,
    work: (owner: Owner) => Effect.Effect<A, unknown>
  ) => promised(() => ports.withAccount(work, workspaceId, false))
  /** A turn for a sender that must hold a reader of the workspace. */
  const opened = <A extends unknown>(
    workspaceId: string,
    id: number,
    work: (owner: Owner) => Effect.Effect<A, unknown>
  ) =>
    turn(workspaceId, (owner) =>
      owner.readers.get(workspaceId)?.has(id)
        ? work(owner)
        : (ports.refuseUnopened(owner, workspaceId) as Effect.Effect<never, unknown>)
    )
  /** A later turn of the same account and reader as the operation's first turn. */
  const same = <A extends unknown>(
    accountId: string,
    workspaceId: string,
    id: number,
    work: (owner: Owner) => Effect.Effect<A, unknown>
  ) =>
    turn(workspaceId, (owner) =>
      owner.accountId === accountId && owner.readers.get(workspaceId)?.has(id)
        ? work(owner)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
  const cloudOf = (accountId: string) =>
    Effect.flatMap(promised(ports.cloud), (cloud) =>
      cloud.accountId === accountId
        ? Effect.succeed(cloud)
        : Effect.fail(new Error('e2ee_account_mismatch'))
    )
  const credentialOf = (workspaceId: string, id: number) =>
    opened(workspaceId, id, (owner) =>
      Effect.map(owner.bootstrap.deviceCredential(workspaceId), (credential) => ({
        credential,
        accountId: owner.accountId
      }))
    )
  const localMachine = Effect.gen(function* () {
    const cli = ports.cli()
    const machineId = yield* promised(() => cli.getLocalMachineId())
    if (!machineId) return yield* Effect.fail(publicError('e2ee_local_agent_unavailable'))
    return { cli, machineId }
  })

  const beginRemoteMachineEffect = (workspaceId: string, id: number) =>
    Effect.gen(function* () {
      const state = yield* opened(workspaceId, id, (owner) =>
        Effect.gen(function* () {
          const credential = yield* owner.bootstrap.deviceCredential(workspaceId)
          const offer = yield* owner.host.remoteMachineOffer(workspaceId, {
            accountId: owner.accountId,
            ...ports.remoteMachineEndpoints()
          })
          return { credential, offer, accountId: owner.accountId }
        })
      )
      const cloud = yield* cloudOf(state.accountId)
      const status = yield* cloud.client.machineBegin({
        workspaceId,
        credential: state.credential,
        offer: state.offer
      })
      return {
        ...status,
        command: `lody machine pair --offer ${Buffer.from(JSON.stringify(state.offer)).toString('base64url')}`
      }
    })
  const inspectRemoteMachineEffect = (workspaceId: string, pairingSessionId: string, id: number) =>
    Effect.gen(function* () {
      const access = yield* credentialOf(workspaceId, id)
      const cloud = yield* cloudOf(access.accountId)
      const status = yield* cloud.client.machineInspect({
        workspaceId,
        pairingSessionId,
        credential: access.credential
      })
      if (status.pairingSessionId !== pairingSessionId)
        return yield* Effect.fail(new Error('e2ee_conflict'))
      const material = status.material
      const summary =
        material && REMOTE_STAGED.includes(status.status)
          ? yield* same(access.accountId, workspaceId, id, (owner) =>
              owner.host.stageRemoteMachine(workspaceId, pairingSessionId, material)
            )
          : null
      return { ...status, summary }
    })
  const approveRemoteMachineEffect = (
    workspaceId: string,
    pairingSessionId: string,
    summary: string,
    id: number
  ) =>
    Effect.gen(function* () {
      const current = yield* inspectRemoteMachineEffect(workspaceId, pairingSessionId, id)
      if (current.summary !== summary || !REMOTE_STAGED.includes(current.status))
        return yield* Effect.fail(new Error('e2ee_conflict'))
      const pending = yield* opened(workspaceId, id, (owner) =>
        Effect.map(
          owner.host.approveRemoteMachine(workspaceId, pairingSessionId, summary),
          (request) => ({ accountId: owner.accountId, request })
        )
      )
      const cloud = yield* cloudOf(pending.accountId)
      if (pending.request) {
        // Verified readback below decides; a lost acknowledgement is only a diagnostic.
        const appended = yield* Effect.exit(cloud.client.appendRecord(pending.request))
        if (Exit.isFailure(appended)) ports.remember(Cause.squash(appended.cause))
      } else {
        const credential = yield* same(pending.accountId, workspaceId, id, (owner) =>
          owner.bootstrap.deviceCredential(workspaceId)
        )
        yield* cloud.client.machineAuthorizeExisting({ workspaceId, pairingSessionId, credential })
      }
      // Refresh reads back the original and drives resumable key distribution.
      yield* promised(() => ports.refresh(workspaceId))
      yield* same(pending.accountId, workspaceId, id, (owner) =>
        owner.host.confirmRemoteMachine(workspaceId, pairingSessionId)
      )
      const status = yield* inspectRemoteMachineEffect(workspaceId, pairingSessionId, id)
      return {
        admitted: status.status === 'admitted' || status.status === 'ready',
        ready: status.status === 'ready'
      }
    })
  const cancelRemoteMachineEffect = (workspaceId: string, pairingSessionId: string, id: number) =>
    Effect.gen(function* () {
      const access = yield* credentialOf(workspaceId, id)
      const cloud = yield* cloudOf(access.accountId)
      const result = yield* cloud.client.machineCancel({
        workspaceId,
        pairingSessionId,
        credential: access.credential
      })
      if (!['cancelled', 'expired', 'conflict', 'ready'].includes(result.status))
        return yield* Effect.fail(new Error('e2ee_conflict'))
      if (!result.noAdmissionReserved) yield* promised(() => ports.refresh(workspaceId))
      yield* same(access.accountId, workspaceId, id, (owner) =>
        owner.host.retireRemoteMachine(
          workspaceId,
          pairingSessionId,
          result.noAdmissionReserved === true
        )
      )
      return result
    })

  const prepareLocalAgentEffect = (workspaceId: string, id: number) =>
    Effect.gen(function* () {
      const context = yield* opened(workspaceId, id, (owner) =>
        Effect.gen(function* () {
          yield* owner.bootstrap.deviceCredential(workspaceId)
          return {
            accountId: owner.accountId,
            ...(yield* owner.host.localPairingContext(workspaceId))
          }
        })
      )
      const { cli, machineId } = yield* localMachine
      // The original stays in main; attaching it would leak raw causes through the IPC logger.
      const material = yield* promised(() =>
        cli.prepareLocalE2eeDevice({ type: 'prepare', machineId, ...context })
      ).pipe(Effect.mapError((error) => publicError(prepareFailureCode(error), error)))
      if (
        material.machineId !== machineId ||
        material.pairingSessionId !== context.pairingSessionId
      )
        return yield* Effect.fail(new Error('e2ee_conflict'))
      if (material.type === 'prepare-superseded') {
        let retirementFailure: unknown
        const retired = yield* Effect.result(
          same(context.accountId, workspaceId, id, (owner) =>
            owner.host.retireSupersededLocalPairing(
              workspaceId,
              context.pairingSessionId,
              (error) => {
                retirementFailure = error
              }
            )
          )
        )
        if (retired._tag === 'Failure') {
          const superseded = new Error('e2ee_pairing_superseded')
          // Original receipt and retirement failure stay in main.
          return yield* Effect.fail(
            publicError(
              'e2ee_local_agent_unavailable',
              new AggregateError(
                [
                  superseded,
                  ...(retirementFailure === undefined ? [] : [retirementFailure]),
                  retired.failure
                ],
                'e2ee_pairing_retirement_failed',
                { cause: superseded }
              )
            )
          )
        }
        return yield* Effect.fail(publicError('e2ee_local_agent_pending'))
      }
      return yield* same(context.accountId, workspaceId, id, (owner) =>
        owner.host.stageLocalPairing(workspaceId, material)
      )
    })
  const admitLocalAgentEffect = (workspaceId: string, pairingSessionId: string, id: number) =>
    Effect.gen(function* () {
      const pending = yield* opened(workspaceId, id, (owner) =>
        Effect.map(owner.host.approveLocalPairing(workspaceId, pairingSessionId), (request) => ({
          accountId: owner.accountId,
          request
        }))
      )
      let appendFailure: unknown
      if (pending.request) {
        const cloud = yield* cloudOf(pending.accountId)
        // Even an uncertain append is reconciled through verified readback below.
        // Its journal retains the same request and signature for the next attempt.
        const appended = yield* Effect.exit(cloud.client.appendRecord(pending.request))
        if (Exit.isFailure(appended)) appendFailure = Cause.squash(appended.cause)
      }
      // The new agent only needs this device's envelope for the current epoch. A device
      // that already holds that key distributes alone; one without it keeps the full
      // round, which receives before it distributes. Repair and reports stay with later
      // full rounds.
      const refreshed = yield* Effect.exit(
        Effect.gen(function* () {
          const holdsKey = yield* promised(() => ports.status(workspaceId)).pipe(
            Effect.map((status) => status.hasCurrentKey),
            Effect.orElseSucceed(() => false)
          )
          yield* promised(() =>
            ports.refresh(workspaceId, { keyMode: holdsKey ? 'distribute' : 'full' })
          )
        })
      )
      if (Exit.isFailure(refreshed)) ports.remember(Cause.squash(refreshed.cause))
      const distributed = Exit.isSuccess(refreshed)
      // Confirmation and the optional ledger view are both local reads of the same
      // verified ledger, so one account turn covers them.
      const verified = yield* Effect.result(
        same(pending.accountId, workspaceId, id, (owner) =>
          Effect.gen(function* () {
            const confirmed = yield* owner.host.confirmLocalPairing(workspaceId, pairingSessionId)
            const view = distributed ? yield* Effect.exit(owner.host.ledgerView(workspaceId)) : null
            return { confirmed, view }
          })
        )
      )
      if (verified._tag === 'Failure') {
        // Keep both failures in main for diagnosis. Only a stable message crosses
        // IPC; never log SDK/raw causes or let an old error undo verified success.
        if (appendFailure === undefined) return yield* Effect.fail(verified.failure)
        const latest = ports.latestFailure()
        return yield* Effect.fail(
          publicError(
            'e2ee_append_unconfirmed',
            new AggregateError(
              [appendFailure, ...(latest === undefined ? [] : [latest]), verified.failure],
              'e2ee_append_unconfirmed',
              { cause: appendFailure }
            )
          )
        )
      }
      if (!distributed) return { admitted: true as const, ready: false }
      const { confirmed, view } = verified.success
      // The CLI verifies these same originals from its own pinned genesis instead of
      // replaying history from the network; unavailable or oversized views are omitted.
      const handoff = view && Exit.isSuccess(view) ? localLedgerHandoff(view.value) : undefined
      const activate = (ledger?: { ledgerRecordsHex: string[]; ledgerPosition: string }) =>
        promised(() =>
          ports.cli().activateLocalE2eeDevice({
            type: 'activate',
            accountId: pending.accountId,
            workspaceId,
            ...confirmed,
            ...ledger
          })
        )
      const activated = yield* Effect.exit(
        activate(handoff).pipe(
          Effect.mapError((error) =>
            handoff && isLegacyInvalidInputRejection(error)
              ? new LegacyHandoffRefused({ cause: error })
              : error
          ),
          // An older local agent's strict schema refuses the optional handoff fields.
          Effect.catchIf(
            (error): error is LegacyHandoffRefused => error instanceof LegacyHandoffRefused,
            () => activate()
          )
        )
      )
      if (Exit.isSuccess(activated)) return { admitted: true as const, ready: true }
      // Approval is already committed. A delayed mailbox or CLI must not undo it.
      ports.remember(Cause.squash(activated.cause))
      return { admitted: true as const, ready: false }
    })
  const resetLocalAgentIdentityEffect = (
    input: { workspaceId: string; resetId: string },
    id: number
  ) =>
    Effect.gen(function* () {
      const { accountId } = yield* credentialOf(input.workspaceId, id)
      const { cli, machineId } = yield* localMachine
      yield* promised(() =>
        cli.resetLocalE2eeIdentity({
          accountId,
          machineId,
          workspaceId: input.workspaceId,
          resetId: input.resetId
        })
      )
      yield* same(accountId, input.workspaceId, id, (owner) =>
        owner.host.resetLocalPairing(input.workspaceId, input.resetId)
      )
    })
  return {
    beginRemoteMachine: (workspaceId: string, id: number) =>
      runPublic(beginRemoteMachineEffect(workspaceId, id)),
    inspectRemoteMachine: (workspaceId: string, pairingSessionId: string, id: number) =>
      runPublic(inspectRemoteMachineEffect(workspaceId, pairingSessionId, id)),
    approveRemoteMachine: (
      workspaceId: string,
      pairingSessionId: string,
      summary: string,
      id: number
    ) => runPublic(approveRemoteMachineEffect(workspaceId, pairingSessionId, summary, id)),
    cancelRemoteMachine: (workspaceId: string, pairingSessionId: string, id: number) =>
      runPublic(cancelRemoteMachineEffect(workspaceId, pairingSessionId, id)),
    prepareLocalAgent: (workspaceId: string, id: number) =>
      runPublic(prepareLocalAgentEffect(workspaceId, id)),
    admitLocalAgent: (workspaceId: string, pairingSessionId: string, id: number) =>
      runPublic(admitLocalAgentEffect(workspaceId, pairingSessionId, id)),
    resetLocalAgentIdentity: (input: { workspaceId: string; resetId: string }, id: number) =>
      runPublic(resetLocalAgentIdentityEffect(input, id))
  }
}
