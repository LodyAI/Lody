import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import test from 'node:test'
import { LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION } from '@lody/shared/local-loro-data-plane'
import { LoroDataPlaneRelay } from './loro-data-plane-relay.ts'

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

/** A daemon socket whose lifecycle events the test emits explicitly. */
function createControlledSocket() {
  const socket = new EventEmitter()
  socket.destroyed = false
  socket.write = () => true
  socket.destroy = (error) => {
    if (socket.destroyed) return
    socket.destroyed = true
    process.nextTick(() => {
      if (error) socket.emit('error', error)
      socket.emit('close')
    })
  }
  return socket
}

function createRelayHarness() {
  const sockets = []
  const statuses = []
  const sender = {
    isDestroyed: () => false,
    send: (channel, value) => {
      if (channel === 'loro.status') statuses.push(value)
    },
    once() {},
    on() {}
  }
  const relay = new LoroDataPlaneRelay('/unused/local-data-plane.sock', () => {
    const socket = createControlledSocket()
    sockets.push(socket)
    return socket
  })
  return { relay, sockets, statuses, sender }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

void test('a replaced socket closing late does not disconnect its successor', async () => {
  const { relay, sockets, statuses, sender } = createRelayHarness()
  relay.attachSender(sender)
  sockets[0].emit('connect')

  relay.setEnabled(false)
  relay.setEnabled(true)
  assert.equal(sockets.length, 2)
  sockets[1].emit('connect')
  // The disabled socket's close arrives after its successor connected.
  await settle()

  assert.equal(relay.isConnected(), true)
  assert.equal(statuses.at(-1), true)
  relay.destroy()
})

void test('re-enabling before the first socket connects dials a fresh socket at once', async () => {
  const { relay, sockets, sender } = createRelayHarness()
  relay.attachSender(sender)
  relay.setEnabled(false)
  relay.setEnabled(true)

  assert.equal(sockets.length, 2)
  sockets[1].emit('connect')
  await settle()
  assert.equal(relay.isConnected(), true)
  relay.destroy()
})

void test('replacing a dead socket before its close still reports the disconnect', async () => {
  const { relay, sockets, statuses, sender } = createRelayHarness()
  relay.attachSender(sender)
  sockets[0].emit('connect')
  // The idle watchdog destroys the socket; a renderer send redials before close.
  sockets[0].destroy()
  relay.send({ type: 'ping', protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION }, sender)
  assert.equal(sockets.length, 2)
  sockets[1].emit('connect')
  await settle()

  // Renderers rejoin on the false → true transition.
  assert.deepEqual(statuses, [false, true, false, true])
  assert.equal(relay.isConnected(), true)
  relay.destroy()
})
