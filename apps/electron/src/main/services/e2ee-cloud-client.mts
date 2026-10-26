import { ConvexHttpClient } from 'convex/browser'
import { api } from '@lody/cloud-api'
import type {
  E2eeAppendRecordRequest,
  E2eeContentTokenRequest,
  E2eeDeviceAccess,
  E2eeWorkspaceHistoryRequest
} from '@lody/cloud-api'
import { BackendError, KeyMailbox } from '@lody/e2ee-core/services'
import { Effect } from 'effect'
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
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const raw = (value: string) => new Uint8Array(Buffer.from(value, 'hex'))
const unavailable = () => new BackendError({ service: 'E2eeCloud', reason: 'unavailable' })

function requestFailure(error: unknown): BackendError {
  if (error instanceof BackendError) return error
  // Never retain the SDK's raw error, server logs, request body, or token.
  const result = z.object({ data: z.object({ code: z.string() }) }).safeParse(error)
  const code = result.success ? result.data.data.code : ''
  const reason = code.endsWith('_conflict')
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
    appendRecord: (requestInput: E2eeAppendRecordRequest) => {
      const original = { ...requestInput }
      return request((client) => client.action(api.e2eeWorkspaces.appendRecord, original), appended)
    },
    contentStreamsToken: (access: E2eeContentTokenRequest) =>
      request(
        (client) => client.action(api.e2eeContent.contentStreamsToken, { ...access }),
        contentToken
      ),
    history: (requestInput: E2eeWorkspaceHistoryRequest) => {
      const original = {
        ...requestInput,
        ...(requestInput.checkpoint ? { checkpoint: { ...requestInput.checkpoint } } : {})
      }
      return request((client) => client.action(api.e2eeWorkspaces.history, original), historyPage)
    }
  })
})
export type E2eeCloudClient = Effect.Success<ReturnType<typeof makeE2eeCloudClient>>
