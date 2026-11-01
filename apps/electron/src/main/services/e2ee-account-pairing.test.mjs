import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Effect, Exit, Result } from 'effect'
import {
  decodePairingRequest,
  hashRecordBytes,
  encodePairingRequest,
  pairingApprovalTag,
  derivePairingKeys,
  parsePairingString
} from '@lody/e2ee-core/protocol'
import { makeDesktopAccountPairing } from './e2ee-account-pairing.mts'

// Real SQLite journal and real core tag/expiry checks; only the relay and the
// per-workspace ledger hosts are synthetic, and they record what they were given.
const hex = (value) => Buffer.from(value).toString('hex')
const fill = (byte, size = 32) => new Uint8Array(size).fill(byte)
const sha = (value) => new Uint8Array(createHash('sha256').update(value).digest())
const run = (effect) => Effect.runPromise(effect)
const refusal = async (effect) => {
  const exit = await Effect.runPromiseExit(effect)
  assert.ok(Exit.isFailure(exit), 'expected a refusal')
  const error = exit.cause.reasons?.[0]?.error ?? exit.cause.failures?.[0] ?? exit.cause
  return error?.code ?? String(error)
}
const NOW = 1_800_000_000_000

/** Backend-like relay: stores opaque bytes by lookup ID; tests may tamper with it. */
function makeRelay() {
  const requests = new Map()
  const relay = {
    requests,
    approvals: new Map(),
    declined: [],
    tamper: null,
    submit: (args) =>
      Effect.sync(() => {
        if (!requests.has(args.lookupId))
          requests.set(args.lookupId, { ...args, requestId: `request-${requests.size + 1}` })
        const row = requests.get(args.lookupId)
        return {
          requestId: row.requestId,
          status: 'pending',
          deviceName: row.deviceName,
          approximateLocation: null,
          requestedAt: NOW,
          expiresAt: row.expiresAt
        }
      }),
    read: (lookupId) =>
      Effect.sync(() => {
        const row = requests.get(lookupId)
        if (!row) return null
        const record = {
          requestId: row.requestId,
          status: 'pending',
          deviceName: row.deviceName,
          approximateLocation: 'Synthetic city',
          requestedAt: NOW,
          expiresAt: row.expiresAt,
          lookupId,
          requestHex: row.requestHex,
          requestTagHex: row.requestTagHex,
          workspaces: row.workspaces
        }
        return relay.tamper ? relay.tamper(record) : record
      }),
    decline: (requestId) => Effect.sync(() => relay.declined.push(requestId)),
    publish: (args) =>
      Effect.suspend(() => {
        if (relay.publishFails) return Effect.fail(new Error('relay unavailable'))
        const list = relay.approvals.get(args.lookupId) ?? []
        list.push({
          approvalHex: args.approvalHex,
          approvalTagHex: args.approvalTagHex,
          publishedAt: NOW,
          invitations: args.invitations.map(({ workspaceId, genesisHash, invitationHex }) => ({
            workspaceId,
            genesisHash,
            invitationHex
          }))
        })
        relay.approvals.set(args.lookupId, list)
        return Effect.succeed({ status: 'published' })
      }),
    claim: (lookupId) =>
      Effect.sync(() =>
        requests.has(lookupId)
          ? { status: 'pending', approvals: relay.approvals.get(lookupId) ?? [] }
          : null
      )
  }
  return relay
}

const WORKSPACES = [
  { workspaceId: 'w1', name: 'Alpha', genesis: fill(0x11) },
  { workspaceId: 'w2', name: 'Beta', genesis: fill(0x22) }
]
/** The new device's retained identities and what it installed. */
function requesterHosts() {
  const installed = []
  const hosts = WORKSPACES.map((workspace, index) => ({
    ...workspace,
    identity: () =>
      Effect.succeed({
        signingPublicKey: fill(0x30 + index),
        encryptionPublicKey: fill(0x40 + index),
        possessionProof: fill(0x50 + index, 64),
        credentialHash: fill(0x60 + index)
      }),
    accept: (invitation, admissionRecordHash) =>
      Effect.sync(() =>
        installed.push({
          workspaceId: workspace.workspaceId,
          invitation: hex(invitation),
          admissionRecordHash: hex(admissionRecordHash)
        })
      )
  }))
  return { hosts, installed }
}
/** An approving device's ledgers: counts signatures and records appended bytes. */
function approverHosts(ids = ['w1', 'w2']) {
  const log = { signed: [], appended: [], appendFails: 0 }
  const hosts = WORKSPACES.filter((workspace) => ids.includes(workspace.workspaceId)).map(
    (workspace, index) => ({
      ...workspace,
      signingPublicKey: fill(0x70 + index),
      sign: (row) =>
        Effect.sync(() => {
          log.signed.push({ workspaceId: workspace.workspaceId, key: hex(row.signingPublicKey) })
          // Each signature is unique, so a second one would be visible.
          return {
            requestId: `admit-${workspace.workspaceId}-${log.signed.length}`,
            record: new Uint8Array([...row.signingPublicKey, log.signed.length])
          }
        }),
      append: (requestId, record) =>
        Effect.suspend(() => {
          if (log.appendFails > 0) {
            log.appendFails--
            return Effect.fail(new Error('append unavailable'))
          }
          log.appended.push({ workspaceId: workspace.workspaceId, requestId, record: hex(record) })
          return Effect.void
        }),
      invitation: (record) => Effect.succeed(new Uint8Array([0xee, ...record])),
      access: () =>
        Effect.succeed({ workspaceId: workspace.workspaceId, credential: hex(fill(0x99)) })
    })
  )
  return { hosts, log }
}
function device({
  db = new DatabaseSync(':memory:'),
  relay,
  requester,
  approver,
  clock,
  seed = 1
}) {
  let counter = seed
  return {
    db,
    pairing: makeDesktopAccountPairing({
      db,
      account: 'synthetic-account',
      deviceName: 'Synthetic laptop',
      relay,
      requesterWorkspaces: () => Effect.succeed(requester?.hosts ?? []),
      approverWorkspaces: () => Effect.succeed(approver?.hosts ?? []),
      now: () => clock.now,
      random: (size) => fill(counter++ * 16 + 1, size)
    })
  }
}

void test('a new device is approved per workspace, verifying each approval before installing', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const requester = requesterHosts()
  const newDevice = device({ relay, requester, clock })
  const state = await run(newDevice.pairing.requestAccountPairing({}))
  assert.equal(state.status, 'waiting')
  assert.equal(state.direction, 'requester-shows')
  assert.match(state.pairingString, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/)
  assert.equal(state.expiresAt, NOW + 600_000)

  // Approver A can sign only Alpha; Beta stays pending for another device.
  const a = approverHosts(['w1'])
  const approverA = device({ relay, approver: a, clock, seed: 50 })
  const preview = await run(approverA.pairing.inspectAccountPairing(state.pairingString))
  assert.deepEqual(preview.workspaces, [{ workspaceId: 'w1', name: 'Alpha' }])
  assert.deepEqual(preview.unavailable, [{ workspaceId: 'w2', name: 'w2' }])
  assert.equal(preview.deviceName, 'Synthetic laptop')
  assert.equal(preview.approximateLocation, 'Synthetic city')
  const result = await run(
    approverA.pairing.approveAccountPairing({
      pairingString: state.pairingString,
      requestId: preview.requestId,
      workspaceIds: ['w1']
    })
  )
  assert.deepEqual(result.workspaces, [{ workspaceId: 'w1', outcome: 'admitted' }])
  assert.deepEqual(a.log.signed, [{ workspaceId: 'w1', key: hex(fill(0x30)) }])

  clock.now += 60_000
  const partial = await run(newDevice.pairing.accountPairingRequest())
  assert.equal(partial.status, 'waiting')
  assert.deepEqual(
    partial.workspaces.map((item) => [item.workspaceId, item.state]),
    [
      ['w1', 'joined'],
      ['w2', 'pending']
    ]
  )
  assert.equal(requester.installed.length, 1)
  assert.equal(
    requester.installed[0].admissionRecordHash,
    hex(hashRecordBytes(new Uint8Array([...fill(0x30), 1])).toBytes())
  )

  const b = approverHosts(['w2'])
  const approverB = device({ relay, approver: b, clock, seed: 70 })
  await run(
    approverB.pairing.approveAccountPairing({
      pairingString: state.pairingString,
      requestId: preview.requestId,
      workspaceIds: ['w2']
    })
  )
  const done = await run(newDevice.pairing.accountPairingRequest())
  assert.equal(done.status, 'joined')
  assert.equal(done.pairingString, null)
  assert.deepEqual(
    requester.installed.map((item) => item.workspaceId),
    ['w1', 'w2']
  )
  // A finished code is never usable again on the approver.
  assert.equal(
    await refusal(approverA.pairing.inspectAccountPairing(state.pairingString)),
    'pairing-used'
  )
})

void test('a request changed by the relay is refused before anything is signed', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const newDevice = device({ relay, requester: requesterHosts(), clock })
  const { pairingString } = await run(newDevice.pairing.requestAccountPairing({}))
  const a = approverHosts()
  const approver = device({ relay, approver: a, clock, seed: 50 })
  // Substitute the new device's signing key in the relayed bytes, keeping the tag.
  relay.tamper = (record) => {
    const request = Result.getOrThrow(
      decodePairingRequest(new Uint8Array(Buffer.from(record.requestHex, 'hex')))
    )
    const rows = request.rows.map((row, index) =>
      index === 0 ? { ...row, signingPublicKey: fill(0xbb) } : row
    )
    return {
      ...record,
      requestHex: hex(Result.getOrThrow(encodePairingRequest({ ...request, rows })))
    }
  }
  assert.equal(
    await refusal(approver.pairing.inspectAccountPairing(pairingString)),
    'pairing-tampered'
  )
  assert.equal(
    await refusal(
      approver.pairing.approveAccountPairing({
        pairingString,
        requestId: 'request-1',
        workspaceIds: ['w1']
      })
    ),
    'pairing-tampered'
  )
  assert.deepEqual(a.log.signed, [])
  // A forged expiry is tampering too: the tag covers it.
  relay.tamper = (record) => {
    const request = Result.getOrThrow(
      decodePairingRequest(new Uint8Array(Buffer.from(record.requestHex, 'hex')))
    )
    return {
      ...record,
      requestHex: hex(
        Result.getOrThrow(encodePairingRequest({ ...request, expiresAt: NOW + 3_600_000 }))
      )
    }
  }
  assert.equal(
    await refusal(approver.pairing.inspectAccountPairing(pairingString)),
    'pairing-tampered'
  )
})

void test('the approver checks expiry on its own clock and records it locally', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const newDevice = device({ relay, requester: requesterHosts(), clock })
  const { pairingString } = await run(newDevice.pairing.requestAccountPairing({}))
  const db = new DatabaseSync(':memory:')
  const a = approverHosts()
  clock.now = NOW + 600_000
  const approver = device({ db, relay, approver: a, clock, seed: 50 })
  assert.equal(
    await refusal(
      approver.pairing.approveAccountPairing({
        pairingString,
        requestId: 'request-1',
        workspaceIds: ['w1']
      })
    ),
    'pairing-expired'
  )
  assert.deepEqual(a.log.signed, [])
  // The terminal record survives a restart and a clock moved back; the relay still says pending.
  clock.now = NOW
  const reopened = device({ db, relay, approver: a, clock, seed: 60 })
  assert.equal(
    await refusal(reopened.pairing.inspectAccountPairing(pairingString)),
    'pairing-expired'
  )
})

void test('each workspace is signed once and the journaled original is retried, also after restart', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const requester = requesterHosts()
  const newDevice = device({ relay, requester, clock })
  const { pairingString } = await run(newDevice.pairing.requestAccountPairing({}))
  const db = new DatabaseSync(':memory:')
  const a = approverHosts()
  a.log.appendFails = 1
  const approver = device({ db, relay, approver: a, clock, seed: 50 })
  const first = await run(
    approver.pairing.approveAccountPairing({
      pairingString,
      requestId: 'request-1',
      workspaceIds: ['w1', 'w2']
    })
  )
  assert.deepEqual(first.workspaces, [
    { workspaceId: 'w1', outcome: 'not-admitted' },
    { workspaceId: 'w2', outcome: 'admitted' }
  ])
  assert.equal(a.log.signed.length, 2)
  // Restart: a new instance on the same journal finishes without signing again.
  const restarted = device({ db, relay, approver: a, clock, seed: 60 })
  const second = await run(
    restarted.pairing.approveAccountPairing({
      pairingString,
      requestId: 'request-1',
      workspaceIds: ['w1', 'w2']
    })
  )
  assert.deepEqual(
    second.workspaces.map((item) => item.outcome),
    ['admitted', 'admitted']
  )
  assert.equal(a.log.signed.length, 2)
  const w1 = a.log.appended.filter((item) => item.workspaceId === 'w1')
  assert.deepEqual(
    w1.map((item) => item.requestId),
    ['admit-w1-1']
  )
  assert.equal(w1[0].record, hex(new Uint8Array([...fill(0x30), 1])))
  const done = await run(newDevice.pairing.accountPairingRequest())
  assert.equal(done.status, 'joined')
})

void test('the new device ignores forged or foreign approvals and refuses late ones', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const requester = requesterHosts()
  const newDevice = device({ relay, requester, clock })
  const { pairingString } = await run(newDevice.pairing.requestAccountPairing({}))
  const lookupId = [...relay.requests.keys()][0]
  const invitation = new Uint8Array([1, 2, 3])
  const approval = {
    requestDigest: fill(0x01),
    approverSigningPublicKey: fill(0x02),
    rows: [
      { genesis: fill(0x11), admissionRecordHash: fill(0x03), invitationDigest: sha(invitation) }
    ]
  }
  const secret = Result.getOrThrow(parsePairingString(pairingString))
  const keys = Result.getOrThrow(derivePairingKeys(secret))
  const { encodePairingApproval } = await import('@lody/e2ee-core/protocol')
  const forged = (overrides) => ({
    approvalHex: hex(Result.getOrThrow(encodePairingApproval(approval))),
    approvalTagHex: hex(Result.getOrThrow(pairingApprovalTag(keys, approval))),
    publishedAt: NOW,
    invitations: [
      { workspaceId: 'w1', genesisHash: hex(fill(0x11)), invitationHex: hex(invitation) }
    ],
    ...overrides
  })
  // A correct tag over another request's digest, and a wrong tag.
  relay.approvals.set(lookupId, [forged({}), forged({ approvalTagHex: hex(fill(0x09)) })])
  const state = await run(newDevice.pairing.accountPairingRequest())
  assert.equal(state.status, 'waiting')
  assert.deepEqual(requester.installed, [])

  // A genuine approval published after the new device's own expiry is refused.
  relay.approvals.clear()
  const a = approverHosts()
  const approver = device({ relay, approver: a, clock, seed: 50 })
  await run(
    approver.pairing.approveAccountPairing({
      pairingString,
      requestId: 'request-1',
      workspaceIds: ['w1', 'w2']
    })
  )
  clock.now = NOW + 600_000
  const late = await run(newDevice.pairing.accountPairingRequest())
  assert.equal(late.status, 'expired')
  assert.deepEqual(requester.installed, [])
})

void test('terminal states are local: cancel and restart end a request whatever the relay says', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const db = new DatabaseSync(':memory:')
  const requester = requesterHosts()
  const first = device({ db, relay, requester, clock })
  const original = await run(first.pairing.requestAccountPairing({}))
  // An exact retry neither extends nor replaces the request.
  clock.now += 30_000
  const retried = await run(first.pairing.requestAccountPairing({}))
  assert.equal(retried.pairingString, original.pairingString)
  assert.equal(retried.expiresAt, original.expiresAt)
  assert.equal(relay.requests.size, 1)

  // The secret is never on disk, so a restart ends the request locally.
  const restarted = device({ db, relay, requester, clock, seed: 9 })
  const after = await run(restarted.pairing.accountPairingRequest())
  assert.equal(after.status, 'expired')
  const fresh = await run(restarted.pairing.requestAccountPairing({}))
  assert.notEqual(fresh.pairingString, original.pairingString)
  await run(restarted.pairing.cancelAccountPairing())
  assert.equal((await run(restarted.pairing.accountPairingRequest())).status, 'expired')
  // The reverse direction refuses a code this device already used.
  const code = await run(device({ relay, clock, seed: 30 }).pairing.accountPairingCode())
  await run(restarted.pairing.requestAccountPairing({ pairingString: code.pairingString }))
  await run(restarted.pairing.cancelAccountPairing())
  assert.equal(
    await refusal(restarted.pairing.requestAccountPairing({ pairingString: code.pairingString })),
    'pairing-used'
  )
})

void test('decline is recorded locally and refused once this device has signed', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const newDevice = device({ relay, requester: requesterHosts(), clock })
  const { pairingString } = await run(newDevice.pairing.requestAccountPairing({}))
  const approver = device({ relay, approver: approverHosts(), clock, seed: 50 })
  await run(approver.pairing.declineAccountPairing({ pairingString, requestId: 'request-1' }))
  assert.deepEqual(relay.declined, ['request-1'])
  assert.equal(await refusal(approver.pairing.inspectAccountPairing(pairingString)), 'pairing-used')
})

void test('an admission journaled before expiry is delivered under the next request without signing again', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const db = new DatabaseSync(':memory:')
  const requester = requesterHosts()
  const first = device({ relay, requester, clock })
  const { pairingString: firstCode } = await run(first.pairing.requestAccountPairing({}))
  const a = approverHosts()
  const approver = device({ db, relay, approver: a, clock, seed: 50 })
  relay.publishFails = true
  const stuck = await run(
    approver.pairing.approveAccountPairing({
      pairingString: firstCode,
      requestId: 'request-1',
      workspaceIds: ['w1', 'w2']
    })
  )
  assert.deepEqual(
    stuck.workspaces.map((item) => item.outcome),
    ['awaiting-delivery', 'awaiting-delivery']
  )
  assert.equal(a.log.signed.length, 2)
  // The request expires before delivery; the new device starts again with the
  // same retained identities.
  relay.publishFails = false
  clock.now = NOW + 600_000
  assert.equal((await run(first.pairing.accountPairingRequest())).status, 'expired')
  const { pairingString: secondCode } = await run(first.pairing.requestAccountPairing({}))
  const [, second] = [...relay.requests.values()]
  const done = await run(
    approver.pairing.approveAccountPairing({
      pairingString: secondCode,
      requestId: second.requestId,
      workspaceIds: ['w1', 'w2']
    })
  )
  assert.deepEqual(
    done.workspaces.map((item) => item.outcome),
    ['admitted', 'admitted']
  )
  assert.equal(a.log.signed.length, 2)
  assert.equal((await run(first.pairing.accountPairingRequest())).status, 'joined')
})

void test('concurrent approvals of one code sign each workspace once', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const newDevice = device({ relay, requester: requesterHosts(), clock })
  const { pairingString } = await run(newDevice.pairing.requestAccountPairing({}))
  const a = approverHosts()
  // The first signature blocks on an explicit gate while the second call runs.
  let entered = 0
  let release
  const gate = new Promise((resolve) => (release = resolve))
  let firstEntered
  const first = new Promise((resolve) => (firstEntered = resolve))
  for (const host of a.hosts) {
    const sign = host.sign
    host.sign = (row) =>
      Effect.flatMap(
        Effect.promise(() => {
          entered++
          firstEntered()
          return gate
        }),
        () => sign(row)
      )
  }
  const approver = device({ relay, approver: a, clock, seed: 50 })
  const approve = () =>
    Effect.runPromiseExit(
      approver.pairing.approveAccountPairing({
        pairingString,
        requestId: 'request-1',
        workspaceIds: ['w1', 'w2']
      })
    )
  const both = Promise.all([approve(), approve()])
  await first
  // Give the second call every chance to reach a signature of its own.
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(entered, 1)
  release()
  await both
  assert.deepEqual(a.log.signed.map((item) => item.workspaceId).sort(), ['w1', 'w2'])
})

void test('a request that fails before it is journaled wipes its secret', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const requester = requesterHosts()
  // Every workspace fails, so the request itself fails before it is journaled.
  requester.hosts = requester.hosts.map((host) => ({
    ...host,
    identity: () => Effect.fail(new Error('locked'))
  }))
  const issued = []
  const db = new DatabaseSync(':memory:')
  const pairing = makeDesktopAccountPairing({
    db,
    account: 'synthetic-account',
    deviceName: 'Synthetic laptop',
    relay,
    requesterWorkspaces: () => Effect.succeed(requester.hosts),
    approverWorkspaces: () => Effect.succeed([]),
    now: () => clock.now,
    random: (size) => {
      const secret = fill(0x5a, size)
      issued.push(secret)
      return secret
    }
  })
  assert.equal(await refusal(pairing.requestAccountPairing({})), 'invalid-input')
  assert.equal(issued.length, 1)
  assert.ok(issued[0].every((byte) => byte === 0))
  assert.equal(relay.requests.size, 0)
})

void test('a workspace that cannot prepare an identity is left out instead of blocking the request', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const requester = requesterHosts()
  requester.hosts[1] = {
    ...requester.hosts[1],
    identity: () => Effect.fail(new Error('missing-binding'))
  }
  const newDevice = device({ relay, requester, clock })
  const state = await run(newDevice.pairing.requestAccountPairing({}))
  assert.deepEqual(
    state.workspaces.map((item) => item.workspaceId),
    ['w1']
  )
  const [submitted] = [...relay.requests.values()]
  assert.deepEqual(
    submitted.workspaces.map((item) => item.workspaceId),
    ['w1']
  )
})

void test('one workspace that fails to install does not block the others', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const requester = requesterHosts()
  let failing = true
  const accept = requester.hosts[0].accept
  requester.hosts[0] = {
    ...requester.hosts[0],
    accept: (...args) => (failing ? Effect.fail(new Error('conflict')) : accept(...args))
  }
  const newDevice = device({ relay, requester, clock })
  const { pairingString } = await run(newDevice.pairing.requestAccountPairing({}))
  const approver = device({ relay, approver: approverHosts(), clock, seed: 50 })
  await run(
    approver.pairing.approveAccountPairing({
      pairingString,
      requestId: 'request-1',
      workspaceIds: ['w1', 'w2']
    })
  )
  const partial = await run(newDevice.pairing.accountPairingRequest())
  assert.deepEqual(
    partial.workspaces.map((item) => [item.workspaceId, item.state]),
    [
      ['w1', 'pending'],
      ['w2', 'joined']
    ]
  )
  failing = false
  assert.equal((await run(newDevice.pairing.accountPairingRequest())).status, 'joined')
})

void test('an admission the ledger settled differently is retired and signed once more', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const newDevice = device({ relay, requester: requesterHosts(), clock })
  const { pairingString } = await run(newDevice.pairing.requestAccountPairing({}))
  const a = approverHosts(['w1'])
  // The first original lost its slot to a concurrent record: the host reports it lost.
  let lost = true
  const append = a.hosts[0].append
  a.hosts[0].append = (...args) =>
    lost
      ? ((lost = false), Effect.fail(Object.assign(new Error('lost'), { code: 'admission-lost' })))
      : append(...args)
  const approver = device({ relay, approver: a, clock, seed: 50 })
  const first = await run(
    approver.pairing.approveAccountPairing({
      pairingString,
      requestId: 'request-1',
      workspaceIds: ['w1']
    })
  )
  assert.deepEqual(first.workspaces, [{ workspaceId: 'w1', outcome: 'not-admitted' }])
  const second = await run(
    approver.pairing.approveAccountPairing({
      pairingString,
      requestId: 'request-1',
      workspaceIds: ['w1']
    })
  )
  assert.deepEqual(second.workspaces, [{ workspaceId: 'w1', outcome: 'admitted' }])
  assert.equal(a.log.signed.length, 2)
  assert.deepEqual(
    a.log.appended.map((item) => item.requestId),
    ['admit-w1-2']
  )
})

void test('expiry is checked again after the pre-signing refresh, before anything is signed or appended', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const newDevice = device({ relay, requester: requesterHosts(), clock })
  const { pairingString, expiresAt } = await run(newDevice.pairing.requestAccountPairing({}))
  const a = approverHosts(['w1'])
  // The refresh is network work; time passes the request's expiry while it runs.
  a.hosts[0].refresh = () =>
    Effect.sync(() => {
      clock.now = expiresAt
    })
  const approver = device({ relay, approver: a, clock, seed: 50 })
  assert.equal(
    await refusal(
      approver.pairing.approveAccountPairing({
        pairingString,
        requestId: 'request-1',
        workspaceIds: ['w1']
      })
    ),
    'pairing-expired'
  )
  assert.deepEqual(a.log.signed, [])
  assert.deepEqual(a.log.appended, [])
})

void test('a workspace whose refresh or signature fails is not admitted while the others proceed', async () => {
  const relay = makeRelay()
  const clock = { now: NOW }
  const newDevice = device({ relay, requester: requesterHosts(), clock })
  const { pairingString } = await run(newDevice.pairing.requestAccountPairing({}))
  const a = approverHosts()
  a.hosts[0].refresh = () => Effect.fail(new Error('history unavailable'))
  const approver = device({ relay, approver: a, clock, seed: 50 })
  const result = await run(
    approver.pairing.approveAccountPairing({
      pairingString,
      requestId: 'request-1',
      workspaceIds: ['w1', 'w2']
    })
  )
  assert.deepEqual(result.workspaces, [
    { workspaceId: 'w1', outcome: 'not-admitted' },
    { workspaceId: 'w2', outcome: 'admitted' }
  ])
  assert.deepEqual(
    a.log.signed.map((item) => item.workspaceId),
    ['w2']
  )
  // A failed signature is isolated the same way, and a retry signs only the missing one.
  delete a.hosts[0].refresh
  const sign = a.hosts[0].sign
  a.hosts[0].sign = () => Effect.fail(new Error('ledger busy'))
  const again = await run(
    approver.pairing.approveAccountPairing({
      pairingString,
      requestId: 'request-1',
      workspaceIds: ['w1', 'w2']
    })
  )
  assert.deepEqual(
    again.workspaces.map((item) => item.outcome),
    ['not-admitted', 'admitted']
  )
  a.hosts[0].sign = sign
  const last = await run(
    approver.pairing.approveAccountPairing({
      pairingString,
      requestId: 'request-1',
      workspaceIds: ['w1', 'w2']
    })
  )
  assert.deepEqual(
    last.workspaces.map((item) => item.outcome),
    ['admitted', 'admitted']
  )
  assert.deepEqual(
    a.log.signed.map((item) => item.workspaceId),
    ['w2', 'w1']
  )
})
