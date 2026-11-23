import { SeatInvitePreviewSchema } from '@lody/cloud-api/seat-invite-preview'
import { makeInlineVersionReadHead, sharingReplySchemas } from '@lody/e2ee-machine-sharing/schemas'
import type { SharingRemote } from '@lody/e2ee-machine-sharing'
import { E2eeDeviceRevokedError, E2eeMemberRemovedError } from './e2ee-cloud-errors.mjs'
import { RemoteMachineStatusSchema } from '@lody/shared/e2ee-remote-pairing'
import {
  isTransientGatewayStatus,
  TRANSIENT_GATEWAY_RETRY_DELAYS_MS
} from '@lody/shared/transient-gateway'
import type { E2eeMachinePairingRequests } from '@lody/cloud-api'
import {
  Bytes,
  PAIRING_MAX_WORKSPACES,
  decodeRecord,
  hashRecordBytes
} from '@lody/e2ee-core/protocol'
import { ConvexHttpClient } from 'convex/browser'
import {
  api,
  makeBatchMailboxStatus,
  makeInlineMailboxFetch,
  makeInlineMailboxPut,
  makeInlineStageGroup,
  makeMailboxStatusCache
} from '@lody/cloud-api'
import type {
  E2eeAppendRecordRequest,
  E2eeContentTokenRequest,
  E2eeAccountPairingRequests,
  E2eeDeviceAccess,
  E2eeJoinRequests,
  E2eeMemberOffer,
  E2eeMemberRequests,
  E2eeWorkspaceHistoryRequest,
  E2eeWorkspaceHistoryPage
} from '@lody/cloud-api'
import {
  LedgerLog,
  LedgerLogError,
  BackendError,
  EpochStagingStore,
  KeyMailbox,
  type RecoveryVaultStore
} from '@lody/e2ee-core/services'
import {
  decodeRecoveryVaultCiphertext,
  encodeRecoveryVaultCiphertext,
  decodeEpochStagedGroup,
  encodeEpochStagedGroup,
  ownEpochStagedGroup,
  ownEpochStagedGroupKey
} from '@lody/e2ee-core/host'
import { Effect, Result } from 'effect'
import { z } from 'zod'
import { MemberOfferSchema } from './e2ee-member-join.mjs'

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
  attachmentToken: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
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
const appended = z.object({
  status: z.enum(['committed', 'conflict']),
  recordHash: hash,
  historyPage: historyPage.optional()
})
const workspaceBatch = <T extends z.ZodType>(schema: T) =>
  z.object({
    items: z
      .array(
        z.discriminatedUnion('status', [
          z.object({ workspaceId: z.string().min(1), status: z.literal('ok'), result: schema }),
          z.object({
            workspaceId: z.string().min(1),
            status: z.literal('error'),
            code: z.string().min(1)
          })
        ])
      )
      .min(1)
      .max(64)
  })
const pairingStatus = z.enum(['pending', 'approved', 'declined', 'expired'])
const pairingSummary = z.object({
  requestId: z.string().min(1),
  status: pairingStatus,
  deviceName: z.string().min(1).max(128),
  approximateLocation: z.string().max(256).nullable(),
  requestedAt: nonnegative,
  expiresAt: nonnegative
})
const pairingWorkspaces = z
  .array(
    z.object({
      workspaceId: z.string().min(1),
      genesisHash: hash,
      checkpoint: checkpoint.nullable().optional().catch(undefined)
    })
  )
  .max(PAIRING_MAX_WORKSPACES)
const pairingRecord = pairingSummary.extend({
  lookupId: z.string().regex(/^[0-9a-f]{32}$/),
  requestHex: bytesHex(64 * 1024),
  requestTagHex: hash,
  workspaces: pairingWorkspaces
})
const pairingClaim = z
  .object({
    status: pairingStatus,
    approvals: z
      .array(
        z.object({
          approvalHex: bytesHex(8 * 1024),
          approvalTagHex: hash,
          publishedAt: nonnegative,
          invitations: z
            .array(
              z.object({
                workspaceId: z.string().min(1),
                genesisHash: hash,
                invitationHex: bytesHex(3 * 1024 * 1024),
                admissionRecordHex: bytesHex(8192).optional().catch(undefined),
                mailboxPreview: z
                  .object({
                    epoch: nonnegative,
                    items: z.array(z.object({ sender: hash, frameHex: bytesHex(512) })).max(100),
                    next: z.null(),
                    slot: status
                  })
                  .optional()
                  .catch(undefined)
              })
            )
            .max(PAIRING_MAX_WORKSPACES)
        })
      )
      .max(8)
  })
  .nullable()
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
const memberRequest = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  accountId: z.string().min(1),
  keyPackageHex: bytesHex(4096),
  signingPublicKey: hash,
  requestId: z.string().regex(/^[0-9a-f]{32}$/),
  source: z.enum(['email', 'link']),
  state: z.enum(['pending', 'admitting', 'committed', 'rejected', 'cancelled']),
  expiresAt: nonnegative,
  // Passed through unparsed: the host verifies the endorsement itself, and a malformed
  // relay copy must only cost automatic admission, never explicit approval.
  offer: z.custom<E2eeMemberOffer>(() => true)
})
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const raw = (value: string) => new Uint8Array(Buffer.from(value, 'hex'))
const memberDeviceAccess = (source: E2eeDeviceAccess): E2eeDeviceAccess => ({
  workspaceId: source.workspaceId,
  credential: source.credential,
  ...(source.cliToken === undefined ? {} : { cliToken: source.cliToken })
})
const unavailable = () => new BackendError({ service: 'E2eeCloud', reason: 'unavailable' })

async function hasE2eeRefusalBody(response: Response, signal: AbortSignal): Promise<boolean> {
  if (typeof response.clone !== 'function') return false
  let onAbort: (() => void) | undefined
  try {
    const cloned = response.clone()
    const aborted = new Promise<string>((_resolve, reject) => {
      if (signal.aborted) {
        reject(unavailable())
        return
      }
      onAbort = () => reject(unavailable())
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const text = await Promise.race([cloned.text(), aborted])
    return /\be2ee_[a-z0-9_]+/i.test(text)
  } catch {
    if (signal.aborted) throw unavailable()
    return false
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function defaultRetryDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(unavailable())
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(unavailable())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

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

/** Account pairing relay refusals the new device explains (see `PAIRING_REFUSALS`):
 * the deployment has account pairing switched off, or the account submitted too
 * many new requests this hour. Only the mapped code leaves; the server text does not. */
type AccountPairingRelayRefusal = 'pairing-unavailable' | 'pairing-rate-limited'
const accountPairingRefusals = new Map<string, AccountPairingRelayRefusal>([
  ['e2ee_account_pairing_disabled', 'pairing-unavailable'],
  ['e2ee_account_pairing_rate_limited', 'pairing-rate-limited']
])
export class E2eeAccountPairingRefusedError extends BackendError {
  constructor(readonly code: AccountPairingRelayRefusal) {
    super({ service: 'E2eeCloud', reason: 'unavailable' })
  }
}

/** Member-invitation refusals an administrator acts on; only the mapped code leaves. */
const memberInvitationRefusals = new Set(['e2ee_member_invitation_request_pending'])
export class E2eeMemberInvitationRefusedError extends BackendError {
  constructor(readonly code: string) {
    super({ service: 'E2eeCloud', reason: 'unavailable' })
  }
}

class E2eeSelfServiceRateLimitedError extends BackendError {
  constructor(readonly retryAt: number) {
    super({ service: 'E2eeCloud', reason: 'unavailable' })
  }
}

/** Only an explicit backend refusal may be presented as recovery switched off. */
export class E2eeRecoveryDisabledError extends BackendError {
  readonly code = 'disabled'
  constructor() {
    super({ service: 'E2eeCloud', reason: 'unavailable' })
  }
}

function requestFailure(error: unknown): BackendError {
  // Terminal types from authentication, transport or decoding are not authority.
  if (error instanceof E2eeMemberRemovedError || error instanceof E2eeDeviceRevokedError)
    return unavailable()
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
  const rateLimited = z
    .object({
      data: z.object({
        code: z.literal('e2ee_self_service_rate_limited'),
        retryAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
      })
    })
    .safeParse(error)
  if (rateLimited.success) return new E2eeSelfServiceRateLimitedError(rateLimited.data.data.retryAt)
  const result = z.object({ data: z.object({ code: z.string() }) }).safeParse(error)
  const code = result.success ? result.data.data.code : ''
  if (code === 'e2ee_recovery_vault_disabled') return new E2eeRecoveryDisabledError()
  if (operatorCodes.has(code)) return new E2eeCloudDiagnosticError(code)
  const refusal = accountPairingRefusals.get(code)
  if (refusal) return new E2eeAccountPairingRefusedError(refusal)
  if (memberInvitationRefusals.has(code)) return new E2eeMemberInvitationRefusedError(code)
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

/** Renew a JWT this long before its `exp`, so no reused token expires in flight. */
const TOKEN_RENEWAL_MARGIN_MS = 60_000
/** When to stop reusing `token`: its `exp` minus the margin, or 0 (never) if unreadable. */
function tokenRenewAt(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())
    return typeof payload?.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000 - TOKEN_RENEWAL_MARGIN_MS
      : 0
  } catch {
    return 0
  }
}

/** Only optional cloud E2EE workflows construct this owner. No generic Convex
 * invocation escapes it. All methods run outside the account's custody lock.
 * Timeouts leave write outcomes unknown: callers reconcile the original bytes. */
export const makeE2eeCloudClient = Effect.fnUntraced(function* (input: {
  platformKind: 'cloud' | 'local'
  deploymentUrl: string
  convexToken: (signal: AbortSignal) => Promise<unknown>
  fetch?: typeof globalThis.fetch
  /** Wall clock for token reuse; injected by tests. */
  now?: () => number
  /** Backoff delay hook between transient HTTP gateway retries; injected by tests. */
  retryDelay?: (ms: number, signal: AbortSignal) => Promise<void>
}) {
  if (input.platformKind !== 'cloud')
    return yield* new BackendError({ service: 'E2eeCloud', reason: 'unauthorized' })
  const owner = new AbortController()
  const now = input.now ?? Date.now
  // One unexpired Convex JWT serves later calls of this owner. The owner belongs to one
  // account and closes on account change and sign-out, which drops the token with it.
  let reusable: { token: string; renewAt: number } | undefined
  const ledgerCaches = new Map<
    string,
    {
      anchorHex: string
      position: string
      records: Uint8Array[]
      bytes: number
    }
  >()
  const inlineMailboxReads = new Map<string, string>()
  const inlineMailboxStatuses = new Map<string, z.infer<typeof status>>()
  const inlineStagedGroups = new Map<string, unknown>()
  const cacheBounded = <V extends unknown>(map: Map<string, V>, key: string, value: V) => {
    if (map.size >= 512 && !map.has(key)) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    map.set(key, value)
  }
  const close = Effect.sync(() => {
    reusable = undefined
    ledgerCaches.clear()
    inlineMailboxReads.clear()
    inlineMailboxStatuses.clear()
    inlineStagedGroups.clear()
    owner.abort()
  })
  yield* Effect.addFinalizer(() => close)
  // Per client: a backend without inlined receipts/originals costs one refused request.
  const inlineVersionReadHead = makeInlineVersionReadHead()
  const inlineMailboxPut = makeInlineMailboxPut()
  const inlineMailboxFetch = makeInlineMailboxFetch()
  const batchMailboxStatus = makeBatchMailboxStatus()
  const isUnsupportedBatchError = (error: unknown) => {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    return /Could not find public function|ArgumentValidationError/.test(message)
  }
  const inlineStageGroup = makeInlineStageGroup()
  const fetch = input.fetch ?? globalThis.fetch

  async function runConvex<T>(
    work: (client: ConvexHttpClient) => Promise<unknown>,
    schema: z.ZodType<T>,
    combined: AbortSignal,
    credentialBound = false,
    actionEnvelope = false,
    preserveTokenOnError?: (error: unknown) => boolean
  ): Promise<T> {
    let terminalFailure: BackendError | undefined
    try {
      combined.throwIfAborted()
      let token: string
      if (reusable && now() < reusable.renewAt) token = reusable.token
      else {
        const response = await input.convexToken(combined).catch(() => {
          throw unavailable()
        })
        combined.throwIfAborted()
        const tokenResponse = z
          .union([
            z.object({ data: z.object({ token: z.string().min(1) }) }),
            z.object({ token: z.string().min(1) })
          ])
          .safeParse(response)
        if (!tokenResponse.success) throw unavailable()
        token =
          'data' in tokenResponse.data ? tokenResponse.data.data.token : tokenResponse.data.token
        const renewAt = tokenRenewAt(token)
        reusable = renewAt > now() ? { token, renewAt } : undefined
      }
      const retryDelay = input.retryDelay ?? defaultRetryDelay
      // A request owns its auth and abort signal. Concurrent work cannot change
      // another request's credentials through a shared mutable SDK client.
      const client = new ConvexHttpClient(input.deploymentUrl, {
        auth: token,
        logger: false,
        fetch: async (url, options) => {
          let httpResponse!: Response
          for (let attempt = 0; attempt <= TRANSIENT_GATEWAY_RETRY_DELAYS_MS.length; attempt++) {
            combined.throwIfAborted()
            httpResponse = await fetch(url, { ...options, signal: combined }).catch(() => {
              throw unavailable()
            })
            if (
              isTransientGatewayStatus(httpResponse.status) &&
              attempt < TRANSIENT_GATEWAY_RETRY_DELAYS_MS.length &&
              !(await hasE2eeRefusalBody(httpResponse, combined))
            ) {
              void httpResponse.body?.cancel?.().catch(() => {})
              await retryDelay(TRANSIENT_GATEWAY_RETRY_DELAYS_MS[attempt]!, combined).catch(() => {
                throw unavailable()
              })
              combined.throwIfAborted()
              continue
            }
            break
          }
          // Convex's function-failure status, only for an explicitly credential-bound
          // endpoint. JWT, transport and JSON exceptions never reach this assignment.
          // The content grant action may report the same envelope over HTTP 200;
          // queries keep requiring 560, and a success body is returned untouched.
          if (
            credentialBound &&
            (httpResponse.status === 560 || (actionEnvelope && httpResponse.status === 200))
          ) {
            const unread = httpResponse.clone()
            const rejection = z
              .object({
                status: z.literal('error'),
                errorMessage: z.string(),
                errorData: z.object({
                  code: z.enum(['e2ee_member_removed', 'e2ee_device_revoked'])
                })
              })
              .safeParse(
                await httpResponse.json().catch(() => {
                  throw unavailable()
                })
              )
            combined.throwIfAborted()
            if (rejection.success) {
              terminalFailure =
                rejection.data.errorData.code === 'e2ee_member_removed'
                  ? new E2eeMemberRemovedError()
                  : new E2eeDeviceRevokedError()
              throw terminalFailure
            }
            return unread
          }
          return httpResponse
        }
      })
      const value = await work(client)
      combined.throwIfAborted()
      return decode(schema, value)
    } catch (error) {
      if (!preserveTokenOnError?.(error)) reusable = undefined
      throw terminalFailure !== undefined && error === terminalFailure
        ? terminalFailure
        : requestFailure(error)
    }
  }

  function request<T>(
    work: (client: ConvexHttpClient) => Promise<unknown>,
    schema: z.ZodType<T>,
    requestSignal?: AbortSignal,
    credentialBound = false,
    /** Convex streams an action's failure as an HTTP 200 error envelope. */
    actionEnvelope = false
  ) {
    return Effect.suspend(() =>
      Effect.tryPromise({
        try: (signal) =>
          runConvex(
            work,
            schema,
            AbortSignal.any([signal, owner.signal, ...(requestSignal ? [requestSignal] : [])]),
            credentialBound,
            actionEnvelope
          ),
        catch: (error) =>
          error instanceof E2eeMemberRemovedError ||
          error instanceof E2eeDeviceRevokedError ||
          error instanceof BackendError
            ? error
            : requestFailure(error)
      }).pipe(
        // A deadline or cancellation interrupts the call before `catch`: drop the token too.
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            reusable = undefined
          })
        )
      )
    ).pipe(Effect.timeoutOrElse({ duration: '30 seconds', orElse: unavailable }))
  }

  const staging = (
    access: E2eeDeviceAccess,
    signal?: AbortSignal,
    round?: string
  ): EpochStagingStore['Service'] => {
    const device = { ...access }
    const invalid = () =>
      new BackendError({ service: 'EpochStagingStore', reason: 'invalid-response' })
    const groupCacheKey = (key: {
      genesis: string
      epoch: number
      commitment: string
      recordHash: string
    }) =>
      `${device.workspaceId}\0${device.credential}\0${device.cliToken ?? ''}\0${key.genesis}\0${key.epoch}\0${key.commitment}\0${key.recordHash}`
    const verifyGroup = (
      key: { genesis: string; epoch: number; commitment: string; recordHash: string },
      value: unknown
    ) => {
      if (value === null) return Effect.succeed(null)
      return Effect.fromResult(Result.mapError(decodeEpochStagedGroup(value), invalid)).pipe(
        Effect.flatMap((group) =>
          group.genesis === key.genesis &&
          group.epoch === key.epoch &&
          group.commitment === key.commitment &&
          group.recordHash === key.recordHash
            ? Effect.succeed(group)
            : Effect.fail(invalid())
        )
      )
    }
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
                inlineStageGroup({ ...device, group, ...(round ? { round } : {}) }, (args) =>
                  client.mutation(api.e2eeEpochStaging.stageGroup, args)
                ),
              z.object({ ok: z.literal(true), group: z.unknown().optional() }),
              signal,
              true
            ).pipe(
              Effect.tap((reply) =>
                Effect.sync(() => {
                  if (reply.group !== undefined)
                    cacheBounded(inlineStagedGroups, groupCacheKey(group), reply.group)
                })
              )
            )
          ),
          Effect.asVoid
        )
      },
      readGroup: (sourceKey) => {
        const original = ownEpochStagedGroupKey(sourceKey)
        return Effect.fromResult(Result.mapError(original, invalid)).pipe(
          Effect.flatMap((key) =>
            Effect.suspend(() => {
              if (signal?.aborted || owner.signal.aborted) return Effect.fail(unavailable())
              const cacheKey = groupCacheKey(key)
              if (inlineStagedGroups.has(cacheKey)) {
                const cached = inlineStagedGroups.get(cacheKey)
                inlineStagedGroups.delete(cacheKey)
                return verifyGroup(key, cached)
              }
              return request(
                (client) => client.query(api.e2eeEpochStaging.readGroup, { ...device, key }),
                z.unknown(),
                signal,
                true
              ).pipe(Effect.flatMap((value) => verifyGroup(key, value)))
            })
          )
        )
      },
      deleteGroup: (sourceKey, occupied) => {
        const original = ownEpochStagedGroupKey(sourceKey)
        const occupiedSlot = { ...occupied }
        return Effect.fromResult(Result.mapError(original, invalid)).pipe(
          Effect.flatMap((key) => {
            inlineStagedGroups.delete(groupCacheKey(key))
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
              signal,
              true
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
      return request(work, schema, signal, true)
    }
    const device = { ...access }
    const selfStatusCache = makeMailboxStatusCache({ ttlMs: 1000 })
    const withinRoundCache = makeMailboxStatusCache({ ttlMs: 200 })
    let knownSelfRecipient: string | undefined
    const readCacheKey = (id: string) =>
      `${device.workspaceId}\0${device.credential}\0${device.cliToken ?? ''}\0${id}`
    const statusCacheKey = (target: { genesis: string; epoch: number; recipient: string }) =>
      `${device.workspaceId}\0${device.credential}\0${device.cliToken ?? ''}\0${target.genesis}\0${target.epoch}\0${target.recipient}`
    const verifyStatus = (
      target: { genesis: string; epoch: number; recipient: string },
      value: z.infer<typeof status>
    ) =>
      value.genesis === target.genesis &&
      value.epoch === target.epoch &&
      value.recipient === target.recipient
        ? Effect.succeed(value)
        : Effect.fail(new BackendError({ service: 'KeyMailbox', reason: 'invalid-response' }))
    return KeyMailbox.of({
      put: (id, frame) => {
        const frameHex = hex(frame)
        return Effect.suspend(() => {
          selfStatusCache.invalidateAccess(device)
          withinRoundCache.invalidateAccess(device)
          return boundRequest(
            (client) =>
              inlineMailboxPut({ ...device, id, frameHex }, (args) =>
                client.mutation(api.e2eeMailbox.put, args)
              ),
            z.union([z.null(), z.object({ frameHex: bytesHex(512), slot: status })])
          )
        }).pipe(
          Effect.tap((receipt) =>
            Effect.sync(() => {
              if (receipt !== null) {
                cacheBounded(inlineMailboxReads, readCacheKey(id), receipt.frameHex)
                cacheBounded(inlineMailboxStatuses, statusCacheKey(receipt.slot), receipt.slot)
                selfStatusCache.invalidateSlot(device, receipt.slot)
                withinRoundCache.invalidateSlot(device, receipt.slot)
              } else {
                selfStatusCache.invalidateAccess(device)
                withinRoundCache.invalidateAccess(device)
              }
            })
          ),
          Effect.asVoid
        )
      },
      read: (id) =>
        Effect.suspend(() => {
          if (signal?.aborted || owner.signal.aborted) return Effect.fail(unavailable())
          const cacheKey = readCacheKey(id)
          if (inlineMailboxReads.has(cacheKey)) {
            const cached = inlineMailboxReads.get(cacheKey)!
            inlineMailboxReads.delete(cacheKey)
            return Effect.succeed(raw(cached))
          }
          return boundRequest(
            (client) => client.query(api.e2eeMailbox.read, { ...device, id }),
            bytesHex(512).nullable()
          ).pipe(Effect.map((value) => (value === null ? null : raw(value))))
        }),
      fetch: (epoch, cursor, limit) =>
        boundRequest(
          (client) =>
            inlineMailboxFetch({ ...device, epoch, cursor, limit }, (args) =>
              client.query(api.e2eeMailbox.fetch, args)
            ),
          envelopes.extend({ slot: status.optional() })
        ).pipe(
          Effect.tap((page) =>
            Effect.sync(() => {
              if (page.slot !== undefined && page.slot.epoch === epoch) {
                knownSelfRecipient = page.slot.recipient
                selfStatusCache.set(device, page.slot)
              }
            })
          ),
          Effect.map((page) => ({
            items: page.items.map((item) => ({ sender: item.sender, frame: raw(item.frameHex) })),
            next: page.next
          }))
        ),
      status: (target) =>
        Effect.suspend(() => {
          if (signal?.aborted || owner.signal.aborted) return Effect.fail(unavailable())
          const cacheKey = statusCacheKey(target)
          if (inlineMailboxStatuses.has(cacheKey)) {
            const cached = inlineMailboxStatuses.get(cacheKey)!
            inlineMailboxStatuses.delete(cacheKey)
            return verifyStatus(target, cached)
          }
          const cachedStatus =
            selfStatusCache.get(device, target) ?? withinRoundCache.get(device, target)
          if (cachedStatus !== undefined) return verifyStatus(target, cachedStatus)
          return Effect.tryPromise({
            try: (fiberSignal) => {
              const waiterSignal = signal ? AbortSignal.any([fiberSignal, signal]) : fiberSignal
              if (waiterSignal.aborted) return Promise.reject(unavailable())
              let usedSingle = false
              const promise = batchMailboxStatus(
                { ...device, slot: target },
                {
                  single: (args) => {
                    usedSingle = true
                    return runConvex(
                      (client) => client.query(api.e2eeMailbox.status, args),
                      status,
                      AbortSignal.any([waiterSignal, owner.signal]),
                      true
                    )
                  },
                  batch: (args) => {
                    let rawError: unknown
                    return runConvex(
                      (client) =>
                        client.query(api.e2eeMailbox.batchStatus, args).catch((error) => {
                          rawError = error
                          throw error
                        }),
                      z.array(status),
                      signal ? AbortSignal.any([owner.signal, signal]) : owner.signal,
                      true,
                      false,
                      () => rawError !== undefined && isUnsupportedBatchError(rawError)
                    ).catch((error) => {
                      if (rawError !== undefined && isUnsupportedBatchError(rawError))
                        throw rawError
                      throw error
                    })
                  }
                }
              ).then((value) => {
                if (usedSingle) {
                  if (target.recipient === knownSelfRecipient) selfStatusCache.set(device, value)
                  else withinRoundCache.set(device, value)
                }
                return value
              })
              return new Promise<z.infer<typeof status>>((resolve, reject) => {
                const onAbort = () => reject(unavailable())
                waiterSignal.addEventListener('abort', onAbort, { once: true })
                promise.then(
                  (value) => {
                    waiterSignal.removeEventListener('abort', onAbort)
                    resolve(value)
                  },
                  (error) => {
                    waiterSignal.removeEventListener('abort', onAbort)
                    reject(error)
                  }
                )
              })
            },
            catch: (error) =>
              error instanceof E2eeMemberRemovedError ||
              error instanceof E2eeDeviceRevokedError ||
              error instanceof BackendError
                ? error
                : requestFailure(error)
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                reusable = undefined
              })
            ),
            Effect.timeoutOrElse({ duration: '30 seconds', orElse: unavailable }),
            Effect.flatMap((value) => verifyStatus(target, value))
          )
        }),
      report: (report, publication) => {
        const reportHex = hex(report),
          publicationHex = publication === undefined ? undefined : hex(publication)
        return Effect.suspend(() => {
          selfStatusCache.invalidateAccess(device)
          withinRoundCache.invalidateAccess(device)
          return boundRequest(
            (client) =>
              client.mutation(api.e2eeMailbox.report, {
                ...device,
                reportHex,
                ...(publicationHex === undefined ? {} : { publicationHex })
              }),
            z.null()
          )
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              selfStatusCache.invalidateAccess(device)
              withinRoundCache.invalidateAccess(device)
            })
          ),
          Effect.asVoid
        )
      },
      repair: (target, id, rejectedDigest) =>
        Effect.suspend(() => {
          inlineMailboxStatuses.delete(statusCacheKey(target))
          selfStatusCache.invalidateSlot(device, target)
          withinRoundCache.invalidateSlot(device, target)
          return boundRequest(
            (client) =>
              client.mutation(api.e2eeMailbox.repair, {
                ...device,
                slot: target,
                id,
                ...(rejectedDigest === undefined ? {} : { rejectedDigest })
              }),
            z.null()
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                selfStatusCache.invalidateSlot(device, target)
                withinRoundCache.invalidateSlot(device, target)
              })
            ),
            Effect.asVoid
          )
        })
    })
  }
  return Object.freeze({
    close,
    mailbox,
    memberCreateInvitation: (args: E2eeMemberRequests['createInvitation']) => {
      const original = {
        ...memberDeviceAccess(args),
        offer: { ...args.offer },
        ...(args.email === undefined ? {} : { email: args.email })
      }
      return request(
        (client) => client.mutation(api.e2eeMembers.createInvitation, original),
        z.object({ offer: MemberOfferSchema }),
        undefined,
        true
      )
    },
    memberSubmit: (args: E2eeMemberRequests['submit']) => {
      const original = { ...args }
      return request((client) => client.mutation(api.e2eeMembers.submit, original), memberRequest)
    },
    memberRetire: (args: E2eeMemberRequests['retire']) => {
      const original = { ...args }
      return request(
        (client) => client.mutation(api.e2eeMembers.retire, original),
        z.object({ state: memberRequest.shape.state })
      )
    },
    memberPending: (args: E2eeMemberRequests['pending']) => {
      const original = { ...memberDeviceAccess(args) }
      return request(
        (client) => client.query(api.e2eeMembers.pending, original),
        z
          .object({
            // Each invitation stands alone: one the relay lists in an unexpected shape is
            // left out instead of failing approval, rejection and revocation of the rest.
            invitations: z.array(z.unknown()).max(100),
            unsignedInvitations: z
              .array(z.object({ token: z.string(), email: z.string().max(320) }))
              .max(100)
              .optional(),
            items: z
              .array(
                memberRequest.extend({
                  applicantName: z.string(),
                  applicantEmail: z.string(),
                  memberLimitReached: z.boolean().optional()
                })
              )
              .max(100),
            hasMore: z.boolean(),
            seatPreview: SeatInvitePreviewSchema
          })
          .transform(({ unsignedInvitations, ...value }) => ({
            ...value,
            invitations: value.invitations.flatMap((item) => {
              const parsed = MemberOfferSchema.safeParse(item)
              if (!parsed.success) return []
              // Unsigned email invitation (created before signed offers): still revocable
              // by token; re-sending to its address issues a signed replacement. It never
              // admits automatically.
              const unsigned = unsignedInvitations?.find(
                (entry) => entry.token === parsed.data.token
              )
              return [
                unsigned
                  ? { ...parsed.data, needsReissue: true as const, email: unsigned.email }
                  : parsed.data
              ]
            })
          })),
        undefined,
        true
      )
    },
    memberRead: (args: E2eeMemberRequests['read']) => {
      const original = { ...memberDeviceAccess(args), requestId: args.requestId }
      return request(
        (client) => client.query(api.e2eeMembers.read, original),
        memberRequest,
        undefined,
        true
      )
    },
    memberReject: (args: E2eeMemberRequests['reject']) => {
      const original = { ...memberDeviceAccess(args), requestId: args.requestId }
      return request(
        (client) => client.mutation(api.e2eeMembers.reject, original),
        z.object({ state: z.literal('rejected') }),
        undefined,
        true
      )
    },
    memberRevoke: (args: E2eeMemberRequests['revoke']) => {
      const original = { ...memberDeviceAccess(args), token: args.token }
      return request(
        (client) => client.mutation(api.e2eeMembers.revoke, original),
        z.object({ revoked: z.literal(true) }),
        undefined,
        true
      )
    },
    memberClaim: (args: E2eeMemberRequests['claim']) => {
      const original = { ...args }
      return request((client) => client.query(api.e2eeMembers.claim, original), memberRequest)
    },

    // Account-wide pairing relay. Replies are untrusted; callers verify every tag.
    pairingSubmit: (requestInput: E2eeAccountPairingRequests['submit']) => {
      const original = { ...requestInput }
      return request(
        (client) => client.mutation(api.e2eeAccountPairing.submit, original),
        pairingSummary
      )
    },
    pairingRead: (requestInput: E2eeAccountPairingRequests['read']) => {
      const original = { ...requestInput }
      return request(
        (client) => client.query(api.e2eeAccountPairing.read, original),
        pairingRecord.nullable()
      )
    },
    pairingDecline: (requestInput: E2eeAccountPairingRequests['decline']) => {
      const original = { ...requestInput }
      return request(
        (client) => client.mutation(api.e2eeAccountPairing.decline, original),
        z.object({ status: z.literal('declined') })
      )
    },
    pairingPublish: (requestInput: E2eeAccountPairingRequests['publish']) => {
      const original = { ...requestInput }
      return request(
        (client) => client.mutation(api.e2eeAccountPairing.publish, original),
        z.object({
          status: z.literal('published'),
          deliveredWorkspaces: z.array(z.string().min(1)).max(64).optional().catch(undefined)
        })
      )
    },
    pairingClaim: (requestInput: E2eeAccountPairingRequests['claim']) => {
      const original = { ...requestInput }
      return request((client) => client.query(api.e2eeAccountPairing.claim, original), pairingClaim)
    },
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
        joinSession,
        undefined,
        true
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
        z.object({ status: z.literal('published') }),
        undefined,
        true
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
        RemoteMachineStatusSchema,
        undefined,
        true
      ),
    machineInspect: (requestInput: E2eeMachinePairingRequests['inspect']) =>
      request(
        (client) => client.query(api.e2eeMachinePairing.inspect, requestInput),
        RemoteMachineStatusSchema,
        undefined,
        true
      ),
    machineAuthorizeExisting: (requestInput: E2eeMachinePairingRequests['inspect']) =>
      request(
        (client) => client.mutation(api.e2eeMachinePairing.authorizeExisting, requestInput),
        RemoteMachineStatusSchema,
        undefined,
        true
      ),
    machineCancel: (requestInput: E2eeMachinePairingRequests['cancel']) =>
      request(
        (client) => client.mutation(api.e2eeMachinePairing.cancel, requestInput),
        RemoteMachineStatusSchema,
        undefined,
        true
      ),
    ledgerLog: (
      workspaceId: string,
      signal?: AbortSignal,
      feed?: {
        position: () => Effect.Effect<string | undefined, unknown>
        ingest: (page: E2eeWorkspaceHistoryPage) => Effect.Effect<unknown, unknown>
      }
    ): LedgerLog['Service'] & {
      observe: (point: { head: Bytes.RecordHash; length: number }) => Effect.Effect<void>
    } => {
      let observed: { head: string; length: number } | undefined
      let inline: E2eeWorkspaceHistoryPage | undefined
      return {
        observe: (point) =>
          Effect.sync(() => {
            observed = { head: hex(point.head.toBytes()), length: point.length }
          }),
        ...(feed
          ? {
              readFrom: (anchor: Bytes.GenesisHash, base: import('@lody/e2ee-core').LedgerView) =>
                Effect.gen(function* () {
                  const anchorHex = hex(anchor.toBytes())
                  const after = yield* feed.position()
                  const retained = inline
                  inline = undefined
                  let cursor: string | undefined
                  let fixed: E2eeWorkspaceHistoryPage['checkpoint'] | undefined
                  const records: Uint8Array[] = []
                  let bytes = 0
                  for (let pageNumber = 0; pageNumber < 256; pageNumber++) {
                    const page =
                      pageNumber === 0 &&
                      retained &&
                      retained.workspaceId === workspaceId &&
                      retained.genesisHash === anchorHex &&
                      retained.startIndex === base.length &&
                      retained.nextCursor === null
                        ? retained
                        : yield* request(
                            (client) =>
                              client.action(api.e2eeWorkspaces.history, {
                                workspaceId,
                                ...(cursor ? { cursor, checkpoint: fixed } : after ? { after } : {})
                              }),
                            historyPage,
                            signal
                          )
                    fixed ??= page.checkpoint
                    if (
                      page.workspaceId !== workspaceId ||
                      page.genesisHash !== anchorHex ||
                      page.startIndex !== base.length + records.length ||
                      page.checkpoint.length !== fixed.length ||
                      page.checkpoint.headHash !== fixed.headHash
                    )
                      return yield* unavailable()
                    for (const value of page.recordsHex) {
                      const original = raw(value)
                      bytes += original.length
                      if (bytes > 33554432) return yield* unavailable()
                      records.push(original)
                    }
                    yield* feed.ingest(page)
                    if (page.nextCursor === null) {
                      observed = { head: fixed.headHash, length: fixed.length }
                      return {
                        records,
                        checkpoint: {
                          head: Result.getOrThrow(Bytes.recordHash(raw(fixed.headHash))),
                          length: fixed.length
                        }
                      }
                    }
                    cursor = page.nextCursor
                  }
                  return yield* unavailable()
                }).pipe(Effect.mapError((cause) => new LedgerLogError({ cause })))
            }
          : {}),
        read: (anchor) =>
          Effect.gen(function* () {
            const anchorHex = hex(anchor.toBytes())
            const cached = ledgerCaches.get(workspaceId)
            const records: Uint8Array[] = []
            let cursor: string | undefined,
              fixed: { length: number; headHash: string } | undefined,
              bytes = 0
            for (let pageNumber = 0; pageNumber < 256; pageNumber++) {
              const page = yield* request(
                (client) =>
                  client.action(api.e2eeWorkspaces.history, {
                    workspaceId,
                    ...(cursor
                      ? { cursor, checkpoint: fixed }
                      : cached && cached.anchorHex === anchorHex
                        ? { after: cached.position }
                        : {})
                  }),
                historyPage,
                signal
              )
              if (
                pageNumber === 0 &&
                cached &&
                cached.anchorHex === anchorHex &&
                page.startIndex === cached.records.length &&
                page.checkpoint.length >= cached.records.length
              ) {
                records.push(...cached.records)
                bytes = cached.bytes
              }
              fixed ??= page.checkpoint
              if (
                page.workspaceId !== workspaceId ||
                page.genesisHash !== anchorHex ||
                page.startIndex !== records.length ||
                page.checkpoint.length !== fixed.length ||
                page.checkpoint.headHash !== fixed.headHash
              ) {
                ledgerCaches.delete(workspaceId)
                return yield* unavailable()
              }
              for (const record of page.recordsHex) {
                const original = raw(record)
                bytes += original.length
                if (bytes > 33554432) return yield* unavailable()
                records.push(original)
              }
              if (!page.nextCursor) {
                ledgerCaches.set(workspaceId, {
                  anchorHex,
                  position: page.position,
                  records: records.slice(),
                  bytes
                })
                return {
                  records,
                  checkpoint: {
                    length: fixed.length,
                    head: Result.getOrThrow(Bytes.recordHash(raw(fixed.headHash)))
                  }
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
            if (reply.historyPage && reply.historyPage.recordsHex.length > 0)
              inline = reply.historyPage
            if (reply.recordHash !== recordHash || reply.status !== 'committed')
              return yield* unavailable()
            return undefined
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof E2eeSelfServiceRateLimitedError
                ? new LedgerLogError({
                    reason: 'self-service-rate-limited',
                    retryAt: cause.retryAt
                  })
                : new LedgerLogError({ cause })
            )
          )
        }
      }
    },
    historyBatch: (items: E2eeWorkspaceHistoryRequest[]) => {
      const original = structuredClone(items)
      return request(async (client) => {
        try {
          return await client.action(api.e2eeWorkspaces.historyBatch, { items: original })
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes('Could not find public function') ||
            !error.message.includes('e2eeWorkspaces:historyBatch')
          )
            throw error
          const items: Array<
            import('@lody/cloud-api').E2eeWorkspaceBatchReply<E2eeWorkspaceHistoryPage>['items'][number]
          > = []
          for (let i = 0; i < original.length; i += 4)
            items.push(
              ...(await Promise.all(
                original.slice(i, i + 4).map(async (item) => {
                  try {
                    return {
                      workspaceId: item.workspaceId,
                      status: 'ok' as const,
                      result: await client.action(api.e2eeWorkspaces.history, item)
                    }
                  } catch {
                    return {
                      workspaceId: item.workspaceId,
                      status: 'error' as const,
                      code: 'e2ee_unavailable'
                    }
                  }
                })
              ))
            )
          return { items }
        }
      }, workspaceBatch(historyPage))
    },
    appendRecordsBatch: (items: E2eeAppendRecordRequest[]) => {
      const original = structuredClone(items)
      return request(
        (client) => client.action(api.e2eeWorkspaces.appendRecordsBatch, { items: original }),
        workspaceBatch(appended)
      )
    },
    appendRecord: (requestInput: E2eeAppendRecordRequest) => {
      const original = { ...requestInput }
      return request((client) => client.action(api.e2eeWorkspaces.appendRecord, original), appended)
    },
    machineSharing: (signal?: AbortSignal): SharingRemote => ({
      readHead: (sharingInput) =>
        request(
          (client) =>
            inlineVersionReadHead(sharingInput, (args) =>
              client.action(api.e2eeMachineSharing.readHead, args)
            ),
          sharingReplySchemas.readHead,
          signal,
          true
        ),
      readVersion: (sharingInput) =>
        request(
          (client) => client.action(api.e2eeMachineSharing.readVersion, sharingInput),
          sharingReplySchemas.readVersion,
          signal,
          true
        ),
      readRequest: (sharingInput) =>
        request(
          (client) => client.action(api.e2eeMachineSharing.readRequest, sharingInput),
          sharingReplySchemas.readRequest,
          signal,
          true
        ),
      commit: (sharingInput) =>
        request(
          (client) => client.action(api.e2eeMachineSharing.commit, sharingInput),
          sharingReplySchemas.commit,
          signal,
          true
        )
    }),
    contentStreamsToken: (access: E2eeContentTokenRequest) =>
      request(
        (client) => client.action(api.e2eeContent.contentStreamsToken, { ...access }),
        contentToken,
        undefined,
        true,
        true
      ),
    history: (requestInput: E2eeWorkspaceHistoryRequest, signal?: AbortSignal) => {
      const original = {
        ...requestInput,
        ...(requestInput.checkpoint ? { checkpoint: { ...requestInput.checkpoint } } : {})
      }
      return request(
        (client) => client.action(api.e2eeWorkspaces.history, original),
        historyPage,
        signal,
        original.credential !== undefined
      )
    },
    staging,
    /** Opaque recovery-vault ciphertext storage. Login gates retrieval only; the
     * service never decrypts, selects ledger trust or proves an active Recovery device. */
    /** The first page of account security events. Kinds this build does not know pass
     * through as strings, and the caller ignores them. */
    accountSecurityEvents: (signal?: AbortSignal) => () =>
      request(
        (client) => client.query(api.accountSecurityEvents.list, { limit: 20 }),
        z.object({
          events: z
            .array(z.object({ id: z.string(), kind: z.string(), occurredAt: z.number() }))
            .max(50),
          nextCursor: z.string().nullable()
        }),
        signal
      ),
    /** Whole-vault replacement bookkeeping. State never decides trust; the ledger does. */
    recoveryVaultReplacement: (signal?: AbortSignal) => {
      const ok = z.object({ ok: z.literal(true) })
      return {
        state: () =>
          request(
            (client) => client.query(api.e2eeRecoveryVault.replacementState, {}),
            z.object({ current: z.string().nullable(), replacing: z.string().nullable() }),
            signal
          ),
        reserve: (vaultId: string) =>
          request(
            (client) => client.mutation(api.e2eeRecoveryVault.reserveReplacementVault, { vaultId }),
            ok,
            signal
          ).pipe(Effect.asVoid),
        finish: (oldVaultId: string, newVaultId: string) =>
          request(
            (client) =>
              client.mutation(api.e2eeRecoveryVault.finishReplacement, { oldVaultId, newVaultId }),
            ok,
            signal
          ).pipe(Effect.asVoid),
        abandon: (vaultId: string) =>
          request(
            (client) => client.mutation(api.e2eeRecoveryVault.abandonReplacement, { vaultId }),
            ok,
            signal
          ).pipe(Effect.asVoid)
      }
    },
    /** Encrypted workspaces this account can name, whether or not this device joined them. */
    recoveryVaultAccountWorkspaces: (signal?: AbortSignal) =>
      request(
        (client) => client.query(api.e2eeMembers.workspaces, {}),
        z.array(z.object({ id: z.string(), name: z.string(), genesisHash: hash })),
        signal
      ),
    /** Whether this account already has a vault. One account has one vault. */
    hasRecoveryVault: (signal?: AbortSignal) =>
      request(
        (client) => client.query(api.e2eeRecoveryVault.hasAccountVault, {}),
        z.object({ exists: z.boolean() }),
        signal
      ).pipe(Effect.map((reply) => reply.exists)),
    recoveryVault: (signal?: AbortSignal): RecoveryVaultStore['Service'] => {
      const ciphertext = (value: unknown) => {
        if (value === null) return Effect.succeed(null)
        const decoded = decodeRecoveryVaultCiphertext(value)
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new BackendError({ service: 'RecoveryVaultStore', reason: 'invalid-response' })
            )
      }
      const ok = z.object({ ok: z.literal(true) })
      return {
        putImmutable: (vaultId, entry) =>
          request(
            (client) =>
              client.mutation(api.e2eeRecoveryVault.putImmutable, {
                vaultId,
                entry: encodeRecoveryVaultCiphertext(entry)
              }),
            ok,
            signal
          ).pipe(Effect.asVoid),
        readEntry: (vaultId, entryId) =>
          request(
            (client) => client.query(api.e2eeRecoveryVault.readEntry, { vaultId, entryId }),
            z.unknown(),
            signal
          ).pipe(Effect.flatMap(ciphertext)),
        readEntries: (vaultId, entryIds) =>
          request(
            async (client) => {
              try {
                return await client.query(api.e2eeRecoveryVault.readEntries, {
                  vaultId,
                  entryIds: [...entryIds]
                })
              } catch (error) {
                if (
                  !(error instanceof Error) ||
                  !error.message.includes('Could not find public function') ||
                  !error.message.includes('e2eeRecoveryVault:readEntries')
                )
                  throw error
                const rows: unknown[] = []
                for (let i = 0; i < entryIds.length; i += 4)
                  rows.push(
                    ...(await Promise.all(
                      entryIds
                        .slice(i, i + 4)
                        .map((entryId) =>
                          client.query(api.e2eeRecoveryVault.readEntry, { vaultId, entryId })
                        )
                    ))
                  )
                return rows
              }
            },
            z.array(z.unknown()),
            signal
          ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, ciphertext))),
        readIndex: (vaultId) =>
          request(
            (client) => client.query(api.e2eeRecoveryVault.readIndex, { vaultId }),
            z.unknown(),
            signal
          ).pipe(Effect.flatMap(ciphertext)),
        compareAndSwapIndex: (vaultId, expected, next, referencedEntryIds) =>
          request(
            (client) =>
              client.mutation(api.e2eeRecoveryVault.compareAndSwapIndex, {
                vaultId,
                expected: expected && { revision: expected.revision, digest: expected.digest },
                next: encodeRecoveryVaultCiphertext(next),
                referencedEntryIds: [...referencedEntryIds]
              }),
            z.object({ outcome: z.enum(['Committed', 'Conflict']) }),
            signal
          ).pipe(Effect.map((value) => value.outcome)),
        deleteUnreferenced: (vaultId, entryId, expectedIndex) =>
          request(
            (client) =>
              client.mutation(api.e2eeRecoveryVault.deleteUnreferenced, {
                vaultId,
                entryId,
                expectedIndex: { revision: expectedIndex.revision, digest: expectedIndex.digest }
              }),
            ok,
            signal
          ).pipe(Effect.asVoid)
      }
    }
  })
})
export type E2eeCloudClient = Effect.Success<ReturnType<typeof makeE2eeCloudClient>>
