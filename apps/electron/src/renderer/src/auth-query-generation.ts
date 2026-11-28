import { useEffect, useSyncExternalStore } from 'react'

export function createAuthQueryGeneration() {
  let current = 0

  return {
    capture: () => current,
    advance: () => {
      current += 1
    },
    commitIfCurrent: (generation: number, commit: () => void): boolean => {
      if (generation !== current) return false
      commit()
      return true
    }
  }
}

export type AuthQuerySnapshot<TData, TError = unknown> = {
  data: TData | null
  isPending: boolean
  isRefetching: boolean
  error: TError | null
}

export type AuthQueryResult<TData, TError = unknown> = AuthQuerySnapshot<TData, TError> & {
  refetch: (queryParams?: unknown) => Promise<void>
}

export type AuthQueryDecodeResult<TData, TError = unknown> =
  | { ok: true; data: TData | null }
  | { ok: false; error: TError }

export type AuthQueryDecoder<TData, TError = unknown> = (
  raw: unknown
) => AuthQueryDecodeResult<TData, TError>

export type AuthQueryStoreOptions<TData, TError = unknown> = {
  decode: AuthQueryDecoder<TData, TError>
  onCommit?: (response: unknown) => void
  timeoutMs?: number
}

const DEFAULT_ELECTRON_AUTH_QUERY_TIMEOUT_MS = 10_000

class ElectronAuthQueryTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`)
    this.name = 'ElectronAuthQueryTimeoutError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapData(response: unknown): unknown {
  if (!isRecord(response)) {
    return response ?? null
  }
  if ('data' in response) {
    return response.data ?? null
  }
  if ('error' in response && response.error != null) {
    return null
  }
  return response
}

function unwrapError(response: unknown): unknown {
  if (!isRecord(response) || !('error' in response)) {
    return null
  }
  return response.error ?? null
}

async function withAuthQueryTimeout<T>(
  label: string,
  timeoutMs: number,
  promise: Promise<T>
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new ElectronAuthQueryTimeoutError(label, timeoutMs))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

export function createAuthQueryStore<TData, TError = unknown>(
  label: string,
  fetcher: () => Promise<unknown>,
  options: AuthQueryStoreOptions<TData, TError>
) {
  const { decode, onCommit, timeoutMs = DEFAULT_ELECTRON_AUTH_QUERY_TIMEOUT_MS } = options
  const decodeResponse = (response: unknown): { data: TData | null; error: TError | null } => {
    const responseError = unwrapError(response)
    if (responseError !== null) {
      return { data: null, error: responseError as TError }
    }
    const decoded = decode(unwrapData(response))
    if (!decoded.ok) {
      return { data: null, error: decoded.error }
    }
    return { data: decoded.data, error: null }
  }
  const refetch = async (_queryParams?: unknown): Promise<void> => {
    await run(true)
  }
  let snapshot: AuthQueryResult<TData, TError> = {
    data: null,
    isPending: true,
    isRefetching: false,
    error: null,
    refetch
  }
  let hasLoaded = false
  let inFlight: Promise<void> | null = null
  let pendingRefetch = false
  let held = false
  let beforePending: AuthQueryResult<TData, TError> | null = null
  const generation = createAuthQueryGeneration()
  const listeners = new Set<() => void>()

  const notify = () => {
    for (const listener of [...listeners]) {
      listener()
    }
  }

  const setSnapshot = (next: AuthQuerySnapshot<TData, TError>) => {
    if (
      Object.is(snapshot.data, next.data) &&
      snapshot.isPending === next.isPending &&
      snapshot.isRefetching === next.isRefetching &&
      Object.is(snapshot.error, next.error)
    ) {
      return
    }
    snapshot = {
      ...next,
      refetch
    }
    notify()
  }

  const run = async (isRefetch: boolean) => {
    if (held) {
      return
    }
    if (inFlight) {
      if (isRefetch) {
        pendingRefetch = true
      }
      await inFlight
      return
    }

    const previous = snapshot
    const requestGeneration = generation.capture()
    setSnapshot({
      data: previous.data,
      isPending: !hasLoaded && !isRefetch,
      isRefetching: hasLoaded || isRefetch,
      error: null
    })

    const currentRun = (async () => {
      try {
        const response = await withAuthQueryTimeout(label, timeoutMs, fetcher())
        generation.commitIfCurrent(requestGeneration, () => {
          onCommit?.(response)
          const { data, error } = decodeResponse(response)
          hasLoaded = true
          setSnapshot({
            data,
            isPending: false,
            isRefetching: false,
            error
          })
        })
      } catch (error) {
        generation.commitIfCurrent(requestGeneration, () => {
          console.warn(`[Auth] ${label} failed`, error)
          hasLoaded = true
          setSnapshot({
            data: previous.data,
            isPending: false,
            isRefetching: false,
            error: (error ?? null) as TError | null
          })
        })
      }
    })()

    inFlight = currentRun
    await currentRun

    if (inFlight === currentRun) {
      inFlight = null
    }

    if (requestGeneration !== generation.capture()) {
      return
    }

    if (pendingRefetch) {
      pendingRefetch = false
      await run(true)
    }
  }

  const ensureLoaded = () => {
    if (hasLoaded || inFlight) {
      return
    }
    void run(false)
  }

  const reset = (data: TData | null = null) => {
    generation.advance()
    held = false
    hasLoaded = true
    inFlight = null
    pendingRefetch = false
    setSnapshot({
      data,
      isPending: false,
      isRefetching: false,
      error: null
    })
  }

  const beginPending = () => {
    if (!held) beforePending = snapshot
    generation.advance()
    held = true
    hasLoaded = false
    inFlight = null
    pendingRefetch = false
    setSnapshot({
      data: null,
      isPending: true,
      isRefetching: false,
      error: null
    })
  }

  const commitResponse = (response: unknown) => {
    generation.advance()
    held = false
    hasLoaded = true
    inFlight = null
    pendingRefetch = false
    onCommit?.(response)
    const { data, error } = decodeResponse(response)
    setSnapshot({
      data,
      isPending: false,
      isRefetching: false,
      error
    })
  }

  const releasePending = () => {
    if (!held) return
    const previous = beforePending
    beforePending = null
    reset(previous?.data ?? null)
  }

  const atom = {
    get: () => snapshot,
    listen: (listener: (value: AuthQueryResult<TData, TError>) => void) => {
      const handleChange = () => {
        listener(snapshot)
      }
      listeners.add(handleChange)
      ensureLoaded()
      return () => {
        listeners.delete(handleChange)
      }
    }
  }

  const useQuery = (): AuthQueryResult<TData, TError> => {
    const state = useSyncExternalStore(
      (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      () => snapshot,
      () => snapshot
    )

    useEffect(() => {
      ensureLoaded()
    }, [])

    return state
  }

  return {
    atom,
    useQuery,
    refetch,
    reset,
    beginPending,
    releasePending,
    commitResponse
  }
}
