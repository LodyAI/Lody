import assert from 'node:assert/strict'
import test from 'node:test'
import { Effect, Fiber, Result, Scope, Exit } from 'effect'
import { TestClock } from 'effect/testing'
import { makeE2eeCloudClient } from './e2ee-cloud-client.mts'

const access = { workspaceId: 'workspace', credential: 'synthetic-device-credential' }
const target = { genesis: '11'.repeat(32), epoch: 0, recipient: '22'.repeat(32) }
const sender = '33'.repeat(32)
const token = async () => ({ data: { token: 'synthetic-auth-jwt' } })
const response = (value) => Response.json({ status: 'success', value })
const build = (fetch, overrides = {}) =>
  makeE2eeCloudClient({
    platformKind: 'cloud',
    deploymentUrl: 'https://synthetic.convex.cloud',
    convexToken: token,
    fetch,
    ...overrides
  })

void test('uses only explicit E2EE endpoints and preserves immutable frame/report/append bytes', async () => {
  const originals = new Map()
  let report = null
  let repaired = null
  let append = null
  const fetch = async (_url, init) => {
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer synthetic-auth-jwt')
    const {
      path,
      args: [args]
    } = JSON.parse(init.body)
    assert.equal(args.workspaceId, access.workspaceId)
    if (path.startsWith('e2eeMailbox:')) assert.equal(args.credential, access.credential)
    switch (path) {
      case 'e2eeMailbox:put':
        originals.set(args.id, args.frameHex)
        return response(null)
      case 'e2eeMailbox:read':
        return response(originals.get(args.id) ?? null)
      case 'e2eeMailbox:fetch':
        return response({
          items: [...originals.values()].map((frameHex) => ({ sender, frameHex })),
          next: null
        })
      case 'e2eeMailbox:status':
        return response({ ...target, revision: 2, status: 'EnvelopeStored' })
      case 'e2eeMailbox:report':
        report = args
        return response(null)
      case 'e2eeMailbox:repair':
        repaired = args
        return response(null)
      case 'e2eeWorkspaces:appendRecord':
        append = args
        return response({ status: 'committed', recordHash: '44'.repeat(32) })
      case 'e2eeWorkspaces:history':
        return response({
          workspaceId: 'workspace',
          genesisHash: target.genesis,
          checkpoint: { headHash: target.genesis, length: 1 },
          startIndex: 1,
          recordsHex: [],
          position: 'p1:workspace:1:original',
          nextCursor: null
        })
      case 'e2eeContent:contentStreamsToken':
        return response({
          token: 'synthetic-content',
          bucketId: 'e2ee',
          gatewayBaseUrl: 'https://synthetic.invalid',
          expiresIn: 900,
          expiresAt: 900_000
        })
      default:
        throw new Error(`Unapproved endpoint ${path}`)
    }
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* build(fetch)
        const mailbox = client.mailbox(access)
        const input = new Uint8Array([1, 2, 3, 255])
        const store = mailbox.put('delivery-id', input)
        input.fill(0)
        yield* store
        assert.deepEqual(yield* mailbox.read('delivery-id'), new Uint8Array([1, 2, 3, 255]))
        assert.equal(yield* mailbox.read('missing'), null)
        assert.deepEqual((yield* mailbox.fetch(0, null, 100)).items, [
          { sender, frame: new Uint8Array([1, 2, 3, 255]) }
        ])
        assert.deepEqual(yield* mailbox.status(target), {
          ...target,
          revision: 2,
          status: 'EnvelopeStored'
        })
        yield* mailbox.report(new Uint8Array([4, 5]), new Uint8Array([6, 7]))
        assert.deepEqual(report, { ...access, reportHex: '0405', publicationHex: '0607' })
        yield* mailbox.repair(target, 'repair-id', '55'.repeat(32))
        assert.deepEqual(repaired, {
          ...access,
          slot: target,
          id: 'repair-id',
          rejectedDigest: '55'.repeat(32)
        })
        const request = {
          workspaceId: 'workspace',
          requestId: 'stable-request',
          recordHex: 'aabb',
          credentialHash: '66'.repeat(32)
        }
        const pending = client.appendRecord(request)
        request.recordHex = 'ffff'
        assert.equal((yield* pending).status, 'committed')
        assert.equal(append.recordHex, 'aabb')
        assert.equal(
          (yield* client.history({ workspaceId: 'workspace', after: 'original' })).position,
          'p1:workspace:1:original'
        )
        assert.equal((yield* client.contentStreamsToken(access)).bucketId, 'e2ee')
      })
    )
  )
})

void test('a lost mutation acknowledgement preserves exact retry bytes and does not fence the next request', async () => {
  let original = null
  let loseAck = true
  const fetch = async (_url, init) => {
    const {
      args: [args]
    } = JSON.parse(init.body)
    if (original !== null && args.frameHex !== original)
      return Response.json(
        {
          status: 'error',
          errorMessage: 'synthetic-private-cause',
          errorData: { code: 'e2ee_mailbox_conflict' }
        },
        { status: 560 }
      )
    original = args.frameHex
    if (loseAck) {
      loseAck = false
      throw new Error('synthetic-private-cause')
    }
    return response(null)
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const mailbox = (yield* build(fetch)).mailbox(access)
        const failed = yield* Effect.result(mailbox.put('same-id', new Uint8Array([1, 2])))
        assert.ok(Result.isFailure(failed))
        assert.equal(failed.failure.reason, 'unavailable')
        assert.equal(JSON.stringify(failed.failure).includes('synthetic-private-cause'), false)
        yield* mailbox.put('same-id', new Uint8Array([1, 2]))
        assert.equal(original, '0102')
        const conflicting = yield* Effect.result(mailbox.put('same-id', new Uint8Array([3])))
        assert.equal(conflicting.failure.reason, 'conflict')
      })
    )
  )
})

void test('rejects malformed response bytes and a status for a different slot', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* build(async (_url, init) => {
          const { path } = JSON.parse(init.body)
          return response(
            path.endsWith(':read')
              ? '0ff'
              : { ...target, recipient: '77'.repeat(32), revision: 0, status: 'NeedsEnvelope' }
          )
        })
        const mailbox = client.mailbox(access)
        assert.equal((yield* Effect.result(mailbox.read('id'))).failure.reason, 'invalid-response')
        assert.equal(
          (yield* Effect.result(mailbox.status(target))).failure.reason,
          'invalid-response'
        )
      })
    )
  )
})

void test('closing aborts active HTTP and refuses later requests while late auth never starts HTTP', async () => {
  const started = Promise.withResolvers()
  let aborted = false
  const scope = await Effect.runPromise(Scope.make())
  const client = await Effect.runPromise(
    build(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          started.resolve()
          init.signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('aborted-secret'))
            },
            { once: true }
          )
        })
    ).pipe(Scope.provide(scope))
  )
  const request = Effect.runPromise(Effect.result(client.mailbox(access).status(target)))
  await started.promise
  await Effect.runPromise(Scope.close(scope, Exit.void))
  assert.equal((await request).failure.reason, 'unavailable')
  assert.equal(aborted, true)
  assert.equal(
    (await Effect.runPromise(Effect.result(client.mailbox(access).status(target)))).failure.reason,
    'unavailable'
  )

  const authStarted = Promise.withResolvers(),
    auth = Promise.withResolvers()
  const secondScope = await Effect.runPromise(Scope.make())
  const late = await Effect.runPromise(
    build(
      () => {
        throw new Error('closed owner must never send HTTP')
      },
      {
        convexToken: () => {
          authStarted.resolve()
          return auth.promise
        }
      }
    ).pipe(Scope.provide(secondScope))
  )
  const waiting = Effect.runPromise(Effect.result(late.mailbox(access).status(target)))
  await authStarted.promise
  await Effect.runPromise(Scope.close(secondScope, Exit.void))
  auth.resolve({ data: { token: 'late-token' } })
  assert.equal((await waiting).failure.reason, 'unavailable')
})

void test('a request deadline aborts HTTP without making later calls unavailable', async () => {
  const started = Promise.withResolvers()
  let stalled = true,
    aborted = false
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* build(async (_url, init) => {
          if (!stalled) return response({ ...target, revision: 0, status: 'NeedsEnvelope' })
          return new Promise((_resolve, reject) => {
            started.resolve()
            init.signal.addEventListener(
              'abort',
              () => {
                aborted = true
                reject(new Error('aborted'))
              },
              { once: true }
            )
          })
        })
        const waiting = yield* Effect.forkChild(
          Effect.result(client.mailbox(access).status(target))
        )
        yield* Effect.promise(() => started.promise)
        yield* TestClock.adjust('30 seconds')
        assert.equal((yield* Fiber.join(waiting)).failure.reason, 'unavailable')
        assert.equal(aborted, true)
        stalled = false
        assert.equal((yield* client.mailbox(access).status(target)).status, 'NeedsEnvelope')
      })
    ).pipe(Effect.provide(TestClock.layer()))
  )
})

void test('local composition never obtains a token or opens cloud HTTP', async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.result(
        build(
          () => {
            throw new Error('local cloud HTTP')
          },
          {
            platformKind: 'local',
            convexToken: () => {
              throw new Error('local cloud auth')
            }
          }
        )
      )
    )
  )
  assert.ok(Result.isFailure(result))
  assert.equal(result.failure.reason, 'unauthorized')
})

void test('closing one workspace aborts its mailbox without retiring another workspace client', async () => {
  const entered = Promise.withResolvers()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* build(async (_url, init) => {
          const input = JSON.parse(init.body).args[0]
          if (input.workspaceId === 'workspace')
            return new Promise((_resolve, reject) => {
              entered.resolve()
              init.signal.addEventListener(
                'abort',
                () => reject(new Error('synthetic aborted request')),
                { once: true }
              )
            })
          return response({ ...target, revision: 0, status: 'NeedsEnvelope' })
        })
        const workspace = new AbortController()
        const held = Effect.runPromise(
          Effect.result(client.mailbox(access, workspace.signal).status(target))
        )
        yield* Effect.promise(() => entered.promise)
        workspace.abort()
        assert.equal((yield* Effect.promise(() => held)).failure.reason, 'unavailable')
        assert.equal(
          (yield* client.mailbox({ ...access, workspaceId: 'another-workspace' }).status(target))
            .status,
          'NeedsEnvelope'
        )
      })
    )
  )
})
