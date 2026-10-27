import type { DesktopE2eeManagementRemote } from './e2ee-management.mjs'
import { Context, Effect, Layer } from 'effect'
import { LedgerSubmission, WorkspaceControl, VerifiedLedger } from '@lody/e2ee-core'
import { Bytes, decodeRecord, type LedgerCommand } from '@lody/e2ee-core/protocol'
import {
  DeviceIdentity,
  WorkspaceScope,
  LedgerLog,
  LedgerLogError,
  LedgerSync,
  SubmissionJournal
} from '@lody/e2ee-core/services'

export type MemberCommand =
  | { type: 'removeMember'; membershipId: string }
  | { type: 'setMemberRole'; membershipId: string; role: 'admin' | 'member' }
export type MemberRemote = Pick<DesktopE2eeManagementRemote, 'log' | 'history'>
export type MemberPorts = {
  log: LedgerLog['Service']
  refresh: () => Effect.Effect<void, unknown>
}

/** A workspace-owned ordinary command journal. No epoch candidate or staging dependency. */
export const makeDesktopMemberManager = Effect.fnUntraced(function* (input: {
  identity: DeviceIdentity['Service']
  genesis: Bytes.GenesisHash
  journal: SubmissionJournal['Service']
  verified: VerifiedLedger['Service']
  current: LedgerSync['Service']['current']
  ports: MemberPorts
}) {
  const ports = Layer.mergeAll(
    Layer.succeed(DeviceIdentity, input.identity),
    Layer.succeed(WorkspaceScope, { genesis: input.genesis }),
    Layer.succeed(VerifiedLedger, input.verified),
    Layer.succeed(SubmissionJournal, input.journal),
    Layer.succeed(LedgerSync, {
      current: input.current,
      refresh: () => input.ports.refresh().pipe(Effect.andThen(input.current()))
    }),
    Layer.succeed(LedgerLog, {
      ...input.ports.log,
      read: (anchor) =>
        input.ports.log.read(anchor).pipe(
          Effect.tap(() => input.ports.refresh()),
          Effect.mapError((cause) =>
            cause instanceof LedgerLogError ? cause : new LedgerLogError({ cause })
          )
        )
    })
  )
  const services = yield* Layer.build(
    WorkspaceControl.layer.pipe(
      Layer.provideMerge(LedgerSubmission.layer.pipe(Layer.provideMerge(ports)))
    )
  )
  const control = Context.get(services, WorkspaceControl)
  const submission = Context.get(services, LedgerSubmission)
  return Effect.fnUntraced(function* (command: MemberCommand) {
    yield* input.ports.refresh()
    const pending = yield* submission.pending()
    if (pending.record) {
      const body = (yield* Effect.fromResult(decodeRecord(pending.record))).body
      const result = yield* control.resume()
      if (result) {
        yield* control.acknowledge(result)
        if (result.outcome === 'Conflict') return result.outcome
        if (body.type === 'ordinary') {
          const op = body.operation
          if (
            command.type === 'removeMember' &&
            op.type === 'removeMember' &&
            Buffer.from(op.membershipId.toBytes()).toString('hex') === command.membershipId
          )
            return result.outcome
          if (
            command.type === 'setMemberRole' &&
            op.type === 'setRole' &&
            op.role === command.role &&
            Buffer.from(op.membershipId.toBytes()).toString('hex') === command.membershipId
          )
            return result.outcome
        }
      }
    }
    const membershipId = yield* Effect.fromResult(
      Bytes.membershipId(new Uint8Array(Buffer.from(command.membershipId, 'hex')))
    )
    const state = (yield* input.verified.current()).inspectState()
    const actorDevice = state.devices.get(
      Buffer.from(input.identity.signer.publicKey.toBytes()).toString('hex')
    )
    const actor =
      actorDevice &&
      state.members.get(Buffer.from(actorDevice.membershipId.toBytes()).toString('hex'))
    const target = state.members.get(command.membershipId)
    if (
      actorDevice?.kind !== 'personal' ||
      !actor ||
      (command.type === 'setMemberRole'
        ? actor.role !== 'owner'
        : actor.role !== 'owner' && actor.role !== 'admin') ||
      target?.role === 'owner' ||
      (command.type === 'removeMember' && actor.role === 'admin' && target?.role === 'admin')
    )
      return yield* Effect.fail(new Error('e2ee_member_management_forbidden'))
    if (!target || (command.type === 'setMemberRole' && target.role === command.role))
      return 'Committed'
    if (command.type === 'removeMember' && !state.capabilities.includes(1)) {
      const declared = yield* control.execute({ _tag: 'DeclareCapabilities', capabilities: [1] })
      yield* control.acknowledge(declared)
      if (declared.outcome === 'Conflict') return declared.outcome
    }
    const intent: LedgerCommand =
      command.type === 'removeMember'
        ? { _tag: 'RemoveMember', membershipId }
        : { _tag: 'SetRole', membershipId, role: command.role }
    const result = yield* control.execute(intent)
    yield* control.acknowledge(result)
    return result.outcome
  })
})
