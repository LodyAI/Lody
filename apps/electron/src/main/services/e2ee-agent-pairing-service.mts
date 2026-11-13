import { Effect } from 'effect'
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

export function makeDesktopAgentPairing(ports: DesktopAgentPairingPorts) {
  async function beginRemoteMachine(workspaceId: string, id: number) {
    const state = await ports.withAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* ports.refuseUnopened(owner, workspaceId)
          const credential = yield* owner.bootstrap.deviceCredential(workspaceId)
          const offer = yield* owner.host.remoteMachineOffer(workspaceId, {
            accountId: owner.accountId,
            ...ports.remoteMachineEndpoints()
          })
          return { credential, offer, accountId: owner.accountId }
        }),
      workspaceId,
      false
    )
    const cloud = await ports.cloud()
    if (cloud.accountId !== state.accountId) throw new Error('e2ee_account_mismatch')
    const status = await Effect.runPromise(
      cloud.client.machineBegin({ workspaceId, credential: state.credential, offer: state.offer })
    )
    return {
      ...status,
      command: `lody machine pair --offer ${Buffer.from(JSON.stringify(state.offer)).toString('base64url')}`
    }
  }
  async function inspectRemoteMachine(workspaceId: string, pairingSessionId: string, id: number) {
    const access = await ports.withAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* ports.refuseUnopened(owner, workspaceId)
          return {
            credential: yield* owner.bootstrap.deviceCredential(workspaceId),
            accountId: owner.accountId
          }
        }),
      workspaceId,
      false
    )
    const cloud = await ports.cloud()
    if (cloud.accountId !== access.accountId) throw new Error('e2ee_account_mismatch')
    const status = await Effect.runPromise(
      cloud.client.machineInspect({ workspaceId, pairingSessionId, credential: access.credential })
    )
    if (status.pairingSessionId !== pairingSessionId) throw new Error('e2ee_conflict')
    const material = status.material
    const summary =
      material && ['claimed', 'admitting', 'admitted', 'ready'].includes(status.status)
        ? await ports.withAccount(
            (owner) =>
              owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
                ? owner.host.stageRemoteMachine(workspaceId, pairingSessionId, material)
                : Effect.fail(new Error('e2ee_account_mismatch')),
            workspaceId,
            false
          )
        : null
    return { ...status, summary }
  }
  async function approveRemoteMachine(
    workspaceId: string,
    pairingSessionId: string,
    summary: string,
    id: number
  ) {
    const current = await inspectRemoteMachine(workspaceId, pairingSessionId, id)
    if (
      current.summary !== summary ||
      !['claimed', 'admitting', 'admitted', 'ready'].includes(current.status)
    )
      throw new Error('e2ee_conflict')
    const pending = await ports.withAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* ports.refuseUnopened(owner, workspaceId)
          return {
            accountId: owner.accountId,
            request: yield* owner.host.approveRemoteMachine(workspaceId, pairingSessionId, summary)
          }
        }),
      workspaceId,
      false
    )
    const cloud = await ports.cloud()
    if (cloud.accountId !== pending.accountId) throw new Error('e2ee_account_mismatch')
    if (pending.request) {
      try {
        await Effect.runPromise(cloud.client.appendRecord(pending.request))
      } catch (error) {
        ports.remember(error)
      }
    } else {
      const credential = await ports.withAccount(
        (owner) =>
          owner.accountId === pending.accountId && owner.readers.get(workspaceId)?.has(id)
            ? owner.bootstrap.deviceCredential(workspaceId)
            : Effect.fail(new Error('e2ee_account_mismatch')),
        workspaceId,
        false
      )
      await Effect.runPromise(
        cloud.client.machineAuthorizeExisting({ workspaceId, pairingSessionId, credential })
      )
    }
    // Refresh reads back the original and drives resumable key distribution.
    await ports.refresh(workspaceId)
    await ports.withAccount(
      (owner) =>
        owner.accountId === pending.accountId && owner.readers.get(workspaceId)?.has(id)
          ? owner.host.confirmRemoteMachine(workspaceId, pairingSessionId)
          : Effect.fail(new Error('e2ee_account_mismatch')),
      workspaceId,
      false
    )
    const status = await inspectRemoteMachine(workspaceId, pairingSessionId, id)
    return {
      admitted: status.status === 'admitted' || status.status === 'ready',
      ready: status.status === 'ready'
    }
  }
  async function cancelRemoteMachine(workspaceId: string, pairingSessionId: string, id: number) {
    const access = await ports.withAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* ports.refuseUnopened(owner, workspaceId)
          return {
            credential: yield* owner.bootstrap.deviceCredential(workspaceId),
            accountId: owner.accountId
          }
        }),
      workspaceId,
      false
    )
    const cloud = await ports.cloud()
    if (cloud.accountId !== access.accountId) throw new Error('e2ee_account_mismatch')
    const result = await Effect.runPromise(
      cloud.client.machineCancel({ workspaceId, pairingSessionId, credential: access.credential })
    )
    if (!['cancelled', 'expired', 'conflict', 'ready'].includes(result.status))
      throw new Error('e2ee_conflict')
    if (!result.noAdmissionReserved) await ports.refresh(workspaceId)
    await ports.withAccount(
      (owner) =>
        owner.accountId === access.accountId && owner.readers.get(workspaceId)?.has(id)
          ? owner.host.retireRemoteMachine(
              workspaceId,
              pairingSessionId,
              result.noAdmissionReserved === true
            )
          : Effect.fail(new Error('e2ee_account_mismatch')),
      workspaceId,
      false
    )
    return result
  }

  async function prepareLocalAgent(workspaceId: string, id: number) {
    const context = await ports.withAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* ports.refuseUnopened(owner, workspaceId)
          yield* owner.bootstrap.deviceCredential(workspaceId)
          return {
            accountId: owner.accountId,
            ...(yield* owner.host.localPairingContext(workspaceId))
          }
        }),
      workspaceId,
      false
    )
    const cli = ports.cli()
    const machineId = await cli.getLocalMachineId()
    if (!machineId) throw new Error('e2ee_local_agent_unavailable')
    let material
    try {
      material = await cli.prepareLocalE2eeDevice({ type: 'prepare', machineId, ...context })
    } catch (error) {
      ports.remember(error)
      // Original retained above; attaching it would leak raw causes through the IPC logger.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        LocalE2eeRecoveryFailureSchema.safeParse({
          ok: false,
          error: error instanceof Error ? error.message : ''
        }).success
          ? `e2ee_machine_${(error as Error).message.slice(5)}`
          : error instanceof Error && error.message === 'e2ee_local_agent_pending'
            ? 'e2ee_local_agent_pending'
            : 'e2ee_local_agent_unavailable'
      )
    }
    if (material.machineId !== machineId || material.pairingSessionId !== context.pairingSessionId)
      throw new Error('e2ee_conflict')
    if (material.type === 'prepare-superseded') {
      let retirementFailure: unknown
      try {
        await ports.withAccount(
          (owner) =>
            owner.accountId === context.accountId && owner.readers.get(workspaceId)?.has(id)
              ? owner.host.retireSupersededLocalPairing(
                  workspaceId,
                  context.pairingSessionId,
                  (error) => {
                    retirementFailure = error
                  }
                )
              : Effect.fail(new Error('e2ee_account_mismatch')),
          workspaceId,
          false
        )
      } catch (error) {
        const superseded = new Error('e2ee_pairing_superseded')
        ports.remember(
          new AggregateError(
            [superseded, ...(retirementFailure === undefined ? [] : [retirementFailure]), error],
            'e2ee_pairing_retirement_failed',
            { cause: superseded }
          )
        )
        // Original receipt and retirement failure stay in main.
        // eslint-disable-next-line preserve-caught-error
        throw new Error('e2ee_local_agent_unavailable')
      }
      throw new Error('e2ee_local_agent_pending')
    }
    return ports.withAccount(
      (owner) =>
        owner.accountId === context.accountId && owner.readers.get(workspaceId)?.has(id)
          ? owner.host.stageLocalPairing(workspaceId, material)
          : Effect.fail(new Error('e2ee_account_mismatch')),
      workspaceId,
      false
    )
  }
  async function admitLocalAgent(workspaceId: string, pairingSessionId: string, id: number) {
    const pending = await ports.withAccount(
      (owner) =>
        Effect.gen(function* () {
          if (!owner.readers.get(workspaceId)?.has(id))
            return yield* ports.refuseUnopened(owner, workspaceId)
          return {
            accountId: owner.accountId,
            request: yield* owner.host.approveLocalPairing(workspaceId, pairingSessionId)
          }
        }),
      workspaceId,
      false
    )
    let appendFailure: unknown
    if (pending.request) {
      const cloud = await ports.cloud()
      if (cloud.accountId !== pending.accountId) throw new Error('e2ee_account_mismatch')
      // Even an uncertain append is reconciled through verified readback below.
      // Its journal retains the same request and signature for the next attempt.
      try {
        await Effect.runPromise(cloud.client.appendRecord(pending.request))
      } catch (error) {
        appendFailure = error
      }
    }
    let distributed = true
    try {
      // The new agent only needs this device's envelope for the current epoch. A device
      // that already holds that key distributes alone; one without it keeps the full
      // round, which receives before it distributes. Repair and reports stay with later
      // full rounds.
      const holdsKey = await ports.status(workspaceId).then(
        (status) => status.hasCurrentKey,
        () => false
      )
      await ports.refresh(workspaceId, { keyMode: holdsKey ? 'distribute' : 'full' })
    } catch (error) {
      ports.remember(error)
      distributed = false
    }
    let confirmed
    try {
      confirmed = await ports.withAccount(
        (owner) =>
          owner.accountId === pending.accountId && owner.readers.get(workspaceId)?.has(id)
            ? owner.host.confirmLocalPairing(workspaceId, pairingSessionId)
            : Effect.fail(new Error('e2ee_account_mismatch')),
        workspaceId,
        false
      )
    } catch (error) {
      // Keep both failures in main for diagnosis. Only a stable message crosses
      // IPC; never log SDK/raw causes or let an old error undo verified success.
      if (appendFailure !== undefined) {
        const latest = ports.latestFailure()
        ports.remember(
          new AggregateError(
            [appendFailure, ...(latest === undefined ? [] : [latest]), error],
            'e2ee_append_unconfirmed',
            { cause: appendFailure }
          )
        )
        // Original retained above; the IPC decorator logs rejected Error causes.
        // eslint-disable-next-line preserve-caught-error
        throw new Error('e2ee_append_unconfirmed')
      }
      throw error
    }
    if (!distributed) return { admitted: true as const, ready: false }
    // The CLI verifies these same originals from its own pinned genesis instead of
    // replaying history from the network; unavailable or oversized views are omitted.
    const handoff = await ports
      .withAccount(
        (owner) =>
          owner.accountId === pending.accountId && owner.readers.get(workspaceId)?.has(id)
            ? owner.host.ledgerView(workspaceId)
            : Effect.fail(new Error('e2ee_account_mismatch')),
        workspaceId,
        false
      )
      .then(localLedgerHandoff, () => undefined)
    const activate = (ledger?: { ledgerRecordsHex: string[]; ledgerPosition: string }) =>
      ports.cli().activateLocalE2eeDevice({
        type: 'activate',
        accountId: pending.accountId,
        workspaceId,
        ...confirmed,
        ...ledger
      })
    try {
      await activate(handoff).catch((error: unknown) => {
        // An older local agent's strict schema refuses the optional handoff fields.
        if (
          !handoff ||
          (error as { cause?: { message?: unknown } })?.cause?.message !== 'e2ee_invalid_input'
        )
          throw error
        return activate()
      })
      return { admitted: true as const, ready: true }
    } catch (error) {
      ports.remember(error)
      // Approval is already committed. A delayed mailbox or CLI must not undo it.
      return { admitted: true as const, ready: false }
    }
  }
  async function resetLocalAgentIdentity(
    input: { workspaceId: string; resetId: string },
    id: number
  ) {
    const accountId = await ports.withAccount(
      (owner) =>
        owner.readers.get(input.workspaceId)?.has(id)
          ? Effect.as(owner.bootstrap.deviceCredential(input.workspaceId), owner.accountId)
          : ports.refuseUnopened(owner, input.workspaceId),
      input.workspaceId,
      false
    )
    const cli = ports.cli()
    const machineId = await cli.getLocalMachineId()
    if (!machineId) throw new Error('e2ee_local_agent_unavailable')
    await cli.resetLocalE2eeIdentity({
      accountId,
      machineId,
      workspaceId: input.workspaceId,
      resetId: input.resetId
    })
    await ports.withAccount(
      (owner) =>
        owner.accountId === accountId && owner.readers.get(input.workspaceId)?.has(id)
          ? owner.host.resetLocalPairing(input.workspaceId, input.resetId)
          : Effect.fail(new Error('e2ee_account_mismatch')),
      input.workspaceId,
      false
    )
  }
  return {
    beginRemoteMachine,
    inspectRemoteMachine,
    approveRemoteMachine,
    cancelRemoteMachine,
    prepareLocalAgent,
    admitLocalAgent,
    resetLocalAgentIdentity
  }
}
