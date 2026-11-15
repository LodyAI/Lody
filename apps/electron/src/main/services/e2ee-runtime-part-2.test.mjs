import {
  Bytes,
  Clock,
  Context,
  DatabaseSync,
  Deferred,
  Effect,
  Fiber,
  InstalledEpochKeys,
  KeyMailbox,
  Layer,
  LedgerPinStore,
  LedgerViewSource,
  Result,
  VerifiedLedger,
  WorkspaceScope,
  assert,
  bind,
  commitEpochKey,
  createDesktopE2eeContent,
  desktopE2eePorts,
  disposeEpochKey,
  encodeCbor,
  execute,
  existsSync,
  extendLedger,
  fixture,
  getCommittedEpochStagingKey,
  hashRecordBytes,
  hex,
  historyDb,
  inspectContentFrame,
  join,
  makeRecords,
  makeSqliteKeyMailbox,
  mkdir,
  ownerWithHost,
  page,
  prepareDeviceAdmission,
  prepareEpochEnvelope,
  prepareLedgerCommand,
  prepareLedgerRecord,
  referenceKeyMailbox,
  sealHistoryPacket,
  signDeviceCredentialBinding,
  signLedgerRecord,
  sqliteInstalledKeyStore,
  sqliteLedgerPinStore,
  test,
  verifyLedger,
  workspaceId
} from './e2ee-runtime-test-helpers.mjs'

for (const outcome of ['unsigned', 'uncertain', 'committed', 'competing', 'admitted', 'revoked']) {
  void test(`local machine pairing preserves pending sessions and renews only after ${outcome} evidence`, async (t) => {
    const directory = await fixture(t)
    let original
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        const prepared = yield* bind(owner)
        yield* owner.host.open(workspaceId)
        const context = yield* owner.host.localPairingContext(workspaceId)
        const genesis = Result.getOrThrow(
          Bytes.genesisHash(Buffer.from(context.genesisHash, 'hex'))
        )
        const machine = yield* owner.custody.prepareDevice()
        const credentialHash = new Uint8Array(32).fill(73)
        const possession = yield* prepareDeviceAdmission({
          genesis,
          membershipId: Result.getOrThrow(
            Bytes.membershipId(Buffer.from(context.membershipId, 'hex'))
          ),
          encryptionPublicKey: machine.enc,
          kind: 'machine',
          machineId: 'synthetic-machine',
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
          machineId: 'synthetic-machine',
          pairingSessionId: context.pairingSessionId,
          signingPublicKey: hex(machine.publicKey.toBytes()),
          encryptionPublicKey: hex(machine.enc.toBytes()),
          possessionSignature: hex(possession.possessionSignature.toBytes()),
          credentialHash: hex(credentialHash),
          bindingSignature: hex(signature.toBytes()),
          protection: 'file'
        }
        yield* owner.host.stageLocalPairing(workspaceId, material)
        let request =
          outcome === 'unsigned' || outcome === 'admitted' || outcome === 'revoked'
            ? null
            : yield* owner.host.approveLocalPairing(workspaceId, context.pairingSessionId)
        if (outcome === 'admitted' || outcome === 'revoked') {
          // Another verified admission can settle staged material even when this
          // local journal never signed a request (approve then returns null).
          const records = [Buffer.from(prepared.genesisRecordHex, 'hex')]
          const view = Result.getOrThrow(
            verifyLedger({
              anchor: genesis,
              records,
              checkpoint: { length: 1, head: hashRecordBytes(records[0]) }
            })
          )
          const signer = yield* owner.custody.openDevice(genesis)
          const record = yield* signLedgerRecord(
            Result.getOrThrow(
              prepareLedgerCommand(view, signer.publicKey, {
                _tag: 'AdmitDevice',
                kind: 'machine',
                machineId: material.machineId,
                signingPublicKey: machine.publicKey,
                encryptionPublicKey: machine.enc,
                possessionSignature: possession.possessionSignature
              })
            ),
            signer
          )
          request = { recordHex: hex(record) }
        }
        if (outcome === 'committed' || outcome === 'admitted' || outcome === 'revoked') {
          const records = [
            Buffer.from(prepared.genesisRecordHex, 'hex'),
            Buffer.from(request.recordHex, 'hex')
          ]
          if (outcome === 'revoked') {
            const view = Result.getOrThrow(
              verifyLedger({
                anchor: genesis,
                records,
                checkpoint: { length: records.length, head: hashRecordBytes(records.at(-1)) }
              })
            )
            const signer = yield* owner.custody.openDevice(genesis)
            records.push(
              yield* signLedgerRecord(
                Result.getOrThrow(
                  prepareLedgerCommand(view, signer.publicKey, {
                    _tag: 'RevokeDevice',
                    target: machine.publicKey
                  })
                ),
                signer
              )
            )
          }
          yield* owner.host.ingestLedgerRecords(
            workspaceId,
            page(records, prepared.genesisHashHex, 0)
          )
        } else if (outcome === 'competing') {
          // Include enough records to compact: terminal evidence must survive retained reopen.
          const records = yield* makeRecords(owner.custody, prepared, 70)
          for (let start = 0; start < records.length; start += 64)
            yield* owner.host.ingestLedgerRecords(
              workspaceId,
              page(records, prepared.genesisHashHex, start, Math.min(start + 64, records.length))
            )
        }
        if (outcome === 'admitted')
          assert.equal(
            yield* owner.host.approveLocalPairing(workspaceId, context.pairingSessionId),
            null
          )
        original = { request, material, context }
        yield* owner.custody.discardDevice(machine)
      })
    )
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        yield* owner.host.open(workspaceId)
        const context = yield* owner.host.localPairingContext(workspaceId)
        if (outcome === 'uncertain' || outcome === 'unsigned') {
          assert.equal(context.pairingSessionId, original.context.pairingSessionId)
          const approved = yield* owner.host.approveLocalPairing(
            workspaceId,
            context.pairingSessionId
          )
          if (outcome === 'uncertain') assert.deepEqual(approved, original.request)
          else assert.equal(typeof approved.recordHex, 'string')
          const conflict = yield* Effect.result(
            owner.host.stageLocalPairing(workspaceId, {
              ...original.material,
              signingPublicKey: '11'.repeat(32)
            })
          )
          assert.equal(conflict.failure.code, 'conflict')
        } else {
          assert.notEqual(context.pairingSessionId, original.context.pairingSessionId)
          const stale = yield* Effect.result(
            owner.host.approveLocalPairing(workspaceId, original.context.pairingSessionId)
          )
          assert.equal(stale.failure.code, 'conflict')
          const replacement = yield* owner.custody.prepareDevice()
          const genesis = Result.getOrThrow(
            Bytes.genesisHash(Buffer.from(context.genesisHash, 'hex'))
          )
          const credentialHash = new Uint8Array(32).fill(74)
          const possession = yield* prepareDeviceAdmission({
            genesis,
            membershipId: Result.getOrThrow(
              Bytes.membershipId(Buffer.from(context.membershipId, 'hex'))
            ),
            encryptionPublicKey: replacement.enc,
            kind: 'machine',
            machineId: original.material.machineId,
            signer: replacement
          })
          const signature = yield* signDeviceCredentialBinding({
            genesis,
            pairingSessionId: Buffer.from(context.pairingSessionId, 'hex'),
            signingPublicKey: replacement.publicKey,
            credentialHash,
            signer: replacement
          })
          const staged = yield* owner.host.stageLocalPairing(workspaceId, {
            ...original.material,
            pairingSessionId: context.pairingSessionId,
            signingPublicKey: hex(replacement.publicKey.toBytes()),
            encryptionPublicKey: hex(replacement.enc.toBytes()),
            possessionSignature: hex(possession.possessionSignature.toBytes()),
            credentialHash: hex(credentialHash),
            bindingSignature: hex(signature.toBytes())
          })
          assert.equal(staged.admitted, false)
          const request = yield* owner.host.approveLocalPairing(
            workspaceId,
            context.pairingSessionId
          )
          assert.ok(request)
          assert.notEqual(request.requestId, original.request?.requestId)
          yield* owner.custody.discardDevice(replacement)
        }
      })
    )
  })
}

void test('a second personal desktop verifies its pinned snapshot, installs through mailbox, exchanges encrypted content and reopens offline', async (t) => {
  const directory = await fixture(t)
  const secondDirectory = join(directory, 'second-desktop')
  let offered, prepared, request, admission, invitation, ciphertext
  const room = { kind: 'meta' }
  const context = {
    protocol: 'loro-streams-crdt-payload-protection',
    version: 2,
    kind: 'update_batch'
  }
  const additionalData = new Uint8Array([7, 18])
  const plaintext = new TextEncoder().encode('synthetic two-personal-device content')
  await execute(
    Effect.gen(function* () {
      const first = yield* ownerWithHost(directory)
      prepared = yield* bind(first)
      yield* first.host.open(workspaceId)
      yield* first.host.ingestLedgerRecords(
        workspaceId,
        page([Buffer.from(prepared.genesisRecordHex, 'hex')], prepared.genesisHashHex, 0)
      )
      offered = yield* first.host.personalPairingOffer(workspaceId)
      assert.deepEqual(yield* first.host.personalPairingOffer(workspaceId), offered)
      const second = yield* ownerWithHost(secondDirectory)
      request = yield* second.bootstrap.preparePersonalJoin(offered)
      assert.deepEqual(yield* second.bootstrap.preparePersonalJoin(offered), request)
      const bad = JSON.parse(Buffer.from(request.requestHex, 'hex').toString())
      bad.credentialHash = '00'.repeat(32)
      const altered = Buffer.from(JSON.stringify(bad)).toString('hex')
      assert.ok(
        Result.isFailure(
          yield* Effect.result(first.host.previewPersonalAdmission(workspaceId, altered))
        )
      )
      const inspected = yield* first.host.previewPersonalAdmission(workspaceId, request.requestHex)
      assert.equal(inspected.signingPublicKey, request.signingPublicKey)
      assert.equal((yield* first.host.status(workspaceId)).length, 1)
      admission = yield* first.host.preparePersonalAdmission(workspaceId, request.requestHex)
      assert.deepEqual(
        yield* first.host.preparePersonalAdmission(workspaceId, request.requestHex),
        admission
      )
      assert.ok(
        Result.isFailure(
          yield* Effect.result(first.host.personalInvitation(workspaceId, offered.pairingSessionId))
        )
      )
    })
  )
  // Both recipient request and approving signature survive closing all native owners.
  await execute(
    Effect.gen(function* () {
      const first = yield* ownerWithHost(directory)
      const second = yield* ownerWithHost(secondDirectory)
      assert.deepEqual(yield* second.bootstrap.preparePersonalJoin(offered), request)
      yield* first.host.open(workspaceId)
      assert.deepEqual(
        yield* first.host.preparePersonalAdmission(workspaceId, request.requestHex),
        admission
      )
      const records = [
        Buffer.from(prepared.genesisRecordHex, 'hex'),
        Buffer.from(admission.recordHex, 'hex')
      ]
      yield* first.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 1))
      invitation = yield* first.host.personalInvitation(workspaceId, offered.pairingSessionId)
      assert.deepEqual(
        yield* first.host.personalInvitation(workspaceId, offered.pairingSessionId),
        invitation
      )
      const corrupt = JSON.parse(Buffer.from(invitation.invitationHex, 'hex').toString())
      corrupt.headSignature = '00'.repeat(64)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            second.bootstrap.acceptPersonalJoin(
              workspaceId,
              Buffer.from(JSON.stringify(corrupt)).toString('hex')
            )
          )
        )
      )
      assert.ok(Result.isFailure(yield* Effect.result(second.host.open(workspaceId))))
      yield* second.bootstrap.acceptPersonalJoin(workspaceId, invitation.invitationHex)
      yield* second.host.open(workspaceId)
      const joined = yield* second.host.open(
        workspaceId,
        {
          genesisHash: prepared.genesisHashHex,
          headHash: prepared.genesisHashHex,
          length: 1
        },
        [page(records, prepared.genesisHashHex, 0)]
      )
      assert.equal(joined.length, 2)
      assert.equal(joined.deviceKind, 'personal')
      assert.equal(joined.hasDeviceCredential, true)
      assert.equal(joined.hasCurrentKey, false)
      assert.equal(joined.position, `p1:${workspaceId}:2:source-2:0`)
      const unrelated = (yield* makeRecords(first.custody, prepared, 2))[1]
      const forgedSuffix = [...records, unrelated]
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            second.host.ingestLedgerRecords(workspaceId, {
              ...page(forgedSuffix, prepared.genesisHashHex, 2),
              startIndex: 3
            })
          )
        )
      )
      assert.equal((yield* second.host.status(workspaceId)).length, 2)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            second.host.ingestLedgerRecords(
              workspaceId,
              page(forgedSuffix, prepared.genesisHashHex, 2)
            )
          )
        )
      )
      const restoredAfterBadSuffix = yield* second.host.open(workspaceId)
      assert.equal(restoredAfterBadSuffix.length, 2)
      assert.equal(restoredAfterBadSuffix.position, joined.position)
      const genesis = Result.getOrThrow(
        Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
      )
      const view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records,
          checkpoint: { head: hashRecordBytes(records.at(-1)), length: 2 }
        })
      )
      const mailboxHost = yield* makeSqliteKeyMailbox({
        path: join(directory, 'two-desktop-mailbox.sqlite'),
        mode: 'create',
        genesis,
        ledger: () => Effect.succeed(view)
      })
      const firstDevice = yield* first.custody.openDevice(genesis)
      const secondDevice = yield* second.custody.openDevice(genesis)
      const firstMailbox = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailboxHost, firstDevice.publicKey)),
        KeyMailbox
      )
      const secondMailbox = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailboxHost, secondDevice.publicKey)),
        KeyMailbox
      )
      yield* first.host.keyRound(workspaceId, () => firstMailbox)
      yield* second.host.keyRound(workspaceId, () => secondMailbox)
      assert.equal((yield* second.host.status(workspaceId)).hasCurrentKey, true)
      ciphertext = yield* first.host.seal(workspaceId, {
        epoch: 0,
        room,
        context,
        plaintext,
        additionalData
      })
      assert.deepEqual(
        yield* second.host.openContent(workspaceId, {
          room,
          context,
          ...ciphertext,
          additionalData
        }),
        plaintext
      )
      const reply = yield* second.host.seal(workspaceId, {
        epoch: 0,
        room,
        context,
        plaintext,
        additionalData
      })
      assert.deepEqual(
        yield* first.host.openContent(workspaceId, { room, context, ...reply, additionalData }),
        plaintext
      )
      assert.deepEqual((yield* second.host.ledgerView(workspaceId)).recordPositions, [0, 1])
    })
  )
  await execute(
    Effect.gen(function* () {
      const second = yield* ownerWithHost(secondDirectory)
      const reopened = yield* second.host.open(workspaceId)
      assert.equal(reopened.length, 2)
      assert.equal(reopened.hasCurrentKey, true)
      assert.deepEqual(
        yield* second.host.openContent(workspaceId, {
          room,
          context,
          ...ciphertext,
          additionalData
        }),
        plaintext
      )
    })
  )
  // A disposable cache cannot change the imported pin or require downloading the prefix.
  historyDb(secondDirectory, (db) => db.prepare('UPDATE cache SET origin=?').run('{corrupt'))
  await execute(
    Effect.gen(function* () {
      const second = yield* ownerWithHost(secondDirectory)
      assert.equal((yield* second.host.open(workspaceId)).hasCurrentKey, true)
    })
  )
})

for (const observedLength of [1, 2])
  for (const nativePin of [false, true, ...(observedLength === 2 ? ['genesis'] : [])]) {
    void test(`snapshot join proves an earlier observation at ${observedLength} (native pin: ${nativePin}) and reopens offline`, async (t) => {
      const directory = await fixture(t)
      const secondDirectory = join(directory, 'second-desktop')
      let observed, records, prepared
      await execute(
        Effect.gen(function* () {
          const first = yield* ownerWithHost(directory)
          prepared = yield* bind(first)
          records = yield* makeRecords(first.custody, prepared, observedLength)
          yield* first.host.open(workspaceId)
          yield* first.host.ingestLedgerRecords(
            workspaceId,
            page(records, prepared.genesisHashHex, 0)
          )
          observed = {
            genesisHash: prepared.genesisHashHex,
            headHash: hex(hashRecordBytes(records.at(-1)).toBytes()),
            length: observedLength
          }
          const offer = yield* first.host.personalPairingOffer(workspaceId)
          const second = yield* ownerWithHost(secondDirectory)
          const request = yield* second.bootstrap.preparePersonalJoin(offer)
          const admission = yield* first.host.preparePersonalAdmission(
            workspaceId,
            request.requestHex
          )
          records.push(Buffer.from(admission.recordHex, 'hex'))
          yield* first.host.ingestLedgerRecords(
            workspaceId,
            page(records, prepared.genesisHashHex, observedLength)
          )
          const invitation = yield* first.host.personalInvitation(
            workspaceId,
            offer.pairingSessionId
          )
          yield* second.bootstrap.acceptPersonalJoin(workspaceId, invitation.invitationHex)
          const genesis = Result.getOrThrow(
            Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
          )
          yield* Effect.promise(() =>
            mkdir(join(secondDirectory, 'workspaces', workspaceId), { recursive: true })
          )
          const pins = Context.get(
            yield* Layer.build(
              sqliteLedgerPinStore({
                path: join(secondDirectory, 'workspaces', workspaceId, 'ledger-pin.sqlite'),
                mode: 'create-or-open'
              }).pipe(Layer.provide(Layer.succeed(WorkspaceScope, { genesis })))
            ),
            LedgerPinStore
          )
          if (nativePin)
            yield* pins.write({
              length: nativePin === 'genesis' ? 1 : observedLength,
              head: hashRecordBytes(records[nativePin === 'genesis' ? 0 : observedLength - 1])
            })
          // The usual claim opens without a renderer observation, before the control page supplies it.
          else assert.equal((yield* second.host.open(workspaceId)).length, observedLength + 1)
          const oldPin = yield* pins.read()
          const missing = yield* Effect.result(second.host.open(workspaceId, observed))
          assert.equal(missing.failure.code, 'snapshot-history-required')
          // A genuinely signed alternate chain with the same genesis is not a bridge to this snapshot.
          const fork = yield* makeRecords(first.custody, prepared, records.length)
          const forkedProof = yield* Effect.result(
            second.host.open(workspaceId, observed, [page(fork, prepared.genesisHashHex, 0)])
          )
          assert.equal(forkedProof.failure.code, 'local-evidence-conflict')
          const rollback = yield* Effect.result(
            second.host.open(workspaceId, observed, [
              page(records.slice(0, observedLength), prepared.genesisHashHex, 0)
            ])
          )
          assert.equal(rollback.failure.code, 'local-evidence-conflict')
          const gap = yield* Effect.result(
            second.host.open(workspaceId, observed, [page(records, prepared.genesisHashHex, 1)])
          )
          assert.equal(gap.failure.code, 'invalid-ledger')
          assert.equal(
            historyDb(
              secondDirectory,
              (db) => db.prepare('SELECT COUNT(*) AS n FROM records').get().n
            ),
            1
          )
          const retainedPin = yield* pins.read()
          assert.equal(retainedPin.length, oldPin.length)
          assert.ok(retainedPin.head.equals(oldPin.head))
          const proof = [
            page(records, prepared.genesisHashHex, 0, 1),
            page(records, prepared.genesisHashHex, 1)
          ]
          if (nativePin) {
            const conflictingObserved = {
              ...observed,
              headHash:
                observedLength === 1
                  ? '00'.repeat(32)
                  : hex(hashRecordBytes(fork[observedLength - 1]).toBytes())
            }
            const rejected = yield* Effect.result(
              second.host.open(workspaceId, conflictingObserved, proof)
            )
            assert.equal(rejected.failure.code, 'local-evidence-conflict')
            const afterRejected = yield* pins.read()
            assert.equal(
              afterRejected.length,
              oldPin.length,
              'failed open must not advance durable pin'
            )
            assert.ok(afterRejected.head.equals(oldPin.head))
            assert.equal(
              historyDb(
                secondDirectory,
                (db) => db.prepare('SELECT COUNT(*) AS n FROM records').get().n
              ),
              1
            )
            // A failed observed open must not leave a bridge that makes an unobserved open succeed.
            const unobserved = yield* Effect.result(second.host.open(workspaceId))
            assert.equal(unobserved.failure.code, 'snapshot-history-required')
            const beforeFetch = yield* Effect.result(
              second.host.open(workspaceId, conflictingObserved)
            )
            assert.equal(
              beforeFetch.failure.code,
              nativePin === 'genesis' ? 'snapshot-history-required' : 'local-evidence-conflict'
            )
          }
          const status = yield* second.host.open(workspaceId, observed, proof)
          assert.equal(status.length, observedLength + 1)
          assert.equal(status.continuityPending, false)
          // Even a real head from a sibling fork at n cannot replace the retained observation.
          const conflict = yield* Effect.result(
            second.host.open(workspaceId, {
              ...observed,
              headHash:
                observedLength === 1
                  ? '00'.repeat(32)
                  : hex(hashRecordBytes(fork[observedLength - 1]).toBytes())
            })
          )
          assert.equal(conflict.failure.code, 'local-evidence-conflict')
          assert.equal((yield* second.host.status(workspaceId)).length, observedLength + 1)
        })
      )
      await execute(
        Effect.gen(function* () {
          const second = yield* ownerWithHost(secondDirectory)
          const status = yield* second.host.open(workspaceId, observed)
          assert.equal(status.length, observedLength + 1)
          assert.equal(status.continuityPending, false)
        })
      )
    })
  }

void test('a snapshot-joined desktop installs only the current epoch and derives older content from the verified history chain', async (t) => {
  const directory = await fixture(t),
    secondDirectory = join(directory, 'second-desktop')
  const room = { kind: 'meta' },
    context = { protocol: 'loro-streams-crdt-payload-protection', version: 2, kind: 'update_batch' }
  const additionalData = new Uint8Array([21]),
    plaintext = new TextEncoder().encode('synthetic older epoch content')
  await execute(
    Effect.gen(function* () {
      const first = yield* ownerWithHost(directory),
        prepared = yield* bind(first)
      yield* first.host.open(workspaceId)
      const oldContent = yield* first.host.seal(workspaceId, {
        epoch: 0,
        room,
        context,
        plaintext,
        additionalData
      })
      const genesis = Result.getOrThrow(
        Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
      )
      const signer = yield* first.custody.openDevice(genesis)
      const records = [Buffer.from(prepared.genesisRecordHex, 'hex')]
      let view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records,
          checkpoint: { head: hashRecordBytes(records.at(-1)), length: 1 }
        })
      )
      const keysLayer = InstalledEpochKeys.layer.pipe(
        Layer.provideMerge(
          sqliteInstalledKeyStore({
            path: join(directory, 'workspaces', workspaceId, 'installed-keys.sqlite'),
            mode: 'open'
          })
        ),
        Layer.provideMerge(VerifiedLedger.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            desktopE2eePorts(first.custody, signer),
            Layer.succeed(WorkspaceScope, { genesis }),
            Layer.succeed(LedgerViewSource, { current: () => Effect.succeed(view) }),
            Layer.succeed(LedgerPinStore, {
              read: () => Effect.succeed(null),
              write: () => Effect.void
            })
          )
        )
      )
      const keys = Context.get(yield* Layer.build(keysLayer), InstalledEpochKeys)
      const currentKey = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(61)))
      yield* Effect.acquireUseRelease(
        keys.read(0),
        (previousKey) =>
          Effect.gen(function* () {
            const commitment = Result.getOrThrow(commitEpochKey(genesis, 1, currentKey))
            const previousEpochKey = Result.getOrThrow(
              sealHistoryPacket({ genesis, epoch: 1, currentKey, previousKey })
            )
            const body = Result.getOrThrow(
              encodeCbor([
                view.head.toBytes(),
                signer.publicKey.toBytes(),
                [7, 1, commitment.toBytes(), previousEpochKey]
              ])
            )
            const rotation = yield* signLedgerRecord(
              Result.getOrThrow(prepareLedgerRecord(view, body)),
              signer
            )
            records.push(rotation)
            view = Result.getOrThrow(
              extendLedger(view, [rotation], { head: hashRecordBytes(rotation), length: 2 })
            )
            yield* first.host.ingestLedgerRecords(
              workspaceId,
              page(records, prepared.genesisHashHex, 0)
            )
            yield* keys.saveAndReload(1, currentKey)
          }),
        (key) => Effect.sync(() => disposeEpochKey(key))
      )
      disposeEpochKey(currentKey)
      const offer = yield* first.host.personalPairingOffer(workspaceId)
      const second = yield* ownerWithHost(secondDirectory),
        request = yield* second.bootstrap.preparePersonalJoin(offer)
      const admission = yield* first.host.preparePersonalAdmission(workspaceId, request.requestHex)
      records.push(Buffer.from(admission.recordHex, 'hex'))
      view = Result.getOrThrow(
        extendLedger(view, [records.at(-1)], { head: hashRecordBytes(records.at(-1)), length: 3 })
      )
      yield* first.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 2))
      const invitation = yield* first.host.personalInvitation(workspaceId, offer.pairingSessionId)
      yield* second.bootstrap.acceptPersonalJoin(workspaceId, invitation.invitationHex)
      assert.equal((yield* second.host.open(workspaceId)).epoch, 1)
      const mailboxHost = yield* makeSqliteKeyMailbox({
        path: join(directory, 'history-mailbox.sqlite'),
        mode: 'create',
        genesis,
        ledger: () => Effect.succeed(view)
      })
      const secondSigner = yield* second.custody.openDevice(genesis)
      const firstMailbox = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailboxHost, signer.publicKey)),
        KeyMailbox
      )
      const secondMailbox = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailboxHost, secondSigner.publicKey)),
        KeyMailbox
      )
      yield* first.host.keyRound(workspaceId, () => firstMailbox)
      yield* second.host.keyRound(workspaceId, () => secondMailbox)
      assert.equal((yield* second.host.status(workspaceId)).hasCurrentKey, true)
      assert.deepEqual(
        yield* second.host.openContent(workspaceId, {
          room,
          context,
          ...oldContent,
          additionalData
        }),
        plaintext
      )
      // The old key is derived from the authenticated history packet, never sent via staging/mailbox.
      const oldEpochFetch = yield* Effect.result(
        secondMailbox.fetch(
          { genesis: prepared.genesisHashHex, epoch: 0, recipient: request.signingPublicKey },
          null,
          100
        )
      )
      assert.equal(oldEpochFetch.failure.reason, 'unauthorized')
      const reply = yield* second.host.seal(workspaceId, {
        epoch: 1,
        room,
        context,
        plaintext,
        additionalData
      })
      assert.deepEqual(
        yield* first.host.openContent(workspaceId, { room, context, ...reply, additionalData }),
        plaintext
      )
    })
  )
})

void test('the approval display pins the exact request and canceled unsigned sessions can renew without replacing keys', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const first = yield* ownerWithHost(directory)
      yield* bind(first)
      yield* first.host.open(workspaceId)
      const offer = yield* first.host.personalPairingOffer(workspaceId)
      const second = yield* ownerWithHost(join(directory, 'second'))
      const third = yield* ownerWithHost(join(directory, 'third'))
      const a = yield* second.bootstrap.preparePersonalJoin(offer)
      const b = yield* third.bootstrap.preparePersonalJoin(offer)
      assert.notEqual(a.signingPublicKey, b.signingPublicKey)
      yield* first.host.previewPersonalAdmission(workspaceId, a.requestHex)
      const substituted = yield* Effect.result(
        first.host.preparePersonalAdmission(workspaceId, b.requestHex)
      )
      assert.equal(substituted.failure.code, 'conflict')
      assert.equal((yield* first.host.status(workspaceId)).length, 1)
      // Caller has reconciled the backend terminal canceled state before these narrow local operations.
      yield* second.bootstrap.retirePersonalJoin(workspaceId, offer.pairingSessionId)
      yield* second.bootstrap.retirePersonalJoin(workspaceId, offer.pairingSessionId)
      yield* first.host.retirePersonalPairing(workspaceId, offer.pairingSessionId)
      yield* first.host.retirePersonalPairing(workspaceId, offer.pairingSessionId)
      const next = yield* first.host.personalPairingOffer(workspaceId)
      assert.notEqual(next.pairingSessionId, offer.pairingSessionId)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            second.bootstrap.preparePersonalJoin({ ...next, endorser: b.signingPublicKey })
          )
        )
      )
      const renewed = yield* second.bootstrap.preparePersonalJoin(next)
      assert.equal(renewed.signingPublicKey, a.signingPublicKey)
      assert.equal(renewed.credentialHash, a.credentialHash)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(first.host.preparePersonalAdmission(workspaceId, a.requestHex))
        )
      )
      yield* first.host.previewPersonalAdmission(workspaceId, renewed.requestHex)
      const signed = yield* first.host.preparePersonalAdmission(workspaceId, renewed.requestHex)
      assert.ok(signed.recordHex)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(first.host.retirePersonalPairing(workspaceId, next.pairingSessionId))
        )
      )
      assert.deepEqual(
        yield* first.host.preparePersonalAdmission(workspaceId, renewed.requestHex),
        signed
      )
    })
  )
})

void test('a verified competing parent settles a lost personal admission without discarding its original or replacing recipient identity', async (t) => {
  const directory = await fixture(t)
  await execute(
    Effect.gen(function* () {
      const first = yield* ownerWithHost(directory),
        prepared = yield* bind(first)
      yield* first.host.open(workspaceId)
      const offer = yield* first.host.personalPairingOffer(workspaceId)
      const second = yield* ownerWithHost(join(directory, 'second'))
      const request = yield* second.bootstrap.preparePersonalJoin(offer)
      const signed = yield* first.host.preparePersonalAdmission(workspaceId, request.requestHex)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            first.host.retirePersonalPairing(workspaceId, offer.pairingSessionId)
          )
        )
      )
      assert.deepEqual(
        yield* first.host.preparePersonalAdmission(workspaceId, request.requestHex),
        signed
      )
      // A valid, different CAS winner at the exact signed parent is ledger proof.
      const competing = yield* makeRecords(first.custody, prepared, 2)
      yield* first.host.ingestLedgerRecords(
        workspaceId,
        page(competing, prepared.genesisHashHex, 0)
      )
      const next = yield* first.host.personalPairingOffer(workspaceId)
      assert.notEqual(next.pairingSessionId, offer.pairingSessionId)
      yield* first.host.retirePersonalPairing(workspaceId, offer.pairingSessionId)
      const retained = historyDb(directory, (db) =>
        db
          .prepare('SELECT record,request_id,retired FROM personal_pairing WHERE session=?')
          .get(offer.pairingSessionId)
      )
      assert.equal(hex(retained.record), signed.recordHex)
      assert.equal(retained.request_id, signed.requestId)
      assert.equal(retained.retired, 1)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(first.host.preparePersonalAdmission(workspaceId, request.requestHex))
        )
      )
      // The recipient has reconciled terminal conflict before retiring the old request.
      yield* second.bootstrap.retirePersonalJoin(workspaceId, offer.pairingSessionId)
      const renewed = yield* second.bootstrap.preparePersonalJoin(next)
      assert.equal(renewed.signingPublicKey, request.signingPublicKey)
      assert.equal(renewed.credentialHash, request.credentialHash)
      const nextSigned = yield* first.host.preparePersonalAdmission(workspaceId, renewed.requestHex)
      assert.notEqual(nextSigned.recordHex, signed.recordHex)
      assert.equal((yield* first.host.status(workspaceId)).length, 2)
    })
  )
})

void test('terminal cancellation can archive a signed pre-reservation intent, while unknown or committed admissions remain protected', async (t) => {
  const directory = await fixture(t)
  let request, signed, offer
  await execute(
    Effect.gen(function* () {
      const first = yield* ownerWithHost(directory)
      yield* bind(first)
      yield* first.host.open(workspaceId)
      offer = yield* first.host.personalPairingOffer(workspaceId)
      const second = yield* ownerWithHost(join(directory, 'second'))
      request = yield* second.bootstrap.preparePersonalJoin(offer)
      signed = yield* first.host.preparePersonalAdmission(workspaceId, request.requestHex)
      assert.ok(
        Result.isFailure(
          yield* Effect.result(
            first.host.retirePersonalPairing(workspaceId, offer.pairingSessionId)
          )
        )
      )
      // Main invokes only after the service confirmed this session terminal-cancelled
      // before append reservation. All original bytes remain available locally.
      yield* first.host.cancelPersonalPairing(workspaceId, offer.pairingSessionId)
      yield* first.host.cancelPersonalPairing(workspaceId, offer.pairingSessionId)
      yield* second.bootstrap.retirePersonalJoin(workspaceId, offer.pairingSessionId)
    })
  )
  await execute(
    Effect.gen(function* () {
      const first = yield* ownerWithHost(directory),
        second = yield* ownerWithHost(join(directory, 'second'))
      yield* first.host.open(workspaceId)
      const next = yield* first.host.personalPairingOffer(workspaceId)
      assert.notEqual(next.pairingSessionId, offer.pairingSessionId)
      const retained = historyDb(directory, (db) =>
        db
          .prepare('SELECT record,request_id,retired FROM personal_pairing WHERE session=?')
          .get(offer.pairingSessionId)
      )
      assert.equal(hex(retained.record), signed.recordHex)
      assert.equal(retained.request_id, signed.requestId)
      assert.equal(retained.retired, 1)
      const renewed = yield* second.bootstrap.preparePersonalJoin(next)
      assert.equal(renewed.signingPublicKey, request.signingPublicKey)
      assert.equal(renewed.credentialHash, request.credentialHash)
      const committed = yield* first.host.preparePersonalAdmission(workspaceId, renewed.requestHex)
      const records = [
        Buffer.from(next.genesisRecordHex, 'hex'),
        Buffer.from(committed.recordHex, 'hex')
      ]
      yield* first.host.ingestLedgerRecords(workspaceId, page(records, next.genesisHash, 0))
      assert.ok(
        Result.isFailure(
          yield* Effect.result(first.host.cancelPersonalPairing(workspaceId, next.pairingSessionId))
        )
      )
      assert.ok(
        Result.isFailure(
          yield* Effect.result(first.host.retirePersonalPairing(workspaceId, next.pairingSessionId))
        )
      )
      assert.equal((yield* first.host.status(workspaceId)).length, 2)
    })
  )
})

for (const source of ['staging', 'temporary-io'])
  void test(`reopens without a candidate and installs the committed epoch via ${source}`, async (t) => {
    const directory = await fixture(t)
    const clock = Object.assign(Object.create(Effect.runSync(Clock.Clock)), {
      currentTimeMillisUnsafe: () => 1_800_000_000_000,
      monotonicTimeNanosUnsafe: () => 0n
    })
    const run = (work) => execute(work.pipe(Effect.provideService(Clock.Clock, clock)))
    let prepared, records, group, retained
    const oldRequest = {
      epoch: 0,
      room: { kind: 'doc', docId: 'staged-document' },
      context: {
        protocol: 'loro-streams-crdt-payload-protection',
        version: 2,
        kind: 'update_batch'
      },
      plaintext: new Uint8Array([4, 5]),
      additionalData: new Uint8Array([3])
    }
    await run(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        prepared = yield* bind(owner)
        yield* owner.host.open(workspaceId)
        const genesis = Result.getOrThrow(
          Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
        )
        const signer = yield* owner.custody.openDevice(genesis)
        records = [Buffer.from(prepared.genesisRecordHex, 'hex')]
        let view = Result.getOrThrow(
          verifyLedger({
            anchor: genesis,
            records,
            checkpoint: { head: hashRecordBytes(records[0]), length: 1 }
          })
        )
        const ports = Layer.mergeAll(
          desktopE2eePorts(owner.custody, signer),
          Layer.succeed(WorkspaceScope, { genesis }),
          Layer.succeed(LedgerViewSource, { current: () => Effect.succeed(view) }),
          Layer.succeed(LedgerPinStore, {
            read: () => Effect.succeed(null),
            write: () => Effect.void
          })
        )
        const keys = Context.get(
          yield* Layer.build(
            InstalledEpochKeys.layer.pipe(
              Layer.provideMerge(
                sqliteInstalledKeyStore({
                  path: join(directory, 'workspaces', workspaceId, 'installed-keys.sqlite'),
                  mode: 'open'
                })
              ),
              Layer.provideMerge(VerifiedLedger.layer),
              Layer.provideMerge(ports)
            )
          ),
          InstalledEpochKeys
        )
        const next = Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(71)))
        try {
          const packet = yield* Effect.acquireUseRelease(
            keys.read(0),
            (previousKey) =>
              Effect.succeed(
                Result.getOrThrow(
                  sealHistoryPacket({ genesis, epoch: 1, currentKey: next, previousKey })
                )
              ),
            (key) => Effect.sync(() => disposeEpochKey(key))
          )
          const commitment = Result.getOrThrow(commitEpochKey(genesis, 1, next))
          const body = Result.getOrThrow(
            encodeCbor([
              view.head.toBytes(),
              signer.publicKey.toBytes(),
              [7, 1, commitment.toBytes(), packet]
            ])
          )
          const record = yield* signLedgerRecord(
            Result.getOrThrow(prepareLedgerRecord(view, body)),
            signer
          )
          records.push(record)
          view = Result.getOrThrow(
            extendLedger(view, [record], { head: hashRecordBytes(record), length: 2 })
          )
          const frame = yield* prepareEpochEnvelope({
            context: {
              genesis,
              epoch: Result.getOrThrow(Bytes.epochNumber(1)),
              sender: signer.publicKey,
              recipient: signer.publicKey
            },
            key: next,
            signer,
            ledger: () => Effect.succeed(view)
          })
          group = {
            ...Result.getOrThrow(getCommittedEpochStagingKey(view, 1)),
            record,
            envelopes: [{ recipient: hex(signer.publicKey.toBytes()), frame }]
          }
        } finally {
          disposeEpochKey(next)
        }
        retained = yield* owner.host.seal(workspaceId, oldRequest)
      })
    )
    // The publication key has been wiped and all former native owners are closed.
    await run(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        yield* owner.host.open(workspaceId)
        yield* owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, prepared.genesisHashHex, 0)
        )
        assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, false)
        assert.equal((yield* owner.host.status(workspaceId)).writeEpoch, 0)
        yield* owner.host.closeWorkspace(workspaceId)
        assert.equal((yield* owner.host.open(workspaceId)).writeEpoch, 0)
        const beforeReceipt = yield* owner.host.seal(workspaceId, oldRequest)
        assert.equal(Result.getOrThrow(inspectContentFrame(beforeReceipt.sealed)).epoch, 0)
        assert.deepEqual(
          yield* owner.host.openContent(workspaceId, { ...oldRequest, ...retained }),
          oldRequest.plaintext
        )

        const genesis = Result.getOrThrow(
          Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex'))
        )
        const signer = yield* owner.custody.openDevice(genesis)
        const view = Result.getOrThrow(
          verifyLedger({
            anchor: genesis,
            records,
            checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
          })
        )
        const mailboxHost = yield* makeSqliteKeyMailbox({
          path: join(directory, 'staged-only-mailbox.sqlite'),
          mode: 'create',
          genesis,
          ledger: () => Effect.succeed(view)
        })
        const mailbox = Context.get(
          yield* Layer.build(referenceKeyMailbox(mailboxHost, signer.publicKey)),
          KeyMailbox
        )
        let unavailable = true
        const staging = () => ({
          readGroup: () =>
            Effect.suspend(() =>
              unavailable ? Effect.fail(new Error(source)) : Effect.succeed(group)
            )
        })
        const missing = yield* Effect.result(
          owner.host.keyRound(workspaceId, () => mailbox, staging)
        )
        assert.equal(
          Result.isFailure(missing) && missing.failure.distribution.failure.reason,
          'missing-key'
        )
        assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, false)
        const grace = yield* owner.host.seal(workspaceId, oldRequest)
        assert.equal(Result.getOrThrow(inspectContentFrame(grace.sealed)).epoch, 0)
        // A missing mailbox key remains visibly missing across repeated staging failures.
        const retried = yield* Effect.result(
          owner.host.keyRound(workspaceId, () => mailbox, staging)
        )
        assert.equal(
          Result.isFailure(retried) && retried.failure.distribution.failure.reason,
          'missing-key'
        )
        assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, false)
        if (source === 'staging') unavailable = false
        else yield* mailbox.put('01'.repeat(16), group.envelopes[0].frame)
        yield* owner.host.keyRound(workspaceId, () => mailbox, staging)
        assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
        const sealed = yield* owner.host.seal(workspaceId, {
          epoch: 1,
          room: { kind: 'doc', docId: 'staged-document' },
          context: {
            protocol: 'loro-streams-crdt-payload-protection',
            version: 2,
            kind: 'update_batch'
          },
          plaintext: new Uint8Array([1, 2]),
          additionalData: new Uint8Array([3])
        })
        assert.equal(Result.getOrThrow(inspectContentFrame(sealed.sealed)).epoch, 1)
      })
    )
  })

for (const damaged of [false, true, 'header'])
  void test(`manual management resumes across full rounds and restart; damaged candidate=${damaged}`, async (t) => {
    const directory = await fixture(t)
    let prepared, records, view, genesis, target
    const groups = new Map(),
      roundIds = [],
      originals = []
    let unavailable = true
    const fullRounds = new Set()
    await execute(
      Effect.gen(function* () {
        const owner = yield* ownerWithHost(directory)
        prepared = yield* bind(owner)
        records = [Buffer.from(prepared.genesisRecordHex, 'hex')]
        genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex')))
        view = Result.getOrThrow(
          verifyLedger({
            anchor: genesis,
            records,
            checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
          })
        )
        const signer = yield* owner.custody.openDevice(genesis)
        const machine = yield* owner.custody.prepareDevice()
        const command = yield* prepareDeviceAdmission({
          genesis,
          membershipId: view.inspectState().owner,
          signer: machine,
          encryptionPublicKey: machine.enc,
          kind: 'machine',
          machineId: 'synthetic-machine'
        })
        const record = yield* signLedgerRecord(
          Result.getOrThrow(prepareLedgerCommand(view, signer.publicKey, command)),
          signer
        )
        records.push(record)
        view = Result.getOrThrow(
          extendLedger(view, [record], { head: hashRecordBytes(record), length: records.length })
        )
        target = hex(machine.publicKey.toBytes())
        yield* owner.custody.discardDevice(machine)
        yield* owner.host.open(workspaceId)
        yield* owner.host.ingestLedgerRecords(
          workspaceId,
          page(records, prepared.genesisHashHex, 0)
        )
      })
    )
    const { E2eeStagingCapacityError } = await import('./e2ee-cloud-client.mts')
    for (const reopened of [false, true, 'install-retry'])
      await execute(
        Effect.gen(function* () {
          const owner = yield* ownerWithHost(directory)
          yield* owner.host.open(workspaceId)
          const signer = yield* owner.custody.openDevice(genesis)
          const mailboxHost = yield* makeSqliteKeyMailbox({
            path: join(directory, 'management-mailbox.sqlite'),
            mode: existsSync(join(directory, 'management-mailbox.sqlite')) ? 'open' : 'create',
            genesis,
            ledger: () => Effect.succeed(view)
          })
          const mailbox = Context.get(
            yield* Layer.build(referenceKeyMailbox(mailboxHost, signer.publicKey)),
            KeyMailbox
          )
          const ports = () => ({
            history: () => Effect.succeed(page(records, prepared.genesisHashHex, 0)),
            mailbox: () => mailbox,
            log: {
              read: () =>
                Effect.succeed({ records, checkpoint: { head: view.head, length: view.length } }),
              appendCas: (_anchor, expected, record) =>
                Effect.sync(() => {
                  assert.equal(view.head.equals(expected.head), true)
                  view = Result.getOrThrow(
                    extendLedger(view, [record], {
                      head: hashRecordBytes(record),
                      length: view.length + 1
                    })
                  )
                  records = [...records, record]
                })
            },
            staging: (round) => ({
              stageGroup: (group) =>
                Effect.suspend(() => {
                  roundIds.push(round)
                  originals.push(Buffer.from(group.record))
                  if (unavailable) return Effect.fail(new Error('staging-offline'))
                  if (fullRounds.has(round) || fullRounds.size < 2) {
                    fullRounds.add(round)
                    return Effect.fail(new E2eeStagingCapacityError(round, 1))
                  }
                  groups.set(group.recordHash, group)
                  return Effect.void
                }),
              readGroup: (key) => Effect.succeed(groups.get(key.recordHash) ?? null),
              deleteGroup: () => Effect.void
            })
          })
          if (!reopened) {
            assert.equal((yield* owner.host.managementState(workspaceId)).mayRotate, true)
            // Every command first refreshes the ledger, before any candidate or pending
            // submission exists. Its state must already read as an update in progress,
            // or a reader takes the old epoch as settled and closes mid-update.
            const entered = yield* Deferred.make()
            const release = yield* Deferred.make()
            const gated = (signal) => {
              const upstream = ports(signal)
              return {
                ...upstream,
                history: (request) =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(upstream.history(request))
                  )
              }
            }
            const revoking = yield* Effect.forkChild(
              owner.host.manage(workspaceId, { type: 'revoke', target }, gated)
            )
            yield* Deferred.await(entered)
            const during = yield* owner.host.managementState(workspaceId)
            // Release before asserting: the update itself is uninterruptible.
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(revoking)
            assert.equal(during.updatePending, true)
            assert.equal(during.updateInProgress, true)
            assert.equal((yield* owner.host.managementState(workspaceId)).updateInProgress, false)
            assert.equal(view.inspectState().devices.has(target), false)
            assert.equal(view.inspectState().epoch.rotationRequired, true)
            assert.equal(
              Result.isFailure(
                yield* Effect.result(owner.host.manage(workspaceId, { type: 'rotate' }, ports))
              ),
              true
            )
            assert.equal(view.inspectState().epoch.number, 0)
            const request = {
              epoch: 0,
              room: { kind: 'doc', docId: 'still-usable' },
              context: {
                protocol: 'loro-streams-crdt-payload-protection',
                version: 2,
                kind: 'update_batch'
              },
              plaintext: new Uint8Array([1]),
              additionalData: new Uint8Array([2])
            }
            const sealed = yield* owner.host.seal(workspaceId, request)
            assert.deepEqual(
              yield* owner.host.openContent(workspaceId, { ...request, ...sealed }),
              request.plaintext
            )
            assert.equal((yield* owner.host.managementState(workspaceId)).updatePending, true)
            if (damaged) {
              const key = (yield* owner.host.managementState(workspaceId)).devices.find(
                (entry) => entry.self
              ).key
              const db = new DatabaseSync(
                join(directory, 'workspaces', workspaceId, `epoch-candidates-${key}.sqlite`)
              )
              try {
                if (damaged === 'header')
                  db.prepare('UPDATE epoch_rotation_meta SET publisher=?').run('ff'.repeat(32))
                else {
                  /* Damage is injected only after the publication commits below. */
                }
              } finally {
                db.close()
              }
            }
            unavailable = false
            return
          }
          if (damaged === 'header' && reopened === true) {
            const visible = yield* owner.host.managementState(workspaceId)
            assert.equal(visible.mayRotate, true)
            assert.equal(visible.recoveryIssue, 'candidate-unavailable')
            assert.equal(visible.updatePending, true)
            assert.equal(
              Result.isFailure(
                yield* Effect.result(owner.host.manage(workspaceId, { type: 'rotate' }, ports))
              ),
              true
            )
            const key = visible.devices.find((entry) => entry.self).key
            const db = new DatabaseSync(
              join(directory, 'workspaces', workspaceId, `epoch-candidates-${key}.sqlite`)
            )
            try {
              db.prepare('UPDATE epoch_rotation_meta SET publisher=?').run(key)
            } finally {
              db.close()
            }
          }
          if (reopened === true) {
            // Capacity and installation failures have separate retry paths at the same epoch.
            assert.equal(
              Result.isFailure(
                yield* Effect.result(owner.host.manage(workspaceId, { type: 'rotate' }, ports))
              ),
              true
            )
            const db = new DatabaseSync(
              join(directory, 'workspaces', workspaceId, 'installed-keys.sqlite')
            )
            try {
              db.exec(
                "CREATE TRIGGER fail_rotation_install BEFORE INSERT ON installed_epoch_keys WHEN NEW.epoch=1 BEGIN SELECT RAISE(ABORT,'synthetic SQLITE_BUSY'); END"
              )
              assert.equal(
                Result.isFailure(
                  yield* Effect.result(owner.host.manage(workspaceId, { type: 'rotate' }, ports))
                ),
                true
              )
              assert.equal(view.inspectState().epoch.number, 1)
              assert.equal((yield* owner.host.managementState(workspaceId)).updatePending, true)
              assert.equal((yield* owner.host.status(workspaceId)).writeEpoch, 0)
              if (damaged === true) {
                const key = (yield* owner.host.managementState(workspaceId)).devices.find(
                  (entry) => entry.self
                ).key
                const candidate = new DatabaseSync(
                  join(directory, 'workspaces', workspaceId, `epoch-candidates-${key}.sqlite`)
                )
                try {
                  candidate.exec("UPDATE epoch_rotation_candidates SET blob=x'00'")
                } finally {
                  candidate.close()
                }
              }
            } finally {
              db.exec('DROP TRIGGER fail_rotation_install')
              db.close()
            }
            return
          }
          yield* owner.host.manage(workspaceId, { type: 'rotate' }, ports)
          assert.equal(view.inspectState().epoch.number, 1)
          assert.equal(view.inspectState().epoch.rotationRequired, false)
          assert.equal((yield* owner.host.status(workspaceId)).hasCurrentKey, true)
          assert.equal((yield* owner.host.managementState(workspaceId)).updatePending, false)
          assert.equal(roundIds[0], roundIds[1])
          assert.equal(new Set(roundIds).size, 3)
          assert.equal(
            originals.every((record) => record.equals(originals[0])),
            true
          )
          assert.equal(
            groups
              .values()
              .next()
              .value.envelopes.some((entry) => entry.recipient === target),
            false
          )
          // Another window/native operation rotates without notifying this
          // renderer. Its real stable provider still holds the epoch-0 hint.
          const content = createDesktopE2eeContent({
            runtime: {
              seal: (id, input) => Effect.runPromise(owner.host.seal(id, input)),
              openContent: (id, input) => Effect.runPromise(owner.host.openContent(id, input))
            },
            workspaceId,
            genesisHash: prepared.genesisHashHex,
            epoch: 0,
            authToken: () => null
          })
          try {
            for (const room of [{ kind: 'doc', docId: 'post-revocation' }, { kind: 'meta' }])
              for (const kind of ['update_batch', 'snapshot']) {
                const provider = content.content.resolve(room).config.provider
                const request = {
                  context: {
                    protocol: 'loro-streams-crdt-payload-protection',
                    version: 2,
                    kind,
                    ...(kind === 'snapshot' ? { continuationOffset: 'next' } : {})
                  },
                  plaintext: new Uint8Array([23]),
                  additionalData: () => new Uint8Array([3])
                }
                const sealed = yield* Effect.promise(() => provider.seal(request))
                const purpose = `${room.kind === 'doc' ? 'doc' : 'flock'}-${kind === 'snapshot' ? 'snapshot' : 'update'}`
                assert.equal(
                  Result.getOrThrow(inspectContentFrame(sealed.sealed, purpose)).epoch,
                  1
                )
                assert.deepEqual(
                  yield* Effect.promise(() =>
                    provider.open({ ...request, ...sealed, additionalData: new Uint8Array([3]) })
                  ),
                  request.plaintext
                )
              }
          } finally {
            yield* Effect.promise(() => content.close())
          }
        })
      )
  })

void test('manual rotation retains turnSync across inline push-ingested appendCas without redundant post-CAS refresh or readFrom', async (t) => {
  const directory = await fixture(t)
  let prepared, records, view, genesis
  const groups = new Map()
  let historyCalls = 0,
    readFromCalls = 0,
    readCalls = 0,
    observeCalls = 0,
    observed = null
  await execute(
    Effect.gen(function* () {
      const owner = yield* ownerWithHost(directory)
      prepared = yield* bind(owner)
      records = [Buffer.from(prepared.genesisRecordHex, 'hex')]
      genesis = Result.getOrThrow(Bytes.genesisHash(Buffer.from(prepared.genesisHashHex, 'hex')))
      view = Result.getOrThrow(
        verifyLedger({
          anchor: genesis,
          records,
          checkpoint: { head: hashRecordBytes(records.at(-1)), length: records.length }
        })
      )
      const signer = yield* owner.custody.openDevice(genesis)
      const machine = yield* owner.custody.prepareDevice()
      const admitCommand = yield* prepareDeviceAdmission({
        genesis,
        membershipId: view.inspectState().owner,
        signer: machine,
        encryptionPublicKey: machine.enc,
        kind: 'machine',
        machineId: 'synthetic-machine'
      })
      const admitRecord = yield* signLedgerRecord(
        Result.getOrThrow(prepareLedgerCommand(view, signer.publicKey, admitCommand)),
        signer
      )
      records = [...records, admitRecord]
      view = Result.getOrThrow(
        extendLedger(view, [admitRecord], {
          head: hashRecordBytes(admitRecord),
          length: records.length
        })
      )
      const revokeRecord = yield* signLedgerRecord(
        Result.getOrThrow(
          prepareLedgerCommand(view, signer.publicKey, {
            _tag: 'RevokeDevice',
            target: machine.publicKey,
            confirmedRecoveryOnly: true
          })
        ),
        signer
      )
      records = [...records, revokeRecord]
      view = Result.getOrThrow(
        extendLedger(view, [revokeRecord], {
          head: hashRecordBytes(revokeRecord),
          length: records.length
        })
      )
      yield* owner.custody.discardDevice(machine)
      yield* owner.host.open(workspaceId)
      yield* owner.host.ingestLedgerRecords(workspaceId, page(records, prepared.genesisHashHex, 0))
      const mailboxHost = yield* makeSqliteKeyMailbox({
        path: join(directory, 'management-mailbox.sqlite'),
        mode: 'create',
        genesis,
        ledger: () => Effect.succeed(view)
      })
      const mailbox = Context.get(
        yield* Layer.build(referenceKeyMailbox(mailboxHost, signer.publicKey)),
        KeyMailbox
      )
      const ports = () => ({
        history: () =>
          Effect.sync(() => {
            historyCalls++
            return page(records, prepared.genesisHashHex, 0)
          }),
        mailbox: () => mailbox,
        log: {
          observe: (point) =>
            Effect.sync(() => {
              observeCalls++
              observed = point
            }),
          read: () =>
            Effect.sync(() => {
              readCalls++
              return { records, checkpoint: { head: view.head, length: records.length } }
            }),
          readFrom: (_anchor, base) =>
            Effect.sync(() => {
              readFromCalls++
              return {
                records: records.slice(base.length),
                checkpoint: { head: view.head, length: records.length }
              }
            }),
          appendCas: (_anchor, expected, record) =>
            Effect.gen(function* () {
              assert.equal(observed?.length, expected.length)
              assert.equal(observed?.head.equals(expected.head), true)
              assert.equal(view.head.equals(expected.head), true)
              view = Result.getOrThrow(
                extendLedger(view, [record], {
                  head: hashRecordBytes(record),
                  length: view.length + 1
                })
              )
              records = [...records, record]
              yield* owner.host.ingestLedgerRecords(
                workspaceId,
                page(records, prepared.genesisHashHex, 0)
              )
            })
        },
        staging: () => ({
          stageGroup: (group) =>
            Effect.sync(() => {
              groups.set(group.recordHash, group)
            }),
          readGroup: (key) => Effect.succeed(groups.get(key.recordHash) ?? null),
          deleteGroup: () => Effect.void
        })
      })
      const outcome = yield* owner.host.manage(workspaceId, { type: 'rotate' }, ports)
      assert.equal(outcome, 'Committed')
      assert.equal(view.inspectState().epoch.number, 1)
      assert.equal((yield* owner.host.managementState(workspaceId)).updatePending, false)
      assert.equal(historyCalls, 1)
      assert.equal(observeCalls, 1)
      assert.equal(readFromCalls, 0)
      assert.equal(readCalls, 0)
    })
  )
})
