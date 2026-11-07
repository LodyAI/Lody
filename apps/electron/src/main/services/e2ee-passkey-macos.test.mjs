import assert from 'node:assert/strict'
import test from 'node:test'
import { E2eePasskeyCancelled } from '@lody/platform/e2ee-passkey'
import { base64url, makeMacosPasskeyPort } from './e2ee-passkey-macos.mts'

const request = {
  rpId: 'vault.lody.ai',
  prfInput: new Uint8Array([1]),
  allowCredentialIds: ['AQID']
}

void test('credential IDs use canonical unpadded base64url on the wire', () => {
  assert.equal(base64url.encode(new Uint8Array([0xfb, 0xff])), '-_8')
  assert.deepEqual(base64url.decode('-_8'), new Uint8Array([0xfb, 0xff]))
})

void test('an absent or unsupported module reports unavailable and never throws', async () => {
  const absent = makeMacosPasskeyPort({
    load: () => {
      throw new Error('no module')
    },
    window: () => Buffer.alloc(8)
  })
  assert.equal(await absent.available(), false)
  await assert.rejects(absent.authenticate(request), /e2ee_passkey_unavailable/)
  const old = makeMacosPasskeyPort({
    load: () => ({ available: () => false }),
    window: () => Buffer.alloc(8)
  })
  assert.equal(await old.available(), false)
})

void test('registration passes exactly what the ceremony needs and reports PRF as seen', async () => {
  let seen
  const port = makeMacosPasskeyPort({
    load: () => ({
      available: () => true,
      register: async (input) => {
        seen = input
        return { credentialId: new Uint8Array([1, 2, 3]), prfSupported: false }
      }
    }),
    window: () => Buffer.from('window')
  })
  const created = await port.register({
    rpId: 'vault.lody.ai',
    userHandle: new Uint8Array(32).fill(7),
    userName: 'Lody recovery vault',
    prfInput: new Uint8Array([9]),
    excludeCredentialIds: ['AQID']
  })
  assert.deepEqual(created, { credentialId: 'AQID', prfEnabled: false })
  assert.deepEqual(seen.excludeCredentialIds, [new Uint8Array([1, 2, 3])])
  assert.equal(seen.window.toString(), 'window')
})

void test('an assertion keeps a missing result missing and maps a dismissed prompt', async () => {
  let dismiss = false
  const port = makeMacosPasskeyPort({
    load: () => ({
      available: () => true,
      authenticate: async () => {
        if (dismiss) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
        return {
          credentialId: new Uint8Array([1, 2, 3]),
          userHandle: new Uint8Array(32).fill(1),
          userVerified: true,
          prfFirst: null
        }
      }
    }),
    window: () => Buffer.alloc(8)
  })
  assert.deepEqual(await port.authenticate(request), {
    credentialId: 'AQID',
    userHandle: new Uint8Array(32).fill(1),
    userVerified: true,
    prfFirst: null
  })
  dismiss = true
  await assert.rejects(port.authenticate(request), E2eePasskeyCancelled)
})
