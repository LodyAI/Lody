import { E2eeDeviceRevokedError, E2eeMemberRemovedError } from './e2ee-cloud-errors.mts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { Bytes, encodeCbor, hashRecordBytes, recordSigningBytes } from '@lody/e2ee-core/protocol'
import { encodeEpochStagedGroup } from '@lody/e2ee-core/host'
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

// Synthetic signed originals; core's rotation suite verifies HPKE and authority.
function stagedGroup() {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, 17)
    ]),
    format: 'der',
    type: 'pkcs8'
  })
  const signer = new Uint8Array(
    createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
  )
  const genesis = '11'.repeat(32),
    commitment = '44'.repeat(32)
  const body = [
    new Uint8Array(32).fill(2),
    signer,
    [7, 1, new Uint8Array(32).fill(0x44), new Uint8Array(72).fill(5)]
  ]
  const record = Result.getOrThrow(
    encodeCbor([
      body,
      new Uint8Array(
        sign(null, recordSigningBytes(Result.getOrThrow(encodeCbor(body))), privateKey)
      )
    ])
  )
  const aad = Result.getOrThrow(encodeCbor([new Uint8Array(32).fill(0x11), 1, signer, signer]))
  const envelope = Buffer.concat([aad, Buffer.alloc(80, 6)])
  const frame = new Uint8Array(
    Buffer.concat([
      envelope,
      sign(null, Buffer.concat([Buffer.from('lody-e2ee/epoch-env/v1\0'), envelope]), privateKey)
    ])
  )
  return {
    genesis,
    epoch: 1,
    commitment,
    recordHash: Buffer.from(hashRecordBytes(record).toBytes()).toString('hex'),
    record,
    envelopes: [{ recipient: Buffer.from(signer).toString('hex'), frame }]
  }
}

void test('staging owns originals across lost acknowledgements and paged cleanup, then recovers on the next call', async () => {
  const group = stagedGroup(),
    expected = encodeEpochStagedGroup(group)
  const credential = { ...access }
  let stored = null,
    stageLost = true,
    deletePending = true
  const deletes = []
  const fetch = async (_url, init) => {
    const {
      path,
      args: [args]
    } = JSON.parse(init.body)
    assert.equal(args.credential, access.credential)
    assert.equal(args.workspaceId, access.workspaceId)
    assert.equal('proof' in args, false)
    switch (path) {
      case 'e2eeEpochStaging:stageGroup':
        assert.deepEqual(args.group, expected)
        stored = args.group
        if (stageLost) {
          stageLost = false
          throw new Error('synthetic lost ack')
        }
        return response({ ok: true })
      case 'e2eeEpochStaging:readGroup':
        return response(stored)
      case 'e2eeEpochStaging:deleteGroup':
        deletes.push(args)
        if (deletePending) {
          deletePending = false
          return response({ ok: true, done: false })
        }
        stored = null
        return response({ ok: true, done: true })
      default:
        throw new Error(`unexpected endpoint ${path}`)
    }
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const staging = (yield* build(fetch)).staging(credential)
        const stage = staging.stageGroup(group)
        credential.credential = 'replaced'
        group.record.fill(0)
        group.envelopes[0].frame.fill(0)
        assert.equal((yield* Effect.result(stage)).failure.reason, 'unavailable')
        assert.deepEqual(encodeEpochStagedGroup(yield* staging.readGroup(expected)), expected)
        yield* stage
        const occupied = { epoch: 1, commitment: '55'.repeat(32) }
        const cleanup = staging.deleteGroup(expected, occupied)
        occupied.commitment = '66'.repeat(32)
        assert.equal((yield* Effect.result(cleanup)).failure.reason, 'unavailable')
        assert.equal(deletes.length, 1)
        assert.deepEqual(encodeEpochStagedGroup(yield* staging.readGroup(expected)), expected)
        yield* cleanup
        assert.deepEqual(deletes[0], deletes[1])
        assert.equal(yield* staging.readGroup(expected), null)
      })
    )
  )
})

void test('staging rejects another locator and malformed groups without poisoning later reads', async () => {
  const group = stagedGroup(),
    dto = encodeEpochStagedGroup(group)
  let reply = { ...dto, genesis: '99'.repeat(32) }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const staging = (yield* build(async () => response(reply))).staging(access)
        const read = staging.readGroup(dto)
        assert.equal((yield* Effect.result(read)).failure.reason, 'invalid-response')
        reply = { ...dto, recordHash: '00'.repeat(32) }
        assert.equal((yield* Effect.result(read)).failure.reason, 'invalid-response')
        reply = dto
        assert.deepEqual(encodeEpochStagedGroup(yield* read), dto)
        assert.equal(
          (yield* Effect.result(
            staging.stageGroup({ ...group, envelopes: [...group.envelopes, ...group.envelopes] })
          )).failure.reason,
          'invalid-response'
        )
        assert.deepEqual(encodeEpochStagedGroup(yield* read), dto)
      })
    )
  )
})

for (const code of ['e2ee_staging_invalid', 'e2ee_staging_corrupt']) {
  void test(`staging treats ${code} as terminal and keeps the next valid call usable`, async () => {
    const group = stagedGroup(),
      dto = encodeEpochStagedGroup(group)
    let fail = true
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const staging = (yield* build(async () =>
            fail
              ? Response.json(
                  {
                    status: 'error',
                    errorMessage: 'synthetic-private-cause',
                    errorData: { code }
                  },
                  { status: 560 }
                )
              : response(dto)
          )).staging(access)
          for (const operation of [
            staging.stageGroup(group),
            staging.readGroup(dto),
            staging.deleteGroup(dto, { epoch: dto.epoch, commitment: '55'.repeat(32) })
          ]) {
            const result = yield* Effect.result(operation)
            assert.equal(result._tag, 'Failure')
            assert.equal(result.failure.reason, 'invalid-response')
            assert.equal(JSON.stringify(result.failure).includes('synthetic-private-cause'), false)
          }
          fail = false
          assert.deepEqual(encodeEpochStagedGroup(yield* staging.readGroup(dto)), dto)
        })
      )
    )
  })
}

void test('staging cancellation rejects a late response and isolates other workspaces', async () => {
  const dto = encodeEpochStagedGroup(stagedGroup())
  const entered = Promise.withResolvers(),
    late = Promise.withResolvers()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* build(async (_url, init) => {
          const args = JSON.parse(init.body).args[0]
          if (args.workspaceId !== access.workspaceId) return response(dto)
          entered.resolve()
          return late.promise
        })
        const controller = new AbortController()
        const staging = client.staging(access, controller.signal)
        const pending = Effect.runPromise(Effect.result(staging.readGroup(dto)))
        yield* Effect.promise(() => entered.promise)
        controller.abort()
        late.resolve(response(dto))
        assert.equal((yield* Effect.promise(() => pending)).failure.reason, 'unavailable')
        assert.deepEqual(
          encodeEpochStagedGroup(
            yield* client.staging({ ...access, workspaceId: 'other' }).readGroup(dto)
          ),
          dto
        )
        assert.equal((yield* Effect.result(staging.readGroup(dto))).failure.reason, 'unavailable')
      })
    )
  )
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

void test('personal join keeps exact originals across lost acknowledgements and accepts the supported invitation size', async () => {
  const join = {
    workspaceId: 'workspace',
    pairingSessionId: 'aa'.repeat(16),
    genesisHash: target.genesis,
    signingPublicKey: sender,
    credentialHash: 'bb'.repeat(32),
    requestHex: 'aabb'
  }
  const session = { ...join, accountId: 'account', status: 'pending' }
  let saved = null
  let loseAck = true
  const invitationHex = 'ab'.repeat(3 * 1024 * 1024)
  const fetch = async (_url, init) => {
    const {
      path,
      args: [args]
    } = JSON.parse(init.body)
    if (path === 'e2eeJoinMailbox:begin') {
      assert.equal(args.requestHex, 'aabb')
      if (saved) assert.deepEqual(args, saved)
      saved = args
      if (loseAck) {
        loseAck = false
        throw new Error('synthetic-private-pairing-cause')
      }
      return response(session)
    }
    if (path === 'e2eeJoinMailbox:claim')
      return response({ ...session, status: 'published', publisher: sender, invitationHex })
    throw new Error('unapproved endpoint')
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* build(fetch)
        const pending = client.joinBegin(join)
        join.requestHex = 'ffff'
        assert.ok(Result.isFailure(yield* Effect.result(pending)))
        assert.equal((yield* pending).requestHex, 'aabb')
        assert.equal(
          (yield* client.joinClaim({
            workspaceId: join.workspaceId,
            pairingSessionId: join.pairingSessionId
          })).invitationHex,
          invitationHex
        )
      })
    )
  )
})

void test('management ledger transport preserves the original record and refuses a mismatched observed CAS checkpoint', async () => {
  const group = stagedGroup(),
    original = Buffer.from(group.record).toString('hex')
  let stored = null
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* build(async (_url, init) => {
          const {
            path,
            args: [args]
          } = JSON.parse(init.body)
          if (path === 'e2eeWorkspaces:history')
            return response({
              workspaceId: access.workspaceId,
              genesisHash: group.genesis,
              checkpoint: { length: 1, headHash: '02'.repeat(32) },
              startIndex: 0,
              recordsHex: ['01'],
              position: 'synthetic-source-position',
              nextCursor: null
            })
          assert.equal(path, 'e2eeWorkspaces:appendRecord')
          assert.equal(args.recordHex, original)
          assert.equal(args.requestId, group.recordHash)
          stored = args.recordHex
          return response({ status: 'committed', recordHash: group.recordHash })
        })
        const anchor = Result.getOrThrow(Bytes.genesisHash(Buffer.from(group.genesis, 'hex')))
        const log = client.ledgerLog(access.workspaceId)
        const read = yield* log.read(anchor)
        const refused = yield* Effect.result(
          log.appendCas(anchor, { ...read.checkpoint, length: 2 }, group.record)
        )
        assert.equal(Result.isFailure(refused), true)
        assert.equal(stored, null)
        const mutable = group.record.slice()
        const append = log.appendCas(anchor, read.checkpoint, mutable)
        mutable.fill(0)
        yield* append
        assert.equal(stored, original)
      })
    )
  )
})

void test('management ledger transport reuses the cached position for delta reads', async () => {
  const group = stagedGroup()
  const historyCalls = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* build(async (_url, init) => {
          const {
            path,
            args: [args]
          } = JSON.parse(init.body)
          assert.equal(path, 'e2eeWorkspaces:history')
          historyCalls.push(args)
          if (args.after === 'p1:w:1:first') {
            return response({
              workspaceId: access.workspaceId,
              genesisHash: group.genesis,
              checkpoint: { length: 2, headHash: '03'.repeat(32) },
              startIndex: 1,
              recordsHex: ['02'],
              position: 'p1:w:2:second',
              nextCursor: null
            })
          }
          return response({
            workspaceId: access.workspaceId,
            genesisHash: group.genesis,
            checkpoint: { length: 1, headHash: '02'.repeat(32) },
            startIndex: 0,
            recordsHex: ['01'],
            position: 'p1:w:1:first',
            nextCursor: null
          })
        })
        const anchor = Result.getOrThrow(Bytes.genesisHash(Buffer.from(group.genesis, 'hex')))
        const log = client.ledgerLog(access.workspaceId)
        const first = yield* log.read(anchor)
        assert.equal(first.records.length, 1)
        const second = yield* log.read(anchor)
        assert.equal(second.records.length, 2)
        assert.deepEqual(
          second.records.map((r) => Buffer.from(r).toString('hex')),
          ['01', '02']
        )
        assert.deepEqual(historyCalls, [
          { workspaceId: access.workspaceId },
          { workspaceId: access.workspaceId, after: 'p1:w:1:first' }
        ])
      })
    )
  )
})

void test('the relay copy of a member invitation reaches the approving host intact for verification', async () => {
  // Automatic email admission verifies this copy itself; dropping it here would silently
  // turn every genuine email invitation into an explicit approval.
  const offer = {
    version: 1,
    workspaceId: access.workspaceId,
    genesisHash: '11'.repeat(32),
    genesisRecordHex: 'abcd',
    endorser: '22'.repeat(32),
    token: '33'.repeat(32),
    mode: 'email',
    expiresAt: 9_000_000_000_000,
    signature: '44'.repeat(64)
  }
  const reply = {
    id: 'synthetic-request',
    workspaceId: access.workspaceId,
    accountId: 'synthetic-account',
    keyPackageHex: 'abcd',
    signingPublicKey: '55'.repeat(32),
    requestId: '66'.repeat(16),
    source: 'email',
    state: 'pending',
    expiresAt: 9_000_000_000_000,
    offer
  }
  const read = await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        build(async () => response(reply)),
        (client) => client.memberRead({ ...access, requestId: reply.requestId })
      )
    )
  )
  assert.deepEqual(read.offer, offer)
})

void test('the member list stays usable when it holds an unsigned or unreadable invitation', async () => {
  const offer = {
    version: 1,
    workspaceId: access.workspaceId,
    genesisHash: '11'.repeat(32),
    genesisRecordHex: 'abcd',
    endorser: '22'.repeat(32),
    token: '33'.repeat(32),
    mode: 'email',
    expiresAt: 9_000_000_000_000
  }
  const legacy = { ...offer, token: '34'.repeat(32) }
  const item = {
    id: 'synthetic-request',
    workspaceId: access.workspaceId,
    accountId: 'synthetic-account',
    keyPackageHex: 'abcd',
    signingPublicKey: '55'.repeat(32),
    requestId: '66'.repeat(16),
    source: 'email',
    state: 'pending',
    expiresAt: 9_000_000_000_000,
    offer: { ...offer, signature: '44'.repeat(64) },
    applicantName: 'Riley',
    applicantEmail: 'r@example.test'
  }
  const pending = await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        build(async () =>
          response({
            invitations: [offer, legacy, { token: 'not-an-offer' }],
            unsignedInvitations: [{ token: legacy.token, email: 'legacy@synthetic.test' }],
            items: [item],
            hasMore: false,
            seatPreview: { status: 'not_billed', reason: 'free' }
          })
        ),
        (client) => client.memberPending(access)
      )
    )
  )
  // The applicant stays approvable, the unsigned invitation stays revocable by token and is
  // marked for re-sending, and only the unreadable entry is left out.
  assert.deepEqual(
    pending.items.map((row) => row.requestId),
    [item.requestId]
  )
  assert.deepEqual(pending.invitations, [
    offer,
    { ...legacy, needsReissue: true, email: 'legacy@synthetic.test' }
  ])
})

for (const paymentAction of ['method_required', 'payment_required', 'refresh']) {
  void test(`member approval preserves ${paymentAction} and its cost details for payment recovery`, async () => {
    const seatPreview = {
      status: 'billed',
      interval: 'month',
      unitAmount: 1000,
      proratedAmount: 500,
      currentPeriodEnd: null,
      seatCount: 1,
      nextSeatCount: 2,
      nextRenewalAmount: 2000,
      currency: 'usd',
      paymentAction,
      addedSeats: 1,
      invoiceAt: null
    }
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(
          build(async () => response({ invitations: [], items: [], hasMore: false, seatPreview })),
          (client) => client.memberPending(access)
        )
      )
    )
    assert.deepEqual(result.seatPreview, seatPreview)
  })
}

for (const invalid of [
  { paymentAction: 'unknown' },
  { addedSeats: 'one' },
  { invoiceAt: 'tomorrow' }
]) {
  void test(`member approval refuses an invalid payment preview: ${JSON.stringify(invalid)}`, async () => {
    const seatPreview = {
      status: 'billed',
      interval: 'month',
      unitAmount: 1000,
      proratedAmount: 500,
      currentPeriodEnd: null,
      seatCount: 1,
      nextSeatCount: 2,
      nextRenewalAmount: 2000,
      ...invalid
    }
    await assert.rejects(
      Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(
            build(async () =>
              response({ invitations: [], items: [], hasMore: false, seatPreview })
            ),
            (client) => client.memberPending(access)
          )
        )
      ),
      (error) => error.reason === 'invalid-response'
    )
  })
}

void test('an invitation refused for a still-waiting applicant keeps its code for the administrator', async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        build(async () =>
          Response.json(
            {
              status: 'error',
              errorMessage: 'synthetic-private-cause',
              errorData: { code: 'e2ee_member_invitation_request_pending' }
            },
            { status: 560 }
          )
        ),
        (client) =>
          Effect.result(
            client.memberCreateInvitation({
              ...access,
              offer: { version: 1 },
              email: 'legacy@synthetic.test'
            })
          )
      )
    )
  )
  assert.equal(result._tag, 'Failure')
  assert.equal(result.failure.code, 'e2ee_member_invitation_request_pending')
  assert.equal(JSON.stringify(result.failure).includes('synthetic-private-cause'), false)
})

void test('only exact authenticated member removal or device revocation carries a terminal signal', async () => {
  for (const code of ['e2ee_member_removed', 'e2ee_device_revoked', 'unauthorized']) {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* build(async () =>
            Response.json(
              { status: 'error', errorMessage: 'synthetic-private-cause', errorData: { code } },
              { status: 560 }
            )
          )
          for (const operation of [
            client.contentStreamsToken(access),
            client.memberPending(access),
            client.memberRead({ ...access, requestId: '11'.repeat(16) }),
            client.memberReject({ ...access, requestId: '11'.repeat(16) }),
            client.memberRevoke({ ...access, token: '22'.repeat(32) })
          ]) {
            const result = yield* Effect.result(operation)
            assert.equal(result._tag, 'Failure')
            assert.equal(
              result.failure instanceof E2eeMemberRemovedError,
              code === 'e2ee_member_removed'
            )
            assert.equal(
              result.failure instanceof E2eeDeviceRevokedError,
              code === 'e2ee_device_revoked'
            )
            assert.equal(JSON.stringify(result.failure).includes('synthetic-private-cause'), false)
          }
        })
      )
    )
  }
})

void test('a removed device learns its loss from the content grant action reported over HTTP 200', async () => {
  // Convex streams action failures as an HTTP 200 error envelope; a real packaged
  // run refused a removed member's content grant exactly so. Without the typed loss
  // the device keeps its accepted join and every new invitation fails as conflict.
  for (const code of ['e2ee_member_removed', 'e2ee_device_revoked', 'unauthorized']) {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* build(async () =>
            Response.json(
              { status: 'error', errorMessage: 'synthetic-private-cause', errorData: { code } },
              { status: 200 }
            )
          )
          const grant = yield* Effect.result(client.contentStreamsToken(access))
          assert.equal(grant._tag, 'Failure')
          assert.equal(
            grant.failure instanceof E2eeMemberRemovedError,
            code === 'e2ee_member_removed'
          )
          assert.equal(
            grant.failure instanceof E2eeDeviceRevokedError,
            code === 'e2ee_device_revoked'
          )
          assert.equal(JSON.stringify(grant.failure).includes('synthetic-private-cause'), false)
          // Other credential-bound endpoints keep requiring Convex's 560 status.
          for (const operation of [
            client.memberPending(access),
            client.memberRead({ ...access, requestId: '11'.repeat(16) })
          ]) {
            const result = yield* Effect.result(operation)
            assert.equal(result._tag, 'Failure')
            assert.equal(result.failure instanceof E2eeMemberRemovedError, false)
            assert.equal(result.failure instanceof E2eeDeviceRevokedError, false)
          }
        })
      )
    )
  }
})

void test('access loss authority belongs to a credential response, never an exception or unrelated endpoint', async () => {
  for (const code of ['e2ee_member_removed', 'e2ee_device_revoked']) {
    const terminal =
      code === 'e2ee_member_removed' ? new E2eeMemberRemovedError() : new E2eeDeviceRevokedError()
    for (const thrown of [{ data: { code } }, terminal]) {
      for (const phase of ['jwt', 'fetch', 'json']) {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* build(
                async () => {
                  if (phase === 'fetch') throw thrown
                  const reply = Response.json(
                    { status: 'error', errorMessage: 'synthetic', errorData: { code } },
                    { status: 560 }
                  )
                  reply.json = async () => {
                    throw thrown
                  }
                  return reply
                },
                {
                  convexToken: async () => {
                    if (phase === 'jwt') throw thrown
                    return token()
                  }
                }
              )
              const result = yield* Effect.result(client.contentStreamsToken(access))
              assert.equal(result._tag, 'Failure')
              assert.equal(result.failure instanceof E2eeMemberRemovedError, false, phase)
              assert.equal(result.failure instanceof E2eeDeviceRevokedError, false, phase)
            })
          )
        )
      }
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* build(async () =>
            Response.json(
              {
                status: 'error',
                errorMessage: 'synthetic',
                errorData: { code }
              },
              { status: 560 }
            )
          )
          const result = yield* Effect.result(client.history({ workspaceId: access.workspaceId }))
          assert.equal(result._tag, 'Failure')
          assert.equal(result.failure instanceof E2eeMemberRemovedError, false)
          assert.equal(result.failure instanceof E2eeDeviceRevokedError, false)
        })
      )
    )
  }
})

// The relay refuses every call while the deployment has account pairing switched
// off, and new requests past the hourly limit. The new device must be able to say
// which, instead of a generic failure.
for (const [serverCode, code] of [
  ['e2ee_account_pairing_disabled', 'pairing-unavailable'],
  ['e2ee_account_pairing_rate_limited', 'pairing-rate-limited']
])
  void test(`account pairing relay keeps ${serverCode} as ${code}`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* build(async () =>
            Response.json(
              {
                status: 'error',
                errorMessage: 'synthetic-private-cause',
                errorData: { code: serverCode }
              },
              { status: 560 }
            )
          )
          const lookupId = '11'.repeat(16)
          for (const operation of [
            client.pairingSubmit({
              lookupId,
              requestHex: '00',
              requestTagHex: '22'.repeat(32),
              direction: 'requester-shows',
              deviceName: 'Synthetic desktop',
              expiresAt: 1,
              workspaces: []
            }),
            client.pairingRead({ lookupId }),
            client.pairingClaim({ lookupId }),
            client.pairingDecline({ requestId: 'request-1' }),
            client.pairingPublish({
              lookupId,
              approvalHex: '00',
              approvalTagHex: '22'.repeat(32),
              invitations: []
            })
          ]) {
            const result = yield* Effect.result(operation)
            assert.equal(result._tag, 'Failure')
            assert.equal(result.failure.code, code)
            assert.equal(JSON.stringify(result.failure).includes('synthetic-private-cause'), false)
          }
        })
      )
    )
  })

const jwtExpiringAt = (seconds, id) =>
  [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({ exp: seconds, jti: id })).toString('base64url'),
    'synthetic-signature'
  ].join('.')
void test('relay calls reuse one unexpired Convex token, renew it near expiry and after a failed call', async () => {
  let now = 1_000_000
  let minted = 0
  const seen = []
  let failNext = false
  const scope = await Effect.runPromise(Scope.make())
  const client = await Effect.runPromise(
    build(
      async (_url, init) => {
        seen.push(new Headers(init.headers).get('authorization'))
        if (failNext) {
          failNext = false
          return new Response('unavailable', { status: 503 })
        }
        return response({ ...target, status: 'NeedsEnvelope', revision: 0 })
      },
      {
        now: () => now,
        convexToken: async () => ({
          data: { token: jwtExpiringAt(Math.floor(now / 1000) + 600, ++minted) }
        })
      }
    ).pipe(Scope.provide(scope))
  )
  const status = () => Effect.runPromise(Effect.result(client.mailbox(access).status(target)))
  for (let index = 0; index < 3; index++) assert.ok(Result.isSuccess(await status()))
  assert.equal(minted, 1)
  assert.equal(new Set(seen).size, 1)
  // Inside the renewal margin: a fresh token, never one about to expire in flight.
  now += 560_000
  await status()
  assert.equal(minted, 2)
  // A failed call may mean a rejected token: the next call mints again.
  failNext = true
  assert.ok(Result.isFailure(await status()))
  await status()
  assert.equal(minted, 3)
  await Effect.runPromise(Scope.close(scope, Exit.void))
})
void test('a call that hits the 30 s deadline drops the reused Convex token', async () => {
  let minted = 0
  let stalled = false
  const started = Promise.withResolvers()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* build(
          async (_url, init) => {
            if (!stalled) return response({ ...target, revision: 0, status: 'NeedsEnvelope' })
            return new Promise((_resolve, reject) => {
              started.resolve()
              init.signal.addEventListener('abort', () => reject(new Error('aborted')), {
                once: true
              })
            })
          },
          {
            now: () => 1_000_000,
            convexToken: async () => ({ data: { token: jwtExpiringAt(1_000 + 600, ++minted) } })
          }
        )
        yield* client.mailbox(access).status(target)
        assert.equal(minted, 1)
        stalled = true
        const waiting = yield* Effect.forkChild(
          Effect.result(client.mailbox(access).status(target))
        )
        yield* Effect.promise(() => started.promise)
        yield* TestClock.adjust('30 seconds')
        assert.equal((yield* Fiber.join(waiting)).failure.reason, 'unavailable')
        // The stalled call may have been a rejected token: the next call mints anew.
        stalled = false
        yield* client.mailbox(access).status(target)
        assert.equal(minted, 2)
      })
    ).pipe(Effect.provide(TestClock.layer()))
  )
})
