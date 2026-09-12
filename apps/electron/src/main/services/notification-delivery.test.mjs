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
  let settled = false
  const resultPromise = showNativeNotification(notification).then((result) => {
    settled = true
    return result
  })

  await Promise.resolve()
  assert.equal(settled, false)
  notification.emit('show', {})

  assert.deepEqual(await resultPromise, { shown: true })
  assert.equal(notification.listenerCount('show'), 0)
  assert.equal(notification.listenerCount('failed'), 0)
})

void test('returns Electron notification delivery failures through IPC', async () => {
  const notification = new TestNotification('Unsigned applications cannot post notifications')

  assert.deepEqual(await showNativeNotification(notification), {
    shown: false,
    reason: 'Unsigned applications cannot post notifications'
  })
})

void test('keeps synchronous notification failures in the result contract', async () => {
  const notification = new TestNotification(new Error('notification setup failed'))

  assert.deepEqual(await showNativeNotification(notification), {
    shown: false,
    reason: 'notification setup failed'
  })
  assert.equal(notification.listenerCount('show'), 0)
  assert.equal(notification.listenerCount('failed'), 0)
})
