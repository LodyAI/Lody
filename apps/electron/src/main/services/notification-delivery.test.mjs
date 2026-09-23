import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { showNativeNotification } from './notification-delivery.ts'

class TestNotification extends EventEmitter {
  constructor(outcome) {
    super()
    this.outcome = outcome
  }

  show() {
    if (this.outcome instanceof Error) {
      throw this.outcome
    }
    if (this.outcome === 'shown') {
      this.emit('show', {})
      return
    }
    if (this.outcome === 'pending') {
      return
    }
    this.emit('failed', {}, this.outcome)
  }
}

void test('resolves only after Electron reports that the notification was shown', async () => {
  const notification = new TestNotification('pending')
  const activeNotifications = new Set()
  let settled = false
  const resultPromise = showNativeNotification(notification, activeNotifications).then((result) => {
    settled = true
    return result
  })

  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(activeNotifications.has(notification), true)
  notification.emit('show', {})

  assert.deepEqual(await resultPromise, { shown: true })
  assert.equal(activeNotifications.has(notification), true)
  assert.equal(notification.listenerCount('show'), 0)
  notification.emit('close')
  assert.equal(activeNotifications.size, 0)
})

void test('returns Electron notification delivery failures through IPC', async () => {
  const notification = new TestNotification('Unsigned applications cannot post notifications')
  const activeNotifications = new Set()

  assert.deepEqual(await showNativeNotification(notification, activeNotifications), {
    shown: false,
    reason: 'Unsigned applications cannot post notifications'
  })
  assert.equal(activeNotifications.size, 0)
})

void test('keeps synchronous notification failures in the result contract', async () => {
  const notification = new TestNotification(new Error('notification setup failed'))
  const activeNotifications = new Set()

  assert.deepEqual(await showNativeNotification(notification, activeNotifications), {
    shown: false,
    reason: 'notification setup failed'
  })
  assert.equal(activeNotifications.size, 0)
  assert.equal(notification.listenerCount('show'), 0)
  assert.equal(notification.listenerCount('failed'), 0)
})

void test('retains delivered notifications independently until clicked or dismissed', async () => {
  const activeNotifications = new Set()
  const first = new TestNotification('shown')
  const second = new TestNotification('shown')
  let selectedSession = null
  first.on('click', () => {
    selectedSession = 'session-1'
  })
  second.on('click', () => {
    selectedSession = 'session-2'
  })

  await showNativeNotification(first, activeNotifications)
  await showNativeNotification(second, activeNotifications)
  assert.deepEqual([...activeNotifications], [first, second])

  first.emit('click')
  assert.equal(selectedSession, 'session-1')
  assert.deepEqual([...activeNotifications], [second])
  first.emit('close')
  assert.deepEqual([...activeNotifications], [second])

  second.emit('click')
  assert.equal(selectedSession, 'session-2')
  assert.equal(activeNotifications.size, 0)
})

void test('releases a delivered notification on a later native failure', async () => {
  const activeNotifications = new Set()
  const notification = new TestNotification('shown')
  assert.deepEqual(await showNativeNotification(notification, activeNotifications), { shown: true })
  notification.emit('failed', {}, 'notification removed')
  assert.equal(activeNotifications.size, 0)
  assert.equal(notification.listenerCount('click'), 0)
  assert.equal(notification.listenerCount('close'), 0)
  assert.equal(notification.listenerCount('failed'), 0)
})
