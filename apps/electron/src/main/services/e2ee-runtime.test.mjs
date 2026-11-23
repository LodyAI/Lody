import {
  BackendError,
  Bytes,
  Context,
  DatabaseSync,
  Effect,
  Exit,
  KeyMailbox,
  Layer,
  Result,
  Scope,
  accountUserId,
  assert,
  bind,
  createDesktopQuitBarrier,
  decodeMemberKeyPackage,
  drainMainProcessQuitResources,
  execute,
  fixture,
  hashRecordBytes,
  hex,
  historyDb,
  intent,
  join,
  makeDesktopE2eeRuntimeHost,
  makeDesktopLocalPairing,
  makeRecords,
  makeSqliteKeyMailbox,
  memberWithHost,
  openOwner,
  ownerWithHost,
  page,
  prepareDeviceAdmission,
  prepareLedgerCommand,
  readFile,
  referenceKeyMailbox,
  rm,
  signDeviceCredentialBinding,
  signLedgerRecord,
  test,
  verifyLedger,
  workspaceId,
  writeFile
} from './e2ee-runtime-test-helpers.mjs'

for (const damage of ['history', 'pin']) {
  void test(`damaged authoritative ${damage} has a distinct recovery code and preserves originals`, async (t) => {
    const directory = await fixture(t)
    let prepared, records
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        prepared = yield* bind(owner)
        records = yield* makeRecords(owner.custody, prepared, 3)
        yield* owner.host.open(workspaceId)
        yield* owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, prepared.genesisHashHex, 0)
        )
      })
    )
    const pinPath = join(directory, 'workspaces', workspaceId, 'ledger-pin.sqlite')
    const pin = new DatabaseSync(pinPath)
    const trusted = pin.prepare('SELECT * FROM ledger_pin').all()
    if (damage === 'pin') pin.exec('UPDATE ledger_pin SET count=0')
    pin.close()
    const damaged = records[2].slice()
    damaged[damaged.length - 1] ^= 1
    if (damage === 'history')
      historyDb(directory, (db) =>
        db.prepare('UPDATE records SET record=? WHERE position=2').run(damaged)
      )
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        const failed = yield* Effect.result(owner.host.open(workspaceId))
        assert.equal(
          failed.failure.code,
          damage === 'history' ? 'local-history-recovery-required' : 'trusted-pin-unavailable'
        )
        const managementFailure = yield* Effect.result(
          owner.host.manage(workspaceId, { type: 'rotate' }, () => {
            throw new Error('unusable host must not access remote ports')
          })
        )
        assert.equal(managementFailure.failure.code, failed.failure.code)
        // The damaged workspace cannot prevent another independent workspace opening.
        const next = yield* owner.bootstrap.prepareCreation({
          ...intent,
          requestId: 'second-recovery-request',
          slug: 'second'
        })
        yield* owner.bootstrap.recordCreated({
          workspaceId: 'second-workspace',
          genesisHash: next.genesisHashHex,
          requestId: 'second-recovery-request'
        })
        assert.equal((yield* owner.host.open('second-workspace')).hasCurrentKey, true)
      })
    )
    const after = new DatabaseSync(pinPath)
    if (damage === 'history')
      assert.deepEqual(after.prepare('SELECT * FROM ledger_pin').all(), trusted)
    else assert.equal(after.prepare('SELECT count FROM ledger_pin').get().count, 0)
    after.close()
    if (damage === 'history')
      historyDb(directory, (db) =>
        assert.deepEqual(
          new Uint8Array(db.prepare('SELECT record FROM records WHERE position=2').get().record),
          damaged
        )
      )
  })
}

void test('a failed workspace finalizer reports restart, retains its fence and leaves a sibling available', async (t) => {
  const directory = await fixture(t)
  const scope = Effect.runSync(Scope.make())
  const run = (work) => Effect.runPromise(work.pipe(Scope.provide(scope)))
  const owner = await run(ownerWithHost(directory))
  await run(bind(owner))
  await run(owner.host.open(workspaceId))
  const next = await run(
    owner.bootstrap.prepareCreation({
      ...intent,
      requestId: 'sibling-finalizer-request',
      slug: 'sibling'
    })
  )
  await run(
    owner.bootstrap.recordCreated({
      workspaceId: 'sibling',
      genesisHash: next.genesisHashHex,
      requestId: 'sibling-finalizer-request'
    })
  )
  await run(owner.host.open('sibling'))
  const original = DatabaseSync.prototype.close
  let retained
  try {
    DatabaseSync.prototype.close = function () {
      retained = this
      throw new Error('synthetic history close failure')
    }
    const failed = await run(Effect.exit(owner.host.closeWorkspace(workspaceId)))
    DatabaseSync.prototype.close = original
    assert.equal(Exit.isFailure(failed), true)
    const blocked = await run(Effect.result(owner.host.open(workspaceId)))
    assert.equal(blocked.failure.code, 'restart-required')
    const managementFailure = await run(
      Effect.result(
        owner.host.manage(workspaceId, { type: 'rotate' }, () => {
          throw new Error('failed close must not access remote ports')
        })
      )
    )
    assert.equal(managementFailure.failure.code, 'restart-required')
    assert.equal((await run(owner.host.status('sibling'))).hasCurrentKey, true)
    const retry = await run(Effect.exit(owner.host.closeWorkspace(workspaceId)))
    assert.equal(Exit.isFailure(retry), true)
  } finally {
    DatabaseSync.prototype.close = original
    if (retained) original.call(retained)
    await run(Effect.exit(Scope.close(scope, Exit.void)))
  }
})

for (const damage of ['history', 'pin']) {
  void test(`a corrupt ${damage} SQLite image preserves bytes and reports a safe recovery code`, async (t) => {
    const directory = await fixture(t)
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        yield* bind(owner)
        yield* owner.host.open(workspaceId)
      })
    )
    const path = join(
      directory,
      'workspaces',
      workspaceId,
      damage === 'history' ? 'history.sqlite' : 'ledger-pin.sqlite'
    )
    const original = Buffer.from('synthetic damaged SQLite image')
    await writeFile(path, original)
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        const failed = yield* Effect.result(owner.host.open(workspaceId))
        assert.equal(
          failed.failure.code,
          damage === 'history' ? 'local-history-recovery-required' : 'trusted-pin-unavailable'
        )
      })
    )
    assert.deepEqual(await readFile(path), original)
  })
}

void test('a different account retains its KeyPackage, joins as Member, exchanges encrypted content and reopens offline', async (t) => {
  const directory = await fixture(t)
  const memberDirectory = join(directory, 'member')
  const openMember = (folder = memberDirectory) => memberWithHost(folder)
  let offer, original, admission, prepared, encrypted
  const room = { kind: 'meta' }
  const context = {
    protocol: 'loro-streams-crdt-payload-protection',
    version: 2,
    kind: 'update_batch'
  }
  const plaintext = new TextEncoder().encode('synthetic team collaboration')
  const additionalData = new Uint8Array([1, 2, 3])
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      prepared = yield* bind(owner)
      yield* owner.host.open(workspaceId)
      offer = yield* owner.host.memberOffer(workspaceId, 'email', 9_000_000_000_000)
      const member = yield* openMember()
      original = yield* member.bootstrap.prepareMemberJoin(offer)
      assert.deepEqual(yield* member.bootstrap.prepareMemberJoin(offer), original)
      assert.equal(
        hex(decodeMemberKeyPackage(original.keyPackageHex).request.userId.toBytes()),
        hex(Result.getOrThrow(accountUserId('acc2')).toBytes())
      )
      assert.ok(Result.isFailure(yield* Effect.result(member.host.open(workspaceId))))
      yield* owner.host.inspectMemberAdmission(workspaceId, original.keyPackageHex)
      admission = yield* owner.host.prepareMemberAdmission(workspaceId, original.keyPackageHex)
      assert.deepEqual(
        yield* owner.host.prepareMemberAdmission(workspaceId, original.keyPackageHex),
        admission
      )
      const changed = JSON.parse(Buffer.from(original.keyPackageHex, 'hex').toString())
      changed.credentialHash = '00'.repeat(32)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            owner.host.prepareMemberAdmission(
              workspaceId,
              Buffer.from(JSON.stringify(changed)).toString('hex')
            )
          )
        )
      )
    })
  )
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const member = yield* openMember()
      assert.deepEqual(yield* member.bootstrap.prepareMemberJoin(offer), original)
      yield* owner.host.open(workspaceId)
      assert.deepEqual(
        yield* owner.host.prepareMemberAdmission(workspaceId, original.keyPackageHex),
        admission
      )
      const records = [
        Buffer.from(prepared.genesisRecordHex, 'hex'),
        Buffer.from(admission.recordHex, 'hex')
      ]
      const pages = [page(records, offer.genesisHash, 0)]
      const bad = [
        { ...pages[0], checkpoint: { ...pages[0].checkpoint, headHash: '00'.repeat(32) } }
      ]
      assert.ok(
        Result.isFailure(yield* Effect.result(member.bootstrap.acceptMemberJoin(workspaceId, bad)))
      )
      assert.ok(Result.isFailure(yield* Effect.result(member.host.open(workspaceId))))
      yield* member.bootstrap.acceptMemberJoin(workspaceId, pages)
      const joined = yield* member.host.open(workspaceId)
      assert.equal(joined.length, 2)
      assert.equal(joined.deviceKind, 'personal')
      assert.equal(joined.hasCurrentKey, false)
      yield* owner.host.ingestLedgerRecords(workspaceId, pages[0])
      const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(offer.genesisHash, 'hex')))
      let view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records,
          checkpoint: { length: 2, head: hashRecordBytes(records[1]) }
        })
      )
      const memberKey = decodeMemberKeyPackage(original.keyPackageHex).request.signingPublicKey
      const memberState = view.inspectState().devices.get(hex(memberKey.toBytes()))
      assert.equal(
        view.inspectState().members.get(hex(memberState.membershipId.toBytes())).role,
        'member'
      )
      const mailbox = yield* makeSqliteKeyMailbox({
        path: join(directory, 'member-mailbox.sqlite'),
        mode: 'create',
        genesis,
        ledger: () => Effect.succeed(view)
      })
      const ownerDevice = yield* owner.custody.openDevice(genesis)
      const ownerPort = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailbox, ownerDevice.publicKey)),
        KeyMailbox
      )
      const memberPort = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailbox, memberKey)),
        KeyMailbox
      )
      // A blocked target is not delivered: the round still succeeds, so only the
      // mailbox's envelope for that recipient is positive evidence.
      const memberDevice = hex(memberKey.toBytes())
      // The host builds its delivery layer from the first round's port, so one port
      // refuses envelope storage only while `refusing` is set.
      let refusing = true
      const sending = {
        ...ownerPort,
        put: (id, frame) =>
          refusing
            ? Effect.fail(new BackendError({ service: 'KeyMailbox', reason: 'unavailable' }))
            : ownerPort.put(id, frame)
      }
      yield* owner.host.keyRound(workspaceId, () => sending)
      assert.equal(
        yield* owner.host.keyDeliveryEvidence(workspaceId, memberDevice, () => ownerPort),
        'e2ee_key_not_sent'
      )
      refusing = false
      yield* owner.host.keyRound(workspaceId, () => sending)
      assert.equal(
        yield* owner.host.keyDeliveryEvidence(workspaceId, memberDevice, () => ownerPort),
        'delivered'
      )
      // Genuine content of an epoch this admitted device's verified ledger holds, read
      // before its own key arrives (a rotation it has not received yet): retryable
      // key-pending, never a terminal ledger failure.
      const early = yield* owner.host.seal(workspaceId, {
        epoch: 0,
        room,
        context,
        plaintext,
        additionalData
      })
      const pending = yield* Effect.flip(
        member.host.openContent(workspaceId, { room, context, ...early, additionalData })
      )
      assert.equal(pending.code, 'key-pending')
      // A frame that fails authentication stays terminal, key or no key.
      const forged = new Uint8Array(early.sealed)
      forged[forged.length - 1] ^= 1
      const refused = yield* Effect.flip(
        member.host.openContent(workspaceId, {
          room,
          context,
          ...early,
          sealed: forged,
          additionalData
        })
      )
      assert.notEqual(refused.code, 'key-pending')
      yield* member.host.keyRound(workspaceId, () => memberPort)
      assert.equal((yield* member.host.status(workspaceId)).hasCurrentKey, true)
      assert.deepEqual(
        yield* member.host.openContent(workspaceId, { room, context, ...early, additionalData }),
        plaintext
      )
      encrypted = yield* owner.host.seal(workspaceId, {
        epoch: 0,
        room,
        context,
        plaintext,
        additionalData
      })
      assert.deepEqual(
        yield* member.host.openContent(workspaceId, {
          room,
          context,
          ...encrypted,
          additionalData
        }),
        plaintext
      )
      const reply = yield* member.host.seal(workspaceId, {
        epoch: 0,
        room,
        context,
        plaintext,
        additionalData
      })
      assert.deepEqual(
        yield* owner.host.openContent(workspaceId, { room, context, ...reply, additionalData }),
        plaintext
      )
      for (const [statusRoom, write] of [
        [
          { kind: 'flock', flockDocId: `${workspaceId}:wf:workspace` },
          { key: ['pinSection', 'section-synthetic'], value: { name: 'Review', orderKey: 'a0' } }
        ],
        [
          { kind: 'meta' },
          {
            snoozedUntil: 9_000_000_000_000,
            settledAt: null,
            focusRestoredAt: 8_999_999_999_000,
            orderKey: 'a0V',
            pinSectionId: 'section-synthetic'
          }
        ]
      ]) {
        const bytes = new TextEncoder().encode(JSON.stringify(write))
        const sealed = yield* member.host.seal(workspaceId, {
          epoch: 0,
          room: statusRoom,
          context,
          plaintext: bytes,
          additionalData
        })
        const opened = yield* owner.host.openContent(workspaceId, {
          room: statusRoom,
          context,
          ...sealed,
          additionalData
        })
        assert.deepEqual(JSON.parse(new TextDecoder().decode(opened)), write)
      }
      const personalOffer = yield* member.host.personalPairingOffer(workspaceId)
      const additional = yield* openMember(join(directory, 'member-additional'))
      const personalRequest = yield* additional.bootstrap.preparePersonalJoin(personalOffer)
      yield* member.host.previewPersonalAdmission(workspaceId, personalRequest.requestHex)
      const personalAdmission = yield* member.host.preparePersonalAdmission(
        workspaceId,
        personalRequest.requestHex
      )
      const expanded = [...records, Buffer.from(personalAdmission.recordHex, 'hex')]
      const expandedPage = page(expanded, offer.genesisHash, 0)
      yield* additional.bootstrap.acceptPersonalHistory(workspaceId, [expandedPage])
      assert.equal((yield* additional.host.open(workspaceId)).length, 3)
      yield* member.host.ingestLedgerRecords(workspaceId, expandedPage)
      assert.equal(
        yield* member.host.personalInvitation(workspaceId, personalOffer.pairingSessionId),
        null
      )
      view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records: expanded,
          checkpoint: { length: 3, head: hashRecordBytes(expanded[2]) }
        })
      )
      const additionalDevice = yield* additional.custody.openDevice(genesis)
      const additionalPort = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailbox, additionalDevice.publicKey)),
        KeyMailbox
      )
      yield* member.host.keyRound(workspaceId, () => memberPort)
      yield* additional.host.keyRound(workspaceId, () => additionalPort)
      assert.deepEqual(
        yield* additional.host.openContent(workspaceId, {
          room,
          context,
          ...encrypted,
          additionalData
        }),
        plaintext
      )
      // skew-convex-slow: Streams delivers the newly admitted device's frame before the
      // owner's ledger feed has its admission. That is retryable lag, not a terminal
      // ledger failure, and it opens once the ledger catches up.
      const ahead = yield* additional.host.seal(workspaceId, {
        epoch: 0,
        room,
        context,
        plaintext,
        additionalData
      })
      const lagging = (sealed) =>
        Effect.flip(
          owner.host.openContent(workspaceId, { room, context, ...ahead, sealed, additionalData })
        )
      assert.equal((yield* lagging(ahead.sealed)).code, 'key-pending')
      // A frame naming an epoch within the bounded lookahead is lag too; one beyond it
      // (a forged far-future epoch) keeps its terminal failure and never asks for a refresh.
      const withEpoch = (epoch) => {
        const sealed = new Uint8Array(ahead.sealed)
        new DataView(sealed.buffer).setUint32(1, epoch, false)
        return sealed
      }
      assert.equal((yield* lagging(withEpoch(4))).code, 'key-pending')
      assert.notEqual((yield* lagging(withEpoch(5))).code, 'key-pending')
      assert.notEqual((yield* lagging(withEpoch(999_999))).code, 'key-pending')
      yield* owner.host.ingestLedgerRecords(workspaceId, expandedPage)
      assert.deepEqual(
        yield* owner.host.openContent(workspaceId, { room, context, ...ahead, additionalData }),
        plaintext
      )
      // The member pairs a machine. Opening the workspace warms the owner's sharing read
      // for that other member's machine once per entry; its own machines need none.
      const memberSigner = yield* member.custody.openDevice(genesis)
      const machine = yield* member.custody.prepareDevice()
      const machineRecord = yield* signLedgerRecord(
        Result.getOrThrow(
          prepareLedgerCommand(
            view,
            memberSigner.publicKey,
            yield* prepareDeviceAdmission({
              genesis,
              membershipId: memberState.membershipId,
              encryptionPublicKey: machine.enc,
              kind: 'machine',
              machineId: 'member-machine',
              signer: machine
            })
          )
        ),
        memberSigner
      )
      yield* owner.host.ingestLedgerRecords(
        workspaceId,
        page([...expanded, machineRecord], offer.genesisHash, 0)
      )
      const warmed = []
      const sharingRemote = {
        readHead: (input) => Effect.sync(() => (warmed.push(input.machineId), null)),
        readVersion: () => Effect.die('no head'),
        readRequest: () => Effect.die('no head'),
        commit: () => Effect.die('read only')
      }
      yield* owner.host.prewarmMachineSharing(workspaceId, sharingRemote)
      yield* owner.host.prewarmMachineSharing(workspaceId, sharingRemote)
      assert.deepEqual(warmed, ['member-machine'])
    })
  )
  await execute(
    Effect.gen(function* () {
      const member = yield* openMember()
      assert.equal((yield* member.host.open(workspaceId)).hasCurrentKey, true)
      assert.deepEqual(
        yield* member.host.openContent(workspaceId, {
          room,
          context,
          ...encrypted,
          additionalData
        }),
        plaintext
      )
      assert.equal(yield* member.bootstrap.pendingMemberJoin(workspaceId), null)
    })
  )
})

for (const completion of ['invitation', 'promoted', 'crash-before-invitation']) {
  void test(`a Member pairs a third personal device after ${completion} and restart`, async (t) => {
    const directory = await fixture(t)
    const memberDirectory = join(directory, 'member')
    let records, personalOffer, genesisHash, membershipId
    const history = () => page(records, genesisHash, 0)
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        const prepared = yield* bind(owner)
        yield* owner.host.open(workspaceId)
        const member = yield* memberWithHost(memberDirectory)
        const offer = yield* owner.host.memberOffer(workspaceId, 'email', 9_000_000_000_000)
        const request = yield* member.bootstrap.prepareMemberJoin(offer)
        yield* owner.host.inspectMemberAdmission(workspaceId, request.keyPackageHex)
        const admission = yield* owner.host.prepareMemberAdmission(
          workspaceId,
          request.keyPackageHex
        )
        genesisHash = offer.genesisHash
        records = [
          Buffer.from(prepared.genesisRecordHex, 'hex'),
          Buffer.from(admission.recordHex, 'hex')
        ]
        yield* member.bootstrap.acceptMemberJoin(workspaceId, [history()])
        const status = yield* member.host.open(workspaceId)
        assert.equal(status.memberRole, 'member')
        membershipId = status.membershipId
        personalOffer = yield* member.host.personalPairingOffer(workspaceId)
        const second = yield* memberWithHost(join(directory, 'device-2'))
        const personalRequest = yield* second.bootstrap.preparePersonalJoin(personalOffer)
        const personalAdmission = yield* member.host.preparePersonalAdmission(
          workspaceId,
          personalRequest.requestHex
        )
        records.push(Buffer.from(personalAdmission.recordHex, 'hex'))
        yield* member.host.ingestLedgerRecords(workspaceId, history())
        yield* second.bootstrap.acceptPersonalHistory(workspaceId, [history()])
        assert.equal((yield* second.host.open(workspaceId)).length, 3)
        if (completion !== 'crash-before-invitation') {
          assert.equal(
            yield* member.host.personalInvitation(workspaceId, personalOffer.pairingSessionId),
            null
          )
          if (completion === 'invitation') {
            const next = yield* member.host.personalPairingOffer(workspaceId)
            assert.notEqual(next.pairingSessionId, personalOffer.pairingSessionId)
          }
        }
      })
    )
    if (completion === 'crash-before-invitation') {
      historyDb(memberDirectory, (db) =>
        db.exec('ALTER TABLE personal_pairing DROP COLUMN completed')
      )
    }
    await execute(
      Effect.gen(function* () {
        const member = yield* memberWithHost(memberDirectory)
        yield* member.host.open(workspaceId)
        if (completion === 'promoted') {
          const owner = yield* ownerWithHost(directory)
          yield* owner.host.open(workspaceId)
          yield* owner.host.ingestLedgerRecords(workspaceId, history())
          const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(genesisHash, 'hex')))
          const view = Result.getOrThrow(
            verifyLedger({
              anchor: genesis,
              records,
              checkpoint: { length: records.length, head: hashRecordBytes(records.at(-1)) }
            })
          )
          const signer = yield* owner.custody.openDevice(genesis)
          const proposal = yield* Effect.fromResult(
            prepareLedgerCommand(view, signer.publicKey, {
              _tag: 'SetRole',
              membershipId: Result.getOrThrow(Bytes.membershipId(Buffer.from(membershipId, 'hex'))),
              role: 'admin'
            })
          )
          records.push(yield* signLedgerRecord(proposal, signer))
          yield* member.host.ingestLedgerRecords(workspaceId, history())
          assert.equal((yield* member.host.status(workspaceId)).memberRole, 'admin')
        }
        const next = yield* member.host.personalPairingOffer(workspaceId)
        assert.notEqual(next.pairingSessionId, personalOffer.pairingSessionId)
        assert.deepEqual(yield* member.host.personalPairingOffer(workspaceId), next)
        for (const operation of ['cancelPersonalPairing', 'retirePersonalPairing']) {
          const result = yield* Effect.result(
            member.host[operation](workspaceId, personalOffer.pairingSessionId)
          )
          assert.equal(result._tag, 'Failure')
          assert.equal(result.failure.code, 'conflict')
        }
        const third = yield* memberWithHost(join(directory, 'device-3'))
        const request = yield* third.bootstrap.preparePersonalJoin(next)
        const admission = yield* member.host.preparePersonalAdmission(
          workspaceId,
          request.requestHex
        )
        records.push(Buffer.from(admission.recordHex, 'hex'))
        yield* member.host.ingestLedgerRecords(workspaceId, history())
        yield* third.bootstrap.acceptPersonalHistory(workspaceId, [history()])
        assert.equal((yield* third.host.open(workspaceId)).length, records.length)
      })
    )
    await execute(
      Effect.gen(function* () {
        const member = yield* memberWithHost(memberDirectory)
        yield* member.host.open(workspaceId)
        assert.notEqual(
          (yield* member.host.personalPairingOffer(workspaceId)).pairingSessionId,
          personalOffer.pairingSessionId
        )
      })
    )
  })
}

for (const installation of ['member', 'personal-history', 'personal-snapshot']) {
  void test(`removed member rejoins with a new invitation and isolated device via ${installation}`, async (t) => {
    const directory = await fixture(t)
    const memberDirectory = join(directory, 'removed-member')
    let currentKey, currentCredential, expectedLength
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        const prepared = yield* bind(owner)
        yield* owner.host.open(workspaceId)
        const genesis = Result.getOrThrow(
          Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
        )
        const removed = yield* memberWithHost(memberDirectory)
        const firstOffer = yield* owner.host.memberOffer(workspaceId, 'email', 9_000_000_000_000)
        const firstRequest = yield* removed.bootstrap.prepareMemberJoin(firstOffer)
        yield* owner.host.inspectMemberAdmission(workspaceId, firstRequest.keyPackageHex)
        const firstAdmission = yield* owner.host.prepareMemberAdmission(
          workspaceId,
          firstRequest.keyPackageHex
        )
        const records = [
          Buffer.from(prepared.genesisRecordHex, 'hex'),
          Buffer.from(firstAdmission.recordHex, 'hex')
        ]
        const history = () => page(records, firstOffer.genesisHash, 0)
        yield* removed.bootstrap.acceptMemberJoin(workspaceId, [history()])
        const first = yield* removed.host.open(workspaceId)
        const original = {
          workspaceId,
          genesisHash: first.genesisHash,
          signingPublicKey: first.signingPublicKey,
          credential: yield* removed.bootstrap.deviceCredential(workspaceId)
        }
        yield* owner.host.ingestLedgerRecords(workspaceId, history())
        const remote = () => ({
          staging: () => ({
            stageGroup: () => Effect.die('unexpected rotation'),
            readGroup: () => Effect.die('unexpected rotation'),
            deleteGroup: () => Effect.die('unexpected rotation')
          }),
          mailbox: () => {
            throw new Error('member management must not rotate')
          },
          log: {
            read: () =>
              Effect.sync(() => ({
                records: records.map((record) => new Uint8Array(record)),
                checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
              })),
            appendCas: (_genesis, point, record) =>
              Effect.sync(() => {
                assert.equal(
                  hex(point.head.toBytes()),
                  hex(hashRecordBytes(records.at(-1)).toBytes())
                )
                records.push(new Uint8Array(record))
              })
          },
          history: () => Effect.succeed(history())
        })
        yield* owner.host.manage(
          workspaceId,
          { type: 'removeMember', membershipId: first.membershipId },
          remote
        )
        assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
        // Personal re-pair also covers an authenticated revocation of only this device:
        // the receipt is the same exact device record, labelled with its reason.
        const reason = installation === 'member' ? 'member_removed' : 'device_revoked'
        assert.equal(yield* removed.bootstrap.recordRemovedWorkspace({ ...original, reason }), true)
        const drain = yield* removed.host.beginCloseWorkspace(workspaceId)
        yield* drain
        assert.equal(yield* removed.bootstrap.forgetRemovedWorkspace(original), true)
        const db = new DatabaseSync(join(memberDirectory, 'creations.sqlite'))
        try {
          for (const table of [
            'member_joins',
            'personal_joins',
            'personal_join_histories',
            'retired_personal_joins'
          ])
            assert.equal(
              db
                .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=?`)
                .get(workspaceId).count,
              0
            )
        } finally {
          db.close()
        }
        assert.equal(yield* removed.bootstrap.hasRemovedWorkspace(workspaceId), true)
        assert.equal((yield* Effect.result(removed.custody.openDevice(genesis)))._tag, 'Failure')
        assert.equal((yield* Effect.result(removed.host.open(workspaceId))).failure.code, reason)
        assert.equal(yield* removed.bootstrap.removedReason(workspaceId), reason)

        const next =
          installation === 'member'
            ? removed
            : yield* memberWithHost(join(directory, 'new-first-device'))
        const nextOffer = yield* owner.host.memberOffer(workspaceId, 'email', 9_000_000_000_001)
        assert.notEqual(nextOffer.token, firstOffer.token)
        const nextRequest = yield* next.bootstrap.prepareMemberJoin(nextOffer)
        // The rejoining account is recognizably the same person under a new membership.
        assert.equal(
          hex(decodeMemberKeyPackage(nextRequest.keyPackageHex).request.userId.toBytes()),
          hex(decodeMemberKeyPackage(firstRequest.keyPackageHex).request.userId.toBytes())
        )
        const proof = decodeMemberKeyPackage(nextRequest.keyPackageHex)
        assert.notEqual(hex(proof.request.signingPublicKey.toBytes()), original.signingPublicKey)
        assert.notEqual(
          proof.credentialHash,
          decodeMemberKeyPackage(firstRequest.keyPackageHex).credentialHash
        )
        yield* owner.host.inspectMemberAdmission(workspaceId, nextRequest.keyPackageHex)
        const nextAdmission = yield* owner.host.prepareMemberAdmission(
          workspaceId,
          nextRequest.keyPackageHex
        )
        records.push(Buffer.from(nextAdmission.recordHex, 'hex'))
        const badHistory = [
          { ...history(), checkpoint: { ...history().checkpoint, headHash: '00'.repeat(32) } }
        ]
        assert.equal(
          (yield* Effect.result(next.bootstrap.acceptMemberJoin(workspaceId, badHistory)))._tag,
          'Failure'
        )
        assert.equal(yield* removed.bootstrap.hasRemovedWorkspace(workspaceId), true)
        yield* next.bootstrap.acceptMemberJoin(workspaceId, [history()])
        const admitted = yield* next.host.open(workspaceId)
        assert.notEqual(admitted.membershipId, first.membershipId)
        yield* owner.host.ingestLedgerRecords(workspaceId, history())
        // The real management command supplied by #1982 promotes the newly admitted Member.
        yield* owner.host.manage(
          workspaceId,
          { type: 'setRole', membershipId: admitted.membershipId, role: 'admin' },
          remote
        )
        yield* next.host.ingestLedgerRecords(workspaceId, history())
        assert.equal((yield* next.host.status(workspaceId)).memberRole, 'admin')
        if (installation !== 'member') {
          const personalOffer = yield* next.host.personalPairingOffer(workspaceId)
          const personalRequest = yield* removed.bootstrap.preparePersonalJoin(personalOffer)
          assert.notEqual(personalRequest.signingPublicKey, original.signingPublicKey)
          yield* next.host.previewPersonalAdmission(workspaceId, personalRequest.requestHex)
          const personalAdmission = yield* next.host.preparePersonalAdmission(
            workspaceId,
            personalRequest.requestHex
          )
          records.push(Buffer.from(personalAdmission.recordHex, 'hex'))
          yield* next.host.ingestLedgerRecords(workspaceId, history())
          // Preparing a replacement key is insufficient to clear the terminal marker.
          assert.equal(yield* removed.bootstrap.hasRemovedWorkspace(workspaceId), true)
          if (installation === 'personal-history') {
            assert.equal(
              (yield* Effect.result(
                removed.bootstrap.acceptPersonalHistory(workspaceId, badHistory)
              ))._tag,
              'Failure'
            )
            assert.equal(yield* removed.bootstrap.hasRemovedWorkspace(workspaceId), true)
            yield* removed.bootstrap.acceptPersonalHistory(workspaceId, [history()])
          } else {
            const invitation = yield* next.host
              .personalInvitation(workspaceId, personalOffer.pairingSessionId)
              .pipe(Effect.mapError((cause) => new Error('snapshot creation failed', { cause })))
            assert.ok(invitation)
            assert.equal(
              (yield* Effect.result(removed.bootstrap.acceptPersonalJoin(workspaceId, '00')))._tag,
              'Failure'
            )
            assert.equal(yield* removed.bootstrap.hasRemovedWorkspace(workspaceId), true)
            yield* removed.bootstrap
              .acceptPersonalJoin(workspaceId, invitation.invitationHex)
              .pipe(
                Effect.mapError((cause) => new Error('snapshot installation failed', { cause }))
              )
          }
        }
        assert.equal(yield* removed.bootstrap.hasRemovedWorkspace(workspaceId), false)
        assert.equal(yield* removed.bootstrap.removedReason(workspaceId), null)
        const installed = yield* removed.host.open(workspaceId)
        currentKey = installed.signingPublicKey
        currentCredential = yield* removed.bootstrap.deviceCredential(workspaceId)
        expectedLength = records.length
        assert.notEqual(currentKey, original.signingPublicKey)
        assert.notEqual(currentCredential, original.credential)
        assert.equal(yield* removed.bootstrap.forgetRemovedWorkspace(original), false)
        assert.equal((yield* removed.host.status(workspaceId)).signingPublicKey, currentKey)
        yield* removed.host.ingestLedgerRecords(
          workspaceId,
          page(
            records,
            firstOffer.genesisHash,
            installation === 'personal-snapshot' ? records.length : 0
          )
        )
        yield* owner.host.ingestLedgerRecords(workspaceId, history())
        const view = Result.getOrThrow(
          verifyLedger({
            anchor: genesis,
            records,
            checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
          })
        )
        const mailbox = yield* makeSqliteKeyMailbox({
          path: join(directory, 'rejoin-mailbox.sqlite'),
          mode: 'create',
          genesis,
          ledger: () => Effect.succeed(view)
        })
        const ownerDevice = yield* owner.custody.openDevice(genesis)
        const freshDevice = yield* removed.custody.openDevice(genesis)
        const ownerPort = Context.get(
          yield* Layer.build(referenceKeyMailbox(mailbox, ownerDevice.publicKey)),
          KeyMailbox
        )
        const freshPort = Context.get(
          yield* Layer.build(referenceKeyMailbox(mailbox, freshDevice.publicKey)),
          KeyMailbox
        )
        yield* owner.host.keyRound(workspaceId, () => ownerPort)
        yield* removed.host.keyRound(workspaceId, () => freshPort)
        assert.equal((yield* removed.host.status(workspaceId)).hasCurrentKey, true)
      })
    )
    await execute(
      Effect.gen(function* () {
        const reopened = yield* memberWithHost(memberDirectory)
        const status = yield* reopened.host.open(workspaceId)
        assert.equal(status.signingPublicKey, currentKey)
        assert.equal(status.length, expectedLength)
        assert.equal(status.hasCurrentKey, true)
        assert.equal(yield* reopened.bootstrap.deviceCredential(workspaceId), currentCredential)
        if (installation === 'personal-history') {
          const db = new DatabaseSync(join(memberDirectory, 'creations.sqlite'))
          try {
            assert.equal(
              db
                .prepare(
                  'SELECT COUNT(*) AS count FROM personal_join_histories WHERE workspace_id=?'
                )
                .get(workspaceId).count,
              1
            )
            const identity = {
              workspaceId,
              genesisHash: status.genesisHash,
              signingPublicKey: currentKey,
              credential: currentCredential
            }
            yield* reopened.bootstrap.recordRemovedWorkspace(identity)
            const drain = yield* reopened.host.beginCloseWorkspace(workspaceId)
            yield* drain
            yield* reopened.bootstrap.forgetRemovedWorkspace(identity)
            assert.equal(
              db
                .prepare(
                  'SELECT COUNT(*) AS count FROM personal_join_histories WHERE workspace_id=?'
                )
                .get(workspaceId).count,
              0
            )
          } finally {
            db.close()
          }
        }
      })
    )
  })
}

for (const fault of ['feed', 'origin']) {
  void test(`accepted ledger progress survives auxiliary ${fault} compaction failure`, async (t) => {
    const directory = await fixture(t),
      warnings = []
    t.mock.method(console, 'warn', (...args) => {
      warnings.push(args)
    })
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory),
          prepared = yield* bind(owner)
        const records = yield* makeRecords(owner.custody, prepared, 71)
        yield* owner.host.open(workspaceId)
        const workspace = join(directory, 'workspaces', workspaceId)
        const history = new DatabaseSync(join(workspace, 'history.sqlite'))
        const feed = new DatabaseSync(
          join(workspace, history.prepare('SELECT name FROM cache WHERE id=1').get().name)
        )
        const db = fault === 'feed' ? feed : history
        db.exec(
          `CREATE TRIGGER fail_compaction BEFORE UPDATE OF origin ON ${fault === 'feed' ? 'feed_meta' : 'cache'} BEGIN SELECT RAISE(ABORT,'synthetic auxiliary failure'); END`
        )
        try {
          yield* owner.host.ingestLedgerRecords(
            workspaceId,
            page(records, prepared.genesisHashHex, 0, 64)
          )
          yield* owner.host.ingestLedgerRecords(
            workspaceId,
            page(records, prepared.genesisHashHex, 64, 70)
          )
          assert.equal((yield* owner.host.status(workspaceId)).length, 70)
          assert.equal(history.prepare('SELECT COUNT(*) AS n FROM records').get().n, 70)
          yield* owner.host.ingestLedgerRecords(
            workspaceId,
            page(records, prepared.genesisHashHex, 70)
          )
          assert.equal((yield* owner.host.status(workspaceId)).length, 71)
          assert.deepEqual(warnings, [
            ['[E2EE] Ledger compaction pending', { code: 'e2ee_ledger_compaction_pending' }]
          ])
        } finally {
          db.exec('DROP TRIGGER fail_compaction')
          feed.close()
          history.close()
        }
      })
    )
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        assert.equal((yield* owner.host.open(workspaceId)).length, 71)
      })
    )
  })
}

void test('binding is immutable, retained reopen asks only for a suffix, and corrupted cache recovers locally', async (t) => {
  const directory = await fixture(t)
  let saved
  let records
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      saved = yield* bind(owner)
      const conflict = yield* Effect.result(
        owner.bootstrap.recordCreated({ workspaceId, genesisHash: 'a'.repeat(64) })
      )
      assert.equal(conflict.failure.code, 'conflict')
      records = yield* makeRecords(owner.custody, saved, 1000)
      assert.equal((yield* owner.host.open(workspaceId)).position, null)
      for (let start = 0; start < records.length; start += 64)
        yield* owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, saved.genesisHashHex, start, Math.min(start + 64, records.length))
        )
      const current = yield* owner.host.status(workspaceId)
      assert.equal(current.length, 1000)
      assert.equal(current.hasCurrentKey, true)
      assert.equal(current.deviceKind, 'personal')
      assert.equal((yield* owner.host.ledgerView(workspaceId)).recordsHex.length, 1000)
    })
  )
  // No history/network capability is provided at all on reopen.
  await execute(
    Effect.gen(function* () {
      const { host } = yield* ownerWithHost(directory)
      const reopened = yield* host.open(workspaceId)
      assert.equal(reopened.position, `p1:${workspaceId}:1000:source-1000:0`)
      assert.equal(reopened.length, 1000)
      const empty = page(records, saved.genesisHashHex, 1000)
      yield* host.ingestLedgerRecords(workspaceId, empty)
    })
  )
  const oldFeed = historyDb(directory, (db) => db.prepare('SELECT name FROM cache').get().name)
  historyDb(directory, (db) => db.prepare('UPDATE cache SET origin=?').run('{corrupt'))
  await execute(
    Effect.gen(function* () {
      const { host } = yield* ownerWithHost(directory)
      assert.equal((yield* host.open(workspaceId)).length, 1000)
    })
  )
  await assert.rejects(readFile(join(directory, 'workspaces', workspaceId, oldFeed)), {
    code: 'ENOENT'
  })
})

void test('a remote machine offer reports non-HTTPS endpoints as bad input before signing', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const plain = yield* Effect.result(
        owner.host.remoteMachineOffer(workspaceId, {
          accountId: intent.accountId,
          deploymentUrl: 'http://127.0.0.1:5210',
          ingressUrl: 'http://127.0.0.1:5211'
        })
      )
      // Previously this surfaced as invalid-ledger and sent users to ledger recovery.
      assert.equal(plain.failure.code, 'invalid-input')
      const offer = yield* owner.host.remoteMachineOffer(workspaceId, {
        accountId: intent.accountId,
        deploymentUrl: 'https://cloud.synthetic.test',
        ingressUrl: 'https://edge.synthetic.test'
      })
      assert.equal(offer.deploymentUrl, 'https://cloud.synthetic.test')
    })
  )
})

void test('a failed originals transaction never advances the pin; reopening retains the last accepted view', async (t) => {
  const directory = await fixture(t)
  let saved
  let records
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      saved = yield* bind(owner)
      records = yield* makeRecords(owner.custody, saved, 3)
      yield* owner.host.open(workspaceId)
      yield* owner.host.ingestLedgerRecords(
        workspaceId,
        page(records.slice(0, 1), saved.genesisHashHex, 0)
      )
      historyDb(directory, (db) =>
        db.exec(
          "CREATE TRIGGER synthetic_full BEFORE INSERT ON records WHEN NEW.position > 0 BEGIN SELECT RAISE(ABORT, 'synthetic full'); END"
        )
      )
      const failed = yield* Effect.result(
        owner.host.ingestLedgerRecords(workspaceId, page(records, saved.genesisHashHex, 1))
      )
      assert.equal(Result.isFailure(failed), true)
      assert.equal((yield* owner.host.status(workspaceId)).length, 1)
      historyDb(directory, (db) => db.exec('DROP TRIGGER synthetic_full'))
      yield* owner.host.ingestLedgerRecords(workspaceId, page(records, saved.genesisHashHex, 1))
    })
  )
  await execute(
    Effect.gen(function* () {
      const { host } = yield* ownerWithHost(directory)
      assert.equal((yield* host.open(workspaceId)).length, 3)
    })
  )
})

void test('retains an earlier renderer checkpoint before first native takeover and refuses server rollback', async (t) => {
  const directory = await fixture(t)
  let prepared
  let records
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      prepared = yield* bind(owner)
      records = yield* makeRecords(owner.custody, prepared, 3)
      const observed = {
        genesisHash: prepared.genesisHashHex,
        length: 3,
        headHash: hex(hashRecordBytes(records[2]).toBytes())
      }
      const status = yield* owner.host.open(workspaceId, observed)
      assert.equal(status.continuityPending, true)
      assert.equal(status.hasCurrentKey, false)
      const stale = yield* Effect.result(
        owner.host.ingestLedgerRecords(
          workspaceId,
          page(records.slice(0, 1), prepared.genesisHashHex, 0)
        )
      )
      assert.equal(stale.failure.code, 'local-evidence-conflict')
    })
  )
  // The restriction survives restart even if the renderer never sends it again.
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      assert.equal((yield* owner.host.open(workspaceId)).continuityPending, true)
      const ready = yield* owner.host.ingestLedgerRecords(
        workspaceId,
        page(records, prepared.genesisHashHex, 0)
      )
      assert.equal(ready.continuityPending, false)
      assert.equal(ready.length, 3)
      assert.equal(ready.hasCurrentKey, true)
    })
  )
})

void test('quit after a link invitation bounds native drain while retaining custody and committed history', async (t) => {
  const directory = await fixture(t)
  const scope = await Effect.runPromise(Scope.make())
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  let hold = false,
    released = false,
    drained = false,
    terminated = false
  let reading, closing, rawClosing
  try {
    const owner = await Effect.runPromise(
      Effect.gen(function* () {
        const base = yield* openOwner(directory)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            released = true
          })
        )
        const custody = {
          ...base.custody,
          installed: {
            ...base.custody.installed,
            unprotect: async (blob) => {
              if (hold) {
                entered.resolve()
                await release.promise
              }
              return base.custody.installed.unprotect(blob)
            }
          }
        }
        const host = yield* makeDesktopE2eeRuntimeHost({
          directory,
          bootstrap: base.bootstrap,
          custody
        })
        return { ...base, host }
      }).pipe(Scope.provide(scope))
    )
    const prepared = await Effect.runPromise(bind(owner))
    const records = await Effect.runPromise(makeRecords(owner.custody, prepared, 2))
    await Effect.runPromise(owner.host.open(workspaceId))
    await Effect.runPromise(
      owner.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 0))
    )
    const before = await Effect.runPromise(owner.host.status(workspaceId))
    const offer = await Effect.runPromise(
      owner.host.memberOffer(workspaceId, 'link', 9_999_999_999_999)
    )
    assert.equal(offer.mode, 'link')
    hold = true
    reading = Effect.runPromise(owner.host.status(workspaceId))
    await entered.promise
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const closingEntered = Promise.withResolvers()
    const events = []
    let unconfirmed
    const barrier = createDesktopQuitBarrier({
      stop: async () => {
        unconfirmed = await drainMainProcessQuitResources(
          [
            {
              name: 'e2ee',
              close: () => {
                closingEntered.resolve()
                rawClosing = Effect.runPromise(Scope.close(scope, Exit.void))
                return rawClosing
              }
            },
            { name: 'independent', close: async () => {} }
          ],
          15_000,
          (name, state) => events.push([name, state])
        )
      },
      quit: () => {
        terminated = true
      },
      reportFailure: (error) => {
        throw error
      }
    })
    closing = Promise.resolve(barrier({ preventDefault() {} })).then(() => {
      drained = true
    })
    await closingEntered.promise
    t.mock.timers.tick(15_000)
    // Drain Promise continuations without advancing real time or releasing native work.
    await new Promise(setImmediate)
    assert.equal(drained, true, 'terminal drain must finish without native completion')
    await closing
    assert.deepEqual(unconfirmed, ['e2ee'])
    assert.equal(terminated, true)
    assert.equal(released, false, 'waiter timeout must retain the native custody owner')
    assert.ok(events.some(([name, state]) => name === 'independent' && state === 'closed'))
    hold = false
    release.resolve()
    await reading
    await rawClosing
    assert.equal(released, true)
    await execute(
      Effect.gen(function* () {
        const reopened = yield* ownerWithHost(directory)
        const status = yield* reopened.host.open(workspaceId)
        assert.equal(status.length, before.length)
        assert.equal(status.epoch, before.epoch)
        assert.equal(status.hasCurrentKey, true)
        assert.deepEqual(
          historyDb(directory, (db) =>
            db
              .prepare('SELECT record FROM records ORDER BY position')
              .all()
              .map((row) => hex(row.record))
          ),
          records.map(hex)
        )
      })
    )
  } finally {
    hold = false
    release.resolve()
    await reading
    await rawClosing
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

void test('overlapping pages compare verified bytes, append only their suffix and keep input errors local', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const prepared = yield* bind(owner)
      const records = yield* makeRecords(owner.custody, prepared, 7)
      yield* owner.host.open(workspaceId)
      const first = page(records.slice(0, 3), prepared.genesisHashHex, 0)
      const initial = yield* owner.host.ingestLedgerRecords(workspaceId, first)
      const gap = yield* Effect.result(
        owner.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 4))
      )
      assert.equal(gap.failure.code, 'invalid-input')
      // If invalid input closed the owner, reopening would trust this altered cache
      // locator instead of retaining the live feed's position.
      historyDb(directory, (db) =>
        db.prepare('UPDATE records SET locator=? WHERE position=2').run('p1:changed')
      )
      assert.equal((yield* owner.host.status(workspaceId)).position, initial.position)
      assert.deepEqual(yield* owner.host.ingestLedgerRecords(workspaceId, first), initial)
      const overlapping = page(records, prepared.genesisHashHex, 1)
      const advanced = yield* owner.host.ingestLedgerRecords(workspaceId, overlapping)
      assert.equal(advanced.length, 7)
      assert.equal(advanced.position, overlapping.position)
      // A slower window's old endpoint is safe only because these exact bytes
      // and its checkpoint already belong to the locally verified prefix.
      assert.deepEqual(yield* owner.host.ingestLedgerRecords(workspaceId, first), advanced)
      assert.deepEqual(
        yield* owner.host.ingestLedgerRecords(
          workspaceId,
          page(records.slice(0, 3), prepared.genesisHashHex, 3)
        ),
        advanced
      )
      assert.equal(
        historyDb(directory, (db) => db.prepare('SELECT COUNT(*) AS n FROM records').get().n),
        7
      )
      const conflict = { ...first, recordsHex: [...first.recordsHex] }
      conflict.recordsHex[1] = conflict.recordsHex[2]
      const rejected = yield* Effect.result(owner.host.ingestLedgerRecords(workspaceId, conflict))
      assert.equal(rejected.failure.code, 'local-evidence-conflict')
      assert.equal(
        historyDb(directory, (db) => db.prepare('SELECT COUNT(*) AS n FROM records').get().n),
        7
      )
    })
  )
})

for (const kind of ['update_batch', 'snapshot'])
  void test(`content IPC binding encrypts allowed rooms and isolates a rejected room or corrupt frame (${kind})`, async (t) => {
    const directory = await fixture(t)
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        yield* bind(owner)
        yield* owner.host.open(workspaceId)
        const context = {
          protocol: 'loro-streams-crdt-payload-protection',
          version: 2,
          kind,
          ...(kind === 'snapshot' ? { continuationOffset: 'opaque:100' } : {})
        }
        const plaintext = new TextEncoder().encode('CANARY-content-boundary-synthetic')
        const additionalData = new Uint8Array([17, 22, 3])
        for (const room of [
          { kind: 'meta' },
          { kind: 'doc', docId: 'session' },
          { kind: 'flock', flockDocId: `${workspaceId}:mf:local` },
          { kind: 'flock', flockDocId: `${workspaceId}:wf:workspace` },
          { kind: 'doc', docId: 'preview-comment-synthetic' },
          { kind: 'flock', flockDocId: `${workspaceId}:fi:synthetic` },
          { kind: 'flock', flockDocId: `${workspaceId}:fis:synthetic` }
        ]) {
          const sealed = yield* owner.host.seal(workspaceId, {
            epoch: 0,
            room,
            context,
            plaintext,
            additionalData
          })
          assert.equal(Buffer.from(sealed.sealed).includes(plaintext), false)
          assert.deepEqual(
            yield* owner.host.openContent(workspaceId, {
              room,
              context,
              ...sealed,
              additionalData
            }),
            plaintext
          )
          const changed = new Uint8Array(sealed.sealed)
          changed[changed.length - 1] ^= 1
          assert.equal(
            Result.isFailure(
              yield* Effect.result(
                owner.host.openContent(workspaceId, {
                  room,
                  context,
                  ...sealed,
                  sealed: changed,
                  additionalData
                })
              )
            ),
            true
          )
        }
        assert.equal(
          Result.isFailure(
            yield* Effect.result(
              owner.host.seal(workspaceId, {
                epoch: 0,
                room: { kind: 'flock', flockDocId: 'code-index' },
                context,
                plaintext,
                additionalData
              })
            )
          ),
          true
        )
        assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
        const valid = yield* owner.host.seal(workspaceId, {
          epoch: 0,
          room: { kind: 'meta' },
          context,
          plaintext,
          additionalData
        })
        assert.ok(valid.sealed.length > plaintext.length)
      })
    )
  })

void test('a slow mailbox round does not hold the local workspace lock and reports its installed key', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const prepared = yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const genesis = Result.getOrThrow(
        Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
      )
      const record = Buffer.from(prepared.genesisRecordHex, 'hex')
      const view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records: [record],
          checkpoint: { head: hashRecordBytes(record), length: 1 }
        })
      )
      const device = yield* owner.custody.openDevice(genesis)
      const host = yield* makeSqliteKeyMailbox({
        path: join(directory, 'reference-mailbox.sqlite'),
        mode: 'create',
        genesis,
        ledger: () => Effect.succeed(view)
      })
      const context = yield* Layer.build(referenceKeyMailbox(host, device.publicKey))
      const mailbox = Context.get(context, KeyMailbox)
      const entered = Promise.withResolvers()
      const release = Promise.withResolvers()
      const slow = KeyMailbox.of({
        ...mailbox,
        report: (report, publication) =>
          Effect.gen(function* () {
            entered.resolve()
            yield* Effect.promise(() => release.promise)
            yield* mailbox.report(report, publication)
          })
      })
      const work = Effect.runPromise(owner.host.keyRound(workspaceId, () => slow))
      yield* Effect.promise(() => entered.promise)
      assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
      release.resolve()
      yield* Effect.promise(() => work)
      assert.equal(
        (yield* mailbox.status({
          genesis: prepared.genesisHashHex,
          epoch: 0,
          recipient: hex(device.publicKey.toBytes())
        })).status,
        'InstallationReported'
      )
    })
  )
})

void test('workspace close fences and drains a held key round without blocking another workspace', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const prepared = yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const other = yield* owner.bootstrap.prepareCreation({
        ...intent,
        requestId: 'request-independent-123',
        slug: 'independent'
      })
      yield* owner.bootstrap.recordCreated({
        workspaceId: 'independent',
        genesisHash: other.genesisHashHex,
        requestId: other.requestId
      })
      yield* owner.host.open('independent')
      const genesis = Result.getOrThrow(
        Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
      )
      const record = Buffer.from(prepared.genesisRecordHex, 'hex')
      const view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records: [record],
          checkpoint: { head: hashRecordBytes(record), length: 1 }
        })
      )
      const device = yield* owner.custody.openDevice(genesis)
      const mailboxHost = yield* makeSqliteKeyMailbox({
        path: join(directory, 'held-mailbox.sqlite'),
        mode: 'create',
        genesis,
        ledger: () => Effect.succeed(view)
      })
      const mailbox = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailboxHost, device.publicKey)),
        KeyMailbox
      )
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers(),
        aborted = Promise.withResolvers()
      const work = Effect.runPromise(
        owner.host.keyRound(workspaceId, (signal) => {
          signal.addEventListener('abort', () => aborted.resolve(), { once: true })
          return KeyMailbox.of({
            ...mailbox,
            report: (report, publication) =>
              Effect.gen(function* () {
                entered.resolve()
                yield* Effect.promise(() => release.promise)
                yield* mailbox.report(report, publication)
              })
          })
        })
      )
      yield* Effect.promise(() => entered.promise)
      let closed = false
      const closing = Effect.runPromise(owner.host.closeWorkspace(workspaceId)).then(() => {
        closed = true
      })
      yield* Effect.promise(() => aborted.promise)
      assert.equal(closed, false)
      assert.equal((yield* owner.host.status('independent')).hasCurrentKey, true)
      assert.equal((yield* Effect.result(owner.host.status(workspaceId))).failure.code, 'closed')
      release.resolve()
      yield* Effect.promise(() => work)
      yield* Effect.promise(() => closing)
      assert.equal(closed, true)
      const staleIngest = yield* Effect.result(
        owner.host.ingestLedgerRecords(workspaceId, page([record], prepared.genesisHashHex, 0))
      )
      assert.equal(staleIngest.failure.code, 'closed')
      // A late IPC cannot recreate the now-unleased workspace owner.
      const stillClosed = yield* Effect.result(owner.host.keyRound(workspaceId, () => mailbox))
      assert.equal(stillClosed.failure.code, 'closed')
      assert.equal((yield* owner.host.open(workspaceId)).hasCurrentKey, true)
    })
  )
})

for (const first of ['local', 'remote']) {
  void test(`pairing reset isolates journals and reset receipts with ${first} reset first`, async (t) => {
    const db = new DatabaseSync(':memory:')
    t.after(() => db.close())
    const journals = {
      local: makeDesktopLocalPairing({ db, current: () => Effect.void }),
      remote: makeDesktopLocalPairing({ db, journal: 'remote', current: () => Effect.void })
    }
    const tables = { local: 'local_pairing', remote: 'remote_local_pairing' }
    const archives = {
      local: 'archived_local_pairings',
      remote: 'remote_archived_local_pairings'
    }
    const read = (table) => db.prepare(`SELECT * FROM ${table} WHERE id=1`).get()
    const originals = {}
    for (const mode of ['local', 'remote']) {
      db.prepare(`INSERT INTO ${tables[mode]} VALUES(1,?,?,?,?)`).run(
        `${mode}-session`,
        `${mode}-material`,
        `${mode}-request`,
        Buffer.from(`${mode}-record`)
      )
      originals[mode] = read(tables[mode])
    }
    // Preserve the existing local archive schema and historical receipts.
    db.exec(
      'CREATE TABLE archived_local_pairings(reset_id TEXT PRIMARY KEY, session TEXT, material TEXT, request_id TEXT, record BLOB)'
    )
    db.prepare('INSERT INTO archived_local_pairings VALUES(?,?,?,?,?)').run(
      'previous-reset',
      'previous-session',
      'previous-material',
      'previous-request',
      Buffer.from('previous-record')
    )
    const previous = db.prepare('SELECT * FROM archived_local_pairings').get()
    const second = first === 'local' ? 'remote' : 'local'
    for (const mode of [first, second]) {
      const other = mode === 'local' ? 'remote' : 'local'
      const otherBefore = read(tables[other])
      await execute(journals[mode].reset('shared-reset-id'))
      const reset = read(tables[mode])
      assert.notEqual(reset.session, originals[mode].session)
      assert.deepEqual(
        { ...reset },
        {
          ...originals[mode],
          session: reset.session,
          material: null,
          request_id: null,
          record: null
        }
      )
      assert.deepEqual(read(tables[other]), otherBefore)
      assert.deepEqual(
        {
          ...db.prepare(`SELECT * FROM ${archives[mode]} WHERE reset_id=?`).get('shared-reset-id')
        },
        {
          reset_id: 'shared-reset-id',
          ...Object.fromEntries(Object.entries(originals[mode]).filter(([key]) => key !== 'id'))
        }
      )
      const reopened = makeDesktopLocalPairing({
        db,
        ...(mode === 'remote' ? { journal: 'remote' } : {}),
        current: () => Effect.void
      })
      await execute(reopened.reset('shared-reset-id'))
      assert.deepEqual(read(tables[mode]), reset)
      assert.deepEqual(read(tables[other]), otherBefore)
    }
    assert.deepEqual(
      db.prepare('SELECT * FROM archived_local_pairings WHERE reset_id=?').get('previous-reset'),
      previous
    )
  })
}

void test('local machine approval retains its exact signed original across restart and verifies the intended session', async (t) => {
  const directory = await fixture(t)
  const original = await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      const prepared = yield* bind(owner)
      yield* owner.host.open(workspaceId)
      const context = yield* owner.host.localPairingContext(workspaceId)
      assert.match(context.pairingSessionId, /^[0-9a-f]{32}$/)
      assert.deepEqual(yield* owner.host.localPairingContext(workspaceId), context)
      assert.equal((yield* owner.host.status(workspaceId)).length, 1)
      const other = yield* openOwner(join(directory, 'machine'))
      const machine = yield* other.custody.prepareDevice()
      const genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(context.genesisHash, 'hex')))
      const credentialHash = new Uint8Array(32).fill(73)
      const possession = yield* prepareDeviceAdmission({
        genesis,
        membershipId: Result.getOrThrow(
          Bytes.membershipId(Buffer.from(context.membershipId, 'hex'))
        ),
        encryptionPublicKey: machine.enc,
        kind: 'machine',
        machineId: 'synthetic-local-machine',
        signer: machine
      })
      const signature = yield* signDeviceCredentialBinding({
        genesis,
        pairingSessionId: Buffer.from(context.pairingSessionId, 'hex'),
        signingPublicKey: machine.publicKey,
        credentialHash,
        signer: machine
      })
      const material = {
        ok: true,
        type: 'prepare',
        machineId: 'synthetic-local-machine',
        pairingSessionId: context.pairingSessionId,
        signingPublicKey: hex(machine.publicKey.toBytes()),
        encryptionPublicKey: hex(machine.enc.toBytes()),
        possessionSignature: hex(possession.possessionSignature.toBytes()),
        credentialHash: hex(credentialHash),
        bindingSignature: hex(signature.toBytes()),
        protection: 'file'
      }
      const wrongSession = yield* Effect.result(
        owner.host.stageLocalPairing(workspaceId, {
          ...material,
          pairingSessionId: '00'.repeat(16)
        })
      )
      assert.ok(Result.isFailure(wrongSession))
      assert.equal((yield* owner.host.status(workspaceId)).length, 1)
      const alteredHash = yield* Effect.result(
        owner.host.stageLocalPairing(workspaceId, {
          ...material,
          credentialHash: '01'.repeat(32)
        })
      )
      assert.ok(Result.isFailure(alteredHash))
      const foreignBinding = yield* signDeviceCredentialBinding({
        genesis,
        pairingSessionId: new Uint8Array(16).fill(0xfe),
        signingPublicKey: machine.publicKey,
        credentialHash,
        signer: machine
      })
      const replayedSession = yield* Effect.result(
        owner.host.stageLocalPairing(workspaceId, {
          ...material,
          bindingSignature: hex(foreignBinding.toBytes())
        })
      )
      assert.ok(Result.isFailure(replayedSession))
      const changedMachine = yield* Effect.result(
        owner.host.stageLocalPairing(workspaceId, {
          ...material,
          machineId: 'another-machine'
        })
      )
      assert.ok(Result.isFailure(changedMachine))
      assert.equal((yield* owner.host.status(workspaceId)).length, 1)
      const staged = yield* owner.host.stageLocalPairing(workspaceId, material)
      assert.deepEqual(staged, {
        pairingSessionId: context.pairingSessionId,
        protection: 'file',
        admitted: false
      })
      // A second window and retry after a lost prepare response keep the pending
      // approval's session and material; neither authorizes a new attempt.
      assert.deepEqual(yield* owner.host.localPairingContext(workspaceId), context)
      assert.deepEqual(yield* owner.host.stageLocalPairing(workspaceId, material), staged)
      assert.deepEqual(yield* owner.host.localPairingContext(workspaceId), context)
      // Preparing and cancelling the UI does not sign or append a ledger record.
      assert.equal((yield* owner.host.ledgerView(workspaceId)).recordsHex.length, 1)
      const request = yield* owner.host.approveLocalPairing(workspaceId, context.pairingSessionId)
      assert.deepEqual(
        yield* owner.host.approveLocalPairing(workspaceId, context.pairingSessionId),
        request
      )
      assert.equal(request.credentialHash, material.credentialHash)
      assert.equal((yield* owner.host.status(workspaceId)).length, 1)
      return {
        request,
        session: context.pairingSessionId,
        frontendSigningPublicKey: context.frontendSigningPublicKey,
        prepared,
        material
      }
    })
  )
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      yield* owner.host.open(workspaceId)
      assert.equal(
        (yield* owner.host.localPairingContext(workspaceId)).pairingSessionId,
        original.session
      )
      assert.deepEqual(
        yield* owner.host.approveLocalPairing(workspaceId, original.session),
        original.request
      )
      const records = [
        Buffer.from(original.prepared.genesisRecordHex, 'hex'),
        Buffer.from(original.request.recordHex, 'hex')
      ]
      yield* owner.host.ingestLedgerRecords(
        workspaceId,
        page(records, original.prepared.genesisHashHex, 0)
      )
      assert.deepEqual(yield* owner.host.confirmLocalPairing(workspaceId, original.session), {
        machineId: original.material.machineId,
        pairingSessionId: original.session,
        frontendSigningPublicKey: original.frontendSigningPublicKey,
        genesisHash: original.prepared.genesisHashHex,
        signingPublicKey: original.material.signingPublicKey
      })
      assert.equal(yield* owner.host.approveLocalPairing(workspaceId, original.session), null)
      assert.equal((yield* owner.host.status(workspaceId)).length, 2)
    })
  )
})

void test('after workspace creation (verified length 1, no prior cursor), ingesting an inline appendRecord historyPage starting at index 1 advances the verified ledger without an extra history fetch and rejects tampered records', async (t) => {
  const directory = await fixture(t)
  let prepared, records, suffixPage
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      prepared = yield* bind(owner)
      records = yield* makeRecords(owner.custody, prepared, 2)
      const opened = yield* owner.host.open(workspaceId)
      assert.equal(opened.length, 1)
      assert.equal(opened.position, null)

      // Tampered record at index 1 must still be rejected by cryptographic verification without advancing state.
      const tampered = records[1].slice()
      tampered[tampered.length - 1] ^= 1
      const tamperedPage = page([records[0], tampered], prepared.genesisHashHex, 1)
      const rejected = yield* Effect.result(
        owner.host.ingestLedgerRecords(workspaceId, tamperedPage)
      )
      assert.equal(Result.isFailure(rejected), true)
      const afterReject = yield* owner.host.status(workspaceId)
      assert.equal(afterReject.length, 1)
      assert.equal(afterReject.position, null)

      // Contiguous startIndex=1 suffix advances verified length to 2 without re-sending genesis.
      suffixPage = page(records, prepared.genesisHashHex, 1)
      assert.equal(suffixPage.startIndex, 1)
      assert.equal(suffixPage.recordsHex.length, 1)
      const advanced = yield* owner.host.ingestLedgerRecords(workspaceId, suffixPage)
      assert.equal(advanced.length, 2)
      assert.equal(advanced.position, suffixPage.position)
      assert.equal(advanced.headHash, hex(hashRecordBytes(records[1]).toBytes()))
      assert.equal(
        historyDb(directory, (db) => db.prepare('SELECT COUNT(*) AS n FROM records').get().n),
        2
      )
    })
  )
  // Deleting the disposable cache forces replay from SQLite originals, confirming full genesis->index 1 integrity.
  await rm(join(directory, 'workspaces', workspaceId, 'ledger-feed.sqlite'), { force: true }).catch(
    () => {}
  )
  const fsPromises = await import('node:fs/promises')
  const entries = await fsPromises.readdir(join(directory, 'workspaces', workspaceId))
  for (const entry of entries) {
    if (entry.startsWith('ledger-feed'))
      await rm(join(directory, 'workspaces', workspaceId, entry), { force: true })
  }
  await execute(
    Effect.gen(function* () {
      const reopened = yield* ownerWithHost(directory)
      const status = yield* reopened.host.open(workspaceId)
      assert.equal(status.length, 2)
      assert.equal(status.position, suffixPage.position)
      assert.equal(status.headHash, hex(hashRecordBytes(records[1]).toBytes()))
    })
  )
})
