import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import test from 'node:test'
import { LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION } from '@lody/shared/local-loro-data-plane'
import { LoroDataPlaneRelay } from './loro-data-plane-relay.ts'

function createSender(send) {
  const sender = new EventEmitter()
  sender.destroyed = false
  sender.isDestroyed = () => sender.destroyed
  sender.send = send
  return sender
}

void test('does not probe the local data plane while local agents are disabled', async () => {
  let connectionAttempts = 0
  const relay = new LoroDataPlaneRelay('/unused/local-data-plane.sock', () => {
    connectionAttempts += 1
    const socket = new net.Socket()
    queueMicrotask(() => socket.emit('error', new Error('test socket unavailable')))
    return socket
  })
  const ping = {
    type: 'ping',
    protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION
  }

  relay.setEnabled(false)
  relay.send(ping)
  assert.equal(connectionAttempts, 0)

  relay.setEnabled(true)
  relay.send(ping)
  assert.equal(connectionAttempts, 1)

  relay.destroy()
  await Promise.resolve()
})

void test('releases a renderer that is destroyed between the alive check and send', () => {
  let target
  const relay = new LoroDataPlaneRelay('/unused/local-data-plane.sock', undefined, (sender) => {
    if (sender === target) sender.destroyed = true
  })
  relay.setEnabled(false)
  target = createSender(() => {
    throw new Error('Object has been destroyed')
  })

  assert.doesNotThrow(() => relay.attachSender(target))
  assert.equal(relay.senders.has(target), false)

  const healthyMessages = []
  const healthy = createSender((channel, payload) => healthyMessages.push({ channel, payload }))
  relay.attachSender(healthy)
  relay.setConnected(true)
  assert.deepEqual(healthyMessages, [
    { channel: 'loro.status', payload: false },
    { channel: 'loro.status', payload: true }
  ])
  relay.destroy()
})

void test('rethrows non-lifecycle renderer send errors', () => {
  const relay = new LoroDataPlaneRelay('/unused/local-data-plane.sock')
  relay.setEnabled(false)
  const sender = createSender(() => {
    throw new Error('Failed to serialize arguments')
  })

  assert.throws(() => relay.attachSender(sender), /Failed to serialize arguments/)
  relay.destroy()
})
