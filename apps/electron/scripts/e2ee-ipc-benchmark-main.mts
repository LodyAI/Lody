import { app, BrowserWindow, ipcMain } from 'electron'
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Exit, Result, Scope } from 'effect'
import {
  Bytes,
  authenticateDocument,
  contentSigningBytes,
  verifySignature,
  deriveContentKey,
  disposeContentKey,
  openContentAead,
  hashRecordBytes,
  signGenesisRecord,
  verifyLedger,
  type ContentScope
} from '@lody/e2ee-core/protocol'
import { nativeDeviceSigner } from '@lody/e2ee-core/services'
import { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams'
import { streamsSnapshotCodec } from '@lody/shared/streams-snapshot-codec'
const __dirname = dirname(fileURLToPath(import.meta.url))
async function main() {
  const directory = process.env.LODY_E2EE_BENCHMARK_DIRECTORY
  if (!directory) throw new Error('benchmark_isolated_profile_required')
  const scope = await Effect.runPromise(Scope.make())
  let window: BrowserWindow | undefined
  let stage = 'load-modules'
  try {
    await app.whenReady()
    const requireLab = createRequire(join(__dirname, '../../../packages/e2ee-lab/package.json'))
    const loroModule = requireLab.resolve('loro-crdt')
    const { LoroDoc } = await import(loroModule)
    const dependencies =
      await import('../../../packages/e2ee-lab/src/platform/ipc-benchmark-dependencies.ts')
    const { StreamsCrdt, InMemoryRemoteCursorStore, createLoroDocAdapter, startDevServer } =
      dependencies
    const sdkModule = fileURLToPath(dependencies.sdkModule)
    const loroAdapterModule = fileURLToPath(dependencies.loroAdapterModule)
    const zstdModule = fileURLToPath(dependencies.zstdModule)
    stage = 'start-server'
    const server = await startDevServer({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(directory, 'streams.sqlite'),
      protocol: 'http1'
    })
    await Effect.runPromise(
      Effect.addFinalizer(() => Effect.promise(() => server.close())).pipe(Scope.provide(scope))
    )
    stage = 'create-bucket'
    const bucket = await fetch(`${server.baseUrl}/ds/benchmark`, { method: 'PUT' })
    if (!bucket.ok) throw new Error('benchmark_bucket_create')
    await bucket.body?.cancel()
    stage = 'prepare-native-binding'
    const key = randomBytes(32)
    const signing = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify'])
    const signer = Result.getOrThrow(
      nativeDeviceSigner(
        Result.getOrThrow(
          Bytes.signingPublicKey(
            new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey))
          )
        ),
        signing.privateKey
      )
    )
    const genesis = await Effect.runPromise(
      signGenesisRecord({
        signer,
        encryptionPublicKey: Result.getOrThrow(
          Bytes.encryptionPublicKey(new Uint8Array(32).fill(22))
        ),
        initialKey: Result.getOrThrow(Bytes.epochKey(new Uint8Array(key))),
        membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(23))),
        userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(24)))
      })
    )
    const view = Result.getOrThrow(
      verifyLedger({
        anchor: genesis.genesis,
        records: [genesis.record],
        checkpoint: { length: 1, head: hashRecordBytes(genesis.record) }
      })
    )
    const binding = await Effect.runPromise(
      makeStreamsUpdateBinding({
        genesis: genesis.genesis,
        resource: 'benchmark-session',
        model: 'loro',
        writeEpoch: 'current',
        signer,
        ledger: () => Effect.succeed(view),
        readEpochKey: () =>
          Effect.sync(() => Result.getOrThrow(Bytes.epochKey(new Uint8Array(key))))
      }).pipe(Scope.provide(scope))
    )
    const context = {
      protocol: 'loro-streams-crdt-payload-protection' as const,
      version: 2 as const,
      kind: 'update_batch' as const
    }
    const aad = new TextEncoder().encode('synthetic-e2ee-ipc-benchmark')
    const seal = (plaintext: Uint8Array) =>
      Effect.runPromise(binding.seal({ context, plaintext, additionalData: () => aad }))
    const doc = new LoroDoc()
    doc.setPeerId(1)
    const text = randomBytes(1_500_000).toString('hex')
    doc.getText('text').insert(0, text)
    doc.commit({ timestamp: 0 })
    const largePlain = doc.export({ mode: 'update' })
    doc.free()
    const largeSealed = await seal(largePlain)
    const sdkProvider = {
      maxSealOverheadBytes: binding.maxSealOverheadBytes,
      seal: (request: Parameters<typeof binding.seal>[0]) =>
        Effect.runPromise(binding.seal(request)),
      open: (request: Parameters<typeof binding.open>[0]) =>
        Effect.runPromise(binding.open(request))
    }
    const snapshotFirst = process.env.LODY_E2EE_BENCHMARK_SNAPSHOTS === '1'
    const snapshotSizes: Record<string, number> = {}
    const historyEdits = Number(process.env.LODY_E2EE_BENCHMARK_EDITS ?? 0)
    if (!Number.isSafeInteger(historyEdits) || historyEdits < 0 || historyEdits > 1000)
      throw new Error('benchmark_invalid_edits')
    stage = 'seed-streams'
    const trace = process.env.LODY_E2EE_BENCHMARK_TRACE === '1'
    ipcMain.on('e2ee-benchmark:trace', (_event, label) => {
      if (trace) process.stderr.write(`benchmark_trace:${label}\n`)
    })
    for (const kind of ['plain', 'protected']) {
      const writer = new LoroDoc()
      writer.setPeerId(1)
      const sdk = new StreamsCrdt({
        streamUrl: `${server.baseUrl}/ds/benchmark/${kind}`,
        adapter: createLoroDocAdapter(writer),
        remoteCursorStore: new InMemoryRemoteCursorStore(),
        ...(kind === 'protected'
          ? {
              payloadProtectionRequired: true,
              e2ee: { provider: sdkProvider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' }
            }
          : {}),
        snapshotCodec: streamsSnapshotCodec,
        snapshotUpload: { enabled: false, canUpload: () => false }
      })
      try {
        const created = await sdk.createStream()
        if (!created.ok) throw new Error('benchmark_stream_create')
        writer.getText('text').insert(0, text)
        writer.commit({ timestamp: 0 })
        if (!Buffer.from(writer.export({ mode: 'update' })).equals(Buffer.from(largePlain)))
          throw new Error('benchmark_fixture_byte_mismatch')
        const uploaded = await sdk.appendWriteOnly()
        if (!uploaded.ok) throw new Error('benchmark_stream_upload')
        for (let revision = 1; revision <= historyEdits; revision++) {
          writer.getMap('data').set('revision', revision)
          writer.commit({ timestamp: 0 })
          const edited = await sdk.appendWriteOnly()
          if (!edited.ok) throw new Error('benchmark_stream_upload')
        }
        if (snapshotFirst) {
          const published = await sdk.uploadSnapshotForTesting()
          if (!published.ok) throw new Error('benchmark_snapshot_upload')
          snapshotSizes[kind] = published.value.snapshotByteLength
          // A real suffix is read after the snapshot in each fresh replica.
          writer.getText('text').insert(text.length, 'tail')
          writer.commit({ timestamp: 0 })
          const suffix = await sdk.appendWriteOnly()
          if (!suffix.ok) throw new Error('benchmark_stream_upload')
        }
      } finally {
        await sdk.close()
        writer.free()
      }
    }
    ipcMain.on('e2ee-benchmark:loro-module', (event) => {
      event.returnValue = { loroModule, sdkModule, loroAdapterModule, zstdModule }
    })
    ipcMain.handle('e2ee-benchmark:fixture', () => ({
      small: new Uint8Array(16_384).fill(42),
      largePlain,
      fixtureSha256: createHash('sha256').update(largePlain).digest('hex'),
      largeSealed,
      textLength: text.length + (snapshotFirst ? 4 : 0),
      updateTextLength: text.length,
      snapshotFirst,
      snapshotSizes,
      historyEdits,
      trace,
      streamBaseUrl: `${server.baseUrl}/ds/benchmark`
    }))
    ipcMain.handle('e2ee-benchmark:seal', (_event, plaintext) => seal(plaintext))
    ipcMain.handle('e2ee-benchmark:open', (_event, result) =>
      Effect.runPromise(binding.open({ context, ...result, additionalData: aad }))
    )
    ipcMain.handle('e2ee-benchmark:provider-seal', (_event, request) =>
      Effect.runPromise(binding.seal({ ...request, additionalData: () => request.aad }))
    )
    let lastSdkOpen: Parameters<typeof binding.open>[0] | undefined
    ipcMain.handle('e2ee-benchmark:provider-open', async (_event, request) => {
      lastSdkOpen = request
      const start = performance.now()
      const plaintext = await Effect.runPromise(binding.open(request))
      return { plaintext, nativeMs: performance.now() - start }
    })
    ipcMain.handle('e2ee-benchmark:phases', async () => {
      if (!lastSdkOpen) throw new Error('benchmark_sdk_frame_missing')
      const expectedPlaintext = await Effect.runPromise(binding.open(lastSdkOpen))
      const frame = lastSdkOpen.sealed,
        frameAad = lastSdkOpen.additionalData
      const contentScope: ContentScope = {
        genesis: Buffer.from(genesis.genesis.toBytes()).toString('hex'),
        resource: 'benchmark-session',
        epoch: 0,
        docEpoch: 0,
        purpose: 'doc-update'
      }
      const authenticated = Result.getOrThrow(
        authenticateDocument(view, contentScope, frame, frameAad)
      )
      const leaf = Result.getOrThrow(
        deriveContentKey(Result.getOrThrow(Bytes.epochKey(new Uint8Array(key))), contentScope)
      )
      try {
        let start = performance.now()
        // The released binding authenticates before key lookup, inside openDocument,
        // and again against the latest view after decrypting (three verifications).
        for (let i = 0; i < 3; i++)
          Result.getOrThrow(authenticateDocument(view, contentScope, frame, frameAad))
        const authenticationMs = performance.now() - start
        const signingBytes = Result.getOrThrow(
          contentSigningBytes(contentScope, frame.subarray(0, -64), frameAad)
        )
        start = performance.now()
        for (let i = 0; i < 3; i++)
          Result.getOrThrow(
            verifySignature(signer.publicKey.toBytes(), signingBytes, frame.subarray(-64))
          )
        const strictVerificationMs = performance.now() - start
        start = performance.now()
        // Update content-v0 has the fixed 39-byte prefix and 24-byte nonce.
        const plaintext = Result.getOrThrow(
          openContentAead(
            leaf,
            authenticated.header,
            frame.subarray(39, 63),
            frame.subarray(63, -64),
            frameAad
          )
        )
        const aeadMs = performance.now() - start
        if (!Buffer.from(plaintext).equals(Buffer.from(expectedPlaintext)))
          throw new Error('benchmark_phase_mismatch')
        plaintext.fill(0)
        start = performance.now()
        const opened = await Effect.runPromise(binding.open(lastSdkOpen))
        const bindingMs = performance.now() - start
        opened.fill(0)
        return { authenticationMs, strictVerificationMs, aeadMs, bindingMs }
      } finally {
        expectedPlaintext.fill(0)
        disposeContentKey(leaf)
      }
    })
    if (trace) process.stderr.write('benchmark_trace:seeded\n')
    stage = 'create-window'
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        backgroundThrottling: false,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(__dirname, 'e2ee-ipc-benchmark-preload.cjs')
      }
    })
    await window.loadURL(`${server.baseUrl}/`)
    stage = 'measure-renderer'
    const measured = await window.webContents.executeJavaScript('window.e2eeBenchmark.run()')
    process.stdout.write(
      `${JSON.stringify({ ...measured, electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch }, null, 2)}\n`
    )
  } catch (error) {
    const code =
      error instanceof Error && /^benchmark_[a-z_]+$/.test(error.message)
        ? error.message
        : typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            typeof error.code === 'string'
          ? error.code
          : 'operation_failed'
    process.stderr.write(`e2ee_ipc_benchmark_failed:${stage}:${code}\n`)
    process.exitCode = 1
  } finally {
    window?.destroy()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    app.exit(process.exitCode === 1 ? 1 : 0)
    // The isolated OS temporary profile is retained for post-exit inspection.
  }
}
void main().catch(() => {
  process.stderr.write('e2ee_ipc_benchmark_bootstrap_failed\n')
  app.exit(1)
})
