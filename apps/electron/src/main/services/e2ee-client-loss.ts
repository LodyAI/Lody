import { randomUUID } from 'node:crypto'

/**
 * E2E-only, read-only evidence that a live desktop client stopped after losing
 * workspace access. It counts the actual E2EE IPC handler promises in this main
 * process and stores renderer-reported transport effects. It never opens a
 * reader, refreshes auth or grants, or retains arguments, results or error text.
 */
export const CLIENT_LOSS_OPERATIONS = [
  'read',
  'seal',
  'prepareDispatch',
  'dispatchResponse',
  'open',
  'refresh',
  'token',
  'close'
] as const
export type ClientLossOperation = (typeof CLIENT_LOSS_OPERATIONS)[number]
export type ClientLossScope = { accountId: string; workspaceId: string; senderId: number }

const REFUSAL_CODES = new Set(['e2ee_member_removed', 'e2ee_device_revoked', 'e2ee_not_open'])
const AUTHORITATIVE_CODES = new Set(['e2ee_member_removed', 'e2ee_device_revoked'])
const EFFECT_COUNTERS = [
  'contentWrites',
  'contentReadEvents',
  'turnStarts',
  'activeContentStreams',
  'pendingWrites',
  'pendingDispatches'
] as const
const HISTORY_LIMIT = 128
const SCOPE_LIMIT = 64

type Counts = { started: number; fulfilled: number; rejected: number; active: number }
type Effects = Record<(typeof EFFECT_COUNTERS)[number], number> & {
  transportOwnerClosed: boolean
}
type Refusal = {
  sequence: number
  startedAtSequence: number
  code: string
  kind: ClientLossOperation
}
type Row = {
  operations: Record<ClientLossOperation, Counts>
  refusals: Refusal[]
  authoritative: (Refusal & {
    operations: Record<ClientLossOperation, Counts>
    effects?: Effects
  })[]
  effects?: Effects
}

const emptyOperations = () =>
  Object.fromEntries(
    CLIENT_LOSS_OPERATIONS.map((kind) => [
      kind,
      { started: 0, fulfilled: 0, rejected: 0, active: 0 }
    ])
  ) as Record<ClientLossOperation, Counts>
const copyOperations = (operations: Record<ClientLossOperation, Counts>) =>
  Object.fromEntries(
    CLIENT_LOSS_OPERATIONS.map((kind) => [kind, { ...operations[kind] }])
  ) as Record<ClientLossOperation, Counts>
const counter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Accept only the closed renderer DTO; anything else is dropped, never coerced. */
function parseEffects(value: unknown): Effects | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (
    keys.length !== EFFECT_COUNTERS.length + 1 ||
    !keys.every(
      (key) =>
        key === 'transportOwnerClosed' || (EFFECT_COUNTERS as readonly string[]).includes(key)
    )
  )
    return null
  if (typeof record.transportOwnerClosed !== 'boolean') return null
  const effects = { transportOwnerClosed: record.transportOwnerClosed } as Effects
  for (const key of EFFECT_COUNTERS) {
    const item = record[key]
    if (!counter(item)) return null
    effects[key] = item
  }
  return effects
}

export function createClientLossObserver(options: {
  enabled: boolean
  processId: number
  processInstance?: string
}) {
  const processInstance = options.processInstance ?? randomUUID()
  const rows = new Map<string, Row>()
  let sequence = 0
  const key = (scope: ClientLossScope) =>
    JSON.stringify([scope.accountId, scope.workspaceId, scope.senderId])
  const row = (scope: ClientLossScope) => {
    const id = key(scope)
    let current = rows.get(id)
    if (current) {
      // Refresh recency so the bound evicts the least recently observed scope.
      rows.delete(id)
      rows.set(id, current)
      return current
    }
    current = { operations: emptyOperations(), refusals: [], authoritative: [] }
    rows.set(id, current)
    if (rows.size > SCOPE_LIMIT) rows.delete(rows.keys().next().value!)
    return current
  }
  const bounded = <A>(list: A[], item: A) => {
    list.push(item)
    if (list.length > HISTORY_LIMIT) list.shift()
  }

  return {
    enabled: options.enabled,
    async observe<A>(
      kind: ClientLossOperation,
      scope: ClientLossScope,
      work: () => Promise<A>
    ): Promise<A> {
      if (!options.enabled) return work()
      const current = row(scope)
      const counts = current.operations[kind]
      const startedAtSequence = ++sequence
      counts.started += 1
      counts.active += 1
      try {
        const value = await work()
        counts.active -= 1
        counts.fulfilled += 1
        return value
      } catch (error) {
        counts.active -= 1
        counts.rejected += 1
        const code = error instanceof Error ? error.message : undefined
        if (code && REFUSAL_CODES.has(code)) {
          const refusal = { sequence: ++sequence, startedAtSequence, code, kind }
          bounded(current.refusals, refusal)
          if (AUTHORITATIVE_CODES.has(code))
            bounded(current.authoritative, {
              ...refusal,
              operations: copyOperations(current.operations),
              ...(current.effects ? { effects: { ...current.effects } } : {})
            })
        }
        throw error
      }
    },
    recordEffects(scope: ClientLossScope, value: unknown) {
      if (!options.enabled) return
      const effects = parseEffects(value)
      if (effects) row(scope).effects = effects
    },
    /** Terminal counters survive owner retirement; `readers` is sampled by the caller. */
    inspect(scope: ClientLossScope, readers: number) {
      if (!options.enabled) return null
      const current = rows.get(key(scope))
      const scoped = {
        workspaceId: scope.workspaceId,
        accountId: scope.accountId,
        processInstance,
        senderId: scope.senderId
      }
      const effects = (value: Effects | undefined) => (value ? { ...scoped, ...value } : undefined)
      return {
        version: 1 as const,
        processId: options.processId,
        ...scoped,
        readers,
        native: {
          ...scoped,
          sequence,
          operations: copyOperations(current?.operations ?? emptyOperations()),
          authoritative: (current?.authoritative ?? []).map(({ effects: captured, ...item }) => ({
            ...item,
            operations: copyOperations(item.operations),
            ...(captured ? { effects: effects(captured) } : {})
          })),
          refusals: (current?.refusals ?? []).map((item) => ({ ...item }))
        },
        ...(current?.effects ? { effects: effects(current.effects) } : {})
      }
    }
  }
}
export type ClientLossObserver = ReturnType<typeof createClientLossObserver>
