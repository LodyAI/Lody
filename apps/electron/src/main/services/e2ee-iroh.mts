import { createRequire } from 'node:module'
import { Deferred, Effect, Exit } from 'effect'
import type { IrohEndpoint, IrohNative } from '@lody/iroh-native'
import type { E2eeIrohRelays } from '@lody/platform'
import type { LedgerView } from '@lody/e2ee-core/protocol'

/** Connection budget for a call; a request without a live connection uses Streams. */
const CONNECT_TIMEOUT_MS = 3_000
/** Budget for preparing a connection in the background. */
const WARM_TIMEOUT_MS = 10_000

/** Loads the module, or `undefined` when it cannot load on this host. */
export function loadIrohNative(file: string | undefined): IrohNative | undefined {
  if (!file) return undefined
  try {
    return createRequire(import.meta.url)(file) as IrohNative
  } catch {
    return undefined
  }
}

/** The single ledger device registered as `machineId`; iroh dials its signing key. */
export function irohTargetDevice(view: LedgerView, machineId: string): string | undefined {
  const matches = [...view.inspectState().devices.entries()].filter(
    ([, device]) => device.kind === 'machine' && device.machineId === machineId
  )
  const key = matches.length === 1 ? matches[0]![0] : undefined
  return typeof key === 'string' && /^[0-9a-f]{64}$/.test(key) ? key : undefined
}

/**
 * Desktop side of encrypted RPC over iroh for one workspace. The endpoint opens
 * lazily on first use with this device's ledger seed, lives as long as the
 * workspace entry (its reader leases), and is closed by the entry Scope. It only
 * carries already prepared envelopes; preparation and response verification stay
 * with the existing renderer/native flow, and the machine still authorizes every
 * frame. Targets are resolved from the verified ledger, never from the renderer.
 */
export const makeDesktopIrohClient = Effect.fnUntraced(function* (options: {
  native: IrohNative
  relays: E2eeIrohRelays
  /** HTTP(S) proxy for relay connections (environment or system proxy). */
  proxyUrl?: string
  withSeed: <A>(open: (seed: Uint8Array) => Promise<A>) => Effect.Effect<A, unknown>
  ledger: () => Effect.Effect<LedgerView, unknown>
}) {
  const scope = yield* Effect.scope
  let opening: Deferred.Deferred<IrohEndpoint, unknown> | undefined
  let closed = false
  const warming = new Set<string>()
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true
      if (!opening) return
      const opened = yield* Effect.exit(Deferred.await(opening))
      if (Exit.isSuccess(opened)) yield* Effect.promise(() => opened.value.close())
    })
  )
  // Single flight; a failed open is not cached, so the next use retries it.
  const endpoint = Effect.gen(function* () {
    if (closed) return yield* Effect.fail(new Error('iroh_closed'))
    if (opening) return yield* Deferred.await(opening)
    const deferred = yield* Deferred.make<IrohEndpoint, unknown>()
    opening = deferred
    const opened = yield* Effect.exit(
      options.withSeed((seed) =>
        options.native.openEndpoint(Buffer.from(seed.buffer, seed.byteOffset, seed.byteLength), {
          relayUrls: [...options.relays.urls],
          ...(options.relays.token ? { relayToken: options.relays.token } : {}),
          ...(options.proxyUrl ? { proxyUrl: options.proxyUrl } : {}),
          accept: false
        })
      )
    )
    if (Exit.isFailure(opened) && opening === deferred) opening = undefined
    if (Exit.isSuccess(opened)) {
      const live = opened.value
      // Observation only: whether a home relay connected within 15 seconds.
      yield* Effect.forkIn(
        Effect.promise(() => live.online(15_000).catch(() => false)).pipe(
          Effect.tap((online) =>
            Effect.sync(() => console.debug('[e2ee-iroh] desktop relay online', { online }))
          )
        ),
        scope
      )
    }
    yield* Deferred.done(deferred, opened)
    return yield* opened
  })
  const target = Effect.fnUntraced(function* (machineId: string) {
    const key = irohTargetDevice(yield* options.ledger(), machineId)
    if (!key) return yield* Effect.fail(new Error('iroh_target_unknown'))
    return key
  })
  return {
    /**
     * Runs under the host's serial lock: resolves the target from the verified
     * ledger and opens the endpoint (no network wait). The returned route does all
     * network waiting, and callers must run it after releasing every lock.
     */
    prepare: (machineId: string) =>
      Effect.gen(function* () {
        const key = yield* target(machineId)
        const live = yield* endpoint
        return makeIrohRoute(live, key, warming)
      })
  }
})

/** One machine's iroh route on an open endpoint. Every method is lock-free. */
export type IrohRoute = ReturnType<typeof makeIrohRoute>

export function makeIrohRoute(
  live: Pick<IrohEndpoint, 'hasConnection' | 'warm' | 'call'>,
  key: string,
  warming: Set<string>
) {
  return {
    /**
     * Whether a live connection exists; never waits for a dial in progress.
     * Without one, starts a bounded background dial (at most one per machine) and
     * answers `false`, so this request uses Streams and a later one can use iroh.
     */
    ready: async (): Promise<boolean> => {
      if (await live.hasConnection(key).catch(() => false)) return true
      if (!warming.has(key)) {
        warming.add(key)
        void live
          .warm({ endpointId: key }, WARM_TIMEOUT_MS)
          .catch(() => undefined)
          .finally(() => warming.delete(key))
      }
      return false
    },
    /**
     * Sends one `{id, frame}` envelope and returns every reply envelope's frame
     * read within `timeoutMs`. Any transport problem rejects; the caller retries
     * the same original over Streams. Timing out cancels the stream at once.
     */
    call: async (envelope: { id: string; frame: string }, timeoutMs: number): Promise<string[]> => {
      const call = await live.call(
        { endpointId: key },
        Buffer.from(JSON.stringify(envelope), 'utf8'),
        CONNECT_TIMEOUT_MS
      )
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        call.cancel()
      }, timeoutMs)
      try {
        const frames: string[] = []
        for (let reply = await call.nextReply(); reply; reply = await call.nextReply()) {
          const parsed = JSON.parse(reply.toString('utf8')) as { id?: unknown; frame?: unknown }
          if (parsed.id === envelope.id && typeof parsed.frame === 'string')
            frames.push(parsed.frame)
          if (frames.length > 128) throw new Error('iroh_reply_limit')
        }
        if (timedOut) throw new Error('iroh_timeout')
        return frames
      } catch (cause) {
        call.cancel()
        throw cause
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

export type DesktopIrohClient = Effect.Success<ReturnType<typeof makeDesktopIrohClient>>
