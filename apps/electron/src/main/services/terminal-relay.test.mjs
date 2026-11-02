import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { TerminalRelay } from './terminal-relay.ts'

/** A daemon socket whose lifecycle events the test emits explicitly. */
function createControlledSocket() {
  const socket = new EventEmitter()
  socket.destroyed = false
  socket.written = []
  socket.write = (line) => {
    socket.written.push(JSON.parse(line))
    return true
  }
  socket.destroy = () => {
    if (socket.destroyed) return
    socket.destroyed = true
    process.nextTick(() => socket.emit('close'))
  }
  return socket
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

void test('a socket dropped for a protocol error does not fail requests on its successor', async () => {
  const sockets = []
  const relay = new TerminalRelay('/unused/terminal.sock', () => {
    const socket = createControlledSocket()
    sockets.push(socket)
    return socket
  })

  const first = relay.list('session-1')
  sockets[0].emit('connect')
  await settle()
  sockets[0].emit('data', Buffer.from('not json\n'))
  await assert.rejects(first, /invalid_terminal_server_event/)

  // The next request redials before the dropped socket's close arrives.
  const second = relay.list('session-1')
  assert.equal(sockets.length, 2)
  sockets[1].emit('connect')
  await settle()
  const { requestId } = sockets[1].written[0]
  sockets[1].emit(
    'data',
    Buffer.from(
      `${JSON.stringify({ type: 'terminals', requestId, sessionId: 'session-1', terminals: [] })}\n`
    )
  )

  assert.deepEqual(await second, [])
  relay.destroy()
})
