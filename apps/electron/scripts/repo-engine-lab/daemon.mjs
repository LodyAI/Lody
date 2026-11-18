// Independent Node client: this exercises SDK IPC, not Lody's execution daemon.
import { connectEngine } from '@loro-dev/loro-repo-client/node'
import { LODY_SESSION_DOC_SCHEMA, META_ROOM } from '@loro-dev/loro-repo-client/browser'

const client = await connectEngine(process.argv[2])
const namespace = 'lody-native-acceptance'
const room = { kind: 'loro_doc', id: 'session-acceptance' }
const flock = { kind: 'flock', id: `${namespace}:wf:workspace` }
await client.createRoom(namespace, room, 'plaintext', { docSchema: LODY_SESSION_DOC_SCHEMA })
await client.createRoom(namespace, flock)
await client.createRoom(namespace, META_ROOM)
await client.repoMeta(namespace).upsertDoc(room.id, { title: 'Native directory acceptance' })
const initial = await client.readDoc(namespace, room)
if (!Array.isArray(initial.value.history)) {
  await client.applyDocPatch(
    namespace,
    room,
    [
      { op: 'set', path: ['session'], value: { id: 'acceptance' } },
      { op: 'set', path: ['history'], value: [] }
    ],
    { precondition: { mode: 'cas', expected_room_tx_id: initial.roomTxId } }
  )
}
process.send?.({ type: 'ready' })

process.on('message', async (message) => {
  try {
    let result
    if (message.type === 'append') {
      const current = await client.readDoc(namespace, room, ['history'])
      result = await client.applyDocPatch(
        namespace,
        room,
        [
          {
            op: 'arr_splice',
            path: ['history'],
            at: current.value.length,
            del: 0,
            items: [{ id: message.id, role: 'assistant', text: message.text }]
          }
        ],
        { precondition: { mode: 'cas', expected_room_tx_id: current.roomTxId } }
      )
    } else if (message.type === 'flock') {
      result = await client.flockBatch(namespace, flock, [
        { op: 'put', key: ['project', message.id], value: { title: message.text } }
      ])
    } else if (message.type === 'read') {
      result = await client.readDoc(namespace, room)
    } else if (message.type === 'stop') {
      await client.close()
      process.disconnect()
      return
    } else throw new Error('unsupported_lab_command')
    process.send?.({ type: 'result', requestId: message.requestId, result })
  } catch (error) {
    process.send?.({
      type: 'error',
      requestId: message.requestId,
      code: error.code ?? error.message
    })
  }
})
process.once('disconnect', () => {
  void client.close().catch(() => {})
})
