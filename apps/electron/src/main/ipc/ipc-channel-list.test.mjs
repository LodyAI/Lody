import assert from 'node:assert/strict'
import test from 'node:test'
import { isClientLossProbeChannel, isIpcInvokeChannel } from '../../preload/ipc-invoke-policy.ts'

void test('invoke policy allows methods only within renderer-facing service groups', () => {
  assert.equal(isIpcInvokeChannel('auth.getSession'), true)
  for (const method of [
    'createMemberInvitation',
    'pendingMemberJoin',
    'prepareMemberJoin',
    'memberJoinRequests',
    'approveMemberJoin',
    'memberKeyDeliveries',
    'retryMemberKeyDelivery',
    'rejectMemberJoin',
    'revokeMemberInvitation',
    'claimMemberJoin',
    'personalPairingOffer',
    'pendingPersonalJoin',
    'preparePersonalJoin',
    'inspectPersonalJoin',
    'approvePersonalJoin',
    'claimPersonalJoin',
    'cancelPersonalJoin',
    'prepareCreation',
    'recordCreated',
    'open',
    'close',
    'status',
    'inspectCachedState',
    'readIdentity',
    'ingestLedgerRecords',
    'ledgerView',
    'managementState',
    'updateKeys',
    'revokeDevice'
  ])
    assert.equal(isIpcInvokeChannel(`e2ee.${method}`), true)
  for (const method of [
    'sign',
    'exportKey',
    'createDevice',
    'deviceCredential',
    'promoteMember',
    'memberScope',
    'installMemberJoin',
    'unknown'
  ])
    assert.equal(isIpcInvokeChannel(`e2ee.${method}`), false)
  assert.equal(isIpcInvokeChannel('cli.methodAddedWithoutASecondAllowlist'), true)
  assert.equal(isIpcInvokeChannel('lodyAuth:getSession'), false)
  assert.equal(isIpcInvokeChannel('unknown.getState'), false)
  assert.equal(isIpcInvokeChannel('cli.restart.extra'), false)
})

void test('admits the E2E client-loss probe only with the argument main passes when it registered it', () => {
  const flag = '--lody-e2ee-client-loss-probe'
  for (const channel of ['e2ee.inspectClientLoss', 'e2ee.clientLossEffects']) {
    assert.equal(isClientLossProbeChannel(channel, ['electron', 'app']), false)
    assert.equal(isClientLossProbeChannel(channel, ['electron', 'app', flag]), true)
  }
  assert.equal(isClientLossProbeChannel('e2ee.seal', ['electron', flag]), false)
  // The ordinary invoke policy never lists it: production preload rejects the channel.
  assert.equal(isIpcInvokeChannel('e2ee.inspectClientLoss'), false)
})
