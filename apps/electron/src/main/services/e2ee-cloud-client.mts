import { E2eeMemberRemovedError } from './e2ee-cloud-errors.mjs'
import { RemoteMachineStatusSchema } from '@lody/shared/e2ee-remote-pairing'
import type { E2eeMachinePairingRequests } from '@lody/cloud-api'
import { Bytes, decodeRecord, hashRecordBytes } from '@lody/e2ee-core/protocol'
import { ConvexHttpClient } from 'convex/browser'
import { api } from '@lody/cloud-api'
import type {
  E2eeAppendRecordRequest,
  E2eeContentTokenRequest,
  E2eeDeviceAccess,
  E2eeJoinRequests,
  E2eeWorkspaceHistoryRequest
} from '@lody/cloud-api'
import {
  LedgerLog,
  LedgerLogError,
  BackendError,
  EpochStagingStore,
  KeyMailbox
} from '@lody/e2ee-core/services'
import {
  decodeEpochStagedGroup,
  encodeEpochStagedGroup,
  ownEpochStagedGroup,
  ownEpochStagedGroupKey
} from '@lody/e2ee-core/host'
import { Effect, Result } from 'effect'
import { z } from 'zod'

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const nonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const bytesHex = (max: number) =>
  z
    .string()
    .regex(/^(?:[0-9a-f]{2})+$/)
    .max(max * 2)
const slot = z.object({ genesis: hash, epoch: nonnegative, recipient: hash })
const status = slot.extend({
  revision: nonnegative,
  status: z.enum([
    'NeedsEnvelope',
    'EnvelopeStored',
    'InstallationReported',
    'Ineligible',
    'Obsolete'
  ])
})
const envelopes = z.object({
  items: z.array(z.object({ sender: hash, frameHex: bytesHex(512) })).max(100),
  next: z
    .string()
    .regex(/^[0-9a-f]{64}:[0-9a-f]{64}$/)
    .nullable()
})
const contentToken = z.object({
  token: z.string().min(1),
  bucketId: z.string().min(1),
  gatewayBaseUrl: z.string().url(),
  expiresIn: z.number().int().positive().max(900),
  expiresAt: nonnegative
})
const checkpoint = z.object({ headHash: hash, length: nonnegative })
const historyPage = z.object({
  workspaceId: z.string().min(1),
  genesisHash: hash,
  checkpoint,
  startIndex: nonnegative,
  recordsHex: z.array(bytesHex(16_384)).max(64),
  position: z.string().min(1),
  nextCursor: z.string().min(1).nullable()
})
const appended = z.object({ status: z.enum(['committed', 'conflict']), recordHash: hash })
const joinSession = z.object({
  workspaceId: z.string().min(1),
  accountId: z.string().min(1),
  pairingSessionId: z.string().regex(/^[0-9a-f]{32}$/),
  genesisHash: hash,
  signingPublicKey: hash,
  credentialHash: hash,
  requestHex: bytesHex(8192),
  status: z.enum(['pending', 'cancelled', 'admitting', 'admitted', 'conflict', 'published'])
})
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const raw = (value: string) => new Uint8Array(Buffer.from(value, 'hex'))
const unavailable = () => new BackendError({ service: 'E2eeCloud', reason: 'unavailable' })

/** Safe server capacity receipt; never contains request data or credentials. */
export class E2eeStagingCapacityError extends BackendError {
  readonly code = 'e2ee_staging_capacity_exceeded'
  constructor(
    readonly round: string,
    readonly limit: number
  ) {
    super({ service: 'EpochStagingStore', reason: 'unavailable' })
  }
}

const operatorCodes = new Set([
  'e2ee_staging_configuration',
  'e2ee_projection_corrupt',
  'e2ee_workspace_rebuild_required',
  'e2ee_ledger_budget_exceeded',
  'e2ee_ledger_configuration'
])
export class E2eeCloudDiagnosticError extends BackendError {
  constructor(readonly code: string) {
    super({ service: 'E2eeCloud', reason: 'unavailable' })
  }
}

function requestFailure(error: unknown): BackendError {
  if (error instanceof BackendError) return error
  // Never retain the SDK's raw error, server logs, request body, or token.
  const capacity = z
    .object({
      data: z.object({
        code: z.literal('e2ee_staging_capacity_exceeded'),
        round: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        limit: z.number().int().min(1).max(256),
        canStartNewRound: z.literal(true)
      })
    })
    .safeParse(error)
  if (capacity.success)
    return new E2eeStagingCapacityError(capacity.data.data.round, capacity.data.data.limit)
  const result = z.object({ data: z.object({ code: z.string() }) }).safeParse(error)
  const code = result.success ? result.data.data.code : ''
  if (operatorCodes.has(code)) return new E2eeCloudDiagnosticError(code)
  if (code === 'e2ee_member_removed') return new E2eeMemberRemovedError()
  const reason =
    code === 'e2ee_staging_invalid' || code === 'e2ee_staging_corrupt'
      ? 'invalid-response'
      : code.endsWith('_conflict')
        ? 'conflict'
        : /(?:unauthorized|credential|device_revoked|account_mismatch|not_authenticated)/.test(code)
          ? 'unauthorized'
          : 'unavailable'
  return new BackendError({ service: 'E2eeCloud', reason })
}

function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new BackendError({ service: 'E2eeCloud', reason: 'invalid-response' })
  return parsed.data
}

/** Only optional cloud E2EE workflows construct this owner. No generic Convex
 * invocation escapes it. All methods run outside the account's custody lock.
 * Timeouts leave write outcomes unknown: callers reconcile the original bytes. */
export const makeE2eeCloudClient = Effect.fnUntraced(function* (input: {
  platformKind: 'cloud' | 'local'
  deploymentUrl: string
  convexToken: (signal: AbortSignal) => Promise<unknown>
  fetch?: typeof globalThis.fetch
}) {
  if (input.platformKind !== 'cloud')
    return yield* new BackendError({ service: 'E2eeCloud', reason: 'unauthorized' })
  const owner = new AbortController()
  const close = Effect.sync(() => owner.abort())
  yield* Effect.addFinalizer(() => close)
  const fetch = input.fetch ?? globalThis.fetch

  function request<T>(
    work: (client: ConvexHttpClient) => Promise<unknown>,
    schema: z.ZodType<T>,
    requestSignal?: AbortSignal
  ) {
    return Effect.tryPromise({
      try: async (signal) => {
        const combined = AbortSignal.any([
          signal,
          owner.signal,
          ...(requestSignal ? [requestSignal] : [])
        ])
        combined.throwIfAborted()
        const response = await input.convexToken(combined)
        combined.throwIfAborted()
        const tokenResponse = z
          .union([
            z.object({ data: z.object({ token: z.string().min(1) }) }),
            z.object({ token: z.string().min(1) })
          ])
          .safeParse(response)
        if (!tokenResponse.success) throw unavailable()
        const token =
          'data' in tokenResponse.data ? tokenResponse.data.data.token : tokenResponse.data.token
        // A request owns its auth and abort signal. Concurrent work cannot change
        // another request's credentials through a shared mutable SDK client.
        const client = new ConvexHttpClient(input.deploymentUrl, {
          auth: token,
          logger: false,
          fetch: (url, options) => {
            combined.throwIfAborted()
            return fetch(url, { ...options, signal: combined })
          }
        })
        const value = await work(client)
        combined.throwIfAborted()
        return decode(schema, value)
      },
      catch: requestFailure
    }).pipe(Effect.timeoutOrElse({ duration: '30 seconds', orElse: unavailable }))
  }

  const staging = (
    access: E2eeDeviceAccess,
    signal?: AbortSignal,
    round?: string
  ): EpochStagingStore['Service'] => {
    const device = { ...access }
    const invalid = () =>
      new BackendError({ service: 'EpochStagingStore', reason: 'invalid-response' })
    return EpochStagingStore.of({
      stageGroup: (source) => {
        // Own and encode before yielding: re-running this Effect resends the
        // original group even if its caller later mutates its buffers.
        if (round !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(round))
          return Effect.fail(invalid())
        const original = Result.map(ownEpochStagedGroup(source), encodeEpochStagedGroup)
        return Effect.fromResult(Result.mapError(original, invalid)).pipe(
          Effect.flatMap((group) =>
            request(
              (client) =>
                client.mutation(api.e2eeEpochStaging.stageGroup, {
                  ...device,
                  group,
                  ...(round ? { round } : {})
                }),
              z.object({ ok: z.literal(true) }),
              signal
            )
          ),
          Effect.asVoid
        )
      },
      readGroup: (sourceKey) => {
        const original = ownEpochStagedGroupKey(sourceKey)
        return Effect.fromResult(Result.mapError(original, invalid)).pipe(
          Effect.flatMap((key) =>
            request(
              (client) => client.query(api.e2eeEpochStaging.readGroup, { ...device, key }),
              z.unknown(),
              signal
            ).pipe(
              Effect.flatMap((value) => {
                if (value === null) return Effect.succeed(null)
                return Effect.fromResult(
                  Result.mapError(decodeEpochStagedGroup(value), invalid)
                ).pipe(
                  Effect.flatMap((group) =>
                    group.genesis === key.genesis &&
                    group.epoch === key.epoch &&
                    group.commitment === key.commitment &&
                    group.recordHash === key.recordHash
                      ? Effect.succeed(group)
                      : Effect.fail(invalid())
                  )
                )
              })
            )
          )
        )
      },
      deleteGroup: (sourceKey, occupied) => {
        const original = ownEpochStagedGroupKey(sourceKey)
        const occupiedSlot = { ...occupied }
        return Effect.fromResult(Result.mapError(original, invalid)).pipe(
          Effect.flatMap((key) => {
            if (
              occupiedSlot.epoch !== key.epoch ||
              !/^[0-9a-f]{64}$/.test(occupiedSlot.commitment) ||
              occupiedSlot.commitment === key.commitment
            )
              return Effect.fail(invalid())
            // One physical cleanup page only. The caller retains its original
            // and explicitly retries until the server confirms completion.
            return request(
              (client) =>
                client.mutation(api.e2eeEpochStaging.deleteGroup, {
                  ...device,
                  key,
                  occupied: occupiedSlot
                }),
              z.object({ ok: z.literal(true), done: z.boolean() }),
              signal
            ).pipe(
              Effect.flatMap((value) => (value.done ? Effect.void : Effect.fail(unavailable())))
            )
          })
        )
      }
    })
  }
  const mailbox = (access: E2eeDeviceAccess, signal?: AbortSignal): KeyMailbox['Service'] => {
    function boundRequest<T>(
      work: (client: ConvexHttpClient) => Promise<unknown>,
      schema: z.ZodType<T>
    ) {
      return request(work, schema, signal)
    }
    const device = { ...access }
    return KeyMailbox.of({
      put: (id, frame) => {
        const frameHex = hex(frame)
        return boundRequest(
          (client) => client.mutation(api.e2eeMailbox.put, { ...device, id, frameHex }),
          z.null()
        ).pipe(Effect.asVoid)
      },
      read: (id) =>
        boundRequest(
          (client) => client.query(api.e2eeMailbox.read, { ...device, id }),
          bytesHex(512).nullable()
        ).pipe(Effect.map((value) => (value === null ? null : raw(value)))),
      fetch: (epoch, cursor, limit) =>
        boundRequest(
          (client) => client.query(api.e2eeMailbox.fetch, { ...device, epoch, cursor, limit }),
          envelopes
        ).pipe(
          Effect.map((page) => ({
            items: page.items.map((item) => ({ sender: item.sender, frame: raw(item.frameHex) })),
            next: page.next
          }))
        ),
      status: (target) =>
        boundRequest(
          (client) => client.query(api.e2eeMailbox.status, { ...device, slot: target }),
          status
        ).pipe(
          Effect.flatMap((value) =>
            value.genesis === target.genesis &&
            value.epoch === target.epoch &&
            value.recipient === target.recipient
              ? Effect.succeed(value)
              : Effect.fail(new BackendError({ service: 'KeyMailbox', reason: 'invalid-response' }))
          )
        ),
      report: (report, publication) => {
        const reportHex = hex(report),
          publicationHex = publication === undefined ? undefined : hex(publication)
        return boundRequest(
          (client) =>
            client.mutation(api.e2eeMailbox.report, {
              ...device,
              reportHex,
              ...(publicationHex === undefined ? {} : { publicationHex })
            }),
          z.null()
        ).pipe(Effect.asVoid)
      },
      repair: (target, id, rejectedDigest) =>
        boundRequest(
          (client) =>
            client.mutation(api.e2eeMailbox.repair, {
              ...device,
              slot: target,
              id,
              ...(rejectedDigest === undefined ? {} : { rejectedDigest })
            }),
          z.null()
        ).pipe(Effect.asVoid)
    })
  }
  return Object.freeze({
    close,
    mailbox,
    accountIdentity: () =>
      request(
        (client) => client.action(api.e2eeWorkspaces.accountIdentity, {}),
        z.object({ accountId: z.string().min(1), cryptoUserId: hash })
      ),
    joinBegin: (requestInput: E2eeJoinRequests['begin']) => {
      const original = { ...requestInput }
      return request((client) => client.mutation(api.e2eeJoinMailbox.begin, original), joinSession)
    },
    joinStatus: (requestInput: E2eeJoinRequests['status']) => {
      const original = { ...requestInput }
      return request((client) => client.query(api.e2eeJoinMailbox.status, original), joinSession)
    },
    joinReadRequest: (requestInput: E2eeJoinRequests['readRequest']) => {
      const original = { ...requestInput }
      return request(
        (client) => client.query(api.e2eeJoinMailbox.readRequest, original),
        joinSession
      )
    },
    joinCancel: (requestInput: E2eeJoinRequests['cancel']) => {
      const original = { ...requestInput }
      return request(
        (client) => client.mutation(api.e2eeJoinMailbox.cancel, original),
        z.object({ status: z.literal('cancelled') })
      )
    },
    joinPublish: (requestInput: E2eeJoinRequests['publish']) => {
      const original = { ...requestInput }
      return request(
        (client) => client.mutation(api.e2eeJoinMailbox.publish, original),
        z.object({ status: z.literal('published') })
      )
    },
    joinClaim: (requestInput: E2eeJoinRequests['claim']) => {
      const original = { ...requestInput }
      return request(
        (client) => client.query(api.e2eeJoinMailbox.claim, original),
        joinSession.extend({
          publisher: hash.nullable(),
          invitationHex: bytesHex(3 * 1024 * 1024).nullable()
        })
      )
    },
    machineBegin: (requestInput: E2eeMachinePairingRequests['begin']) =>
      request(
        (client) => client.mutation(api.e2eeMachinePairing.begin, requestInput),
        RemoteMachineStatusSchema
      ),
    machineInspect: (requestInput: E2eeMachinePairingRequests['inspect']) =>
      request(
        (client) => client.query(api.e2eeMachinePairing.inspect, requestInput),
        RemoteMachineStatusSchema
      ),
    machineAuthorizeExisting: (requestInput: E2eeMachinePairingRequests['inspect']) =>
      request(
        (client) => client.mutation(api.e2eeMachinePairing.authorizeExisting, requestInput),
        RemoteMachineStatusSchema
      ),
    machineCancel: (requestInput: E2eeMachinePairingRequests['cancel']) =>
      request(
        (client) => client.mutation(api.e2eeMachinePairing.cancel, requestInput),
        RemoteMachineStatusSchema
      ),
    ledgerLog: (workspaceId: string, signal?: AbortSignal): LedgerLog['Service'] => {
      let observed: { head: string; length: number } | undefined
      return LedgerLog.of({
        read: (anchor) =>
          Effect.gen(function* () {
            const records: Uint8Array[] = []
            let cursor: string | undefined,
              fixed: { length: number; headHash: string } | undefined,
              bytes = 0
            for (let pageNumber = 0; pageNumber < 256; pageNumber++) {
              const page = yield* request(
                (client) =>
                  client.action(api.e2eeWorkspaces.history, {
                    workspaceId,
                    ...(cursor ? { cursor, checkpoint: fixed } : {})
                  }),
                historyPage,
                signal
              )
              fixed ??= page.checkpoint
              if (
                page.workspaceId !== workspaceId ||
                page.genesisHash !== hex(anchor.toBytes()) ||
                page.startIndex !== records.length ||
                page.checkpoint.length !== fixed.length ||
                page.checkpoint.headHash !== fixed.headHash
              )
                return yield* unavailable()
              for (const record of page.recordsHex) {
                const original = raw(record)
                bytes += original.length
                if (bytes > 33554432) return yield* unavailable()
                records.push(original)
              }
              if (!page.nextCursor)
                return {
                  records,
                  checkpoint: {
                    length: fixed.length,
                    head: Result.getOrThrow(Bytes.recordHash(raw(fixed.headHash)))
                  }
                }
              cursor = page.nextCursor
            }
            return yield* unavailable()
          }).pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                observed = {
                  head: hex(value.checkpoint.head.toBytes()),
                  length: value.checkpoint.length
                }
              })
            ),
            Effect.mapError((cause) => new LedgerLogError({ cause }))
          ),
        appendCas: (_anchor, point, source) => {
          const expected = { ...point },
            record = new Uint8Array(source)
          return Effect.gen(function* () {
            const parsed = yield* Effect.fromResult(decodeRecord(record))
            if (
              parsed.body.type !== 'ordinary' ||
              !parsed.body.previousHash.equals(expected.head) ||
              observed?.head !== hex(expected.head.toBytes()) ||
              observed.length !== expected.length
            )
              return yield* unavailable()
            const recordHash = hex(hashRecordBytes(record).toBytes())
            const reply = yield* request(
              (client) =>
                client.action(api.e2eeWorkspaces.appendRecord, {
                  workspaceId,
                  requestId: recordHash,
                  recordHex: hex(record)
                }),
              appended,
              signal
            )
            if (reply.recordHash !== recordHash || reply.status !== 'committed')
              return yield* unavailable()
            return undefined
          }).pipe(Effect.mapError((cause) => new LedgerLogError({ cause })))
        }
      })
    },
    appendRecord: (requestInput: E2eeAppendRecordRequest) => {
      const original = { ...requestInput }
      return request((client) => client.action(api.e2eeWorkspaces.appendRecord, original), appended)
    },
    contentStreamsToken: (access: E2eeContentTokenRequest) =>
      request(
        (client) => client.action(api.e2eeContent.contentStreamsToken, { ...access }),
        contentToken
      ),
    history: (requestInput: E2eeWorkspaceHistoryRequest, signal?: AbortSignal) => {
      const original = {
        ...requestInput,
        ...(requestInput.checkpoint ? { checkpoint: { ...requestInput.checkpoint } } : {})
      }
      return request(
        (client) => client.action(api.e2eeWorkspaces.history, original),
        historyPage,
        signal
      )
    },
    staging
  })
})
export type E2eeCloudClient = Effect.Success<ReturnType<typeof makeE2eeCloudClient>>
