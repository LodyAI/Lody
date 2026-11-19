import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkspaceBundleService } from './workspace-bundle-service.ts'

function harness(overrides = {}) {
  const sent = []
  const service = createWorkspaceBundleService({
    machineId: async () => 'machine-1',
    chooseSavePath: async (defaultName) => `/home/u/${defaultName}`,
    chooseOpenPath: async () => '/home/u/in.lodybundle',
    send: async (message) => {
      sent.push(message)
      if (message.operation === 'export')
        return {
          ok: true,
          result: { file: message.out, rooms: 3, blobs: 1, gaps: [], digest: 'd' }
        }
      return {
        ok: true,
        result: {
          plan: {
            rooms: [],
            gaps: [],
            digest: 'd',
            sourceWorkspaceId: 'a',
            targetWorkspaceId: 'b'
          },
          uploadPending: [],
          ...(message.dryRun ? {} : { result: { imported: 2, skipped: 0, resumed: 0 } })
        }
      }
    },
    now: () => new Date('2026-11-19T08:00:00Z'),
    ...overrides
  })
  return { service, sent }
}

void test('exports to the path the user chose, named after the workspace and date', async () => {
  const { service } = harness()
  const result = await service.exportWorkspace({ workspaceId: 'lw_1', workspaceName: 'My Team/x' })
  assert.deepEqual(result, {
    status: 'done',
    summary: {
      file: '/home/u/My Team-x-2026-11-19.lodybundle',
      rooms: 3,
      blobs: 1,
      gaps: [],
      digest: 'd'
    }
  })
})

void test('the renderer imports only through a token bound to the window that chose the file', async () => {
  const { service, sent } = harness()
  const chosen = await service.chooseImportFile(7)
  assert.equal(chosen.status, 'chosen')
  assert.equal(chosen.fileName, 'in.lodybundle')
  assert.equal(JSON.stringify(chosen).includes('/home/u'), false)

  assert.deepEqual(
    await service.previewImport({ senderId: 8, workspaceId: 'lw_1', token: chosen.token }),
    {
      status: 'error',
      message: 'import_file_expired'
    }
  )
  const preview = await service.previewImport({
    senderId: 7,
    workspaceId: 'lw_1',
    token: chosen.token
  })
  assert.equal(preview.status, 'planned')
  const done = await service.importWorkspace({
    senderId: 7,
    workspaceId: 'lw_1',
    token: chosen.token
  })
  assert.equal(done.status, 'done')
  assert.deepEqual(done.outcome.result, { imported: 2, skipped: 0, resumed: 0 })
  assert.deepEqual(
    sent.map((message) => [message.operation, message.file, message.dryRun ?? false]),
    [
      ['import', '/home/u/in.lodybundle', true],
      ['import', '/home/u/in.lodybundle', false]
    ]
  )
  // A completed import retires the token.
  assert.deepEqual(
    await service.importWorkspace({ senderId: 7, workspaceId: 'lw_1', token: chosen.token }),
    {
      status: 'error',
      message: 'import_file_expired'
    }
  )
})
