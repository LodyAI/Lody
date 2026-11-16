import {
  Clock,
  DatabaseSync,
  E2eeDeviceRevokedError,
  E2eeMemberRemovedError,
  Effect,
  EventEmitter,
  Exit,
  KEY_DELIVERY_READER,
  KEY_DELIVERY_RETRY_DELAYS,
  Layer,
  Scope,
  TestClock,
  assert,
  createAccountWorkspace,
  createRequire,
  deferredMember,
  electronIpc,
  fakeKeyDeliveryTimers,
  identityStorage,
  isIpcInvokeChannel,
  join,
  keyDeliveryState,
  load,
  makeE2eeCloudClient,
  memberIpcFixture,
  nativeAccountFixture,
  personalApprovalFixture,
  personalApprovalRequest,
  personalJoinFixture,
  plain,
  randomUUID,
  readFile,
  readdir,
  test
} from './e2ee-account-runtime-test-helpers.mjs'

void test('prepareDispatch isolates JWT, transport and parse failures from credential authority through the real cloud client', async (t) => {
  for (const hasReader of [false, true]) {
    for (const code of ['e2ee_member_removed', 'e2ee_device_revoked']) {
      for (const source of [
        'jwt',
        'transport',
        'parse',
        'endpoint',
        'endpoint-slow-cleanup',
        'endpoint-cleanup-failure',
        ...(hasReader
          ? ['endpoint-slow-cleanup-frame']
          : ['endpoint-after-budget', 'transport-after-budget'])
      ]) {
        await t.test(`${hasReader ? 'reader' : 'closed'}-${code}-${source}`, async (subtest) => {
          const scope = await Effect.runPromise(Scope.make())
          const clock = await Effect.runPromise(Layer.buildWithScope(TestClock.layer(), scope))
          subtest.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
          const run = (work) => Effect.runPromise(Effect.provide(work, clock))
          const { api, identity } = await nativeAccountFixture(subtest, identityStorage, clock)
          const first = await createAccountWorkspace(api, 'workspace')
          const sender = Object.assign(new EventEmitter(), {
            id: 41,
            isDestroyed: () => false,
            send: () => {}
          })
          const failure = { data: { code } }
          const diagnostics = []
          let endpointCalls = 0
          let dispatchCalls = 0
          const cleanupEntered = Promise.withResolvers()
          const cleanupDone = Promise.withResolvers()
          const releaseCleanup = Promise.withResolvers()
          subtest.after(() => releaseCleanup.resolve())
          const delayedCleanup = source.startsWith('endpoint-slow-cleanup')
          if (delayedCleanup) await createAccountWorkspace(api, 'independent-workspace')
          let escapedFrames = 0
          const afterBudget = source.endsWith('-after-budget')
          const endpointEntered = Promise.withResolvers()
          const releaseEndpoint = Promise.withResolvers()
          subtest.after(() => releaseEndpoint.resolve())
          const credential = await api.withDesktopE2eeAccount(
            (owner) => {
              owner.readers.set('workspace', new Map([[sender.id, 1]]))
              owner.host.prepareDispatch = () =>
                Effect.sync(() => {
                  dispatchCalls++
                  if (source.endsWith('-frame')) return { frame: 'synthetic-frame-must-not-escape' }
                  throw new Error('synthetic local dispatch failure')
                })
              return owner.bootstrap.deviceCredential('workspace')
            },
            'workspace',
            false
          )
          const client = await Effect.runPromise(
            makeE2eeCloudClient({
              platformKind: 'cloud',
              deploymentUrl: 'https://synthetic.convex.cloud',
              convexToken: async () => {
                if (source === 'jwt') throw failure
                return { token: 'synthetic-jwt' }
              },
              fetch: async (_url, init) => {
                const request = JSON.parse(init.body)
                assert.equal(request.path, 'e2eeContent:contentStreamsToken')
                assert.equal(request.args[0].credential, credential)
                endpointCalls++
                if (afterBudget) {
                  endpointEntered.resolve()
                  await releaseEndpoint.promise
                }
                if (source === 'transport' || source === 'transport-after-budget') throw failure
                const response = Response.json(
                  { status: 'error', errorMessage: 'synthetic rejection', errorData: { code } },
                  { status: 560 }
                )
                if (source === 'parse')
                  response.json = async () => {
                    throw failure
                  }
                return response
              }
            }).pipe(Scope.provide(scope))
          )
          const { E2eeIpc } = await load(
            '../ipc/services/e2ee-ipc.ts',
            {
              '../product-window-ipc-service': { ProductWindowIpcService: class {} },
              'electron-ipc-decorator': {
                IpcMethod: () => (_target, _name, descriptor) => descriptor,
                getIpcContext: () => ({ event: { sender } })
              },
              '../../platform': { isLocalPlatform: () => false },
              '../../services/e2ee-bootstrap.mjs': {},
              '../assert-sender': { assertProductWindowSender: () => {} },
              '../ipc-service-deps': {
                getIpcServiceDeps: () => ({
                  authService: { getCachedSessionIdentity: () => ({ ...identity }) }
                })
              },
              '../../services/e2ee-account-runtime': {
                ...api,
                cleanupRemovedDesktopWorkspace: async (input) => {
                  if (delayedCleanup) {
                    cleanupEntered.resolve()
                    await releaseCleanup.promise
                  }
                  try {
                    if (source === 'endpoint-cleanup-failure')
                      throw new Error('synthetic private cleanup failure')
                    return await api.cleanupRemovedDesktopWorkspace(input)
                  } finally {
                    cleanupDone.resolve()
                  }
                },
                desktopE2eeCloudClient: async () => ({ accountId: 'acc1', client })
              }
            },
            { ...console, warn: (...args) => diagnostics.push(args) }
          )
          const ipc = new E2eeIpc()
          if (!hasReader) await ipc.close('workspace')
          const original = await readFile(join(first.directory, 'creations.sqlite'))
          const snapshot = () => {
            const db = new DatabaseSync(join(first.directory, 'creations.sqlite'))
            try {
              return {
                creations: db
                  .prepare(
                    'SELECT request_id,hex(record) AS record,hex(epoch_blob) AS epoch_blob FROM creations ORDER BY request_id'
                  )
                  .all(),
                receipts: db.prepare('SELECT count(*) AS n FROM removed_workspaces').get().n
              }
            } finally {
              db.close()
            }
          }
          const originalRows = snapshot().creations
          assert.equal(originalRows.length, 1)
          let settled = false
          const outcome = ipc
            .prepareDispatch('workspace', 'synthetic-machine', {
              sessionId: 'session',
              userTurnId: 'turn',
              userId: 'display-only',
              timestamp: new Date(0).toISOString(),
              inputConfig: {}
            })
            .then(
              () => {
                escapedFrames++
                return new Error('unexpected prepared frame')
              },
              (cause) => cause
            )
            .finally(() => {
              settled = true
            })
          if (delayedCleanup) {
            // The exact credential verdict and its durable receipt already exist.
            // Hold only terminal erase; these are the ORIGINAL creation rows.
            await cleanupEntered.promise
            assert.deepEqual(snapshot(), { creations: originalRows, receipts: 1 })
            await run(TestClock.adjust('50 millis'))
            const bounded = settled ? (await outcome).message : undefined
            await run(TestClock.adjust('5 minutes'))
            const eventually = settled ? (await outcome).message : undefined
            // No successor may enter while the original erase still owns the identity.
            let fenceReason
            try {
              await api.withDesktopE2eeAccount(() => Effect.void, 'workspace', false)
            } catch (error) {
              fenceReason = error.message
            }
            const retained = snapshot()
            const independent = await api.withDesktopE2eeAccount(
              (owner) => owner.bootstrap.removedReason('independent-workspace'),
              'independent-workspace',
              false
            )
            assert.equal(independent, null, 'a pending erase cannot fence another workspace')
            releaseCleanup.resolve()
            await cleanupDone.promise
            await outcome
            if (ipc.dispatchCleanups)
              await Promise.all([...ipc.dispatchCleanups.values()].map((slot) => slot.done))
            assert.equal(
              bounded,
              code,
              'known loss must return its exact refusal within 50ms, not await erase'
            )
            assert.equal(eventually, code)
            assert.equal(fenceReason, code, 'pending erase must keep the original identity fenced')
            assert.deepEqual(retained, { creations: originalRows, receipts: 1 })
            assert.equal(escapedFrames, 0)
            assert.ok(diagnostics.some(([, fields]) => fields?.code === 'e2ee_cleanup_pending'))
            assert.equal(
              ipc.dispatchCleanups.size,
              0,
              'actual completion releases the cleanup owner'
            )
            assert.equal(
              await api.withDesktopE2eeAccount(
                (owner) => owner.bootstrap.removedReason('workspace'),
                'workspace',
                false
              ),
              code === 'e2ee_member_removed' ? 'member_removed' : 'device_revoked',
              'actual erase releases the native fence and retains the durable refusal'
            )
          }
          if (afterBudget) {
            // e6 live trace: reader already closed, credential request still has
            // no headers/body when the 300ms budget and IPC response expire.
            await endpointEntered.promise
            await run(TestClock.adjust('321 millis'))
            await api.withDesktopE2eeAccount(() => Effect.void, 'workspace', false)
            const premature = settled ? (await outcome).message : undefined
            assert.deepEqual(snapshot(), { creations: originalRows, receipts: 0 })
            assert.equal(escapedFrames, 0)
            await run(TestClock.adjust('479 millis'))
            releaseEndpoint.resolve()
            await outcome
            if (source.startsWith('endpoint')) await cleanupDone.promise
            assert.equal(
              premature,
              undefined,
              'readerless refusal must await credential diagnosis, not turn timeout into a verdict'
            )
          }
          const error = await outcome
          if (source.startsWith('endpoint')) {
            await cleanupDone.promise
            if (ipc.dispatchCleanups)
              await Promise.all([...ipc.dispatchCleanups.values()].map((slot) => slot.done))
          }
          if (source === 'endpoint-cleanup-failure') {
            assert.equal(error.message, code)
            assert.deepEqual(snapshot(), { creations: originalRows, receipts: 1 })
            await assert.rejects(
              api.withDesktopE2eeAccount(() => Effect.void, 'workspace', false),
              new RegExp(code)
            )
            await assert.rejects(
              api.resetDesktopE2eeIdentity({ workspaceId: 'workspace', resetId: randomUUID() }),
              new RegExp(code)
            )
            assert.equal(
              ipc.dispatchCleanups.size,
              0,
              'settled task releases no native failure fence'
            )
            assert.ok(diagnostics.some(([, fields]) => fields?.code === 'e2ee_cleanup_failed'))
            assert.ok(!JSON.stringify(diagnostics).includes('synthetic private'))
            return
          }
          const db = new DatabaseSync(join(first.directory, 'creations.sqlite'))
          try {
            const authoritative = source.startsWith('endpoint')
            assert.deepEqual(
              {
                message: error.message,
                endpointCalls,
                creations: db.prepare('SELECT count(*) AS n FROM creations').get().n,
                receipts: db.prepare('SELECT count(*) AS n FROM removed_workspaces').get().n
              },
              {
                message: authoritative ? code : 'e2ee_host_operation_failed',
                endpointCalls: source === 'jwt' ? 0 : 1,
                creations: authoritative ? 0 : 1,
                receipts: authoritative ? 1 : 0
              }
            )
          } finally {
            db.close()
          }
          assert.equal(dispatchCalls, hasReader ? 1 : 0)
          assert.equal(escapedFrames, 0)
          if (!source.startsWith('endpoint')) {
            assert.deepEqual(await readFile(join(first.directory, 'creations.sqlite')), original)
            const cached = await api.withDesktopE2eeAccount(
              (owner) => owner.host.inspectCachedState('workspace', 'synthetic-machine'),
              'workspace',
              false
            )
            assert.equal(cached.entryPresent, hasReader)
          }
        })
      }
    }
  }
})

void test('a live reader is cut at prepareDispatch after server-side access loss; stale operations keep the exact code and reader windows get a re-read hint', async (t) => {
  const room = { kind: 'meta' }
  const context = {
    protocol: 'loro-streams-crdt-payload-protection',
    version: 2,
    kind: 'update_batch'
  }
  const additionalData = new Uint8Array([4, 5, 6])
  const dispatchInput = {
    sessionId: 'session',
    userTurnId: 'turn',
    userId: 'display-only',
    timestamp: new Date(0).toISOString(),
    inputConfig: {}
  }
  for (const [reason, Loss, cut] of [
    ['member_removed', E2eeMemberRemovedError, 'prepareDispatch'],
    ['device_revoked', E2eeDeviceRevokedError, 'prepareDispatch'],
    ['member_removed', E2eeMemberRemovedError, 'contentStreamsToken'],
    ['device_revoked', E2eeDeviceRevokedError, 'contentStreamsToken'],
    ['network', null, 'prepareDispatch']
  ]) {
    await t.test(`${reason}-${cut}`, async (subtest) => {
      const { api, identity } = await nativeAccountFixture(subtest)
      const first = await createAccountWorkspace(api, 'workspace')
      const pushes = []
      const sender = Object.assign(new EventEmitter(), {
        id: 41,
        isDestroyed: () => false,
        send: (channel, payload) => pushes.push({ channel, payload: { ...payload } })
      })
      const server = { lost: false, checks: 0 }
      const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
        '../product-window-ipc-service': { ProductWindowIpcService: class {} },
        'electron-ipc-decorator': {
          IpcMethod: () => (_target, _name, descriptor) => descriptor,
          getIpcContext: () => ({ event: { sender } })
        },
        '../../platform': { isLocalPlatform: () => false },
        '../../services/e2ee-bootstrap.mjs': {},
        '../assert-sender': { assertProductWindowSender: () => {} },
        '../ipc-service-deps': {
          getIpcServiceDeps: () => ({
            authService: { getCachedSessionIdentity: () => ({ ...identity }) }
          })
        },
        '../../services/e2ee-account-runtime': {
          ...api,
          desktopE2eeCloudClient: async () => ({
            accountId: 'acc1',
            client: {
              contentStreamsToken: () => {
                server.checks += 1
                return !server.lost
                  ? Effect.succeed({ token: 'synthetic-unused-token' })
                  : Loss
                    ? Effect.fail(new Loss())
                    : Effect.fail(new Error('synthetic network failure'))
              },
              machineSharing: () => ({}),
              history: () => Effect.fail(new Error('synthetic history unavailable'))
            }
          })
        }
      })
      const ipc = new E2eeIpc()
      await ipc.open('workspace')
      // Dispatch policy needs a shared machine; only the IPC/account boundary is under test.
      await api.withDesktopE2eeAccount(
        (owner) =>
          Effect.sync(() => {
            owner.host.prepareDispatch = () =>
              Effect.sync(() => ({
                frame: 'synthetic-prepared-dispatch',
                checksSeenByPreparation: server.checks
              }))
          }),
        'workspace',
        false
      )
      const sealInput = {
        epoch: 0,
        room,
        context,
        plaintext: new TextEncoder().encode('synthetic live content'),
        additionalData
      }
      const sealed = await ipc.seal('workspace', sealInput)
      const openInput = { room, context, ...sealed, additionalData }
      assert.deepEqual(await ipc.openContent('workspace', openInput), sealInput.plaintext)
      // The credential check is already asked while the local preparation runs: the
      // renderer's dispatch fast path cannot absorb a serial server round trip.
      const checksBefore = server.checks
      assert.deepEqual(await ipc.prepareDispatch('workspace', 'synthetic-machine', dispatchInput), {
        frame: 'synthetic-prepared-dispatch',
        checksSeenByPreparation: checksBefore + 1
      })
      assert.equal(server.checks, checksBefore + 1)

      // The server accepted the removal/revocation; this live process has not learned it.
      server.lost = true
      const stale = () =>
        Promise.allSettled([
          ipc.openContent('workspace', openInput),
          ipc.seal('workspace', sealInput),
          ipc.prepareDispatch('workspace', 'synthetic-machine', dispatchInput)
        ])
      if (!Loss) {
        // An unconfirmed check establishes nothing: the reader keeps working.
        assert.deepEqual(
          (await stale()).map((result) => result.status),
          ['fulfilled', 'fulfilled', 'fulfilled']
        )
        assert.deepEqual(pushes, [])
        assert.equal((await ipc.status('workspace')).signingPublicKey, first.signingPublicKey)
        return
      }
      await assert.rejects(
        cut === 'prepareDispatch'
          ? ipc.prepareDispatch('workspace', 'synthetic-machine', dispatchInput)
          : ipc.contentStreamsToken('workspace'),
        new RegExp(`^Error: e2ee_${reason}$`)
      )
      await Promise.all([...ipc.dispatchCleanups.values()].map((slot) => slot.done))
      // Replayed stale arguments stay refused with the same exact, renderer-visible code.
      assert.deepEqual(
        (await stale()).map((result) => result.reason?.message),
        [`e2ee_${reason}`, `e2ee_${reason}`, `e2ee_${reason}`]
      )
      assert.deepEqual(pushes, [
        { channel: 'e2ee.accessLost', payload: { workspaceId: 'workspace' } }
      ])
      // The window's own re-read after the hint is classified as terminal loss.
      await assert.rejects(
        ipc.refresh('workspace', { keyMode: 'none' }),
        new RegExp(`^Error: e2ee_${reason}$`)
      )
      assert.equal(
        api.countDesktopE2eeReaders('acc1', 'workspace', sender.id),
        0,
        'the original reader is closed'
      )
    })
  }
})

// All timing is driven by TestClock; native custody and the account boundary are real.
void test('dispatch confirmation fences its reader and bounds only the waiter', async (t) => {
  for (const scenario of [
    'closed-reader',
    'account-switch',
    'reauthenticated',
    'reader-reopened',
    'renderer-replaced',
    'credential-replaced',
    'unreachable',
    'early-loss',
    'late-loss',
    'loss-during-binding-read'
  ]) {
    await t.test(scenario, async (t) => {
      const scope = await Effect.runPromise(Scope.make())
      const clock = await Effect.runPromise(Layer.buildWithScope(TestClock.layer(), scope))
      t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
      const run = (work) => Effect.runPromise(Effect.provide(work, clock))
      const { api, identity, publishIdentity } = await nativeAccountFixture(
        t,
        identityStorage,
        clock
      )
      await createAccountWorkspace(api, 'workspace')
      const asked = Promise.withResolvers()
      const answer = Promise.withResolvers()
      const prepared = Promise.withResolvers()
      t.after(() => answer.resolve(false))
      const pushed = Promise.withResolvers()
      const bindingEntered = Promise.withResolvers()
      const releaseBinding = Promise.withResolvers()
      const lossCleanupQueued = Promise.withResolvers()
      let bindingHeld = false,
        lossSent = false
      t.after(() => releaseBinding.resolve())
      const sender = Object.assign(new EventEmitter(), {
        id: 42,
        isDestroyed: () => false,
        send: (channel, payload) => pushed.resolve({ channel, payload: { ...payload } })
      })
      let activeSender = sender
      const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
        '../product-window-ipc-service': { ProductWindowIpcService: class {} },
        'electron-ipc-decorator': {
          IpcMethod: () => (_t, _n, d) => d,
          getIpcContext: () => ({ event: { sender: activeSender } })
        },
        '../../platform': { isLocalPlatform: () => false },
        '../../services/e2ee-bootstrap.mjs': {},
        '../assert-sender': { assertProductWindowSender: () => {} },
        '../ipc-service-deps': {
          getIpcServiceDeps: () => ({
            authService: { getCachedSessionIdentity: () => ({ ...identity }) }
          })
        },
        '../../services/e2ee-account-runtime': {
          ...api,
          withDesktopE2eeAccount: (...args) => {
            if (bindingHeld && lossSent) lossCleanupQueued.resolve()
            return api.withDesktopE2eeAccount(...args)
          },
          runDesktopE2eeOperation: async (...args) => {
            const value = await api.runDesktopE2eeOperation(...args)
            // Signal after the native boundary's post-operation account recheck.
            if (value?.frame === 'synthetic-frame') prepared.resolve()
            return value
          },
          desktopE2eeCloudClient: async () => ({
            accountId: 'acc1',
            client: {
              contentStreamsToken: () =>
                Effect.gen(function* () {
                  asked.resolve()
                  const lost = yield* Effect.promise(() => answer.promise)
                  if (lost) {
                    lossSent = true
                    return yield* Effect.fail(new E2eeDeviceRevokedError())
                  }
                  return { token: 'synthetic-token' }
                }),
              machineSharing: () => ({}),
              history: () => Effect.fail(new Error('unused'))
            }
          })
        }
      })
      const ipc = new E2eeIpc()
      await ipc.open('workspace')
      if (scenario === 'reader-reopened' || scenario === 'renderer-replaced') {
        activeSender = Object.assign(new EventEmitter(), {
          id: 43,
          isDestroyed: () => false,
          send: () => {}
        })
        await ipc.open('workspace')
        activeSender = sender
      }
      await api.withDesktopE2eeAccount(
        (owner) =>
          Effect.sync(() => {
            if (scenario === 'loss-during-binding-read') {
              const status = owner.host.status
              let reads = 0
              owner.host.status = (workspace) =>
                Effect.gen(function* () {
                  const value = yield* status(workspace)
                  if (++reads === 2) {
                    bindingHeld = true
                    bindingEntered.resolve()
                    yield* Effect.promise(() => releaseBinding.promise)
                    bindingHeld = false
                  }
                  return value
                })
            }
            owner.host.prepareDispatch = () =>
              Effect.sync(() => {
                return { frame: 'synthetic-frame' }
              })
          }),
        'workspace',
        false
      )
      let settled = false
      const dispatch = ipc.prepareDispatch('workspace', 'machine', {
        sessionId: 'session',
        userTurnId: 'turn',
        userId: 'acc1',
        timestamp: new Date(0).toISOString(),
        inputConfig: {}
      })
      const result = dispatch
        .then(
          (value) => ({ value }),
          (error) => ({ error })
        )
        .finally(() => {
          settled = true
        })
      await asked.promise
      await prepared.promise
      if (scenario === 'closed-reader') await ipc.close('workspace')
      if (scenario === 'reader-reopened') {
        await ipc.close('workspace')
        await ipc.open('workspace')
      }
      if (scenario === 'renderer-replaced') {
        sender.emit('render-process-gone')
        await ipc.open('workspace')
      }
      if (scenario === 'credential-replaced') {
        await api.resetDesktopE2eeIdentity({ workspaceId: 'workspace', resetId: randomUUID() })
        await createAccountWorkspace(api, 'workspace')
        await ipc.open('workspace')
      }
      if (scenario === 'account-switch' || scenario === 'reauthenticated') {
        publishIdentity(scenario === 'account-switch' ? 'acc2' : 'acc1')
        await api.closeDesktopE2eeAccount()
      }
      if (scenario === 'loss-during-binding-read') {
        await run(TestClock.adjust('50 millis'))
        await bindingEntered.promise
        answer.resolve(true)
        // Queueing terminal cleanup proves the exact verdict was latched while
        // the final account lock still holds the binding read.
        await lossCleanupQueued.promise
        await run(TestClock.adjust('50 millis'))
        const refusedBeforeDrain = settled
        releaseBinding.resolve()
        const outcome = await result
        assert.equal(refusedBeforeDrain, true, 'known loss cannot wait on a stalled final read')
        await pushed.promise
        await Promise.all([...ipc.dispatchCleanups.values()].map((slot) => slot.done))
        assert.equal(outcome.value, undefined, 'loss learned before frame handoff must discard it')
        assert.equal(outcome.error?.message, 'e2ee_device_revoked')
        await assert.rejects(ipc.status('workspace'), /^Error: e2ee_device_revoked$/)
      } else if (scenario === 'unreachable' || scenario === 'late-loss') {
        // The local frame is ready; network uncertainty must not impose its 30s timeout.
        await run(TestClock.adjust('49 millis'))
        assert.equal(settled, false)
        await run(TestClock.adjust('1 millis'))
        // Clock stays at 50ms and the credential response is still held.
        assert.deepEqual((await result).value, { frame: 'synthetic-frame' })
        assert.equal(settled, true)
        answer.resolve(scenario === 'late-loss')
        if (scenario === 'late-loss') {
          assert.deepEqual(await pushed.promise, {
            channel: 'e2ee.accessLost',
            payload: { workspaceId: 'workspace' }
          })
          await Promise.all([...ipc.dispatchCleanups.values()].map((slot) => slot.done))
          await assert.rejects(ipc.status('workspace'), /^Error: e2ee_device_revoked$/)
        }
      } else {
        answer.resolve(scenario === 'early-loss')
        const outcome = await result
        assert.equal(outcome.value, undefined)
        assert.match(
          outcome.error?.message ?? '',
          scenario === 'early-loss'
            ? /e2ee_device_revoked/
            : /e2ee_(account_mismatch|host_operation_failed|closed)/
        )
      }
      answer.resolve(false)
      await Promise.all([...ipc.dispatchCleanups.values()].map((slot) => slot.done))
    })
  }
})

void test('30ms local dispatch stays fast with an 800ms credential reply', async (t) => {
  const scope = await Effect.runPromise(Scope.make())
  const clock = await Effect.runPromise(Layer.buildWithScope(TestClock.layer(), scope))
  t.after(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const run = (work) => Effect.runPromise(Effect.provide(work, clock))
  const { api, identity } = await nativeAccountFixture(t, identityStorage, clock)
  const workspaceId = `fast-${randomUUID()}`
  await createAccountWorkspace(api, workspaceId)
  const asked = Promise.withResolvers(),
    local = Promise.withResolvers(),
    credential = Promise.withResolvers()
  const sender = Object.assign(new EventEmitter(), {
    id: 44,
    isDestroyed: () => false,
    send: () => {}
  })
  let waiterSettled = false
  const { E2eeIpc } = await load('../ipc/services/e2ee-ipc.ts', {
    '../product-window-ipc-service': { ProductWindowIpcService: class {} },
    'electron-ipc-decorator': {
      IpcMethod: () => (_t, _n, d) => d,
      getIpcContext: () => ({ event: { sender } })
    },
    '../../platform': { isLocalPlatform: () => false },
    '../../services/e2ee-bootstrap.mjs': {},
    '../assert-sender': { assertProductWindowSender: () => {} },
    '../ipc-service-deps': {
      getIpcServiceDeps: () => ({
        authService: { getCachedSessionIdentity: () => ({ ...identity }) }
      })
    },
    '../../services/e2ee-account-runtime': {
      ...api,
      runDesktopE2eeOperation: async (...args) => {
        const value = await api.runDesktopE2eeOperation(...args)
        if (value?.frameHex) local.resolve()
        else if (value === undefined) waiterSettled = true
        return value
      },
      desktopE2eeCloudClient: async () => ({
        accountId: 'acc1',
        client: {
          contentStreamsToken: () =>
            Effect.gen(function* () {
              asked.resolve()
              yield* Effect.sleep('800 millis')
              credential.resolve()
              return { token: 'synthetic-token' }
            }).pipe(Effect.provide(clock)),
          machineSharing: () => ({}),
          history: () => Effect.fail(new Error('unused'))
        }
      })
    }
  })
  const ipc = new E2eeIpc()
  await ipc.open(workspaceId)
  const original = {
    requestId: '0a'.repeat(16),
    frameHex: '0b'.repeat(300),
    targetMachineId: 'machine',
    requesterDevice: '0c'.repeat(32),
    expiresAt: 4_102_444_800_000
  }
  const input = {
    sessionId: 'session',
    userTurnId: 'turn',
    userId: 'acc1',
    timestamp: new Date(0).toISOString(),
    inputConfig: {}
  }
  const ack = {
    type: 'session/dispatch-turn_response',
    sessionId: input.sessionId,
    userTurnId: input.userTurnId,
    accepted: true,
    disposition: 'accepted'
  }
  await api.withDesktopE2eeAccount(
    (owner) =>
      Effect.sync(() => {
        owner.host.prepareDispatch = () => Effect.sleep('30 millis').pipe(Effect.as(original))
        owner.host.acceptDispatchResponse = () => Effect.succeed(ack)
      }),
    workspaceId,
    false
  )
  const [
    { createEncryptedDispatchLegacy },
    { dispatchUserTurn },
    { createConversationSession },
    { createSessionSendResources },
    { EncryptedPrepareTimeout },
    { LoroDoc }
  ] = await Promise.all([
    import('../../../../../packages/components/src/providers/encrypted-dispatch-legacy.ts'),
    import('../../../../../packages/components/src/lib/session-send-delivery.ts'),
    import('../../../../../packages/components/src/lib/conversation-view/create-conversation-session.ts'),
    import('../../../../../packages/components/src/lib/session-send-resources.ts'),
    import('../../../../../packages/components/src/lib/encrypted-dispatch-outcome.ts'),
    Promise.resolve(
      createRequire(new URL('../../../../../packages/components/package.json', import.meta.url))(
        'loro-crdt'
      )
    )
  ])
  const doc = new LoroDoc()
  const session = createConversationSession(doc, { sessionId: input.sessionId })
  const resources = createSessionSendResources({
    acquire: async () => ({
      sessionData: session.sessionData,
      getState: () => session.mirror.getState(),
      setState: session.mirror.setState.bind(session.mirror),
      waitUntilSynced: async () => {}
    }),
    releaseRef: () => {}
  })
  await session.sessionData.commands.appendTurn({
    id: input.userTurnId,
    role: 'user',
    userId: input.userId,
    timestamp: input.timestamp,
    status: 'pending',
    items: [{ type: 'text', text: 'synthetic fast dispatch' }],
    fileDiff: [],
    inputConfig: {
      cliType: 'builtin',
      agentType: 'codex',
      inputBlocks: [{ type: 'text', text: 'synthetic fast dispatch' }]
    }
  })
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const reports = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __LODY_E2E_CLIENT_LOSS__: true,
      ipc: { send: (_channel, payload) => reports.push(payload) }
    }
  })
  let onBatch,
    responseFulfilled = 0,
    late = 0,
    returnedAt
  const frames = []
  const readerReady = Promise.withResolvers()
  const dispatcher = createEncryptedDispatchLegacy({
    workspaceId,
    prepare: async (machine, input) => {
      const result = await ipc.prepareDispatch(workspaceId, machine, input)
      returnedAt = await run(Clock.currentTimeMillis)
      return result
    },
    accept: async (machine, input, frame) => {
      const result = await ipc.acceptDispatchResponse(workspaceId, machine, input, frame)
      responseFulfilled++
      return result
    },
    client: async () => ({
      ensureJsonStream: async () => {},
      readJsonLive: (_stream, _state, batch, options) => {
        onBatch = batch
        readerReady.resolve()
        return new Promise((resolve) => options.signal.addEventListener('abort', resolve))
      },
      appendJson: async (_stream, frame) => {
        await readerReady.promise
        frames.push(frame)
        onBatch({ messages: [{ id: frame.id, frame: '0d'.repeat(300) }] })
      }
    })
  })
  let meta = { id: input.sessionId, machineId: 'machine' }
  const activated = Promise.withResolvers()
  const runtime = {
    contentMode: 'e2ee',
    sendResources: resources,
    repo: { getDocMeta: async () => ({ meta }) },
    writer: {
      upsertDocMeta: async (_room, patch) => {
        meta = { ...meta, ...patch }
        activated.resolve()
      }
    },
    prepareEncryptedDispatch: async (machine, input) => {
      try {
        return await dispatcher.prepare(machine, input)
      } catch (error) {
        if (error instanceof EncryptedPrepareTimeout) late++
        throw error
      }
    }
  }
  // The native work uses TestClock; Node's mock timers drive the real renderer 200ms deadline.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let sending
  try {
    sending = dispatchUserTurn(runtime, input.sessionId, input.userTurnId)
    await asked.promise
    await run(TestClock.adjust('30 millis'))
    t.mock.timers.tick(30)
    await local.promise
    await run(TestClock.adjust('70 millis'))
    t.mock.timers.tick(70)
    // Flush the native account boundary without advancing either clock. Old 300ms
    // code has not settled its waiter; drive its real renderer fallback to RED.
    await api.withDesktopE2eeAccount(() => Effect.void, workspaceId, false)
    if (!waiterSettled) {
      await run(TestClock.adjust('100 millis'))
      t.mock.timers.tick(100)
      await activated.promise
    } else await sending
    assert.equal(late, 0, 'healthy send must not enter the renderer deadline fallback')
    assert.ok(returnedAt < 200, 'prepared frame must arrive before the renderer deadline')
    assert.equal(reports.at(-1)?.effects.turnStarts, 1)
    assert.equal(responseFulfilled, 1, 'real dispatchResponse boundary fulfilled')
    assert.equal(frames.length, 1)
    assert.equal(meta.latestUserMsgId, input.userTurnId, 'normal durable activation is retained')
    await run(TestClock.adjust('700 millis'))
    await credential.promise
    assert.equal(frames.length, 1, 'late successful confirmation never sends again')
  } finally {
    await run(TestClock.adjust('1 second'))
    await dispatcher.close()
    await sending
    t.mock.timers.reset()
    await resources.dispose()
    session.dispose()
    doc.free()
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
    else delete globalThis.window
  }
})

void test('credential-authenticated device revocation stops, drains and deletes only this device identity, and keeps its reason', async (t) => {
  const f = await personalJoinFixture(t)
  const owner = await f.open('revoked-ipc')
  await owner.create()
  const status = await owner.ipc.status(f.workspaceId)
  f.relay.deviceRevoked = true
  await assert.rejects(owner.ipc.contentStreamsToken(f.workspaceId), /^Error: e2ee_device_revoked$/)
  assert.equal(owner.readers.has(f.workspaceId), false)
  await assert.rejects(owner.ipc.status(f.workspaceId), /^Error: e2ee_device_revoked$/)
  await assert.rejects(
    owner.ipc.seal(f.workspaceId, {
      epoch: 0,
      room: { kind: 'meta' },
      context: {
        protocol: 'loro-streams-crdt-payload-protection',
        version: 2,
        kind: 'update_batch'
      },
      plaintext: new Uint8Array([1]),
      additionalData: new Uint8Array([2])
    }),
    /^Error: e2ee_device_revoked$/
  )
  assert.equal(
    f.db(
      owner,
      'creations.sqlite',
      (db) => db.prepare('SELECT count(*) AS n FROM creations').get().n
    ),
    0
  )
  await assert.rejects(readFile(join(owner.path, 'workspaces', f.workspaceId, 'history.sqlite')), {
    code: 'ENOENT'
  })
  // A later open, with a freshly constructed owner, reports the persisted reason.
  await assert.rejects(owner.ipc.open(f.workspaceId), (error) => error.code === 'device_revoked')
  assert.ok(status.signingPublicKey)
})

void test('credential-authenticated joining management uses exact-identity removal cleanup through IPC', async (t) => {
  const f = await personalJoinFixture(t)
  const actions = [
    (ipc) =>
      ipc.createMemberInvitation({
        workspaceId: f.workspaceId,
        mode: 'email',
        email: 'synthetic@example.test'
      }),
    (ipc) => ipc.memberJoinRequests(f.workspaceId),
    (ipc) => ipc.approveMemberJoin(f.workspaceId, '11'.repeat(16), 'explicit'),
    (ipc) => ipc.rejectMemberJoin(f.workspaceId, '11'.repeat(16)),
    (ipc) => ipc.revokeMemberInvitation(f.workspaceId, '22'.repeat(32))
  ]
  for (const [index, invoke] of actions.entries()) {
    const owner = await f.open(`removed-join-${index}`)
    await owner.create()
    const before = await owner.ipc.status(f.workspaceId)
    await assert.rejects(invoke(owner.ipc), /^Error: e2ee_member_removed$/)
    assert.equal(await Effect.runPromise(owner.bootstrap.hasRemovedWorkspace(f.workspaceId)), true)
    assert.equal(owner.readers.has(f.workspaceId), false)
    assert.equal(
      f.db(
        owner,
        'creations.sqlite',
        (db) => db.prepare('SELECT COUNT(*) AS count FROM workspace_bindings').get().count
      ),
      0
    )
    await assert.rejects(
      readFile(join(owner.path, 'workspaces', f.workspaceId, 'history.sqlite')),
      { code: 'ENOENT' }
    )
    assert.ok(before.signingPublicKey)
  }
})

void test('automatic removal retries the exclusive native identity lease and preserves a sibling workspace', async (t) => {
  const { api } = await nativeAccountFixture(t)
  const first = await createAccountWorkspace(api, 'removed')
  await createAccountWorkspace(api, 'sibling')
  const scope = await Effect.runPromise(Scope.make())
  await Effect.runPromise(
    identityStorage.leaseE2eeIdentity(first.directory).pipe(Scope.provide(scope))
  )
  const drain = await api.withDesktopE2eeAccount(
    (owner) =>
      Effect.gen(function* () {
        const status = yield* owner.host.status('removed')
        const credential = yield* owner.bootstrap.deviceCredential('removed')
        yield* owner.bootstrap.recordRemovedWorkspace({
          workspaceId: 'removed',
          genesisHash: status.genesisHash,
          signingPublicKey: status.signingPublicKey,
          credential
        })
        return yield* owner.host.beginCloseWorkspace('removed')
      }),
    'removed'
  )
  await Effect.runPromise(drain)
  await assert.rejects(
    api.cleanupRemovedDesktopWorkspace({ accountId: 'acc1', workspaceId: 'removed' }),
    /e2ee_identity-busy/
  )
  const original = join(
    first.directory,
    'custody',
    first.creation.genesisHashHex + '.personal.device'
  )
  assert.ok((await readFile(original)).length > 0)
  await Effect.runPromise(Scope.close(scope, Exit.void))
  assert.equal(
    await api.cleanupRemovedDesktopWorkspace({ accountId: 'acc1', workspaceId: 'removed' }),
    true
  )
  await assert.rejects(readFile(original), (error) => error.code === 'ENOENT')
  const status = await api.withDesktopE2eeAccount(
    (owner) => owner.host.status('sibling'),
    'sibling'
  )
  assert.equal(status.epoch, 0)
  await assert.rejects(
    api.withDesktopE2eeAccount((owner) => owner.host.open('removed'), 'removed'),
    /e2ee_member_removed/
  )
})

void test('slow terminal deletion fences only that workspace and never holds the account lock', async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  let hold = true
  const storage = {
    ...identityStorage,
    leaseE2eeIdentity: (directory, exclusive) =>
      Effect.gen(function* () {
        yield* identityStorage.leaseE2eeIdentity(directory, exclusive)
        if (exclusive && directory.endsWith('/removed') && hold) {
          entered.resolve()
          yield* Effect.promise(() => release.promise)
        }
      })
  }
  const { api } = await nativeAccountFixture(t, storage)
  await createAccountWorkspace(api, 'removed')
  await createAccountWorkspace(api, 'sibling')
  const drain = await api.withDesktopE2eeAccount(
    (owner) =>
      Effect.gen(function* () {
        const status = yield* owner.host.status('removed')
        const credential = yield* owner.bootstrap.deviceCredential('removed')
        yield* owner.bootstrap.recordRemovedWorkspace({
          workspaceId: 'removed',
          genesisHash: status.genesisHash,
          signingPublicKey: status.signingPublicKey,
          credential
        })
        return yield* owner.host.beginCloseWorkspace('removed')
      }),
    'removed'
  )
  await Effect.runPromise(drain)
  const removal = api.cleanupRemovedDesktopWorkspace({
    accountId: 'acc1',
    workspaceId: 'removed'
  })
  try {
    await entered.promise
    assert.equal(
      (await api.withDesktopE2eeAccount((owner) => owner.host.status('sibling'), 'sibling')).epoch,
      0
    )
    await assert.rejects(
      api.withDesktopE2eeAccount(() => Effect.void, 'removed'),
      /e2ee_member_removed/
    )
  } finally {
    hold = false
    release.resolve()
    await removal
  }
})

void test('remote commands use workspace custody and never create an account control identity', async (t) => {
  const { api, directory } = await nativeAccountFixture(t)
  const first = await createAccountWorkspace(api, 'first')
  const second = await createAccountWorkspace(api, 'second')
  const sender = Object.assign(new EventEmitter(), {
    id: 19,
    isDestroyed: () => false,
    send: () => {}
  })
  const sessions = new Map()
  const { E2eeIpc } = await load(
    '../ipc/services/e2ee-ipc.ts',
    {
      '../ipc-service-deps': { getIpcServiceDeps: () => ({}) },
      '../product-window-ipc-service': { ProductWindowIpcService: class {} },
      'electron-ipc-decorator': {
        IpcMethod: () => (_target, _name, descriptor) => descriptor,
        getIpcContext: () => ({ event: { sender } })
      },
      '../../platform': { isLocalPlatform: () => false },
      '../../services/e2ee-bootstrap.mjs': {},
      '../../services/e2ee-account-runtime': {
        ...api,
        desktopE2eeCloudClient: async () => ({
          accountId: 'acc1',
          client: {
            machineBegin: ({ workspaceId, offer }) =>
              Effect.sync(() => {
                sessions.set(workspaceId, {
                  pairingSessionId: offer.pairingSessionId,
                  status: 'pending',
                  offer
                })
                return sessions.get(workspaceId)
              }),
            machineInspect: ({ workspaceId }) => Effect.succeed(sessions.get(workspaceId)),
            machineCancel: ({ workspaceId }) =>
              Effect.sync(() => {
                const next = {
                  ...sessions.get(workspaceId),
                  status: 'cancelled',
                  noAdmissionReserved: true
                }
                sessions.set(workspaceId, next)
                return next
              })
          }
        })
      },
      '../assert-sender': { assertProductWindowSender: () => {} }
    },
    globalThis.console,
    {
      VITE_CONVEX_DEPLOY_URL: 'https://cloud.synthetic.test',
      VITE_SERVER_URL: 'https://edge.synthetic.test'
    }
  )
  const ipc = new E2eeIpc()
  const { ipcBridge } = await load('../../preload/ipc-bridge.ts', {
    electron: {
      ipcRenderer: {
        on: () => {},
        invoke: (channel, ...args) => ipc[channel.split('.')[1]](...args)
      }
    },
    './ipc-invoke-policy': { isIpcInvokeChannel, isClientLossProbeChannel: () => false },
    '@lody/shared/electron-ipc': electronIpc
  })
  for (const [workspaceId, expected] of [
    ['first', first],
    ['second', second]
  ]) {
    await ipcBridge.invoke('e2ee.open', workspaceId)
    const started = await ipcBridge.invoke('e2ee.beginRemoteMachinePairing', workspaceId)
    const offer = JSON.parse(
      Buffer.from(started.command.split(' --offer ')[1], 'base64url').toString()
    )
    assert.equal(offer.frontendSigningPublicKey, expected.signingPublicKey)
    assert.equal(offer.genesisHash, expected.creation.genesisHashHex)
    await assert.rejects(
      ipcBridge.invoke(
        'e2ee.approveRemoteMachinePairing',
        workspaceId,
        offer.pairingSessionId,
        Array(8).fill('00000000').join(' ')
      ),
      /e2ee_conflict/
    )
    assert.equal(
      (await ipcBridge.invoke('e2ee.beginRemoteMachinePairing', workspaceId)).command,
      started.command
    )
    assert.equal(
      (
        await ipcBridge.invoke(
          'e2ee.inspectRemoteMachinePairing',
          workspaceId,
          offer.pairingSessionId
        )
      ).status,
      'pending'
    )
    assert.equal(
      (
        await ipcBridge.invoke(
          'e2ee.cancelRemoteMachinePairing',
          workspaceId,
          offer.pairingSessionId
        )
      ).status,
      'cancelled'
    )
    const next = await ipcBridge.invoke('e2ee.beginRemoteMachinePairing', workspaceId)
    assert.notEqual(next.pairingSessionId, offer.pairingSessionId)
    assert.equal(
      (await ipcBridge.invoke('e2ee.status', workspaceId)).genesisHash,
      expected.creation.genesisHashHex
    )
    await ipcBridge.invoke('e2ee.close', workspaceId)
  }
  assert.notEqual(first.signingPublicKey, second.signingPublicKey)
  const roots = await readdir(join(directory, 'e2ee-bootstrap'))
  assert.ok(!(await readdir(join(directory, 'e2ee-bootstrap', roots[0]))).includes('control'))
})

void test('member invitation retains its original native namespace across a delayed cloud call', async () => {
  const f = await memberIpcFixture()
  f.holdCloud()
  const operation = f.ipc.createMemberInvitation({ workspaceId: 'team', mode: 'link' })
  const rejected = assert.rejects(operation, /e2ee_account_mismatch/)
  await f.cloudEntered.promise
  f.setOwner(f.makeOwner('A', 'replacement-A'))
  f.cloudGate.resolve()
  await rejected
  assert.deepEqual(f.signed, [])
})

for (const sameAccount of [true, false])
  void test(`late member installation cannot read or release a replacement namespace (same account: ${sameAccount})`, async () => {
    const f = await memberIpcFixture()
    const operation = f.ipc.claimMemberJoin('team', 'request')
    const rejected = assert.rejects(operation, /e2ee_account_mismatch/)
    await f.keyEntered.promise
    if (!sameAccount) {
      f.identity.userId = 'B'
      f.identity.generation++
    }
    const replacement = f.makeOwner(f.identity.userId, 'replacement')
    f.setOwner(replacement)
    f.keyGate.resolve()
    await rejected
    assert.equal(replacement.readers.get('team').get(1), 1)
    assert.deepEqual(f.closed, [])
  })

void test('a background reader closes only the namespace returned by its own open', async () => {
  const f = await memberIpcFixture()
  const opened = await f.ipc.open('team', undefined, 'A')
  const replacement = f.makeOwner('A', 'replacement')
  f.setOwner(replacement)
  await f.ipc.close('team', 'A', opened.readerOwner)
  assert.equal(replacement.readers.get('team').get(1), 1)
  assert.deepEqual(f.closed, [])
  f.identity.userId = 'B'
  f.identity.generation++
  await assert.rejects(f.ipc.open('team', undefined, 'A'), /e2ee_account_mismatch/)
})

for (const publish of [true, false])
  void test(`personal approval publishes before a blocked key round; publication succeeds: ${publish}`, async () => {
    const f = await personalApprovalFixture({ publish })
    const approval = f.ipc.approvePersonalJoin('team', f.session)
    try {
      await f.keyEntered.promise
      // The old full-refresh sequence reaches this gate before it can publish.
      assert.equal(f.publicationAttempted(), true)
      assert.equal(f.published(), publish)
      assert.deepEqual(plain(await approval), { admitted: true, invitationPublished: publish })
      assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'delivering')
      // Closing the approving window cannot abandon a committed device's delivery.
      f.owner().readers.get('team').delete(1)
      assert.deepEqual(f.closed, [])
    } finally {
      f.keyGate.resolve()
      await approval.catch(() => {})
      await f.ipc.keyDeliveryIdle('A', 'team')
    }
    assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'delivered')
    assert.deepEqual(f.closed, ['original-A'])
  })

void test('personal approval cannot publish or start delivery before ledger confirmation', async () => {
  const f = await personalApprovalFixture({ confirmed: false })
  try {
    await assert.rejects(f.ipc.approvePersonalJoin('team', f.session), /e2ee_append_unconfirmed/)
    assert.equal(f.published(), false)
    assert.equal(keyDeliveryState(f, personalApprovalRequest), null)
  } finally {
    f.keyGate.resolve()
    await f.ipc.keyDeliveryIdle('A', 'team')
  }
})

void test('a late personal invitation publication cannot restart delivery after workspace reset', async () => {
  const publication = { entered: deferredMember(), release: deferredMember() }
  const f = await personalApprovalFixture({ publication })
  const approval = f.ipc.approvePersonalJoin('team', f.session)
  let delivery
  try {
    await publication.entered.promise
    await f.keyEntered.promise
    delivery = f.ipc.keyDeliveryIdle('A', 'team')
    await f.ipc
      .resetIdentity({ workspaceId: 'team', resetId: randomUUID(), confirm: true })
      .catch(() => {})
    f.keyGate.resolve()
    await delivery
    publication.release.resolve()
    await assert.rejects(approval, /e2ee_account_mismatch/)
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
  } finally {
    f.keyGate.resolve()
    publication.release.resolve()
    await approval.catch(() => {})
    await delivery
  }
})

for (const change of [
  'workspace-reset',
  'account-reset',
  'same-account-login',
  'signed-out',
  'different-account',
  'same-account-owner'
])
  void test(`pending personal invitation is invalidated by ${change} before delivery registration`, async () => {
    const invitationGate = { entered: deferredMember(), release: deferredMember() }
    const f = await personalApprovalFixture({ invitationGate })
    const approval = f.ipc.approvePersonalJoin('team', f.session)
    const outcome = approval.then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    try {
      await invitationGate.entered.promise
      if (change.endsWith('reset')) {
        await f.ipc
          .resetIdentity({
            ...(change === 'workspace-reset' ? { workspaceId: 'team' } : {}),
            resetId: randomUUID(),
            confirm: true
          })
          .catch(() => {})
      } else if (change === 'same-account-owner') {
        f.setOwner(f.makeOwner('A', 'replacement-A'))
      } else {
        f.identity.userId = undefined
        f.identity.generation += 1
        f.identity.userId =
          change === 'signed-out' ? undefined : change === 'different-account' ? 'B' : 'A'
        f.identity.generation += 1
      }
      invitationGate.release.resolve()
      const result = await outcome
      assert.ok(result.error, 'the old approval cannot authorize work under a later identity')
      assert.equal(f.published(), false)
      assert.equal(f.committed(), true)
      assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
      assert.equal(f.ipc.personalApprovals.size, 0)
    } finally {
      invitationGate.release.resolve()
      f.keyGate.resolve()
      await outcome
      await f.ipc.keyDeliveryIdle('A', 'team')
    }
  })

for (const resetScope of ['workspace', 'account'])
  void test(`${resetScope} reset fences the correct concurrent personal approvals`, async () => {
    const team = { entered: deferredMember(), release: deferredMember() }
    const other = { entered: deferredMember(), release: deferredMember() }
    const f = await personalApprovalFixture({
      invitationGates: new Map([
        ['team', team],
        ['other', other]
      ])
    })
    f.owner().readers.set('other', new Map([[1, 1]]))
    const first = f.ipc.approvePersonalJoin('team', f.session).then(
      (value) => ({ value }),
      (error) => ({ error })
    )
    let second
    try {
      await team.entered.promise
      second = f.ipc.approvePersonalJoin('other', f.session).then(
        (value) => ({ value }),
        (error) => ({ error })
      )
      await other.entered.promise
      await f.ipc
        .resetIdentity({
          ...(resetScope === 'workspace' ? { workspaceId: 'team' } : {}),
          resetId: randomUUID(),
          confirm: true
        })
        .catch(() => {})
      other.release.resolve()
      const result = await second
      team.release.resolve()
      assert.ok((await first).error)
      assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
      if (resetScope === 'account') {
        assert.ok(result.error)
        assert.equal(f.ipc.keyDelivery.slots.has('A\nother'), false)
      } else {
        assert.deepEqual(plain(result.value), { admitted: true, invitationPublished: true })
        await f.keyEntered.promise
        f.keyGate.resolve()
        await f.ipc.keyDeliveryIdle('A', 'other')
        assert.equal(
          f.ipc.keyDelivery.slots.get('A\nother').requests.get(personalApprovalRequest).state,
          'delivered'
        )
      }
      assert.equal(f.ipc.personalApprovals.size, 0)
    } finally {
      team.release.resolve()
      other.release.resolve()
      f.keyGate.resolve()
      await first
      await second
      await f.ipc.keyDeliveryIdle('A', 'other')
    }
  })

void test('a control-only personal approver receives its missing current key before distributing without blocking admission', async () => {
  const local = { hasCurrentKey: false }
  const received = deferredMember(),
    release = deferredMember()
  let receiving = false
  const f = await personalApprovalFixture({
    local,
    receive: () =>
      Effect.promise(async () => {
        receiving = true
        received.resolve()
        await release.promise
        local.hasCurrentKey = true
      }),
    distribution: () => Effect.sync(() => assert.equal(local.hasCurrentKey, true))
  })
  try {
    assert.deepEqual(plain(await f.ipc.approvePersonalJoin('team', f.session)), {
      admitted: true,
      invitationPublished: true
    })
    await Promise.race([received.promise, f.ipc.keyDeliveryIdle('A', 'team')])
    assert.equal(receiving, true)
    assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'delivering')
  } finally {
    release.resolve()
    await f.ipc.keyDeliveryIdle('A', 'team')
  }
  assert.equal(local.hasCurrentKey, true)
  assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'delivered')
})

void test('personal key failures keep admission, exhaust bounded backoff, and accept the original personal-device retry id', async () => {
  const local = { hasCurrentKey: false }
  let outage = true,
    now = 1_800_000_000_000
  const f = await personalApprovalFixture({
    local,
    receive: () =>
      Effect.suspend(() => {
        if (outage) return Effect.fail(new Error('e2ee_management_retry'))
        local.hasCurrentKey = true
        return Effect.void
      }),
    distribution: () => Effect.sync(() => assert.equal(local.hasCurrentKey, true))
  })
  const clock = fakeKeyDeliveryTimers()
  f.ipc.keyDeliveryTimers = clock.timers
  f.ipc.keyDeliveryNow = () => now
  assert.deepEqual(plain(await f.ipc.approvePersonalJoin('team', f.session)), {
    admitted: true,
    invitationPublished: true
  })
  for (let retry = 0; retry <= 8; retry++) {
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'failed')
    assert.equal(f.committed(), true)
    if (retry === 8) {
      assert.deepEqual(clock.pending, [])
      break
    }
    const timer = clock.pending.shift()
    assert.equal(timer.ms, KEY_DELIVERY_RETRY_DELAYS[retry])
    now += timer.ms
    timer.run()
  }
  outage = false
  const retried = plain(await f.ipc.retryMemberKeyDelivery('team', personalApprovalRequest))
  assert.equal(retried.requestId, personalApprovalRequest)
  await f.ipc.keyDeliveryIdle('A', 'team')
  assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'delivered')
  assert.equal(local.hasCurrentKey, true)
  assert.deepEqual(clock.pending, [])
})

for (const Terminal of [E2eeDeviceRevokedError, E2eeMemberRemovedError])
  void test(`personal delivery ends without retry when local key receipt reports ${Terminal.name}`, async () => {
    const f = await personalApprovalFixture({
      local: { hasCurrentKey: false },
      receive: () => Effect.fail(new Terminal()),
      distribution: () => Effect.die(new Error('must not distribute after terminal access loss'))
    })
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    assert.deepEqual(plain(await f.ipc.approvePersonalJoin('team', f.session)), {
      admitted: true,
      invitationPublished: true
    })
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
    assert.equal(f.committed(), true)
    assert.deepEqual(clock.pending, [])
  })

void test('main retries a personal delivery after an outage and installs the local key without a page or poll', async () => {
  const local = { hasCurrentKey: false }
  let outage = true
  const f = await personalApprovalFixture({
    local,
    receive: () =>
      Effect.suspend(() => {
        if (outage) return Effect.fail(new Error('e2ee_management_retry'))
        local.hasCurrentKey = true
        return Effect.void
      }),
    distribution: () => Effect.sync(() => assert.equal(local.hasCurrentKey, true))
  })
  const clock = fakeKeyDeliveryTimers()
  f.ipc.keyDeliveryTimers = clock.timers
  f.ipc.keyDeliveryNow = () => 1_800_000_000_000
  await f.ipc.approvePersonalJoin('team', f.session)
  await f.ipc.keyDeliveryIdle('A', 'team')
  assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'failed')
  outage = false
  clock.pending.shift().run()
  await f.ipc.keyDeliveryIdle('A', 'team')
  assert.equal(keyDeliveryState(f, personalApprovalRequest).state, 'delivered')
  assert.equal(local.hasCurrentKey, true)
  assert.deepEqual(clock.pending, [])
})

for (const outage of [false, true])
  void test(`an account approval's first key delivery pass ends after the first attempt, before any backoff; outage: ${outage}`, async () => {
    // The approval publishes once this pass ends, so a new device woken by that publish
    // finds its key at once; a retryable failure must not hold it for the backoff timer.
    const local = { hasCurrentKey: !outage }
    const f = await personalApprovalFixture({
      local,
      receive: () => Effect.fail(new Error('e2ee_management_retry')),
      distribution: () => Effect.void
    })
    const clock = fakeKeyDeliveryTimers()
    f.ipc.keyDeliveryTimers = clock.timers
    f.ipc.keyDeliveryNow = () => 1_800_000_000_000
    await f.ipc.approvePersonalJoin('team', f.session)
    await Effect.runPromise(f.ipc.keyDelivery.firstPass('A', 'team', personalApprovalRequest))
    assert.equal(
      keyDeliveryState(f, personalApprovalRequest).state,
      outage ? 'failed' : 'delivered'
    )
    assert.equal(clock.pending.length, outage ? 1 : 0)
    // The main-owned reader is released as soon as the attempt ends.
    await f.ipc.keyDeliveryIdle('A', 'team')
    assert.equal(f.owner().readers.get('team')?.has(KEY_DELIVERY_READER) ?? false, false)
  })

void test("removing a workspace ends its account approval's first key delivery pass mid-round and still releases main's reader", async () => {
  const f = await personalApprovalFixture()
  const approval = f.ipc.approvePersonalJoin('team', f.session)
  let settled = false
  let delivery
  try {
    await f.keyEntered.promise
    delivery = f.ipc.keyDeliveryIdle('A', 'team')
    void Effect.runPromise(f.ipc.keyDelivery.firstPass('A', 'team', personalApprovalRequest)).then(
      () => (settled = true)
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    assert.equal(f.owner().readers.get('team')?.get(KEY_DELIVERY_READER), 1)
    f.ipc.keyDelivery.dropWorkspace('team', 'A')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, true)
  } finally {
    f.keyGate.resolve()
    await approval.catch(() => {})
    await delivery
  }
  assert.equal(f.owner().readers.get('team')?.has(KEY_DELIVERY_READER) ?? false, false)
})

void test('personal approval reconciles an unknown append result and retries publication with the same admission original', async () => {
  const f = await personalApprovalFixture({ appendReceiptLost: true, publish: false })
  try {
    const expected = { admitted: true, invitationPublished: false }
    assert.deepEqual(plain(await f.ipc.approvePersonalJoin('team', f.session)), expected)
    assert.deepEqual(plain(await f.ipc.approvePersonalJoin('team', f.session)), expected)
    assert.equal(f.committed(), true)
    assert.deepEqual(
      [...f.writes],
      [[personalApprovalRequest, { requestId: personalApprovalRequest, recordHex: 'ab' }]]
    )
  } finally {
    f.keyGate.resolve()
    await f.ipc.keyDeliveryIdle('A', 'team')
  }
})

void test('reset while native admission preparation is pending prevents any later cloud append', async () => {
  const prepareGate = { entered: deferredMember(), release: deferredMember() }
  const f = await personalApprovalFixture({ prepareGate })
  const approval = f.ipc.approvePersonalJoin('team', f.session)
  const outcome = approval.then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  try {
    await prepareGate.entered.promise
    await f.ipc
      .resetIdentity({ workspaceId: 'team', resetId: randomUUID(), confirm: true })
      .catch(() => {})
    prepareGate.release.resolve()
    assert.ok((await outcome).error)
    assert.equal(f.committed(), false)
    assert.equal(f.writes.size, 0)
    assert.equal(f.published(), false)
    assert.equal(f.ipc.keyDelivery.slots.has('A\nteam'), false)
  } finally {
    prepareGate.release.resolve()
    f.keyGate.resolve()
    await outcome
    await f.ipc.keyDeliveryIdle('A', 'team')
  }
})
