import { RepoClient, LODY_SESSION_DOC_SCHEMA } from '@loro-dev/loro-repo-client/browser'
import { createWorkspaceDirectoryReader } from '../../../../packages/shared/src/workspace-directory.ts'

const namespace = 'lody-native-acceptance'
const room = { kind: 'loro_doc', id: 'session-acceptance' }
const flock = { kind: 'flock', id: `${namespace}:wf:workspace` }
let client
let subscription
let flockSubscription

function portTransport() {
  return new Promise((resolve, reject) => {
    const receive = (event) => {
      if (event.source !== window) return
      if (event.data?.type === 'repo-lab:connect-error') {
        window.removeEventListener('message', receive)
        reject(new Error('engine_unavailable'))
      }
      if (event.data?.type !== 'repo-lab:port' || !event.ports[0]) return
      window.removeEventListener('message', receive)
      const port = event.ports[0]
      const messages = new Set()
      const closers = new Set()
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        port.close()
        for (const callback of [...closers]) callback(new Error('engine_disconnected'))
      }
      port.onmessage = ({ data }) => {
        if (data?.type === 'closed') close()
        else if (typeof data === 'string') for (const callback of messages) callback(data)
      }
      port.start()
      resolve({
        send: (text) => {
          if (closed) throw new Error('transport_closed')
          port.postMessage(text)
        },
        onMessage: (callback) => {
          messages.add(callback)
          return () => messages.delete(callback)
        },
        onClose: (callback) => {
          closers.add(callback)
          return () => closers.delete(callback)
        },
        close: async () => close()
      })
    }
    window.addEventListener('message', receive)
    window.repoLab.connect()
  })
}

function render(value) {
  document.querySelector('#history').textContent = JSON.stringify(value)
}

async function connect() {
  document.querySelector('#ready').textContent = ''
  document.querySelector('#state').textContent = 'connecting'
  const transport = await portTransport()
  if (client) await client.reconnectWith(transport)
  else {
    client = new RepoClient(transport, { queueWhileReconnecting: false })
    client.onConnectionStateChange((state) => {
      document.querySelector('#state').textContent = state
      if (state !== 'connected') document.querySelector('#ready').textContent = ''
    })
    await client.createRoom(namespace, room, 'plaintext', { docSchema: LODY_SESSION_DOC_SCHEMA })
    await client.createRoom(namespace, flock)
    subscription = await client.subscribeDoc(namespace, room, ['history'], (value, info) => {
      render(value)
      document.querySelector('#reset').textContent = info.resetReason ?? 'patch'
    })
    render(subscription.currentValue)
    flockSubscription = await client.flockSubscribe(
      namespace,
      flock,
      { prefix: ['project'] },
      (value) => {
        document.querySelector('#projects').textContent = JSON.stringify(value)
      }
    )
    document.querySelector('#projects').textContent = JSON.stringify(flockSubscription.currentValue)
  }
  document.querySelector('#state').textContent = client.connectionState
  document.querySelector('#ready').textContent = 'ready'
}

document.querySelector('#connect').onclick = () => {
  void connect().catch((error) => {
    document.querySelector('#state').textContent = error.message
  })
}
document.querySelector('#send').onclick = () => {
  void (async () => {
    const input = document.querySelector('#message')
    const current = await client.readDoc(namespace, room, ['history'])
    const ack = await client.applyDocPatch(
      namespace,
      room,
      [
        {
          op: 'arr_splice',
          path: ['history'],
          at: current.value.length,
          del: 0,
          items: [{ id: input.value, role: 'user', text: input.value }]
        }
      ],
      { precondition: { mode: 'cas', expected_room_tx_id: current.roomTxId } }
    )
    await subscription.whenVisible(ack.txId)
    document.querySelector('#ack').textContent = input.value
  })().catch((error) => {
    document.querySelector('#error').textContent = error.code ?? error.message
  })
}
// Only this disposable lab exposes diagnostics; no product preload is modified.
window.repoAcceptance = {
  directory: () =>
    createWorkspaceDirectoryReader(async (prefix) => {
      const snapshot = await client.flockScan(namespace, { kind: 'meta', id: 'meta' }, { prefix })
      return snapshot.entries
    }).listEntries(),
  read: () => client.readDoc(namespace, room),
  watermark: (txId) => subscription.whenVisible(txId),
  closedWaiter: async () => {
    const sub = await client.subscribeDoc(namespace, room, ['session'])
    const waiting = sub.whenVisible(Number.MAX_SAFE_INTEGER).then(
      () => 'resolved',
      () => 'rejected'
    )
    await sub.unsubscribe()
    return waiting
  }
}
