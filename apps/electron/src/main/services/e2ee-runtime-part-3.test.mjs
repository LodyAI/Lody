import {
  Bytes,
  Clock,
  Context,
  DatabaseSync,
  Deferred,
  Effect,
  Exit,
  Fiber,
  InstalledEpochKeys,
  Layer,
  LedgerPinStore,
  LedgerViewSource,
  Result,
  VerifiedLedger,
  WorkspaceScope,
  assert,
  bind,
  commitEpochKey,
  decodeE2eeIntentRecord,
  decodeRecord,
  desktopE2eePorts,
  disposeEpochKey,
  encodeCbor,
  execute,
  existsSync,
  expectNoEntry,
  extendLedger,
  fixture,
  hashRecordBytes,
  hex,
  inspectContentFrame,
  intent,
  join,
  mailboxDigest,
  maintenanceFixture,
  makeRecords,
  managementFailureFixture,
  ownerWithHost,
  page,
  prepareDeviceAdmission,
  prepareEpochEnvelope,
  prepareJoinRequest,
  prepareLedgerCommand,
  prepareLedgerRecord,
  scheduleDeclarationSubject,
  sealHistoryPacket,
  sharingCacheFixture,
  signLedgerRecord,
  sqliteInstalledKeyStore,
  test,
  verifyExecutionIntent,
  verifyLedger,
  workspaceId
} from './e2ee-runtime-test-helpers.mjs'

for (const commandType of ['revoke', 'removeMember']) {
  void test(`${commandType} bypasses an unstaged candidate but preserves an unknown publication CAS across reopen`, (t) =>
    managementFailureFixture(t, commandType))
}

void test('closing during a manual management ledger read aborts outside account locks and releases the host', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const entered = Promise.withResolvers()
      let aborted = false
      const management = Effect.runPromise(
        Effect.result(
          owner.host.manage(workspaceId, { type: 'rotate' }, (signal) => ({
            history: () =>
              Effect.tryPromise({
                try: () =>
                  new Promise((resolve, reject) => {
                    signal.addEventListener(
                      'abort',
                      () => {
                        aborted = true
                        reject(new Error('synthetic aborted ledger request'))
                      },
                      { once: true }
                    )
                    entered.resolve()
                  }),
                catch: (error) => error
              }),
            log: {
              read: () => Effect.die('refresh must precede submission'),
              appendCas: () => Effect.die('no signing')
            },
            staging: () => ({
              stageGroup: () => Effect.die('no stage'),
              readGroup: () => Effect.succeed(null),
              deleteGroup: () => Effect.void
            }),
            mailbox: () => {
              throw new Error('no key reception')
            }
          }))
        )
      )
      yield* Effect.promise(() =>
        Promise.race([
          entered.promise,
          management.then(() => {
            throw new Error('management failed before the remote boundary')
          })
        ])
      )
      yield* owner.host.closeWorkspace(workspaceId)
      const result = yield* Effect.promise(() => management)
      assert.equal(aborted, true)
      assert.equal(Result.isFailure(result), true)
      assert.equal((yield* owner.host.open(workspaceId)).hasCurrentKey, true)
    })
  )
})

void test('native content uses a durable bounded grace and immediately prefers an installed current key', async (t) => {
  const directory = await fixture(t)
  let elapsed = 0
  const clock = Object.assign(Object.create(Effect.runSync(Clock.Clock)), {
    currentTimeMillisUnsafe: () => 1_800_000_000_000 + elapsed,
    monotonicTimeNanosUnsafe: () => BigInt(elapsed) * 1_000_000n
  })
  await execute(
    Effect.gen(function* () {
      const f = yield* maintenanceFixture(directory)
      const next = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(88)))
      yield* Effect.addFinalizer(() => Effect.sync(() => disposeEpochKey(next)))
      const previous = yield* f.keys.read(0)
      const packet = Result.getOrThrow(
        sealHistoryPacket({ genesis: f.genesis, epoch: 1, currentKey: next, previousKey: previous })
      )
      disposeEpochKey(previous)
      const body = Result.getOrThrow(
        encodeCbor([
          f.view().head.toBytes(),
          f.device.publicKey.toBytes(),
          [7, 1, Result.getOrThrow(commitEpochKey(f.genesis, 1, next)).toBytes(), packet]
        ])
      )
      const record = yield* signLedgerRecord(
        Result.getOrThrow(prepareLedgerRecord(f.view(), body)),
        f.device
      )
      f.setView(
        Result.getOrThrow(
          extendLedger(f.view(), [record], { head: hashRecordBytes(record), length: 2 })
        )
      )
      yield* f.owner.host.ingestLedgerRecords(
        workspaceId,
        page(
          [Buffer.from(f.prepared.genesisRecordHex, 'hex'), record],
          f.prepared.genesisHashHex,
          0
        )
      )
      for (const kind of ['update_batch', 'snapshot']) {
        const request = {
          epoch: 0,
          room: { kind: 'doc', docId: 'bounded-grace' },
          context: {
            protocol: 'loro-streams-crdt-payload-protection',
            version: 2,
            kind,
            ...(kind === 'snapshot' ? { continuationOffset: 'next' } : {})
          },
          plaintext: Uint8Array.of(23),
          additionalData: Uint8Array.of(3)
        }
        elapsed = 899_999
        const sealed = yield* f.owner.host.seal(workspaceId, request)
        assert.equal(Result.getOrThrow(inspectContentFrame(sealed.sealed)).epoch, 0)
        assert.deepEqual(
          yield* f.owner.host.openContent(workspaceId, { ...request, ...sealed }),
          request.plaintext
        )
      }
      yield* f.owner.host.closeWorkspace(workspaceId)
      elapsed = 900_000
      yield* f.owner.host.open(workspaceId)
      const request = {
        epoch: 0,
        room: { kind: 'meta' },
        context: {
          protocol: 'loro-streams-crdt-payload-protection',
          version: 2,
          kind: 'update_batch'
        },
        plaintext: Uint8Array.of(24),
        additionalData: Uint8Array.of(3)
      }
      const expired = yield* Effect.result(f.owner.host.seal(workspaceId, request))
      assert.equal(Result.isFailure(expired), true)
      assert.equal(expired.failure.code, 'key-update-required')
      yield* f.keys.saveAndReload(1, next)
      const current = yield* f.owner.host.seal(workspaceId, request)
      assert.equal(Result.getOrThrow(inspectContentFrame(current.sealed)).epoch, 1)
    }).pipe(Effect.provideService(Clock.Clock, clock))
  )
})

// Each key-round mode opens only the SQLite journals its core capabilities require, so a
// receive-only or distribute-only open never creates unused maintenance stores. The
// distributor records this device's own publication through the receiver, so it needs
// receive.sqlite as well; repair.sqlite belongs to full rounds only.
void test('a device admitted during an older full round receives its key before targeted distribution returns', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const f = yield* maintenanceFixture(directory)
      const records = [Buffer.from(f.prepared.genesisRecordHex, 'hex')]
      const admit = Effect.fnUntraced(function* () {
        const initial = f.view()
        const joining = yield* f.owner.custody.prepareDevice()
        const command = yield* prepareDeviceAdmission({
          genesis: f.genesis,
          membershipId: initial.inspectState().owner,
          encryptionPublicKey: joining.enc,
          kind: 'personal',
          signer: joining
        })
        const record = yield* signLedgerRecord(
          Result.getOrThrow(prepareLedgerCommand(initial, f.device.publicKey, command)),
          f.device
        )
        records.push(record)
        f.setView(
          Result.getOrThrow(
            extendLedger(initial, [record], {
              head: hashRecordBytes(record),
              length: records.length
            })
          )
        )
        yield* f.owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, f.prepared.genesisHashHex, 0)
        )
        return joining
      })
      const existing = yield* admit()
      const entered = yield* Deferred.make()
      const release = yield* Deferred.make()
      let held = false
      const mailbox = {
        ...f.mailbox,
        status: (slot) =>
          Effect.gen(function* () {
            if (!held && slot.recipient === hex(existing.publicKey.toBytes())) {
              held = true
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }
            return yield* f.mailbox.status(slot)
          })
      }
      const full = yield* Effect.forkChild(f.owner.host.keyRound(workspaceId, () => mailbox))
      yield* Deferred.await(entered)
      const joining = yield* admit()
      const recipient = hex(joining.publicKey.toBytes())
      const targeted = yield* Effect.forkChild(
        f.owner.host.distributeKeys(workspaceId, () => mailbox, [recipient]),
        { startImmediately: true }
      )
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(full)
      yield* Fiber.join(targeted)
      assert.notEqual(
        (yield* f.mailbox.status({ genesis: f.prepared.genesisHashHex, epoch: 0, recipient }))
          .status,
        'NeedsEnvelope'
      )
      yield* f.owner.custody.discardDevice(joining)
      yield* f.owner.custody.discardDevice(existing)
    })
  )
})

void test('key rounds create only the maintenance journals their mode needs', async (t) => {
  const journals = (directory) =>
    ['receive', 'outbox', 'distribution', 'repair'].filter((name) =>
      existsSync(join(directory, 'workspaces', workspaceId, `${name}.sqlite`))
    )
  const receiving = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const { owner, mailbox } = yield* maintenanceFixture(receiving)
      assert.deepEqual(journals(receiving), [])
      yield* owner.host.receiveKeys(workspaceId, () => mailbox)
      assert.deepEqual(journals(receiving), ['receive'])
      yield* owner.host.keyRound(workspaceId, () => mailbox)
      assert.deepEqual(journals(receiving), ['receive', 'outbox', 'distribution', 'repair'])
      assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
    })
  )
  const distributing = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const { owner, mailbox } = yield* maintenanceFixture(distributing)
      yield* owner.host.distributeKeys(workspaceId, () => mailbox)
      assert.deepEqual(journals(distributing), ['receive', 'outbox', 'distribution'])
      yield* owner.host.keyRound(workspaceId, () => mailbox)
      assert.deepEqual(journals(distributing), ['receive', 'outbox', 'distribution', 'repair'])
    })
  )
})

void test('an unreadable installed blob keeps ledger open and is replaced only by a verified mailbox key', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const { owner, mailbox } = yield* maintenanceFixture(directory)
      yield* owner.host.closeWorkspace(workspaceId)
      const db = new DatabaseSync(
        join(directory, 'workspaces', workspaceId, 'installed-keys.sqlite')
      )
      db.prepare('UPDATE installed_epoch_keys SET blob=? WHERE epoch=0').run(
        new Uint8Array([1, 2, 3])
      )
      db.close()
      const status = yield* owner.host.open(workspaceId)
      assert.equal(status.hasCurrentKey, false)
      assert.equal(status.writeEpoch, null)
      assert.equal((yield* owner.host.ledgerView(workspaceId)).status.length, 1)
      yield* owner.host.keyRound(workspaceId, () => mailbox)
      assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
    })
  )
})

void test('a transient installed-key write failure never rejects the good mailbox envelope and retries after storage recovers', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const { owner, mailbox, path } = yield* maintenanceFixture(directory)
      const local = new DatabaseSync(
        join(directory, 'workspaces', workspaceId, 'installed-keys.sqlite')
      )
      local.prepare('UPDATE installed_epoch_keys SET blob=? WHERE epoch=0').run(new Uint8Array([1]))
      local.exec(
        "CREATE TRIGGER block_replace BEFORE UPDATE ON installed_epoch_keys BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END"
      )
      const failed = yield* Effect.result(owner.host.keyRound(workspaceId, () => mailbox))
      assert.equal(failed.failure.receive.failure.cryptographicRejection, false)
      const remote = new DatabaseSync(path)
      assert.equal(remote.prepare('SELECT count(*) AS n FROM mailbox_rejected').get().n, 0)
      assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, false)
      local.exec('DROP TRIGGER block_replace')
      yield* owner.host.keyRound(workspaceId, () => mailbox)
      assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
      remote.close()
      local.close()
    })
  )
})

void test('unknown mailbox sender requests verified ledger refresh and retries exact bytes without rejection', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const f = yield* maintenanceFixture(directory)
      const initial = f.view()
      const joining = yield* f.owner.custody.prepareDevice()
      const membershipId = initial
        .inspectState()
        .devices.get(hex(f.device.publicKey.toBytes())).membershipId
      const possession = yield* prepareDeviceAdmission({
        genesis: f.genesis,
        membershipId,
        encryptionPublicKey: joining.enc,
        kind: 'personal',
        signer: joining
      })
      const record = yield* signLedgerRecord(
        Result.getOrThrow(
          prepareLedgerCommand(initial, f.device.publicKey, {
            _tag: 'AdmitDevice',
            kind: 'personal',
            signingPublicKey: joining.publicKey,
            encryptionPublicKey: joining.enc,
            possessionSignature: possession.possessionSignature
          })
        ),
        f.device
      )
      const records = [Buffer.from(f.prepared.genesisRecordHex, 'hex'), record]
      const latest = Result.getOrThrow(
        extendLedger(initial, [record], { head: hashRecordBytes(record), length: 2 })
      )
      const frame = yield* Effect.acquireUseRelease(
        f.keys.read(0),
        (key) =>
          prepareEpochEnvelope({
            context: {
              genesis: f.genesis,
              epoch: 0,
              sender: joining.publicKey,
              recipient: f.device.publicKey
            },
            key,
            signer: joining,
            ledger: () => Effect.succeed(latest)
          }),
        (key) => Effect.sync(() => disposeEpochKey(key))
      )
      f.setView(latest)
      const mailbox = {
        ...f.mailbox,
        fetch: () =>
          Effect.succeed({
            items: [{ sender: hex(joining.publicKey.toBytes()), frame }],
            next: null
          })
      }
      yield* f.owner.host.keyRound(
        workspaceId,
        () => mailbox,
        undefined,
        () => () => Effect.succeed(page(records, f.prepared.genesisHashHex, 0, 2))
      )
      assert.equal((yield* f.owner.host.ledgerView(workspaceId)).status.length, 2)
      const receive = new DatabaseSync(join(directory, 'workspaces', workspaceId, 'receive.sqlite'))
      assert.equal(
        receive.prepare("SELECT count(*) AS n FROM receive_tasks WHERE phase='Reported'").get().n,
        1
      )
      receive.close()
      const backend = new DatabaseSync(f.path)
      assert.equal(backend.prepare('SELECT count(*) AS n FROM mailbox_rejected').get().n, 0)
      backend.close()
      yield* f.owner.custody.discardDevice(joining)
    })
  )
})

void test('desktop reconciliation reaches more than one hundred genuine ledger recipients', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const f = yield* maintenanceFixture(directory)
      let view = f.view()
      const records = [Buffer.from(f.prepared.genesisRecordHex, 'hex')]
      const membershipId = view
        .inspectState()
        .devices.get(hex(f.device.publicKey.toBytes())).membershipId
      for (let index = 0; index < 105; index++) {
        const joining = yield* f.owner.custody.prepareDevice()
        const machineId = `synthetic-recipient-${index}`
        const possession = yield* prepareDeviceAdmission({
          genesis: f.genesis,
          membershipId,
          encryptionPublicKey: joining.enc,
          kind: 'machine',
          machineId,
          signer: joining
        })
        const record = yield* signLedgerRecord(
          Result.getOrThrow(
            prepareLedgerCommand(view, f.device.publicKey, {
              _tag: 'AdmitDevice',
              kind: 'machine',
              machineId,
              signingPublicKey: joining.publicKey,
              encryptionPublicKey: joining.enc,
              possessionSignature: possession.possessionSignature
            })
          ),
          f.device
        )
        records.push(record)
        view = Result.getOrThrow(
          extendLedger(view, [record], { head: hashRecordBytes(record), length: records.length })
        )
        yield* f.owner.custody.discardDevice(joining)
      }
      f.setView(view)
      for (let start = 0; start < records.length; start += 64) {
        yield* f.owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, f.prepared.genesisHashHex, start, Math.min(start + 64, records.length))
        )
      }
      yield* f.owner.host.keyRound(workspaceId, () => f.mailbox)
      const db = new DatabaseSync(f.path)
      assert.equal(
        db.prepare('SELECT count(DISTINCT recipient) AS n FROM mailbox_envelopes').get().n,
        106
      )
      db.close()
      const journal = new DatabaseSync(
        join(directory, 'workspaces', workspaceId, 'distribution.sqlite')
      )
      assert.equal(
        journal
          .prepare(
            "SELECT count(*) AS n FROM distribution_tasks WHERE phase='Observed' AND consumed=1"
          )
          .get().n,
        105
      )
      journal.close()
    })
  )
})

for (const senderHint of ['registered', 'unknown']) {
  for (const laterHonestRow of [false, true]) {
    void test(`sender hint ${senderHint} cannot reject original bytes and later honest row=${laterHonestRow} stays usable`, async (t) => {
      const directory = await fixture(t)
      await execute(
        Effect.gen(function* () {
          const f = yield* maintenanceFixture(directory)
          const joining = yield* f.owner.custody.prepareDevice()
          const unregistered = yield* f.owner.custody.prepareDevice()
          const membershipId = f
            .view()
            .inspectState()
            .devices.get(hex(f.device.publicKey.toBytes())).membershipId
          const admission = yield* signLedgerRecord(
            Result.getOrThrow(
              prepareLedgerCommand(
                f.view(),
                f.device.publicKey,
                yield* prepareDeviceAdmission({
                  genesis: f.genesis,
                  membershipId,
                  encryptionPublicKey: joining.enc,
                  kind: 'machine',
                  machineId: 'metadata-hint-target',
                  signer: joining
                })
              )
            ),
            f.device
          )
          const records = [Buffer.from(f.prepared.genesisRecordHex, 'hex'), admission]
          f.setView(
            Result.getOrThrow(
              extendLedger(f.view(), [admission], { head: hashRecordBytes(admission), length: 2 })
            )
          )
          yield* f.owner.host.ingestLedgerRecords(
            workspaceId,
            page(records, f.prepared.genesisHashHex, 0)
          )
          const local = new DatabaseSync(
            join(directory, 'workspaces', workspaceId, 'installed-keys.sqlite')
          )
          local
            .prepare('UPDATE installed_epoch_keys SET blob=? WHERE epoch=0')
            .run(new Uint8Array([1]))
          local.close()
          let spoof = true
          const hostile = {
            ...f.mailbox,
            fetch: (epoch, cursor, limit) =>
              f.mailbox.fetch(epoch, cursor, limit).pipe(
                Effect.map((p) => ({
                  ...p,
                  items: spoof
                    ? p.items.flatMap((row) => {
                        const changed = {
                          ...row,
                          sender:
                            senderHint === 'registered'
                              ? hex(joining.publicKey.toBytes())
                              : hex(unregistered.publicKey.toBytes())
                        }
                        return laterHonestRow ? [changed, row] : [changed]
                      })
                    : p.items
                }))
              )
          }
          yield* Effect.result(f.owner.host.keyRound(workspaceId, () => hostile))
          const remote = new DatabaseSync(f.path)
          try {
            assert.equal(
              remote
                .prepare('SELECT count(*) AS n FROM mailbox_rejected WHERE digest=?')
                .get(mailboxDigest(f.frame)).n,
              0,
              'untrusted sender metadata cannot permanently reject the authentic frame digest'
            )
            assert.equal(
              (yield* f.owner.host.status(workspaceId)).hasCurrentKey,
              laterHonestRow,
              'a metadata mismatch must not stop the following honest envelope'
            )
            spoof = false
            yield* f.mailbox.put('ab'.repeat(16), f.frame)
            yield* f.owner.host.keyRound(workspaceId, () => hostile)
            assert.equal((yield* f.owner.host.status(workspaceId)).hasCurrentKey, true)
            assert.equal(
              (yield* f.mailbox.fetch(0, null, 100)).items.some(
                (row) => mailboxDigest(row.frame) === mailboxDigest(f.frame)
              ),
              true
            )
          } finally {
            remote.close()
            yield* f.owner.custody.discardDevice(joining)
            yield* f.owner.custody.discardDevice(unregistered)
          }
        })
      )
    })
  }
}

void test('member controls use ordinary durable records and keep the old epoch available', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const prepared = yield* bind(owner)
      const records = yield* makeRecords(owner.custody, prepared, 2)
      yield* owner.host.open(workspaceId)
      yield* owner.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 0))
      const remote = () => ({
        staging: () => ({
          stageGroup: () => Effect.die('member commands must not stage a candidate'),
          readGroup: () => Effect.die('member commands must not read a candidate'),
          deleteGroup: () => Effect.die('member commands must not delete a candidate')
        }),
        mailbox: () => {
          throw new Error('member commands must not receive a candidate')
        },
        log: {
          read: () =>
            Effect.sync(() => ({
              records: records.map((x) => new Uint8Array(x)),
              checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
            })),
          appendCas: (_genesis, point, original) =>
            Effect.sync(() => {
              assert.equal(
                hex(point.head.toBytes()),
                hex(hashRecordBytes(records.at(-1)).toBytes())
              )
              records.push(new Uint8Array(original))
            })
        },
        history: () => Effect.succeed(page(records, prepared.genesisHashHex, 0))
      })
      const membershipId = '11'.repeat(16)
      assert.equal(
        yield* owner.host.manage(
          workspaceId,
          { type: 'setRole', membershipId, role: 'admin' },
          remote
        ),
        'Committed'
      )
      assert.equal((yield* owner.host.status(workspaceId)).epoch, 0)
      assert.equal(
        yield* owner.host.manage(
          workspaceId,
          { type: 'setRole', membershipId, role: 'member' },
          remote
        ),
        'Committed'
      )
      assert.equal(
        yield* owner.host.manage(workspaceId, { type: 'removeMember', membershipId }, remote),
        'Committed'
      )
      const status = yield* owner.host.status(workspaceId)
      assert.equal(status.epoch, 0)
      assert.equal(status.rotationRequired, true)
      assert.equal(status.hasCurrentKey, true)
      assert.equal(status.memberRole, 'owner')
      const management = yield* owner.host.managementState(workspaceId)
      assert.equal(management.rotationRequired, true)
      assert.equal(management.mayRotate, true)
      assert.equal(management.updatePending, false)
      const count = records.length
      assert.equal(
        yield* owner.host.manage(workspaceId, { type: 'removeMember', membershipId }, remote),
        'Committed'
      )
      assert.equal(records.length, count)
      assert.deepEqual(
        records
          .slice(-2)
          .map((record) => Result.getOrThrow(decodeRecord(record)).body.operation.type),
        ['declareCapabilities', 'removeMember']
      )
    })
  )
})

void test('ownership transfer signs one ordinary record and leaves the former owner an admin', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const prepared = yield* bind(owner)
      const records = yield* makeRecords(owner.custody, prepared, 2)
      yield* owner.host.open(workspaceId)
      yield* owner.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 0))
      const remote = () => ({
        staging: () => ({
          stageGroup: () => Effect.die('member commands must not stage a candidate'),
          readGroup: () => Effect.die('member commands must not read a candidate'),
          deleteGroup: () => Effect.die('member commands must not delete a candidate')
        }),
        mailbox: () => {
          throw new Error('member commands must not receive a candidate')
        },
        log: {
          read: () =>
            Effect.sync(() => ({
              records: records.map((x) => new Uint8Array(x)),
              checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
            })),
          appendCas: (_genesis, point, original) =>
            Effect.sync(() => {
              assert.equal(
                hex(point.head.toBytes()),
                hex(hashRecordBytes(records.at(-1)).toBytes())
              )
              records.push(new Uint8Array(original))
            })
        },
        history: () => Effect.succeed(page(records, prepared.genesisHashHex, 0))
      })
      const membershipId = '11'.repeat(16)
      // A member that does not exist cannot receive ownership.
      const missing = yield* Effect.result(
        owner.host.manage(
          workspaceId,
          { type: 'transferOwner', membershipId: '99'.repeat(16) },
          remote
        )
      )
      assert.equal(missing._tag, 'Failure')
      assert.equal(
        yield* owner.host.manage(workspaceId, { type: 'transferOwner', membershipId }, remote),
        'Committed'
      )
      assert.equal(
        Result.getOrThrow(decodeRecord(records.at(-1))).body.operation.type,
        'transferOwner'
      )
      const status = yield* owner.host.status(workspaceId)
      assert.equal(status.memberRole, 'admin')
      // Keys are unchanged: a transfer is not a removal.
      assert.equal(status.rotationRequired, false)
      // The former owner has no authority to transfer again.
      const again = yield* Effect.result(
        owner.host.manage(workspaceId, { type: 'transferOwner', membershipId }, remote)
      )
      assert.equal(again._tag, 'Failure')
    })
  )
})

void test('member removal reopens its uncertain original and never signs a replacement', async (t) => {
  const directory = await fixture(t)
  let records,
    prepared,
    uncertain,
    blocked = false
  const membershipId = '11'.repeat(16)
  const remote = () => ({
    staging: () => ({
      stageGroup: () => Effect.die('member commands must not stage a candidate'),
      readGroup: () => Effect.die('member commands must not read a candidate'),
      deleteGroup: () => Effect.die('member commands must not delete a candidate')
    }),
    mailbox: () => {
      throw new Error('member commands must not receive a candidate')
    },
    log: {
      read: () =>
        blocked
          ? Effect.fail(new Error('synthetic readback unavailable'))
          : Effect.succeed({
              records: records.map((x) => new Uint8Array(x)),
              checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
            }),
      appendCas: (_genesis, _point, original) =>
        Effect.suspend(() => {
          records.push(new Uint8Array(original))
          if (Result.getOrThrow(decodeRecord(original)).body.operation.type === 'removeMember') {
            uncertain = new Uint8Array(original)
            blocked = true
            return Effect.fail(new Error('synthetic lost ACK'))
          }
          return Effect.void
        })
    },
    history: () =>
      blocked
        ? Effect.fail(new Error('synthetic history unavailable'))
        : Effect.succeed(page(records, prepared.genesisHashHex, 0))
  })
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      prepared = yield* bind(owner)
      records = yield* makeRecords(owner.custody, prepared, 2)
      yield* owner.host.open(workspaceId)
      yield* owner.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 0))
      assert.equal(
        (yield* Effect.result(
          owner.host.manage(workspaceId, { type: 'removeMember', membershipId }, remote)
        ))._tag,
        'Failure'
      )
    })
  )
  const count = records.length
  blocked = false
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      yield* owner.host.open(workspaceId)
      assert.equal(
        yield* owner.host.manage(workspaceId, { type: 'removeMember', membershipId }, remote),
        'Committed'
      )
      assert.equal(records.length, count)
      assert.deepEqual(records.at(-1), uncertain)
      assert.equal((yield* owner.host.status(workspaceId)).epoch, 0)
      assert.equal((yield* owner.host.status(workspaceId)).rotationRequired, true)
    })
  )
})

// A successful recovery settles the old request, not an unrelated new click.
for (const difference of ['role', 'type', 'membershipId']) {
  void test(`ordinary management recovery compares the full ${difference} intent`, async (t) => {
    const directory = await fixture(t)
    let records,
      prepared,
      original,
      blocked = false
    const firstId = '11'.repeat(16),
      secondId = '22'.repeat(16)
    const before =
      difference === 'membershipId'
        ? { type: 'removeMember', membershipId: firstId }
        : { type: 'setRole', membershipId: firstId, role: 'admin' }
    const after =
      difference === 'role'
        ? { type: 'setRole', membershipId: firstId, role: 'member' }
        : { type: 'removeMember', membershipId: difference === 'membershipId' ? secondId : firstId }
    const remote = () => ({
      staging: () => ({
        stageGroup: () => Effect.die('ordinary commands cannot stage'),
        readGroup: () => Effect.die('ordinary commands cannot read staging'),
        deleteGroup: () => Effect.die('ordinary commands cannot delete staging')
      }),
      mailbox: () => {
        throw new Error('ordinary commands cannot receive')
      },
      history: () =>
        blocked
          ? Effect.fail(new Error('synthetic history unavailable'))
          : Effect.succeed(page(records, prepared.genesisHashHex, 0)),
      log: {
        read: () =>
          blocked
            ? Effect.fail(new Error('synthetic readback unavailable'))
            : Effect.succeed({
                records,
                checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
              }),
        appendCas: (_genesis, point, record) =>
          Effect.suspend(() => {
            assert.equal(point.head.equals(hashRecordBytes(records.at(-1))), true)
            records.push(new Uint8Array(record))
            if (
              !original &&
              Result.getOrThrow(decodeRecord(record)).body.operation.type !== 'declareCapabilities'
            ) {
              original = new Uint8Array(record)
              blocked = true
              return Effect.fail(new Error('synthetic lost ACK'))
            }
            return Effect.void
          })
      }
    })
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        prepared = yield* bind(owner)
        records = yield* makeRecords(owner.custody, prepared, 2)
        if (difference === 'membershipId') {
          const genesis = Result.getOrThrow(
            Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
          )
          const signer = yield* owner.custody.openDevice(genesis),
            joining = yield* owner.custody.prepareDevice()
          const request = yield* prepareJoinRequest({
            genesis,
            requestId: Result.getOrThrow(Bytes.requestId(Buffer.alloc(16, 34))),
            userId: Result.getOrThrow(Bytes.userId(Buffer.alloc(32, 35))),
            encryptionPublicKey: joining.enc,
            expiresAt: null,
            signer: joining
          })
          const view = Result.getOrThrow(
            verifyLedger({
              anchor: genesis,
              records,
              checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
            })
          )
          records.push(
            yield* signLedgerRecord(
              Result.getOrThrow(
                prepareLedgerCommand(view, signer.publicKey, {
                  _tag: 'AdmitMember',
                  membershipId: Result.getOrThrow(Bytes.membershipId(Buffer.from(secondId, 'hex'))),
                  request
                })
              ),
              signer
            )
          )
          yield* owner.custody.discardDevice(joining)
        }
        yield* owner.host.open(workspaceId)
        yield* owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, prepared.genesisHashHex, 0)
        )
        assert.equal(
          Result.isFailure(yield* Effect.result(owner.host.manage(workspaceId, before, remote))),
          true
        )
      })
    )
    const uncertainLength = records.length
    blocked = false
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        yield* owner.host.open(workspaceId)
        assert.equal(yield* owner.host.manage(workspaceId, after, remote), 'Committed')
        assert.ok(records.length > uncertainLength, 'the new intent must commit after old recovery')
        assert.equal(
          records.filter((record) => Buffer.from(record).equals(Buffer.from(original))).length,
          1
        )
        const op = Result.getOrThrow(decodeRecord(records.at(-1))).body.operation
        assert.equal(op.type, after.type)
        assert.equal(hex(op.membershipId.toBytes()), after.membershipId)
        if (after.type === 'setRole') assert.equal(op.role, after.role)
        assert.equal((yield* owner.host.status(workspaceId)).epoch, 0)
      })
    )
  })
}

void test('member operation history releases on workspace close without reentering the account coordinator', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory),
        prepared = yield* bind(owner)
      const records = yield* makeRecords(owner.custody, prepared, 2)
      yield* owner.host.open(workspaceId)
      yield* owner.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 0))
      const entered = Deferred.makeUnsafe(),
        release = Deferred.makeUnsafe(),
        stopped = Deferred.makeUnsafe()
      const work = yield* Effect.forkChild(
        owner.host.manage(
          workspaceId,
          { type: 'removeMember', membershipId: '11'.repeat(16) },
          (signal) => {
            signal.addEventListener('abort', () => Deferred.doneUnsafe(stopped, Effect.void), {
              once: true
            })
            return {
              staging: () => ({
                stageGroup: () => Effect.die('member commands must not stage a candidate'),
                readGroup: () => Effect.die('member commands must not read a candidate'),
                deleteGroup: () => Effect.die('member commands must not delete a candidate')
              }),
              mailbox: () => {
                throw new Error('member commands must not receive a candidate')
              },
              log: {
                read: () => Effect.die('not reached'),
                appendCas: () => Effect.die('not reached')
              },
              history: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                  return page(records, prepared.genesisHashHex, 0)
                })
            }
          }
        )
      )
      yield* Deferred.await(entered)
      const close = yield* Effect.forkChild(owner.host.closeWorkspace(workspaceId))
      yield* Deferred.await(stopped)
      yield* Deferred.succeed(release, undefined)
      assert.equal(Exit.isFailure(yield* Fiber.await(work)), true)
      yield* Fiber.join(close)
      const reopened = yield* owner.host.open(workspaceId)
      assert.equal(reopened.epoch, 0)
      assert.equal(reopened.rotationRequired, false)
      assert.equal(records.length, 2)
    })
  )
})

void test('sharing host retains an unknown owner original across reopen and preserves execution refusals', async (t) => {
  const directory = await fixture(t)
  let prepared,
    head = null,
    version = null,
    lost = true
  let commits = 0
  const remote = {
    readHead: () => Effect.succeed(head),
    readVersion: () => Effect.succeed(version),
    readRequest: () => Effect.succeed(version),
    commit: (input) =>
      Effect.gen(function* () {
        commits++
        const { credential: _credential, expectedHead: _expectedHead, ...original } = input
        const { machineSharingDigest } = yield* Effect.promise(
          () => import('@lody/e2ee-core/protocol')
        )
        version = {
          ...original,
          digest: Result.getOrThrow(machineSharingDigest(Buffer.from(input.frameHex, 'hex')))
        }
        head = {
          workspaceId,
          genesisHash: input.genesisHash,
          machineId: input.machineId,
          ownerMembershipId: input.ownerMembershipId,
          generation: input.generation,
          revision: input.revision,
          digest: version.digest,
          status: 'active'
        }
        if (lost) return yield* Effect.fail(new Error('synthetic lost response'))
        return { status: 'committed', version }
      })
  }
  const change = { kind: 'project', localProjectId: 'project-a', sharedWithTeam: true }
  const rid = '19'.repeat(16)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      prepared = yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const genesis = Result.getOrThrow(
        Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
      )
      const signer = yield* owner.custody.openDevice(genesis)
      const machine = yield* owner.custody.prepareDevice()
      let view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records: [Buffer.from(prepared.genesisRecordHex, 'hex')],
          checkpoint: {
            length: 1,
            head: hashRecordBytes(Buffer.from(prepared.genesisRecordHex, 'hex'))
          }
        })
      )
      const admission = yield* prepareDeviceAdmission({
        genesis,
        membershipId: view.inspectState().owner,
        encryptionPublicKey: machine.enc,
        kind: 'machine',
        machineId: 'synthetic-machine',
        signer: machine
      })
      const record = yield* signLedgerRecord(
        Result.getOrThrow(prepareLedgerCommand(view, signer.publicKey, admission)),
        signer
      )
      yield* owner.host.ingestLedgerRecords(
        workspaceId,
        page([Buffer.from(prepared.genesisRecordHex, 'hex'), record], prepared.genesisHashHex, 0)
      )
      assert.deepEqual(
        yield* owner.host.updateMachineSharing(
          workspaceId,
          'synthetic-machine',
          version?.generation ??
            (yield* owner.host.readMachineSharing(workspaceId, 'synthetic-machine', remote))
              .generation,
          rid,
          change,
          remote
        ),
        { status: 'pending', requestId: rid }
      )
    })
  )
  const original = version.frameHex
  lost = false
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      yield* owner.host.open(workspaceId)
      assert.deepEqual(
        yield* owner.host.updateMachineSharing(
          workspaceId,
          'synthetic-machine',
          version?.generation ??
            (yield* owner.host.readMachineSharing(workspaceId, 'synthetic-machine', remote))
              .generation,
          rid,
          change,
          remote
        ),
        { status: 'saved', requestId: rid }
      )
      const state = yield* owner.host.readMachineSharing(workspaceId, 'synthetic-machine', remote)
      assert.equal(state.sharedWithTeam, true)
      assert.deepEqual(state.projects, ['project-a'])
      const refused = yield* Effect.result(
        owner.host.prepareDispatch(
          workspaceId,
          'missing-machine',
          {
            sessionId: 'session',
            userTurnId: 'turn',
            userId: 'display-only',
            timestamp: new Date(0).toISOString(),
            inputConfig: {}
          },
          remote
        )
      )
      assert.equal(refused.failure.code, 'machine_not_owned')
    })
  )
  assert.equal(version.frameHex, original)
  assert.equal(commits, 1)
})

void test('signs a schedule declaration over the fingerprint it computes itself', async (t) => {
  const directory = await fixture(t)
  const document = {
    definition: {
      scheduleId: 'synthetic-schedule',
      title: 'Synthetic',
      ownerId: 'owner',
      machineId: 'fixture-machine',
      enabled: true,
      activationId: 'activation',
      activeFrom: 0,
      trigger: { kind: 'interval', everyMs: 60_000, anchorAt: '2026-01-01T00:00:00Z' },
      misfirePolicy: { kind: 'skip' },
      overlapPolicy: 'queue_one',
      agent: { agentConfigId: 'agent', modeId: 'safe' },
      retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
      createdAt: 0,
      updatedAt: 0,
      createdBy: 'owner'
    },
    prompt: 'synthetic scheduled input'
  }
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const status = yield* owner.host.status(workspaceId)
      const manualRunKey = 'ab'.repeat(32)
      const record = decodeE2eeIntentRecord(
        yield* owner.host.signScheduleDeclaration(workspaceId, document, manualRunKey)
      )
      assert.equal(Buffer.from(record.signer).toString('hex'), status.signingPublicKey)
      const subject = scheduleDeclarationSubject(document, manualRunKey)
      const intent = {
        ...subject,
        genesis: Result.getOrThrow(Bytes.genesisHash(Buffer.from(status.genesisHash, 'hex'))),
        workspaceId,
        contentDigest: Buffer.from(subject.contentDigest, 'hex')
      }
      assert.equal(
        Result.isSuccess(verifyExecutionIntent(intent, record.signer, record.signature)),
        true
      )
      // It binds this definition and run only.
      assert.equal(
        Result.isFailure(
          verifyExecutionIntent(
            { ...intent, messageId: 'definition' },
            record.signer,
            record.signature
          )
        ),
        true
      )
      const refused = yield* Effect.result(
        owner.host.signScheduleDeclaration(workspaceId, { ...document, prompt: '' })
      )
      assert.equal(refused.failure.code, 'invalid-input')
    })
  )
})

void test('passive cache state never opens workspace custody or changes sibling entries', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      expectNoEntry(yield* owner.host.inspectCachedState(workspaceId, 'fixture-machine'))
      assert.equal(existsSync(join(directory, 'workspaces', workspaceId)), false)
      yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const before = yield* owner.host.status(workspaceId)
      const snapshot = yield* owner.host.inspectCachedState(workspaceId, 'fixture-machine')
      assert.equal(snapshot.entryPresent, true)
      assert.equal(snapshot.cachedExecutionGrants, 0)
      assert.deepEqual(yield* owner.host.status(workspaceId), before)
      expectNoEntry(yield* owner.host.inspectCachedState('unopened-sibling', 'fixture-machine'))
      assert.equal(existsSync(join(directory, 'workspaces', 'unopened-sibling')), false)
    })
  )
})

void test('unchanged verified ledger refresh retains sharing cache; a real advance clears it', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const f = yield* sharingCacheFixture(directory)
      const cached = yield* f.cache()
      // Empty current page, exact replay and older verified overlap are all no-ops.
      for (const start of [f.records.length, 0, 1]) {
        yield* f.owner.host.ingestLedgerRecords(
          workspaceId,
          page(f.records, f.prepared.genesisHashHex, start)
        )
        assert.deepEqual(yield* f.cache(), cached)
      }
      yield* f.append({
        _tag: 'SetRole',
        membershipId: Result.getOrThrow(Bytes.membershipId(Buffer.alloc(16, 17))),
        role: 'admin'
      })
      yield* f.ingest()
      assert.equal((yield* f.cache()).cachedExecutionGrants, 0)
    })
  )
})

for (const change of ['member revocation', 'device revocation', 'epoch', 'generation']) {
  void test(`verified ${change} immediately clears the native sharing cache`, async (t) => {
    const directory = await fixture(t)
    await execute(
      Effect.gen(function* () {
        const f = yield* sharingCacheFixture(directory)
        if (change === 'member revocation') {
          yield* f.append({
            _tag: 'RemoveMember',
            membershipId: Result.getOrThrow(Bytes.membershipId(Buffer.alloc(16, 17)))
          })
        } else {
          yield* f.append({ _tag: 'RevokeDevice', target: f.machine.publicKey })
          if (change === 'generation') {
            const replacement = yield* f.owner.custody.prepareDevice()
            yield* f.append(
              yield* prepareDeviceAdmission({
                genesis: f.genesis,
                membershipId: f.view().inspectState().owner,
                encryptionPublicKey: replacement.enc,
                kind: 'machine',
                machineId: 'cache-machine',
                signer: replacement
              })
            )
            yield* f.owner.custody.discardDevice(replacement)
          } else if (change === 'epoch') {
            yield* f.append(
              Result.getOrThrow(
                encodeCbor([
                  f.view().head.toBytes(),
                  f.signer.publicKey.toBytes(),
                  [7, 1, Buffer.alloc(32, 81), Buffer.alloc(72, 82)]
                ])
              )
            )
          }
        }
        yield* f.ingest()
        assert.equal((yield* f.cache()).cachedExecutionGrants, 0)
        if (change === 'generation') {
          const current = yield* f.owner.host.readMachineSharing(
            workspaceId,
            'cache-machine',
            f.remote
          )
          assert.notEqual(current.generation, f.generation)
          assert.equal(current.sharedWithTeam, false)
          assert.equal(current.head, null)
          assert.equal((yield* f.cache()).cachedExecutionGrants, 0)
        }
      })
    )
  })
}

for (const advance of [false, true]) {
  void test(`a policy read racing ingest advance=${advance} follows the verified head`, async (t) => {
    const directory = await fixture(t)
    await execute(
      Effect.gen(function* () {
        const f = yield* sharingCacheFixture(directory)
        const entered = Deferred.makeUnsafe(),
          release = Deferred.makeUnsafe()
        const slow = {
          ...f.remote,
          readHead: (binding) =>
            Effect.gen(function* () {
              const head = yield* f.remote.readHead(binding)
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return head
            })
        }
        const reading = yield* Effect.forkChild(
          Effect.result(f.owner.host.readMachineSharing(workspaceId, 'cache-machine', slow))
        )
        yield* Deferred.await(entered)
        if (advance)
          yield* f.append({
            _tag: 'SetRole',
            membershipId: Result.getOrThrow(Bytes.membershipId(Buffer.alloc(16, 17))),
            role: 'admin'
          })
        yield* f.ingest()
        yield* Deferred.succeed(release, undefined)
        const result = yield* Fiber.join(reading)
        if (advance) {
          assert.equal(result.failure?.code, 'sharing_unavailable')
          assert.equal((yield* f.cache()).cachedExecutionGrants, 0)
        } else {
          assert.equal(Result.getOrThrow(result).sharedWithTeam, true)
          assert.equal((yield* f.cache()).cachedExecutionGrants, 1)
        }
        assert.equal(
          (yield* f.owner.host.readMachineSharing(workspaceId, 'cache-machine', f.remote))
            .sharedWithTeam,
          true
        )
        assert.equal((yield* f.cache()).cachedExecutionGrants, 1)
      })
    )
  })
}

void test('an iroh call that outlives its budget is cancelled and rejects for Streams fallback', async (t) => {
  const { makeIrohRoute } = await import('./e2ee-iroh.mts')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release
  const call = {
    // The machine accepted the stream but never replies or finishes it.
    nextReply: () => new Promise((resolve) => (release = resolve)),
    cancel: () => release?.(null)
  }
  const route = makeIrohRoute(
    {
      hasConnection: async () => true,
      warm: async () => undefined,
      call: async () => call
    },
    'aa'.repeat(32),
    new Set()
  )
  assert.equal(await route.ready(), true)
  const pending = route.call({ id: 'bb'.repeat(16), frame: 'cc'.repeat(200) }, 800)
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(800)
  await assert.rejects(pending, /iroh_timeout/)
})

void test('desktop status skips an abandoned retained write hint with only K1 installed', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory),
        prepared = yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const genesis = Result.getOrThrow(
        Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
      )
      const signer = yield* owner.custody.openDevice(genesis),
        records = [Buffer.from(prepared.genesisRecordHex, 'hex')]
      let view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records,
          checkpoint: { head: hashRecordBytes(records[0]), length: 1 }
        })
      )
      const append = Effect.fnUntraced(function* (op) {
        const body = Result.getOrThrow(
          encodeCbor([view.head.toBytes(), signer.publicKey.toBytes(), op])
        )
        const record = yield* signLedgerRecord(
          Result.getOrThrow(prepareLedgerRecord(view, body)),
          signer
        )
        records.push(record)
        view = Result.getOrThrow(
          extendLedger(view, [record], { head: hashRecordBytes(record), length: records.length })
        )
      })
      const ports = Layer.mergeAll(
        desktopE2eePorts(owner.custody, signer),
        Layer.succeed(WorkspaceScope, { genesis }),
        Layer.succeed(LedgerViewSource, { current: () => Effect.succeed(view) }),
        Layer.succeed(LedgerPinStore, {
          read: () => Effect.succeed(null),
          write: () => Effect.void
        })
      )
      const path = join(directory, 'workspaces', workspaceId, 'installed-keys.sqlite')
      const keys = Context.get(
        yield* Layer.build(
          InstalledEpochKeys.layer.pipe(
            Layer.provideMerge(sqliteInstalledKeyStore({ path, mode: 'open' })),
            Layer.provideMerge(VerifiedLedger.layer),
            Layer.provideMerge(ports)
          )
        ),
        InstalledEpochKeys
      )
      const key1 = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(71))),
        key2 = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(72)))
      try {
        const base = yield* keys.read(0)
        try {
          yield* append([
            7,
            1,
            Result.getOrThrow(commitEpochKey(genesis, 1, key1)).toBytes(),
            Result.getOrThrow(
              sealHistoryPacket({ genesis, epoch: 1, currentKey: key1, previousKey: base })
            )
          ])
          yield* keys.saveAndReload(1, key1)
          const db = new DatabaseSync(path)
          try {
            db.exec('DELETE FROM installed_epoch_keys WHERE epoch = 0')
          } finally {
            db.close()
          }
          yield* owner.host.ingestLedgerRecords(
            workspaceId,
            page(records, prepared.genesisHashHex, 0)
          )
          assert.equal((yield* owner.host.status(workspaceId)).writeEpoch, 1)
          yield* append([9, [2]])
          yield* append([
            11,
            2,
            Result.getOrThrow(commitEpochKey(genesis, 2, key2)).toBytes(),
            0,
            Result.getOrThrow(
              sealHistoryPacket({
                genesis,
                epoch: 2,
                baseEpoch: 0,
                currentKey: key2,
                previousKey: base
              })
            )
          ])
          yield* owner.host.ingestLedgerRecords(
            workspaceId,
            page(records, prepared.genesisHashHex, 0)
          )
          assert.equal((yield* owner.host.status(workspaceId)).writeEpoch, null)
          assert.equal((yield* owner.host.status(workspaceId)).writeEpoch, null)
          yield* keys.check(1) // Historical key installation remains intact.
        } finally {
          disposeEpochKey(base)
        }
      } finally {
        disposeEpochKey(key1)
        disposeEpochKey(key2)
      }
    })
  )
})

for (const inlineHistory of [true, false]) {
  void test(`revoke persists the suffix with ${inlineHistory ? 2 : 3} cloud actions and no genesis download`, async (t) => {
    const directory = await fixture(t)
    const { makeE2eeCloudClient } = await import('./e2ee-cloud-client.mts')
    let target
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        const prepared = yield* bind(owner)
        const genesis = Result.getOrThrow(
          Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
        )
        const signer = yield* owner.custody.openDevice(genesis)
        const machine = yield* owner.custody.prepareDevice()
        let records = [Buffer.from(prepared.genesisRecordHex, 'hex')]
        let view = Result.getOrThrow(
          verifyLedger({
            anchor: genesis,
            records,
            checkpoint: { head: hashRecordBytes(records[0]), length: 1 }
          })
        )
        const admission = yield* prepareDeviceAdmission({
          genesis,
          membershipId: view.inspectState().owner,
          signer: machine,
          encryptionPublicKey: machine.enc,
          kind: 'machine',
          machineId: 'revocation-performance'
        })
        const admitted = yield* signLedgerRecord(
          Result.getOrThrow(prepareLedgerCommand(view, signer.publicKey, admission)),
          signer
        )
        records.push(admitted)
        view = Result.getOrThrow(
          extendLedger(view, [admitted], { head: hashRecordBytes(admitted), length: 2 })
        )
        target = hex(machine.publicKey.toBytes())
        yield* owner.custody.discardDevice(machine)
        yield* owner.host.open(workspaceId)
        yield* owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, prepared.genesisHashHex, 0)
        )
        const calls = []
        const client = yield* makeE2eeCloudClient({
          platformKind: 'cloud',
          deploymentUrl: 'https://synthetic.convex.cloud',
          convexToken: async () => ({ data: { token: 'synthetic-jwt' } }),
          fetch: async (_url, init) => {
            const {
              path,
              args: [args]
            } = JSON.parse(init.body)
            calls.push({ path, args })
            let value
            if (path === 'e2eeWorkspaces:history') {
              assert.ok(args.after, 'bootstrapped management must use an opaque suffix position')
              value = page(records, prepared.genesisHashHex, 2)
            } else {
              assert.equal(path, 'e2eeWorkspaces:appendRecord')
              assert.deepEqual(Object.keys(args).sort(), ['recordHex', 'requestId', 'workspaceId'])
              const record = new Uint8Array(Buffer.from(args.recordHex, 'hex'))
              view = Result.getOrThrow(
                extendLedger(view, [record], {
                  head: hashRecordBytes(record),
                  length: view.length + 1
                })
              )
              records = [...records, record]
              value = {
                status: 'committed',
                recordHash: hex(hashRecordBytes(record).toBytes()),
                ...(inlineHistory ? { historyPage: page(records, prepared.genesisHashHex, 2) } : {})
              }
            }
            return Response.json({ status: 'success', value })
          }
        })
        const result = yield* owner.host.manage(
          workspaceId,
          { type: 'revoke', target },
          (signal, feed) => ({
            log: client.ledgerLog(workspaceId, signal, feed),
            history: (request) => client.history(request, signal),
            staging: () => {
              throw new Error('revocation must not stage keys')
            },
            mailbox: () => {
              throw new Error('revocation must not receive keys')
            }
          })
        )
        assert.equal(result, 'Committed')
        const local = yield* owner.host.status(workspaceId)
        assert.equal(local.length, 3)
        assert.equal(local.headHash, hex(view.head.toBytes()))
        assert.equal(
          (yield* owner.host.managementState(workspaceId)).devices.some(
            (device) => device.key === target
          ),
          false
        )
        assert.equal(
          calls.filter((call) => call.path === 'e2eeWorkspaces:history').length,
          inlineHistory ? 1 : 2
        )
        assert.equal(calls.filter((call) => call.path === 'e2eeWorkspaces:appendRecord').length, 1)
      })
    )
    await execute(
      Effect.gen(function* () {
        const reopened = yield* ownerWithHost(directory)
        yield* reopened.host.open(workspaceId)
        assert.equal((yield* reopened.host.status(workspaceId)).length, 3)
        assert.equal(
          (yield* reopened.host.managementState(workspaceId)).devices.some(
            (device) => device.key === target
          ),
          false
        )
      })
    )
  })
}
