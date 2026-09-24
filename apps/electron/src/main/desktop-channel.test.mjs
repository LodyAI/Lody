import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDesktopProfile } from './desktop-channel.ts'

const cloud = {
  platform: 'cloud',
  namespace: 'lody',
  dataDirectoryName: '.lody',
  desktopProtocol: 'lody',
  desktopProductName: 'Lody',
  desktopAppId: 'ai.lody.desktop',
  localCliHostPort: 17788
}

void test('Nightly separates desktop identity while retaining the shared CLI owner', () => {
  const nightly = resolveDesktopProfile(cloud, 'nightly')
  assert.equal(nightly.desktopProtocol, 'ai.lody.nightly')
  assert.equal(nightly.desktopUserDataName, 'Lody Nightly')
  assert.equal(nightly.desktopAppId, 'ai.lody.desktop.nightly')
  assert.equal(nightly.desktopIpcNamespace, 'lody-nightly')
  assert.equal(nightly.namespace, cloud.namespace)
  assert.equal(nightly.localCliHostPort, cloud.localCliHostPort)
  assert.equal(nightly.dataDirectoryName, cloud.dataDirectoryName)
  assert.equal(cloud.desktopProductName, 'Lody')
})

void test('Stable preserves existing desktop paths and local builds reject cloud channels', () => {
  const stable = resolveDesktopProfile(cloud)
  assert.equal(stable.desktopUserDataName, null)
  assert.equal(stable.desktopProtocol, 'lody')
  assert.equal(stable.desktopIpcNamespace, 'lody')
  assert.throws(() => resolveDesktopProfile(cloud, 'unknown'))
  assert.throws(() => resolveDesktopProfile(cloud, 'local'))
  const local = { ...cloud, platform: 'local', namespace: 'lody-oss', desktopProtocol: 'lody-oss' }
  assert.equal(resolveDesktopProfile(local).releaseChannel, 'local')
  assert.throws(() => resolveDesktopProfile(local, 'nightly'))
})
