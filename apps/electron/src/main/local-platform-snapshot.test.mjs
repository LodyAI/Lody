import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLocalPlatformSnapshot } from './local-platform-snapshot.ts'

const validCatalog = {
  identity: { userId: 'local:user-1' },
  workspaces: [
    {
      workspaceId: 'lw_workspace-1',
      name: 'Lody',
      slug: 'local',
      role: 'owner',
      state: 'active'
    }
  ]
}

void test('rejects identity drift and multiple active local workspaces', () => {
  assert.throws(
    () => parseLocalPlatformSnapshot({ ...validCatalog, identity: { userId: 'cloud-user' } }),
    /invalid local user id/
  )
  assert.throws(
    () =>
      parseLocalPlatformSnapshot({
        ...validCatalog,
        workspaces: [...validCatalog.workspaces, { ...validCatalog.workspaces[0] }]
      }),
    /exactly one active workspace/
  )
})
