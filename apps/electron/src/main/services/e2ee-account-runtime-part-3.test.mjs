import {
  BackendError,
  Bytes,
  Context,
  DatabaseSync,
  E2eeDeviceRevokedError,
  E2eeMemberRemovedError,
  Effect,
  EventEmitter,
  Exit,
  Fiber,
  KEY_DELIVERY_RETRY_DELAYS,
  KeyMailbox,
  Layer,
  ObservedLedgerStorage,
  RELAY_CALL_S,
  Result,
  Scope,
  TOKEN_MINT_S,
  WorkspaceKeyRoundFailure,
  account,
  accountPairingFixture,
  appendLedgerHistory,
  approvalDevice,
  approvalRequest,
  assert,
  blockedApproverListing,
  claimCalls,
  createAccountWorkspace,
  criticalPath,
  deferredMember,
  derivePairingKeys,
  disposePairingKeys,
  drainMainProcessQuitResources,
  e2eeIpcDependencies,
  encodePairingSecret,
  fakeKeyDeliveryTimers,
  formatPairingString,
  hashRecordBytes,
  hostLedgerHistory,
  isIpcInvokeChannel,
  join,
  keyDeliveryState,
  load,
  makeSqliteKeyMailbox,
  memberApprovalFixture,
  memberIpcFixture,
  nativeAccountFixture,
  newDesktopAccountPairing,
  personalApprovalFixture,
  personalApprovalRequest,
  plain,
  randomUUID,
  readObservedLedgerCheckpoint,
  readdir,
  referenceKeyMailbox,
  relaySignedOffer,
  retainObservedLedgerCheckpoint,
  rotatedTeam,
  settle,
  slowSignIn,
  slowSignInAccount,
  test,
  twoDeviceMemberJoin,
  verifyLedger
} from './e2ee-account-runtime-test-helpers.mjs'

void test('a personal delivery retry cannot cross a same-account logout and login generation', async () => {
  let outage = true
  const delivered = []
  const f = await personalApprovalFixture({
    distribution: () =>
      Effect.sync(() => {
        if (outage) throw new Error('e2ee_management_retry')
        delivered.push(f.identity.generation)
      })
  })
  const clock = fakeKeyDeliveryTimers()
  f.ipc.keyDeliveryTimers = clock.timers
  await f.ipc.approvePersonalJoin('team', f.session)
  await f.ipc.keyDeliveryIdle('A', 'team')
  assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'failed')
  f.identity.userId = undefined
  f.identity.generation++
  f.identity.userId = 'A'
  f.identity.generation++
  outage = false
  clock.pending.shift().run()
  await f.ipc.keyDeliveryIdle('A', 'team')
  assert.deepEqual(delivered, [])
  assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
  assert.deepEqual(clock.pending, [])
})

void test('a personal delivery registered before publication retires after same-account re-login', async () => {
  const publication = { entered: deferredMember(), release: deferredMember() }
  const f = await personalApprovalFixture({ publication })
  const approval = f.ipc.approvePersonalJoin('team', f.session).then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  let delivery
  try {
    await publication.entered.promise
    await f.keyEntered.promise
    delivery = f.ipc.keyDeliveryIdle('A', 'team')
    f.identity.userId = undefined
    f.identity.generation++
    f.identity.userId = 'A'
    f.identity.generation++
    publication.release.resolve()
    assert.ok((await approval).error)
    f.keyGate.resolve()
    await delivery
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
  } finally {
    publication.release.resolve()
    f.keyGate.resolve()
    await approval
    await delivery
  }
})

void test(
  'an admin sees a committed member admitted before key delivery ends; main finishes delivery after the window closes',
  { timeout: 5000 },
  async () => {
    // keyRound never settles until keyGate opens: the approval must not wait for it.
    const f = await memberApprovalFixture()
    const approved = await f.ipc.approveMemberJoin('team', approvalRequest, 'automatic')
    assert.deepEqual(plain(approved), {
      admitted: true,
      keyPending: true,
      keyDelivery: 'delivering'
    })
    await f.keyEntered.promise
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'delivering' }
    ])
    // The only renderer window goes away while the key round is still running.
    f.owner().readers.get('team').delete(1)
    assert.deepEqual(f.closed, [])
    f.keyGate.resolve()
    await f.ipc.keyDeliveryIdle('A', 'team')
    // Main's own reader kept the workspace open, then released it after delivery.
    assert.deepEqual(f.closed, ['original-A'])
    f.owner().readers.set('team', new Map([[1, 1]]))
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'delivered' }
    ])
  }
)

void test(
  'an account-pairing key delivery that fails is retried by main on its own due timer until delivered, with no page, poll or explicit retry',
  { timeout: 5000 },
  async () => {
    const outcomes = [Effect.fail(new Error('e2ee_management_retry')), Effect.void]
    const f = await memberApprovalFixture(() => outcomes.shift() ?? Effect.die('unexpected round'))
    let now = 1_000
    f.ipc.keyDeliveryNow = () => now
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    const requestId = `account-device-${randomUUID()}`
    // What the account-pairing host calls once the admission commits.
    f.ipc.trackKeyDelivery('A', 'team', requestId, approvalDevice)
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(keyDeliveryState(f, requestId).state, 'failed')
    // Main scheduled the next round at the failure's backoff.
    assert.deepEqual(
      clock.pending.map((timer) => timer.ms),
      [KEY_DELIVERY_RETRY_DELAYS[0]]
    )
    now += KEY_DELIVERY_RETRY_DELAYS[0]
    clock.pending.shift().run()
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(keyDeliveryState(f, requestId).state, 'delivered')
    assert.equal(outcomes.length, 0)
    assert.deepEqual(clock.pending, [])
  }
)

void test(
  'a new device waiting for its key gets the first desktop delivery retry 500 ms after a failed delivery',
  { timeout: 5000 },
  async () => {
    // A transient refusal right after approval must not hold the requester back for the
    // long tail of the backoff: the first retry follows the shared fast schedule.
    const f = await memberApprovalFixture(() => Effect.fail(new Error('e2ee_management_retry')))
    f.ipc.keyDeliveryNow = () => 1_000
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    const requestId = `account-device-${randomUUID()}`
    f.ipc.trackKeyDelivery('A', 'team', requestId, approvalDevice)
    await f.ipc.keyDeliveryIdle('A', 'team')
    const failed = keyDeliveryState(f, requestId)
    assert.equal(failed.state, 'failed')
    assert.equal(failed.retryAt, 1_500)
    assert.deepEqual(
      clock.pending.map((timer) => timer.ms),
      [500]
    )
  }
)

void test(
  'the main-owned key delivery timer is bounded and ends when the signed-in account changes',
  { timeout: 5000 },
  async () => {
    let rounds = 0
    const f = await memberApprovalFixture(() =>
      Effect.suspend(() => {
        rounds += 1
        return Effect.fail(new Error('e2ee_management_retry'))
      })
    )
    let now = 1_000
    f.ipc.keyDeliveryNow = () => now
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    const requestId = `account-device-${randomUUID()}`
    f.ipc.trackKeyDelivery('A', 'team', requestId, approvalDevice)
    await f.ipc.keyDeliveryIdle('A', 'team')
    for (let retry = 0; retry < 8; retry++) {
      assert.equal(clock.pending.length, 1)
      now += clock.pending[0].ms
      clock.pending.shift().run()
      await f.ipc.keyDeliveryIdle('A', 'team')
    }
    assert.equal(rounds, 9)
    // The bound stops the timer; the failure stays visible for a poll or explicit retry.
    assert.deepEqual(clock.pending, [])
    assert.equal(keyDeliveryState(f, requestId).state, 'failed')

    // A later admission starts a fresh bound; an account change before the timer fires
    // drops the slot without another round.
    const next = `account-device-${randomUUID()}`
    f.ipc.trackKeyDelivery('A', 'team', next, approvalDevice)
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(clock.pending.length, 1)
    f.identity.userId = 'B'
    const before = rounds
    clock.pending.shift().run()
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(rounds, before)
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
  }
)

void test(
  'a request admitted while the second delivery pass runs is still delivered by main without a poll',
  { timeout: 5000 },
  async () => {
    // Each round waits for its own gate, so the test decides when each pass ends.
    const gates = []
    const entered = []
    const f = await memberApprovalFixture(() =>
      Effect.promise(() => {
        const gate = deferredMember()
        gates.push(gate)
        entered.shift()?.resolve()
        return gate.promise
      })
    )
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    const round = () => {
      const signal = deferredMember()
      entered.push(signal)
      return signal.promise
    }
    const first = `account-device-${randomUUID()}`
    const second = `account-device-${randomUUID()}`
    const third = `account-device-${randomUUID()}`
    let started = round()
    f.ipc.trackKeyDelivery('A', 'team', first, approvalDevice)
    await started
    // Admitted during pass one: covered by the follow-up pass.
    f.ipc.trackKeyDelivery('A', 'team', second, approvalDevice)
    started = round()
    gates[0].resolve()
    await started
    // Admitted during pass two, the last pass of this run.
    f.ipc.trackKeyDelivery('A', 'team', third, approvalDevice)
    gates[1].resolve()
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(keyDeliveryState(f, third).state, 'pending')
    // Main scheduled it at once; firing that timer is the only step taken here.
    assert.deepEqual(
      clock.pending.map((timer) => timer.ms),
      [0]
    )
    started = round()
    clock.pending.shift().run()
    await started
    gates[2].resolve()
    await f.ipc.keyDeliveryIdle('A', 'team')
    for (const requestId of [first, second, third])
      assert.equal(keyDeliveryState(f, requestId).state, 'delivered')
    assert.deepEqual(clock.pending, [])
  }
)

void test('inline publication marks delivery without a network round and its late receipt cannot survive reset', async () => {
  const f = await memberApprovalFixture(() =>
    Effect.die(new Error('inline delivery must not start a round'))
  )
  const first = f.ipc.keyDelivery.prepareInline('A', 'team', 'inline-first', approvalDevice)
  assert.equal(first.active(), true)
  first.delivered()
  assert.equal(f.ipc.keyDelivery.list('A', 'team')[0].state, 'delivered')
  const late = f.ipc.keyDelivery.prepareInline('A', 'team', 'inline-late', approvalDevice)
  await f.ipc
    .resetIdentity({ workspaceId: 'team', resetId: randomUUID(), confirm: true })
    .catch(() => {})
  assert.equal(late.active(), false)
  late.delivered()
  assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
})

void test(
  'a workspace reset ends its pending key delivery so no timer reopens it',
  { timeout: 5000 },
  async () => {
    let rounds = 0
    const f = await memberApprovalFixture(() =>
      Effect.suspend(() => {
        rounds += 1
        return Effect.fail(new Error('e2ee_management_retry'))
      })
    )
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    f.ipc.trackKeyDelivery('A', 'team', `account-device-${randomUUID()}`, approvalDevice)
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(clock.pending.length, 1)
    // The reset itself is outside this fixture; the delivery must end before it runs.
    await f.ipc
      .resetIdentity({ workspaceId: 'team', resetId: randomUUID(), confirm: true })
      .catch(() => {})
    assert.deepEqual(clock.pending, [])
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
    assert.equal(rounds, 1)
  }
)

void test(
  'a key delivery round already in flight never reopens a workspace reset during it',
  { timeout: 5000 },
  async () => {
    let rounds = 0
    const f = await memberApprovalFixture(() =>
      Effect.sync(() => {
        rounds += 1
      })
    )
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    let opens = 0
    const owner = f.owner()
    const open = owner.host.open
    owner.host.open = (...args) => {
      opens += 1
      return open(...args)
    }
    // The round has started and waits for its cloud client when the reset arrives.
    f.holdCloud()
    f.ipc.trackKeyDelivery('A', 'team', `account-device-${randomUUID()}`, approvalDevice)
    await f.cloudEntered.promise
    const inFlight = f.ipc.keyDelivery.slots.get('A\nteam').running
    await f.ipc
      .resetIdentity({ workspaceId: 'team', resetId: randomUUID(), confirm: true })
      .catch(() => {})
    f.cloudGate.resolve()
    await inFlight
    assert.equal(opens, 0)
    assert.equal(rounds, 0)
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
    assert.deepEqual(clock.pending, [])
  }
)

void test(
  'a key delivery round already in flight never opens the workspace after the account changes',
  { timeout: 5000 },
  async () => {
    let rounds = 0
    const f = await memberApprovalFixture(() =>
      Effect.sync(() => {
        rounds += 1
      })
    )
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    let opens = 0
    const owner = f.owner()
    const open = owner.host.open
    owner.host.open = (...args) => {
      opens += 1
      return open(...args)
    }
    // The round has started and waits for its cloud client when account B signs in.
    f.holdCloud()
    f.ipc.trackKeyDelivery('A', 'team', `account-device-${randomUUID()}`, approvalDevice)
    await f.cloudEntered.promise
    const inFlight = f.ipc.keyDelivery.slots.get('A\nteam').running
    f.identity.userId = 'B'
    f.identity.generation++
    f.cloudGate.resolve()
    await inFlight
    assert.equal(opens, 0)
    assert.equal(rounds, 0)
    // The slot is aborted and dropped, so no timer or poll resumes it for account B.
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
    assert.deepEqual(clock.pending, [])
  }
)

void test(
  'a failed key delivery stays visible by code and the next due periodic poll retries it until delivered',
  { timeout: 5000 },
  async () => {
    const outcomes = [Effect.fail(new Error('e2ee_management_retry')), Effect.void]
    const f = await memberApprovalFixture(() => outcomes.shift() ?? Effect.die('unexpected round'))
    let now = 1_000
    f.ipc.keyDeliveryNow = () => now
    const approved = await f.ipc.approveMemberJoin('team', approvalRequest, 'automatic')
    assert.equal(approved.admitted, true)
    await f.ipc.keyDeliveryIdle('A', 'team')
    const failed = [{ requestId: approvalRequest, state: 'failed', code: 'e2ee_management_retry' }]
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), failed)
    // A poll inside the backoff interval does not start another round.
    await f.ipc.memberJoinRequests('team')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), failed)
    assert.equal(outcomes.length, 1)
    now += KEY_DELIVERY_RETRY_DELAYS[0]
    // The email admission worker's next poll drives the due retry.
    await f.ipc.memberJoinRequests('team')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'delivered' }
    ])
  }
)

void test(
  'a committed admission missing from the local verified ledger is never reported delivered; a later poll ingests it first',
  { timeout: 5000 },
  async () => {
    // Distribution selects targets from the local verified ledger: without the
    // admission a key round succeeds with zero recipients.
    const ledger = { relayHasAdmission: false, historyFails: true }
    let rounds = 0
    const f = await memberApprovalFixture(
      () =>
        Effect.sync(() => {
          rounds++
        }),
      ledger
    )
    let now = 1_000
    f.ipc.keyDeliveryNow = () => now
    const approved = await f.ipc.approveMemberJoin('team', approvalRequest, 'automatic')
    assert.equal(approved.admitted, true)
    await f.ipc.keyDeliveryIdle('A', 'team')
    const lagging = plain((await f.ipc.memberKeyDeliveries('team')).items)
    assert.equal(lagging.length, 1)
    assert.notEqual(lagging[0].state, 'delivered')
    // The relay now serves the admission; the next due poll ingests before distributing.
    ledger.historyFails = false
    ledger.relayHasAdmission = true
    now += KEY_DELIVERY_RETRY_DELAYS[0]
    await f.ipc.memberJoinRequests('team')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'delivered' }
    ])
    assert.ok(rounds >= 1)
  }
)

for (const [name, nested] of [
  ['member removal', () => new E2eeMemberRemovedError()],
  ['device revocation', () => new E2eeDeviceRevokedError()],
  ['a missing binding', () => Object.assign(new Error('synthetic'), { code: 'missing-binding' })],
  [
    'a restart-required owner',
    () => Object.assign(new Error('synthetic'), { code: 'restart-required' })
  ]
])
  void test(
    `${name} nested in a key-round failure ends delivery from this device without retries`,
    { timeout: 5000 },
    async () => {
      let rounds = 0
      const f = await memberApprovalFixture(() =>
        Effect.suspend(() => {
          rounds++
          return Effect.fail(
            new WorkspaceKeyRoundFailure({
              receive: Result.succeed({}),
              distribution: Result.fail(nested()),
              reportsAfterSend: Result.succeed({}),
              cursors: {}
            })
          )
        })
      )
      let now = 1_000
      f.ipc.keyDeliveryNow = () => now
      await f.ipc.approveMemberJoin('team', approvalRequest, 'automatic')
      await f.ipc.keyDeliveryIdle('A', 'team')
      assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [])
      now += 10 * 60_000
      await f.ipc.memberJoinRequests('team')
      await f.ipc.keyDeliveryIdle('A', 'team')
      assert.equal(rounds, 1)
    }
  )

void test(
  'a successful key round without a stored envelope for the member stays retryable',
  { timeout: 5000 },
  async () => {
    // A blocked target, an ineligible sender or a joined round all end the round in success.
    const ledger = { relayHasAdmission: true, evidence: () => 'e2ee_key_not_sent' }
    const f = await memberApprovalFixture(() => Effect.void, ledger)
    let now = 1_000
    f.ipc.keyDeliveryNow = () => now
    await f.ipc.approveMemberJoin('team', approvalRequest, 'automatic')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'failed', code: 'e2ee_key_not_sent' }
    ])
    ledger.evidence = () => 'delivered'
    now += KEY_DELIVERY_RETRY_DELAYS[0]
    await f.ipc.memberJoinRequests('team')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'delivered' }
    ])
  }
)

void test(
  'a workspace closed during a key round is reopened and delivered by the next due poll',
  { timeout: 5000 },
  async () => {
    const outcomes = [
      Effect.fail(
        new WorkspaceKeyRoundFailure({
          receive: Result.succeed({}),
          distribution: Result.fail(Object.assign(new Error('synthetic'), { code: 'closed' })),
          reportsAfterSend: Result.succeed({}),
          cursors: {}
        })
      ),
      Effect.void
    ]
    const f = await memberApprovalFixture(() => outcomes.shift() ?? Effect.die('unexpected round'))
    let now = 1_000
    f.ipc.keyDeliveryNow = () => now
    await f.ipc.approveMemberJoin('team', approvalRequest, 'automatic')
    await f.ipc.keyDeliveryIdle('A', 'team')
    const [closed] = plain((await f.ipc.memberKeyDeliveries('team')).items)
    assert.equal(closed.state, 'failed')
    now += KEY_DELIVERY_RETRY_DELAYS[0]
    await f.ipc.memberJoinRequests('team')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'delivered' }
    ])
  }
)

void test(
  'a delivery round ended by an unexpected exception is not left shown as delivering',
  { timeout: 5000 },
  async (t) => {
    const f = await memberApprovalFixture(() => Effect.void)
    let now = 1_000
    f.ipc.keyDeliveryNow = () => now
    // The daily-log sink fails once, right after the request was marked delivering.
    const info = console.info
    t.after(() => {
      console.info = info
    })
    let broken = true
    console.info = (event, fields) => {
      if (broken && fields?.state === 'delivering') {
        broken = false
        throw new Error('synthetic log sink failure')
      }
    }
    await f.ipc.approveMemberJoin('team', approvalRequest, 'automatic')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'failed', code: 'e2ee_key_delivery_interrupted' }
    ])
    // Retryable with the usual backoff: the next due poll delivers it.
    now += KEY_DELIVERY_RETRY_DELAYS[0]
    await f.ipc.memberJoinRequests('team')
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.deepEqual(plain((await f.ipc.memberKeyDeliveries('team')).items), [
      { requestId: approvalRequest, state: 'delivered' }
    ])
  }
)

void test('passive cache inspection stays account/product-window bound without opening a reader or cloud call', async () => {
  const f = await memberIpcFixture()
  const owner = f.makeOwner('A', 'passive-A')
  owner.readers.clear()
  f.setOwner(owner)
  const snapshot = await f.ipc.inspectCachedState('team', 'machine')
  assert.equal(snapshot.accountId, 'A')
  assert.equal(snapshot.workspaceId, 'team')
  assert.equal(snapshot.machineId, 'machine')
  assert.equal(snapshot.activeContentReaders, 0)
  assert.equal(snapshot.cachedExecutionGrants, 0)
  assert.equal(owner.readers.size, 0)
  assert.deepEqual(f.signed, [])
  assert.deepEqual(f.closed, [])
  f.identity.userId = 'B'
  await assert.rejects(f.ipc.inspectCachedState('team', 'machine'), /e2ee_account_mismatch/)
  f.identity.userId = 'A'
  f.setTrusted(false)
  await assert.rejects(f.ipc.inspectCachedState('team', 'machine'), /untrusted sender/)
  f.setTrusted(true)
  await assert.rejects(f.ipc.inspectCachedState('', 'machine'), /e2ee_invalid-input/)
})

void test('account-wide pairing runs from the new device request to an installed invitation on real hosts', async (t) => {
  const { f, approver, newDevice, genesisHash, requester, approving, appended } =
    await accountPairingFixture(t)
  const request = await Effect.runPromise(requester.requestAccountPairing({}))
  assert.equal(request.status, 'waiting')
  assert.deepEqual(
    request.workspaces.map((item) => [item.workspaceId, item.state]),
    [[f.workspaceId, 'pending']]
  )
  // The new device has a retained identity but no access yet.
  await assert.rejects(Effect.runPromise(newDevice.host.open(f.workspaceId)))

  const preview = await Effect.runPromise(approving.inspectAccountPairing(request.pairingString))
  assert.deepEqual(preview.workspaces, [
    { workspaceId: f.workspaceId, name: 'Synthetic encrypted workspace' }
  ])
  assert.equal(preview.deviceName, 'Synthetic second desktop')
  const result = await Effect.runPromise(
    approving.approveAccountPairing({
      pairingString: request.pairingString,
      requestId: preview.requestId,
      workspaceIds: [f.workspaceId]
    })
  )
  assert.deepEqual(result.workspaces, [{ workspaceId: f.workspaceId, outcome: 'admitted' }])
  assert.equal(appended.length, 1)

  const joined = await Effect.runPromise(requester.accountPairingRequest())
  assert.equal(joined.status, 'joined')
  // The installed invitation opens the workspace with the new device's own identity.
  const opened = await Effect.runPromise(newDevice.host.open(f.workspaceId))
  assert.equal(opened.deviceKind, 'personal')
  const approverStatus = await Effect.runPromise(approver.host.status(f.workspaceId))
  assert.notEqual(opened.signingPublicKey, approverStatus.signingPublicKey)
  assert.equal(opened.genesisHash, genesisHash)
  // A finished code cannot be used again on either device.
  await assert.rejects(
    Effect.runPromise(approving.inspectAccountPairing(request.pairingString)),
    (error) => error.code === 'pairing-used'
  )
})

void test('the new device opens the paired workspace and asks for its keys right after installing', async (t) => {
  const { f, newDevice, requester, approving, mailboxRequests } = await accountPairingFixture(t)
  const request = await Effect.runPromise(requester.requestAccountPairing({}))
  const preview = await Effect.runPromise(approving.inspectAccountPairing(request.pairingString))
  await Effect.runPromise(
    approving.approveAccountPairing({
      pairingString: request.pairingString,
      requestId: preview.requestId,
      workspaceIds: [f.workspaceId]
    })
  )
  mailboxRequests.length = 0
  const modes = []
  const keyRound = newDevice.host.keyRound
  newDevice.host.keyRound = (...args) => {
    modes.push(args[4])
    return keyRound(...args)
  }
  assert.equal((await Effect.runPromise(requester.accountPairingRequest())).status, 'joined')
  // Like the per-workspace claim: open, refresh and receive this device's own key with
  // its own credential, without waiting for the workspace to be opened later. Reports,
  // distribution and repair wait for a later full round.
  const credential = await Effect.runPromise(newDevice.bootstrap.deviceCredential(f.workspaceId))
  assert.deepEqual(
    mailboxRequests.map((item) => [item.workspaceId, item.credential]),
    [[f.workspaceId, credential]]
  )
  assert.deepEqual(modes, ['receive'])
})

void test('installing an approval reads only the ledger records after the history the request already verified', async (t) => {
  // The request verified the full history from genesis; the claim reuses that verified
  // prefix and downloads only later records instead of paging the whole ledger again.
  const { f, cloud, requester, approving } = await accountPairingFixture(t)
  const request = await Effect.runPromise(requester.requestAccountPairing({}))
  const preview = await Effect.runPromise(approving.inspectAccountPairing(request.pairingString))
  await Effect.runPromise(
    approving.approveAccountPairing({
      pairingString: request.pairingString,
      requestId: preview.requestId,
      workspaceIds: [f.workspaceId]
    })
  )
  const read = cloud.history
  const requests = []
  cloud.history = (input) => {
    requests.push({ ...input })
    return read(input)
  }
  assert.equal((await Effect.runPromise(requester.accountPairingRequest())).status, 'joined')
  assert.ok(requests.length > 0)
  assert.deepEqual(
    requests.filter((input) => input.after === undefined && input.cursor === undefined),
    []
  )
})

void test('approving on a desktop with many workspaces inspects four at a time and keeps their order', async () => {
  // Inspection latency must not grow by one owner turn per workspace, while the
  // approval preview keeps the account's workspace order.
  const listing = blockedApproverListing()
  const done = Effect.runPromise(listing.approverWorkspaces())
  await listing.startedCount(4)
  assert.equal(listing.started.length, 4)
  // Settling one inspection starts the next; later ones settle before earlier ones.
  listing.settle('team-1')
  await listing.startedCount(5)
  listing.settle('team-3')
  await listing.startedCount(6)
  for (const workspaceId of ['team-5', 'team-4', 'team-2', 'team-0']) listing.settle(workspaceId)
  const workspaces = await done
  assert.equal(listing.peak(), 4)
  assert.deepEqual(
    workspaces.map((item) => item.workspaceId),
    listing.hints.map((hint) => hint.workspaceId)
  )
  assert.deepEqual(listing.closed, [])
})

void test('an interrupted approver inspection closes every workspace any concurrent inspection opened', async () => {
  // Pairing must not leave workspaces open that no window reads: settled ones and
  // ones whose inspection was still running are all closed again.
  const listing = blockedApproverListing()
  const fiber = Effect.runFork(listing.approverWorkspaces())
  await listing.startedCount(4)
  listing.settle('team-0')
  listing.settle('team-1')
  await listing.startedCount(6)
  await Effect.runPromise(Fiber.interrupt(fiber))
  assert.deepEqual([...listing.closed].sort(), [...listing.started].sort())
})

void test('after a failed first delivery, main retries the account-pairing key on its own timer until the new device holds the current key', async (t) => {
  // Real custody, ledger hosts and reference mailbox on both devices. The approval hands
  // the admitted device to the real E2eeIpc delivery (trackKeyDelivery, distribute-only
  // round, mailbox evidence, due timer); the test never runs a delivery itself.
  let ipcFixture
  const { f, approver, newDevice, genesisHash, cloud, requester, approving } =
    await accountPairingFixture(t, {
      deliverKeys: (workspaceId, requestId, device) =>
        ipcFixture.ipc.trackKeyDelivery('A', workspaceId, requestId, device)
    })
  const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(genesisHash, 'hex')))
  const mailboxScope = Effect.runSync(Scope.make())
  t.after(() => Effect.runPromise(Scope.close(mailboxScope, Exit.void)))
  const mailbox = await Effect.runPromise(
    makeSqliteKeyMailbox({
      path: join(approver.path, 'reference-mailbox.sqlite'),
      mode: 'create',
      genesis,
      ledger: () =>
        Effect.promise(async () => {
          const ledger = await Effect.runPromise(approver.host.ledgerView(f.workspaceId))
          const records = ledger.recordsHex.map((value) => Buffer.from(value, 'hex'))
          return Result.getOrThrow(
            verifyLedger({
              anchor: genesis,
              records,
              checkpoint: { length: records.length, head: hashRecordBytes(records.at(-1)) }
            })
          )
        })
    }).pipe(Scope.provide(mailboxScope))
  )
  const portFor = async (owner) => {
    const device = await Effect.runPromise(owner.custody.openDevice(genesis))
    return Context.get(
      await Effect.runPromise(
        Layer.buildWithScope(referenceKeyMailbox(mailbox, device.publicKey), mailboxScope)
      ),
      KeyMailbox
    )
  }
  const approverPort = await portFor(approver)
  // Envelope storage is refused until `refusing` is cleared; every attempt is recorded.
  let refusing = true
  const puts = []
  const sending = {
    ...approverPort,
    put: (id, frame) => {
      puts.push({ id, frame: Buffer.from(frame).toString('hex') })
      return refusing
        ? Effect.fail(new BackendError({ service: 'KeyMailbox', reason: 'unavailable' }))
        : approverPort.put(id, frame)
    }
  }
  ipcFixture = await memberIpcFixture({
    bootstrap: {
      deviceCredential: (workspaceId) => approver.bootstrap.deviceCredential(workspaceId)
    },
    host: {
      open: (workspaceId) => approver.host.open(workspaceId),
      status: (workspaceId) => approver.host.status(workspaceId),
      ingestLedgerRecords: (workspaceId, page) =>
        approver.host.ingestLedgerRecords(workspaceId, page),
      keyDeliveryTarget: (workspaceId, device) =>
        approver.host.keyDeliveryTarget(workspaceId, device),
      distributeKeys: (workspaceId, port) => approver.host.distributeKeys(workspaceId, port),
      keyDeliveryEvidence: (workspaceId, device, port) =>
        approver.host.keyDeliveryEvidence(workspaceId, device, port),
      // The approver's real host stays open for the rest of the test.
      beginCloseWorkspace: () => Effect.succeed(Effect.void)
    },
    client: { history: (request) => cloud.history(request), mailbox: () => sending }
  })
  let now = 1_000
  ipcFixture.ipc.keyDeliveryNow = () => now
  const clock = fakeKeyDeliveryTimers()
  ipcFixture.ipc.keyDeliveryTimers = clock.timers
  const slot = () => ipcFixture.ipc.keyDelivery.slots.get(`A\n${f.workspaceId}`)
  const approverCredential = await Effect.runPromise(
    approver.bootstrap.deviceCredential(f.workspaceId)
  )
  let desktopPort
  cloud.keyServices = (access) =>
    Effect.promise(async () => {
      assert.notEqual(access.credential, approverCredential)
      desktopPort ??= await portFor(newDevice)
      return { mailbox: () => desktopPort, history: () => cloud.history }
    })

  const request = await Effect.runPromise(requester.requestAccountPairing({}))
  const preview = await Effect.runPromise(approving.inspectAccountPairing(request.pairingString))
  const result = await Effect.runPromise(
    approving.approveAccountPairing({
      pairingString: request.pairingString,
      requestId: preview.requestId,
      workspaceIds: [f.workspaceId]
    })
  )
  assert.deepEqual(result.workspaces, [{ workspaceId: f.workspaceId, outcome: 'admitted' }])
  await ipcFixture.ipc.keyDeliveryIdle('A', f.workspaceId)
  // The refused store leaves the key unsent; the approval already returned admitted.
  const [[requestId, delivery]] = [...slot().requests]
  assert.match(requestId, /^account-device-[0-9a-f-]{36}$/)
  assert.equal(delivery.state, 'failed')
  assert.equal(delivery.code, 'e2ee_key_not_sent')
  assert.ok(puts.length > 0)
  const firstAttempt = puts.map((item) => ({ ...item }))

  // Admitted and joined is not keyed: the claim's own key round finds no envelope.
  assert.equal((await Effect.runPromise(requester.accountPairingRequest())).status, 'joined')
  const joined = await Effect.runPromise(newDevice.host.open(f.workspaceId))
  assert.equal(joined.hasCurrentKey, false)
  // Exactly the device the verified ledger admitted.
  assert.equal(delivery.device, joined.signingPublicKey)

  // Only the injected clock moves; main's own timer runs the next round.
  refusing = false
  puts.length = 0
  assert.equal(clock.pending.length, 1)
  now += clock.pending[0].ms
  clock.pending.shift().run()
  await ipcFixture.ipc.keyDeliveryIdle('A', f.workspaceId)
  assert.equal(slot().requests.get(requestId).state, 'delivered')
  assert.deepEqual(clock.pending, [])
  // The retry stores the same envelope under the same id: no re-encryption.
  assert.deepEqual(puts.slice(0, firstAttempt.length), firstAttempt)

  await Effect.runPromise(newDevice.host.keyRound(f.workspaceId, () => desktopPort))
  assert.equal((await Effect.runPromise(newDevice.host.status(f.workspaceId))).hasCurrentKey, true)
  const room = { kind: 'meta' }
  const context = {
    protocol: 'loro-streams-crdt-payload-protection',
    version: 2,
    kind: 'update_batch'
  }
  const plaintext = new TextEncoder().encode('synthetic account pairing history')
  const additionalData = new Uint8Array([4, 5, 6])
  const sealed = await Effect.runPromise(
    approver.host.seal(f.workspaceId, { epoch: 0, room, context, plaintext, additionalData })
  )
  assert.deepEqual(
    await Effect.runPromise(
      newDevice.host.openContent(f.workspaceId, { room, context, ...sealed, additionalData })
    ),
    plaintext
  )
})

void test('an unrelated unfinished per-workspace pairing blocks only that workspace, with a clear state', async (t) => {
  const { f, approver, newDevice, genesisHash, requester, approving } =
    await accountPairingFixture(t)
  // The new device already started the per-workspace exchange from another offer.
  const offer = await Effect.runPromise(approver.host.personalPairingOffer(f.workspaceId))
  await Effect.runPromise(newDevice.bootstrap.preparePersonalJoin(offer))
  const request = await Effect.runPromise(requester.requestAccountPairing({}))
  const preview = await Effect.runPromise(approving.inspectAccountPairing(request.pairingString))
  await Effect.runPromise(
    approving.approveAccountPairing({
      pairingString: request.pairingString,
      requestId: preview.requestId,
      workspaceIds: [f.workspaceId]
    })
  )
  const state = await Effect.runPromise(requester.accountPairingRequest())
  assert.equal(state.status, 'waiting')
  assert.deepEqual(
    state.workspaces.map((item) => [item.workspaceId, item.state]),
    [[f.workspaceId, 'blocked']]
  )
  // The unfinished exchange is kept, not overwritten.
  const pending = await Effect.runPromise(newDevice.bootstrap.pendingPersonalJoin(f.workspaceId))
  assert.equal(pending.offer.pairingSessionId, offer.pairingSessionId)
  void genesisHash
})

void test('account pairing keeps a control-page observation made before approval when the invitation snapshot is newer', async (t) => {
  const { f, approver, newDevice, genesisHash, requester, approving } =
    await accountPairingFixture(t)
  // The desktop opened the control page before it joined and verified the
  // server's genesis. That observation is durable local evidence.
  const storage = new ObservedLedgerStorage()
  const observed = appendLedgerHistory(
    null,
    {
      workspaceId: f.workspaceId,
      genesisHash,
      startIndex: 0,
      recordsHex: [
        (await Effect.runPromise(approver.host.ledgerView(f.workspaceId))).recordsHex[0]
      ],
      checkpoint: { length: 1, headHash: genesisHash },
      position: `p1:${f.workspaceId}:1:source:0`,
      nextCursor: null
    },
    { workspaceId: f.workspaceId, genesisHash, localPin: null }
  )
  assert.equal(observed.view.length, 1)
  assert.equal(
    retainObservedLedgerCheckpoint(storage, newDevice.accountId, f.workspaceId, observed),
    true
  )
  assert.equal(readObservedLedgerCheckpoint(storage, newDevice.accountId, f.workspaceId).length, 1)

  // Approval admits the desktop into a later snapshot. The join installs the
  // endorsement and its own genesis original, but not the intervening record.
  const request = await Effect.runPromise(requester.requestAccountPairing({}))
  const preview = await Effect.runPromise(approving.inspectAccountPairing(request.pairingString))
  await Effect.runPromise(
    approving.approveAccountPairing({
      pairingString: request.pairingString,
      requestId: preview.requestId,
      workspaceIds: [f.workspaceId]
    })
  )
  assert.equal((await Effect.runPromise(requester.accountPairingRequest())).status, 'joined')
  assert.equal((await Effect.runPromise(newDevice.host.open(f.workspaceId))).deviceKind, 'personal')

  // The control page publishes that host view. The signed snapshot cannot name
  // the earlier checkpoint, but the retained genesis original proves it; the
  // page must not claim a rollback or fork.
  const published = hostLedgerHistory(
    await Effect.runPromise(newDevice.host.ledgerView(f.workspaceId))
  )
  assert.equal(published.view.length, 2)
  assert.ok(published.records.length < published.view.length)
  assert.equal(
    retainObservedLedgerCheckpoint(storage, newDevice.accountId, f.workspaceId, published),
    true
  )
  assert.equal(readObservedLedgerCheckpoint(storage, newDevice.accountId, f.workspaceId).length, 2)

  // The approved desktop still receives the current epoch key. A later key
  // round, not the control-page read, installs it.
  const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(genesisHash, 'hex')))
  const mailboxScope = Effect.runSync(Scope.make())
  t.after(() => Effect.runPromise(Scope.close(mailboxScope, Exit.void)))
  const mailbox = await Effect.runPromise(
    makeSqliteKeyMailbox({
      path: join(newDevice.path, 'reference-mailbox.sqlite'),
      mode: 'create',
      genesis,
      ledger: () =>
        Effect.promise(async () => {
          const ledger = await Effect.runPromise(approver.host.ledgerView(f.workspaceId))
          const records = ledger.recordsHex.map((value) => Buffer.from(value, 'hex'))
          return Result.getOrThrow(
            verifyLedger({
              anchor: genesis,
              records,
              checkpoint: { length: records.length, head: hashRecordBytes(records.at(-1)) }
            })
          )
        })
    }).pipe(Scope.provide(mailboxScope))
  )
  const approverDevice = await Effect.runPromise(approver.custody.openDevice(genesis))
  const desktopDevice = await Effect.runPromise(newDevice.custody.openDevice(genesis))
  const approverMailbox = Context.get(
    await Effect.runPromise(
      Layer.buildWithScope(referenceKeyMailbox(mailbox, approverDevice.publicKey), mailboxScope)
    ),
    KeyMailbox
  )
  const desktopMailbox = Context.get(
    await Effect.runPromise(
      Layer.buildWithScope(referenceKeyMailbox(mailbox, desktopDevice.publicKey), mailboxScope)
    ),
    KeyMailbox
  )
  await Effect.runPromise(approver.host.keyRound(f.workspaceId, () => approverMailbox))
  await Effect.runPromise(newDevice.host.keyRound(f.workspaceId, () => desktopMailbox))
  assert.equal((await Effect.runPromise(newDevice.host.status(f.workspaceId))).hasCurrentKey, true)

  // A conflicting earlier observation remains blocking evidence, not repair.
  const conflicting = new ObservedLedgerStorage()
  conflicting.setItem(
    `lody-e2ee-observed-ledger:${encodeURIComponent(newDevice.accountId)}:${encodeURIComponent(f.workspaceId)}:1:${'00'.repeat(32)}`,
    JSON.stringify({ genesisHash, headHash: '00'.repeat(32), length: 1 })
  )
  assert.throws(
    () =>
      retainObservedLedgerCheckpoint(conflicting, newDevice.accountId, f.workspaceId, published),
    /Ledger history changed/
  )
})

void test(
  'member key delivery and claim transitions are logged under a short request tag, never the request id',
  { timeout: 20_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const submitted = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', submitted.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    assert.equal((await f.joiner.claimMemberJoin('team', submitted.requestId)).ready, true)
    const trail = f.logs.map(([event, fields]) => `${event}:${fields.state}:${fields.phase ?? ''}`)
    assert.deepEqual(trail, [
      '[E2EE] key-delivery:pending:',
      '[E2EE] key-delivery:delivering:',
      '[E2EE] key-delivery:delivered:',
      '[E2EE] member-claim:committed:ready'
    ])
    assert.ok(f.logs.every(([, fields]) => /^[0-9a-f]{12}$/.test(fields.request)))
    assert.ok(!JSON.stringify(f.logs).includes(submitted.requestId))
  }
)

void test(
  'a relay-forged email request is never admitted unattended and waits for explicit approval',
  { timeout: 30_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const submitted = await f.submit()
    await f.approver.memberJoinRequests('team')
    const stored = f.requests.get(submitted.requestId)
    const genuine = stored.offer
    const before = f.records.length
    // `source: 'email'` alone, an invitation signed by the relay's own key, and a genuine
    // signature over different pins: none is an invitation this approver can verify.
    for (const [forged, refusal] of [
      [undefined, /e2ee_member_invitation_invalid/],
      // Verifies under the relay's own key, which the ledger never admitted.
      [relaySignedOffer(genuine), /e2ee_member_invitation_endorser_ineligible/],
      [{ ...genuine, expiresAt: genuine.expiresAt - 1 }, /e2ee_member_invitation_invalid/]
    ]) {
      stored.offer = forged
      await assert.rejects(
        f.approver.approveMemberJoin('team', submitted.requestId, 'automatic'),
        refusal
      )
      assert.equal(f.records.length, before)
    }
    // The applicant stays listed, and an administrator's explicit approval still admits it.
    assert.equal(
      JSON.stringify(
        (await f.approver.memberJoinRequests('team')).items.map((item) => item.requestId)
      ),
      JSON.stringify([submitted.requestId])
    )
    assert.equal(
      (await f.approver.approveMemberJoin('team', submitted.requestId, 'explicit')).admitted,
      true
    )
    await f.approver.keyDeliveryIdle('acc1', 'team')
  }
)

void test(
  'an email invitation admits one applicant: another account presenting its token is refused as used',
  { timeout: 30_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const first = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', first.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    const before = f.records.length
    // The relay replays the same invitation for another account's keys.
    const other = await f.addMember('thr', 3, f.offer)
    assert.equal(other.submitted.requestId, first.requestId)
    await assert.rejects(
      f.approver.approveMemberJoin('team', other.submitted.requestId, 'automatic'),
      /e2ee_member_invitation_used/
    )
    assert.equal(f.records.length, before)
  }
)

void test(
  'invitations from an admin who was later demoted are no longer admitted unattended',
  { timeout: 40_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const admin = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', admin.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    assert.equal((await f.joiner.claimMemberJoin('team', admin.requestId)).ready, true)
    await f.joiner.memberSettleIdle('member', 'team')
    await f.approver.setMemberRole('team', admin.requestId, 'admin')
    await f.joiner.open('team')
    await f.joiner.refresh('team', { keyMode: 'none' })
    const mint = async () => {
      const minted = await f.memberApi.withDesktopE2eeAccount(
        (account) => account.host.memberOffer('team', 'email', 9_000_000_000_000),
        'team',
        false
      )
      f.offers.set(minted.token, minted)
      return minted
    }
    const early = await mint()
    const late = await mint()
    // While the endorser is an admin its invitation is admitted unattended.
    const accepted = await f.addMember('acc3', 3, early)
    await f.approver.memberJoinRequests('team')
    assert.equal(
      (await f.approver.approveMemberJoin('team', accepted.submitted.requestId, 'automatic'))
        .admitted,
      true
    )
    await f.approver.keyDeliveryIdle('acc1', 'team')
    await f.approver.setMemberRole('team', admin.requestId, 'member')
    const waiting = await f.addMember('acc4', 4, late)
    // Listed and pinned like any applicant: only the endorser's current role refuses it.
    await f.approver.memberJoinRequests('team')
    const before = f.records.length
    await assert.rejects(
      f.approver.approveMemberJoin('team', waiting.submitted.requestId, 'automatic'),
      /e2ee_member_invitation_endorser_ineligible/
    )
    assert.equal(f.records.length, before)
  }
)

void test('preload admits every renderer-facing E2EE IPC method', async () => {
  // Preload lists the E2EE methods it admits; every `@IpcMethod()` must be on it,
  // or the renderer cannot call a method the product already uses (#2204 shipped
  // the account pairing methods without it).
  const methods = []
  await load(
    '../ipc/services/e2ee-ipc.ts',
    e2eeIpcDependencies({}, new EventEmitter(), (name) => methods.push(name))
  )
  assert.ok(methods.includes('requestAccountPairing'))
  assert.deepEqual(
    methods.filter((method) => !isIpcInvokeChannel(`e2ee.${method}`)),
    []
  )
})

void test('a brand-new desktop gets a pairing code for a workspace another device created', async (t) => {
  const submitted = []
  const { ipc, hints, genesisHash } = await newDesktopAccountPairing(t, (request) =>
    Effect.sync(() => {
      submitted.push(request)
      return {
        requestId: 'request-1',
        status: 'pending',
        deviceName: request.deviceName,
        approximateLocation: null,
        requestedAt: Date.now(),
        expiresAt: request.expiresAt
      }
    })
  )
  // The renderer first asks for a retained request, then starts one.
  assert.equal(await ipc.accountPairingRequest(hints), null)
  const state = await ipc.requestAccountPairing({}, hints)
  assert.equal(state.status, 'waiting')
  assert.match(state.pairingString, /\S/)
  assert.deepEqual(state.workspaces, [
    { workspaceId: 'workspace', name: 'Phone workspace', state: 'pending', approval: 'waiting' }
  ])
  assert.deepEqual(
    submitted.map((request) => request.workspaces),
    [[{ workspaceId: 'workspace', genesisHash }]]
  )
})

void test('IPC requestAccountPairing decouples preserveExisting from multi-workspace hints and optional workspaceId', async (t) => {
  const phone = await nativeAccountFixture(t)
  const first = await createAccountWorkspace(phone.api, 'workspace-a')
  const second = await createAccountWorkspace(phone.api, 'workspace-b')
  const ledgerPage = async (workspaceId) => {
    const genesisHash =
      workspaceId === 'workspace-a' ? first.creation.genesisHashHex : second.creation.genesisHashHex
    const ledger = await phone.api.withDesktopE2eeAccount(
      (owner) => owner.host.ledgerView(workspaceId),
      workspaceId
    )
    return {
      workspaceId,
      genesisHash,
      startIndex: 0,
      recordsHex: ledger.recordsHex,
      checkpoint: { length: ledger.status.length, headHash: ledger.status.headHash },
      position: `p1:${workspaceId}:${ledger.status.length}:source-${ledger.status.length}:0`,
      nextCursor: null
    }
  }
  const submitted = []
  const desktop = await nativeAccountFixture(t)
  const client = {
    history: ({ workspaceId }) => Effect.promise(() => ledgerPage(workspaceId)),
    pairingSubmit: (request) =>
      Effect.sync(() => {
        submitted.push(request)
        return {
          requestId: `request-${submitted.length}`,
          status: 'pending',
          deviceName: request.deviceName,
          approximateLocation: null,
          requestedAt: Date.now(),
          expiresAt: request.expiresAt
        }
      }),
    pairingClaim: () => Effect.succeed({ status: 'pending', approvals: [] })
  }
  const sender = Object.assign(new EventEmitter(), {
    id: 32,
    isDestroyed: () => false,
    send: () => {}
  })
  const { E2eeIpc } = await load(
    '../ipc/services/e2ee-ipc.ts',
    e2eeIpcDependencies(
      {
        ...desktop.api,
        desktopE2eeCloudClient: async () => ({ accountId: 'acc1', client }),
        desktopAccountPairingDatabase: (accountId) =>
          join(desktop.directory, `account-pairing-${accountId}.sqlite`)
      },
      sender
    )
  )
  const ipc = new E2eeIpc()
  const hints = [
    { workspaceId: 'workspace-a', name: 'Alpha', genesisHash: first.creation.genesisHashHex },
    { workspaceId: 'workspace-b', name: 'Beta', genesisHash: second.creation.genesisHashHex }
  ]
  const makeCode = (fillByte) => {
    const secret = new Uint8Array(16).fill(fillByte)
    const keys = Result.getOrThrow(derivePairingKeys(secret))
    const lookupId = Buffer.from(keys.lookupId).toString('hex')
    disposePairingKeys(keys)
    const pairingString = formatPairingString(Result.getOrThrow(encodePairingSecret(secret)))
    secret.fill(0)
    return { pairingString, lookupId }
  }
  const codeOne = makeCode(11)
  const codeTwo = makeCode(22)

  // Account-wide external link confirmation passes preserveExisting across 2+ workspaces.
  const allState = await ipc.requestAccountPairing(
    { pairingString: codeOne.pairingString, preserveExisting: true },
    hints
  )
  assert.equal(allState.status, 'waiting')
  assert.deepEqual(allState.workspaces.map((w) => w.workspaceId).sort(), [
    'workspace-a',
    'workspace-b'
  ])
  // Another preserveExisting request refuses with pairing-elsewhere while codeOne is open.
  await assert.rejects(
    ipc.requestAccountPairing(
      { pairingString: codeTwo.pairingString, preserveExisting: true },
      hints
    ),
    { message: 'e2ee_pairing-elsewhere' }
  )
  // Cancelling with a non-matching lookupId preserves codeOne; matching lookupId cancels it.
  await ipc.cancelAccountPairing({ expectedLookupId: codeTwo.lookupId })
  assert.equal((await ipc.accountPairingRequest(hints))?.status, 'waiting')
  await ipc.cancelAccountPairing({ expectedLookupId: codeOne.lookupId })
  assert.equal((await ipc.accountPairingRequest(hints))?.status, 'expired')

  // Automatic pairing passes workspaceId explicitly and scopes to that single workspace.
  const singleState = await ipc.requestAccountPairing(
    {
      pairingString: codeTwo.pairingString,
      preserveExisting: true,
      workspaceId: 'workspace-b'
    },
    [hints[1]]
  )
  assert.deepEqual(
    singleState.workspaces.map((w) => w.workspaceId),
    ['workspace-b']
  )
})

for (const code of ['pairing-unavailable', 'pairing-rate-limited'])
  void test(`a relay refusal (${code}) reaches the new desktop's UI with its reason`, async (t) => {
    const refusal = Object.assign(new Error('synthetic private relay cause'), { code })
    const { ipc, hints } = await newDesktopAccountPairing(t, () => Effect.fail(refusal))
    await assert.rejects(ipc.requestAccountPairing({}, hints), (error) => {
      assert.equal(error.message, `e2ee_${code}`)
      assert.equal(ipc.pairingFailure, refusal)
      return true
    })
  })

// Critical path from the approval result: approver calls until its envelope `put`, one
// member claim that just missed it plus the 3 s cadence, then the claim that installs.
void test(
  'an admitted member is ready within 30 s of the approval result on the critical path',
  { timeout: 20_000 },
  async (t) => {
    const calls = { owner: [], member: [] }
    let held
    let reachedPut
    const f = await twoDeviceMemberJoin(t, {
      latency: (name, { device }) => {
        calls[device].push(name)
        if (!(held && device === 'owner' && name === 'mailbox.put')) return Effect.void
        reachedPut.resolve()
        return Effect.promise(() => held.promise)
      }
    })
    await f.approver.open('team')
    // The approver has already run full key rounds, as after earlier pairings.
    await f.approver.refresh('team')
    const submitted = await f.submit()
    await f.approver.memberJoinRequests('team')
    held = deferredMember()
    reachedPut = deferredMember()
    const approvalStart = calls.owner.length
    await f.approver.approveMemberJoin('team', submitted.requestId, 'automatic')
    await reachedPut.promise
    const approval = calls.owner.slice(approvalStart)
    const toPut = approval.length - approval.lastIndexOf('memberRead') - 1
    // The member's first committed claim accepts the verified history; a later retry
    // runs just before the envelope exists and misses it.
    assert.equal((await f.joiner.claimMemberJoin('team', submitted.requestId)).ready, false)
    calls.member = []
    assert.equal((await f.joiner.claimMemberJoin('team', submitted.requestId)).ready, false)
    const missed = calls.member.length
    held.resolve()
    await f.approver.keyDeliveryIdle('acc1', 'team')
    calls.member = []
    assert.equal((await f.joiner.claimMemberJoin('team', submitted.requestId)).ready, true)
    const installing = claimCalls(calls.member)
    // Off the ready path, main still flushes the member's installation report and then
    // releases the workspace the claim opened.
    await f.joiner.memberSettleIdle('member', 'team')
    assert.ok(calls.member.slice(installing).includes('mailbox.report'))
    assert.equal(
      await f.memberApi.withDesktopE2eeAccount(
        (account) => Effect.succeed(account.readers.has('team')),
        'team',
        false
      ),
      false
    )
    const seconds = (toPut + missed + installing) * RELAY_CALL_S + TOKEN_MINT_S + 3
    t.diagnostic(
      `to put ${toPut}, missed claim ${missed}, installing claim ${installing}: about ${seconds.toFixed(1)} s`
    )
    assert.ok(seconds <= 30, `about ${seconds.toFixed(1)} s from approval to ready`)
  }
)

// At ~1.3 s per relay call (B on-site run22: 36 serial mailbox calls, 47.7 s) only about
// ten round trips fit beside the rest of J07/continue's 60 s window.
void test(
  'a full key round reaches every other device in a bounded number of serial relay round trips',
  { timeout: 120_000 },
  async (t) => {
    let path
    const calls = []
    const f = await rotatedTeam(t, (name, { device }) => {
      if (!path || device !== 'owner' || !name.startsWith('mailbox.')) return Effect.void
      calls.push(name)
      // A relay call suspends its fiber, as a network round trip does.
      return Effect.andThen(path.call(), Effect.yieldNow)
    })
    path = criticalPath(t)
    await f.approver.refresh('team')
    const tally = Object.entries(
      calls.reduce((counts, name) => ({ ...counts, [name]: (counts[name] ?? 0) + 1 }), {})
    )
    t.diagnostic(`round trips ${path.longest()} of ${calls.length} calls: ${tally.join(' ')}`)
    assert.equal(calls.filter((name) => name === 'mailbox.put').length, 5)
    assert.ok(path.longest() <= 10, `${path.longest()} serial mailbox round trips`)
  }
)

void test(
  'a delivery refused during a concurrent round stays pending with its original while the other devices are delivered',
  { timeout: 120_000 },
  async (t) => {
    let watching = false
    let refusing = true
    let refused
    const puts = []
    const f = await rotatedTeam(t, (name, { device, args }) => {
      if (!watching || device !== 'owner' || name !== 'mailbox.put') return Effect.void
      const [slot, frame] = args
      puts.push({ slot, frame: Buffer.from(frame).toString('hex') })
      refused ??= puts.at(-1)
      return refusing && slot === refused.slot
        ? Effect.fail(new BackendError({ service: 'KeyMailbox', reason: 'conflict' }))
        : Effect.yieldNow
    })
    watching = true
    await f.approver.refresh('team')
    refusing = false
    assert.equal(new Set(puts.map((put) => put.slot)).size, 5)
    // The next round re-sends only the refused task, with its exact original ciphertext.
    puts.length = 0
    await f.approver.refresh('team')
    assert.deepEqual(puts, [refused])
    puts.length = 0
    await f.approver.refresh('team')
    assert.deepEqual(puts, [])
  }
)

void test(
  'a member accepted before a rotation is ready only with the current epoch key, never the old one',
  { timeout: 30_000 },
  async (t) => {
    let held
    const f = await twoDeviceMemberJoin(t, {
      latency: (name, { device }) =>
        held && device === 'owner' && name === 'mailbox.put'
          ? Effect.promise(() => held.promise)
          : Effect.void
    })
    await f.approver.open('team')
    const submitted = await f.submit()
    await f.approver.memberJoinRequests('team')
    held = deferredMember()
    await f.approver.approveMemberJoin('team', submitted.requestId, 'automatic')
    // Accepted locally while the epoch 0 envelope is still on its way.
    assert.equal((await f.joiner.claimMemberJoin('team', submitted.requestId)).ready, false)
    const release = held
    held = undefined
    release.resolve()
    await f.approver.keyDeliveryIdle('acc1', 'team')
    // Before the member's next claim, another member joins and is removed, and the
    // required rotation publishes epoch 1.
    const other = await f.addMember('thr', 3)
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', other.submitted.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    await f.approver.removeMember('team', other.submitted.requestId)
    await f.approver.updateKeys('team')
    const epoch = async (api) =>
      (await api.withDesktopE2eeAccount((account) => account.host.status('team'), 'team', false))
        .epoch
    assert.equal(await epoch(f.ownerApi), 1)
    let claimed = await f.joiner.claimMemberJoin('team', submitted.requestId)
    for (let attempt = 0; !claimed.ready && attempt < 3; attempt++)
      claimed = await f.joiner.claimMemberJoin('team', submitted.requestId)
    assert.equal(claimed.ready, true)
    await f.joiner.memberSettleIdle('member', 'team')
    assert.equal(await epoch(f.memberApi), 1)
  }
)

void test(
  'a fast-path claim whose relay history is still paging after 256 pages is not ready',
  { timeout: 30_000 },
  async () => {
    let pages = 0
    let ingested = 0
    const f = await memberIpcFixture({
      bootstrap: { acceptedMemberJoin: () => Effect.succeed(approvalRequest) },
      client: {
        // A 257th page always follows: the local ledger cannot be confirmed current.
        history: () =>
          Effect.sync(() => ({ checkpoint: {}, nextCursor: `page-${++pages}`, recordsHex: [] })),
        mailbox: () => ({}),
        staging: () => ({})
      },
      host: {
        status: () => Effect.succeed({ hasCurrentKey: true, position: 'p1:team:1:fixture' }),
        ingestLedgerRecords: () =>
          Effect.sync(() => {
            ingested++
          }),
        receiveKeys: () => Effect.void
      }
    })
    const claimed = await f.ipc.claimMemberJoin('team', approvalRequest)
    assert.equal(ingested, 256)
    assert.deepEqual({ ...claimed }, { ready: false, state: 'committed' })
  }
)

void test(
  'access loss during the fast-path catch-up removes the local workspace',
  { timeout: 30_000 },
  async (t) => {
    let held
    const f = await twoDeviceMemberJoin(t, {
      latency: (name, { device }) =>
        held && device === 'owner' && name === 'mailbox.put'
          ? Effect.promise(() => held.promise)
          : Effect.void
    })
    await f.approver.open('team')
    const submitted = await f.submit()
    await f.approver.memberJoinRequests('team')
    held = deferredMember()
    await f.approver.approveMemberJoin('team', submitted.requestId, 'automatic')
    assert.equal((await f.joiner.claimMemberJoin('team', submitted.requestId)).ready, false)
    held.resolve()
    held = undefined
    await f.approver.keyDeliveryIdle('acc1', 'team')
    // The member is removed before its next claim; only its credential can confirm it.
    f.relay.memberRemoved = true
    await assert.rejects(
      f.joiner.claimMemberJoin('team', submitted.requestId),
      /^Error: e2ee_member_removed$/
    )
    // The removal receipt fences this identity: reopening reports the removal.
    await assert.rejects(f.joiner.open('team'), /e2ee_member_removed/)
  }
)

void test(
  'a member whose retained join predates signed invitations still reopens its workspace',
  { timeout: 30_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const submitted = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', submitted.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    assert.equal((await f.joiner.claimMemberJoin('team', submitted.requestId)).ready, true)
    await f.joiner.memberSettleIdle('member', 'team')
    // The join was retained by a build that wrote invitations without an endorsement.
    const find = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }))
        if (entry.isFile() && entry.name === 'creations.sqlite')
          return join(entry.parentPath, entry.name)
      return null
    }
    const path = await find(f.memberDirectory)
    assert.ok(path)
    const db = new DatabaseSync(path)
    try {
      const row = db
        .prepare('SELECT offer,history FROM member_joins WHERE workspace_id=?')
        .get('team')
      assert.ok(row.history)
      const { signature, ...unsigned } = JSON.parse(row.offer)
      assert.ok(signature)
      db.prepare('UPDATE member_joins SET offer=? WHERE workspace_id=?').run(
        JSON.stringify(unsigned),
        'team'
      )
    } finally {
      db.close()
    }
    const creation = await f.memberApi.withDesktopE2eeAccount(
      (account) => account.bootstrap.creationFor('team'),
      'team',
      false
    )
    assert.equal(creation.genesisHash, f.offer.genesisHash)
  }
)

void test(
  'a removed member that has not yet observed its removal can submit a new invitation',
  { timeout: 30_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const first = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', first.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    assert.equal((await f.joiner.claimMemberJoin('team', first.requestId)).ready, true)
    await f.joiner.memberSettleIdle('member', 'team')
    // An administrator removes the member and invites it again. The member opens the new
    // invitation before any refresh or token request has told this device of the removal.
    f.relay.memberRemoved = true
    const again = await f.ownerApi.withDesktopE2eeAccount(
      (account) => account.host.memberOffer('team', 'link', 9_000_000_000_000),
      'team',
      false
    )
    assert.notEqual(JSON.stringify(again), JSON.stringify(f.offer))
    const second = await f.joiner.prepareMemberJoin(again)
    assert.notEqual(second.requestId, first.requestId)
    assert.notEqual(second.signingPublicKey, first.signingPublicKey)
    await assert.rejects(f.joiner.open('team'), /e2ee_member_removed/)
    // The new request is the retained pending join; the removed one no longer refuses it.
    assert.equal(
      JSON.stringify(await f.joiner.pendingMemberJoin('team')),
      JSON.stringify({ offer: again, requestId: second.requestId })
    )
  }
)

void test(
  'a removed member whose local erase failed can accept a new invitation once the fault clears',
  { timeout: 30_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const first = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', first.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    assert.equal((await f.joiner.claimMemberJoin('team', first.requestId)).ready, true)
    await f.joiner.memberSettleIdle('member', 'team')
    f.relay.memberRemoved = true
    // The OS key store becomes unavailable just as the removal is confirmed, so the
    // receipt is recorded but the local erase that follows it fails.
    f.relay.onRemovalConfirmed = () => {
      f.relay.onRemovalConfirmed = undefined
      f.setMemberLocked(true)
    }
    const again = await f.ownerApi.withDesktopE2eeAccount(
      (account) => account.host.memberOffer('team', 'link', 9_000_000_000_000),
      'team',
      false
    )
    await assert.rejects(f.joiner.prepareMemberJoin(again))
    // Once the key store is back, accepting the same invitation finishes the erase and joins.
    f.setMemberLocked(false)
    const second = await f.joiner.prepareMemberJoin(again)
    assert.notEqual(second.requestId, first.requestId)
    assert.equal(
      JSON.stringify(await f.joiner.pendingMemberJoin('team')),
      JSON.stringify({ offer: again, requestId: second.requestId })
    )
  }
)

void test(
  'a sign-in change while a removed join is cleaned up refuses the new invitation',
  { timeout: 30_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const first = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', first.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    assert.equal((await f.joiner.claimMemberJoin('team', first.requestId)).ready, true)
    await f.joiner.memberSettleIdle('member', 'team')
    f.relay.memberRemoved = true
    // The same account signs in again while the confirmed removal is being cleaned up.
    f.relay.onRemovalConfirmed = () => {
      f.memberIdentity.generation = (f.memberIdentity.generation ?? 0) + 1
    }
    const again = await f.ownerApi.withDesktopE2eeAccount(
      (account) => account.host.memberOffer('team', 'link', 9_000_000_000_000),
      'team',
      false
    )
    await assert.rejects(f.joiner.prepareMemberJoin(again), /^Error: e2ee_host_operation_failed$/)
    f.relay.onRemovalConfirmed = undefined
    // The removal still ends the old workspace, but no request was made for the new sign-in.
    await assert.rejects(f.joiner.open('team'), /e2ee_member_removed/)
    assert.equal(await f.joiner.pendingMemberJoin('team'), null)
  }
)

void test(
  'a current member refuses another invitation and keeps its workspace',
  { timeout: 30_000 },
  async (t) => {
    const f = await twoDeviceMemberJoin(t)
    await f.approver.open('team')
    const first = await f.submit()
    await f.approver.memberJoinRequests('team')
    await f.approver.approveMemberJoin('team', first.requestId, 'automatic')
    await f.approver.keyDeliveryIdle('acc1', 'team')
    assert.equal((await f.joiner.claimMemberJoin('team', first.requestId)).ready, true)
    await f.joiner.memberSettleIdle('member', 'team')
    const again = await f.ownerApi.withDesktopE2eeAccount(
      (account) => account.host.memberOffer('team', 'link', 9_000_000_000_000),
      'team',
      false
    )
    await assert.rejects(f.joiner.prepareMemberJoin(again), /^Error: e2ee_conflict$/)
    assert.equal((await f.joiner.open('team')).hasCurrentKey, true)
  }
)

void test('quitting ends a request waiting on a slow sign-in token within the quit budget', async (t) => {
  // Injected clock: the 15 s quit budget and the 30 s request deadline only pass when ticked.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signIn = slowSignIn()
  const api = await slowSignInAccount(t, signIn)
  const { client } = await api.desktopE2eeCloudClient()
  // Stands in for a key round's history read; the host's close awaits that round.
  const round = Effect.runPromiseExit(client.history({ workspaceId: 'workspace' }))
  await settle(() => signIn.pending.size === 1)
  assert.equal(signIn.pending.size, 1)
  let finished = false
  const drained = drainMainProcessQuitResources(
    [
      {
        name: 'e2ee',
        close: async () => {
          await api.closeDesktopE2eeAccount({ quit: true })
          await round
        }
      }
    ],
    15_000
  ).finally(() => {
    finished = true
  })
  await settle(() => finished)
  t.mock.timers.tick(15_000)
  assert.deepEqual(await drained, [])
  // Cancelling the quit left no token request behind.
  assert.equal(signIn.pending.size, 0)
  assert.equal(Exit.isFailure(await round), true)
})

void test('a slow sign-in token still completes a request when nothing is quitting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signIn = slowSignIn()
  const api = await slowSignInAccount(t, signIn)
  const { client } = await api.desktopE2eeCloudClient()
  const read = Effect.runPromise(client.history({ workspaceId: 'workspace' }))
  await settle(() => signIn.pending.size === 1)
  // Slower than the quit budget, inside the request's own deadline.
  t.mock.timers.tick(20_000)
  signIn.answerAll()
  assert.equal((await read).position, 'p1:workspace:1:synthetic')
})

void test('after workspace creation (length 1, no prior cursor), ingesting inline appendRecord historyPage at index 1 skips history RTT while non-contiguous pages still fall back', async () => {
  let position = null
  let length = 1
  const historyCalls = []
  const ingestedPages = []
  const inlinePage = (idx) => ({
    workspaceId: 'team',
    genesisHash: '11'.repeat(32),
    checkpoint: { headHash: '22'.repeat(32), length: idx + 1 },
    startIndex: idx,
    recordsHex: ['aa'],
    position: `p1:team:${idx + 1}:cursor`,
    nextCursor: null
  })
  const f = await memberIpcFixture({
    realRefresh: true,
    client: {
      history: (args) =>
        Effect.sync(() => {
          historyCalls.push(args)
          return {
            workspaceId: 'team',
            genesisHash: '11'.repeat(32),
            checkpoint: { headHash: '22'.repeat(32), length: length + 1 },
            startIndex: 0,
            recordsHex: Array.from({ length: length + 1 }, (_v, i) => (i === 0 ? '00' : 'aa')),
            position: `p1:team:${length + 1}:bootstrapped`,
            nextCursor: null
          }
        })
    },
    host: {
      status: () =>
        Effect.succeed({
          hasCurrentKey: true,
          genesisHash: '11'.repeat(32),
          length,
          position
        }),
      ingestLedgerRecords: (_ws, page) =>
        Effect.sync(() => {
          ingestedPages.push(page.startIndex)
          position = page.position
          length = page.checkpoint.length
        })
    }
  })
  // Brand-new workspace (position === null, length === 1): contiguous startIndex=1 skips history().
  f.ipc.retainInlineHistory('team', inlinePage(1))
  await f.ipc.refresh('team', { keyMode: 'none' })
  assert.equal(historyCalls.length, 0)
  assert.deepEqual(ingestedPages, [1])
  assert.equal(length, 2)
  assert.equal(position, 'p1:team:2:cursor')

  // Bootstrapped workspace (position !== null): inline suffix serves refresh without calling history.
  f.ipc.retainInlineHistory('team', inlinePage(2))
  await f.ipc.refresh('team', { keyMode: 'none' })
  assert.equal(historyCalls.length, 0)
  assert.deepEqual(ingestedPages, [1, 2])

  // Non-contiguous inline page (startIndex=2 at length=1) or length > 1 without cursor still falls back to history().
  position = null
  length = 1
  f.ipc.retainInlineHistory('team', inlinePage(2))
  await f.ipc.refresh('team', { keyMode: 'none' })
  assert.equal(historyCalls.length, 1)
  assert.deepEqual(ingestedPages, [1, 2, 0])

  position = null
  length = 2
  f.ipc.retainInlineHistory('team', inlinePage(2))
  await f.ipc.refresh('team', { keyMode: 'none' })
  assert.equal(historyCalls.length, 2)
  assert.deepEqual(ingestedPages, [1, 2, 0, 0])
})
