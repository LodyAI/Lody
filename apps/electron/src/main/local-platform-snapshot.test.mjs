import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import installationProfile from '../../../../packages/shared/src/node/installation-profile.cjs'
import { parseLocalPlatformSnapshot } from './local-platform-snapshot.ts'

const { getInstallationProfile } = installationProfile

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

void test('keeps packaged Electron state in the local installation namespace', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

  assert.equal(manifest.productName, getInstallationProfile('local').desktopProductName)
})

void test('keeps CLI identity and workspace in one local platform snapshot', () => {
  assert.deepEqual(parseLocalPlatformSnapshot(validCatalog), {
    userId: 'local:user-1',
    workspace: {
      workspaceId: 'lw_workspace-1',
      name: 'Lody',
      slug: 'local',
      role: 'owner'
    }
  })
})

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
