import assert from 'node:assert/strict'
import test from 'node:test'
import { createClientLossObserver } from './e2ee-client-loss.ts'

const scope = { accountId: 'account-a', workspaceId: 'workspace-a', senderId: 7 }
const instance = '0b8d6f1e-5c2a-4f3e-9a1b-2c3d4e5f6a7b'
const make = (enabled = true) =>
  createClientLossObserver({ enabled, processId: 4242, processInstance: instance })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}
const fail = (message) => Promise.reject(new Error(message))
const effects = {
  contentWrites: 3,
  contentReadEvents: 5,
  turnStarts: 1,
  activeContentStreams: 1,
  pendingWrites: 0,
  pendingDispatches: 0,
  transportOwnerClosed: false
}

void test('a disabled observer forwards work and keeps no evidence', async () => {
  const observer = make(false)
  assert.equal(observer.enabled, false)
  assert.equal(await observer.observe('read', scope, async () => 'plain'), 'plain')
  observer.recordEffects(scope, effects)
  assert.equal(observer.inspect(scope, 1), null)
})

void test('counts started, settled and active operations from the actual handler promise', async () => {
  const observer = make()
  const pending = deferred()
  const running = observer.observe('seal', scope, () => pending.promise)
  let row = observer.inspect(scope, 1).native.operations.seal
  assert.deepEqual(row, { started: 1, fulfilled: 0, rejected: 0, active: 1 })
  pending.resolve('sealed')
  assert.equal(await running, 'sealed')
  await assert.rejects(
    observer.observe('seal', scope, () => fail('disk full')),
    /disk full/
  )
  row = observer.inspect(scope, 1).native.operations.seal
  assert.deepEqual(row, { started: 2, fulfilled: 1, rejected: 1, active: 0 })
  // Unknown failures leave no refusal row and no retained error text.
  const snapshot = observer.inspect(scope, 1)
  assert.deepEqual(snapshot.native.refusals, [])
  assert.equal(JSON.stringify(snapshot).includes('disk full'), false)
})

void test('records the authoritative refusal with counters and effects captured at that moment', async () => {
  const observer = make()
  await observer.observe('read', scope, async () => 'ok')
  observer.recordEffects(scope, effects)
  const before = observer.inspect(scope, 1)
  await assert.rejects(
    observer.observe('token', scope, () => fail('e2ee_member_removed')),
    /e2ee_member_removed/
  )
  // Later activity cannot rewrite what was captured at the cut.
  observer.recordEffects(scope, { ...effects, contentWrites: 9, transportOwnerClosed: true })
  await assert.rejects(observer.observe('seal', scope, () => fail('e2ee_not_open')))
  const after = observer.inspect(scope, 0)
  assert.equal(after.version, 1)
  assert.equal(after.processId, 4242)
  assert.equal(after.processInstance, instance)
  assert.equal(after.readers, 0)
  const [confirmed] = after.native.authoritative
  assert.equal(confirmed.code, 'e2ee_member_removed')
  assert.equal(confirmed.kind, 'token')
  assert.ok(confirmed.startedAtSequence > before.native.sequence)
  assert.ok(confirmed.sequence > confirmed.startedAtSequence)
  assert.deepEqual(confirmed.operations.read, { started: 1, fulfilled: 1, rejected: 0, active: 0 })
  assert.deepEqual(confirmed.operations.seal, { started: 0, fulfilled: 0, rejected: 0, active: 0 })
  assert.equal(confirmed.effects.contentWrites, 3)
  assert.equal(confirmed.effects.transportOwnerClosed, false)
  assert.deepEqual(
    after.native.refusals.map(({ code, kind }) => [code, kind]),
    [
      ['e2ee_member_removed', 'token'],
      ['e2ee_not_open', 'seal']
    ]
  )
  assert.ok(after.native.refusals[1].sequence <= after.native.sequence)
  assert.equal(after.effects.contentWrites, 9)
  assert.equal(after.effects.transportOwnerClosed, true)
  for (const row of [after.native, after.effects, confirmed.effects])
    assert.deepEqual(
      [row.workspaceId, row.accountId, row.processInstance, row.senderId],
      ['workspace-a', 'account-a', instance, 7]
    )
})

void test('keeps senders and accounts separate and the sequence monotonic', async () => {
  const observer = make()
  await observer.observe('open', scope, async () => undefined)
  const other = { ...scope, senderId: 8 }
  await observer.observe('open', other, async () => undefined)
  await observer.observe('open', { ...scope, accountId: 'account-b' }, async () => undefined)
  assert.equal(observer.inspect(scope, 1).native.operations.open.fulfilled, 1)
  assert.equal(observer.inspect(other, 1).native.operations.open.fulfilled, 1)
  assert.ok(
    observer.inspect(other, 1).native.sequence > observer.inspect(scope, 1).native.sequence - 1
  )
  assert.equal(observer.inspect({ ...scope, workspaceId: 'unknown' }, 0).native.sequence > 0, true)
  assert.equal(
    observer.inspect({ ...scope, workspaceId: 'unknown' }, 0).native.operations.open.started,
    0
  )
})

void test('rejects malformed effects and bounds refusal history', async () => {
  const observer = make()
  for (const bad of [
    null,
    { ...effects, contentWrites: -1 },
    { ...effects, turnStarts: 1.5 },
    { ...effects, transportOwnerClosed: 'yes' },
    { ...effects, secret: 'token' }
  ])
    observer.recordEffects(scope, bad)
  assert.equal(observer.inspect(scope, 0).effects, undefined)
  for (let index = 0; index < 140; index += 1)
    await assert.rejects(observer.observe('read', scope, () => fail('e2ee_not_open')))
  const snapshot = observer.inspect(scope, 0)
  assert.equal(snapshot.native.refusals.length, 128)
  assert.equal(snapshot.native.operations.read.rejected, 140)
})
