const { ipcRenderer, contextBridge } = require('electron')
const modules = ipcRenderer.sendSync('e2ee-benchmark:loro-module')
const { LoroDoc } = require(modules.loroModule)
const { StreamsCrdt } = require(modules.sdkModule)
const { createLoroDocAdapter } = require(modules.loroAdapterModule)
const now = () => performance.now()
const stats = (values) => {
  const sorted = values.slice().sort((a, b) => a - b)
  return {
    samples: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]
  }
}
const importDocument = (bytes, expectedLength) => {
  const doc = new LoroDoc()
  try {
    doc.import(bytes)
    if (doc.getText('text').length !== expectedLength) throw new Error('benchmark_import_mismatch')
  } finally {
    doc.free()
  }
}
const openDb = (name) =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('replica')
    request.onerror = () => reject(new Error('benchmark_db_open'))
    request.onsuccess = () => resolve(request.result)
  })
const deleteDb = (name) =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = request.onblocked = () => reject(new Error('benchmark_db_delete'))
  })
let currentPhases = null
const provider = {
  maxSealOverheadBytes: 4096,
  seal: (request) =>
    ipcRenderer.invoke('e2ee-benchmark:provider-seal', {
      context: request.context,
      plaintext: request.plaintext,
      aad: request.additionalData(new Uint8Array([request.context.kind === 'snapshot' ? 4 : 3]))
    }),
  open: async (request) => {
    const start = now()
    const result = await ipcRenderer.invoke('e2ee-benchmark:provider-open', request)
    if (currentPhases) {
      currentPhases.nativeMs += result.nativeMs
      currentPhases.ipcMs += Math.max(0, now() - start - result.nativeMs)
    }
    return result.plaintext
  }
}
async function firstSync(fixture, kind, index) {
  if (fixture.trace) ipcRenderer.send('e2ee-benchmark:trace', `${kind}:${index}:start`)
  const start = now(),
    name = `e2ee-benchmark-${kind}-${index}`
  const db = await openDb(name),
    doc = new LoroDoc()
  const cursorStore = {
    load: () => Promise.resolve(null),
    save: (cursor) =>
      new Promise((resolve, reject) => {
        if (fixture.trace)
          ipcRenderer.send('e2ee-benchmark:trace', `${kind}:${index}:save:${cursor.nextOffset}`)
        const tx = db.transaction('replica', 'readwrite')
        tx.objectStore('replica').put(doc.export({ mode: 'snapshot' }), 'state')
        tx.objectStore('replica').put(cursor, 'cursor')
        tx.oncomplete = () => {
          if (fixture.trace) ipcRenderer.send('e2ee-benchmark:trace', `${kind}:${index}:saved`)
          resolve()
        }
        tx.onerror = tx.onabort = () => reject(new Error('benchmark_db_persist'))
      })
  }
  const phases = { nativeMs: 0, ipcMs: 0, importMs: 0 }
  currentPhases = phases
  const adapter = createLoroDocAdapter(doc)
  const measuredAdapter = new Proxy(adapter, {
    get(target, key) {
      const value = target[key]
      if (!['applyRemoteUpdates', 'applySnapshot'].includes(key) || typeof value !== 'function')
        return typeof value === 'function' ? value.bind(target) : value
      return (...args) => {
        const start = now()
        try {
          return value.apply(target, args)
        } finally {
          phases.importMs += now() - start
        }
      }
    }
  })
  const sdk = new StreamsCrdt({
    snapshotCodec: {
      compress: async (bytes) => (await import(modules.zstdModule)).compress(bytes),
      decompress: async (bytes) => (await import(modules.zstdModule)).decompress(bytes)
    },
    streamUrl: `${fixture.streamBaseUrl}/${kind}`,
    adapter: measuredAdapter,
    remoteCursorStore: cursorStore,
    ...(kind === 'protected'
      ? {
          payloadProtectionRequired: true,
          e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' }
        }
      : {}),
    snapshotUpload: { enabled: false, canUpload: () => false }
  })
  try {
    const result = await sdk.catchup()
    if (
      !result.ok ||
      doc.getText('text').length !== fixture.textLength ||
      (fixture.historyEdits > 0 && doc.getMap('data').get('revision') !== fixture.historyEdits)
    )
      throw new Error('benchmark_first_sync')
    const elapsed = now() - start
    const [state, cursor] = await Promise.all(
      ['state', 'cursor'].map(
        (key) =>
          new Promise((resolve, reject) => {
            const request = db.transaction('replica').objectStore('replica').get(key)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(new Error('benchmark_db_readback'))
          })
      )
    )
    if (!(state instanceof Uint8Array) || !cursor?.nextOffset)
      throw new Error('benchmark_durable_pair_missing')
    const restored = new LoroDoc()
    try {
      restored.import(state)
      if (
        restored.getText('text').length !== fixture.textLength ||
        (fixture.historyEdits > 0 &&
          restored.getMap('data').get('revision') !== fixture.historyEdits)
      )
        throw new Error('benchmark_durable_document_mismatch')
    } finally {
      restored.free()
    }
    if (fixture.trace) ipcRenderer.send('e2ee-benchmark:trace', `${kind}:${index}:done:${elapsed}`)
    return { elapsed, ...phases }
  } finally {
    currentPhases = null
    await sdk.close()
    doc.free()
    db.close()
    await deleteDb(name)
  }
}
contextBridge.exposeInMainWorld('e2eeBenchmark', {
  async run() {
    const fixture = await ipcRenderer.invoke('e2ee-benchmark:fixture')
    for (let index = 0; index < 20; index++)
      await ipcRenderer.invoke('e2ee-benchmark:seal', fixture.small)
    const seal = []
    for (let index = 0; index < 300; index++) {
      const start = now()
      await ipcRenderer.invoke('e2ee-benchmark:seal', fixture.small)
      seal.push(now() - start)
    }
    const plain = [],
      protectedMs = []
    for (let index = 0; index < 12; index++) {
      let start = now()
      importDocument(fixture.largePlain, fixture.updateTextLength)
      plain.push(now() - start)
      start = now()
      const opened = await ipcRenderer.invoke('e2ee-benchmark:open', fixture.largeSealed)
      importDocument(opened, fixture.updateTextLength)
      protectedMs.push(now() - start)
    }
    const plaintext = stats(plain.slice(2)),
      protectedFirstSync = stats(protectedMs.slice(2))
    const sdkPlain = [],
      sdkProtected = []
    for (let index = 0; index < 12; index++) {
      // Alternate order so one mode does not always inherit warmer OS caches.
      if (index % 2) {
        sdkProtected.push(await firstSync(fixture, 'protected', index))
        sdkPlain.push(await firstSync(fixture, 'plain', index))
      } else {
        sdkPlain.push(await firstSync(fixture, 'plain', index))
        sdkProtected.push(await firstSync(fixture, 'protected', index))
      }
    }
    const sdkFirstSyncPlaintext = stats(sdkPlain.slice(2).map((x) => x.elapsed)),
      sdkFirstSyncProtected = stats(sdkProtected.slice(2).map((x) => x.elapsed))
    const phaseSamples = []
    for (let index = 0; index < 22; index++)
      phaseSamples.push(await ipcRenderer.invoke('e2ee-benchmark:phases'))
    const measuredPhases = phaseSamples.slice(2)
    const protectedSamples = sdkProtected.slice(2)
    const phaseBreakdown = {
      ipcTransportAndQueue: stats(protectedSamples.map((x) => x.ipcMs)),
      nativeBinding: stats(protectedSamples.map((x) => x.nativeMs)),
      crdtImport: stats(protectedSamples.map((x) => x.importMs)),
      plaintextCrdtImport: stats(sdkPlain.slice(2).map((x) => x.importMs)),
      representativeAuthenticationThreePasses: stats(measuredPhases.map((x) => x.authenticationMs)),
      representativeStrictVerificationThreePasses: stats(
        measuredPhases.map((x) => x.strictVerificationMs)
      ),
      representativeAeadDecrypt: stats(measuredPhases.map((x) => x.aeadMs)),
      representativeBinding: stats(measuredPhases.map((x) => x.bindingMs)),
      ipcFraction:
        stats(protectedSamples.map((x) => x.ipcMs)).medianMs / sdkFirstSyncProtected.medianMs,
      note: 'IPC = actual invoke elapsed minus actual main binding; includes serialization, scheduling and IPC. CRDT import wraps actual adapter.applyRemoteUpdates. Authentication (including strict signature verification) and AEAD are separately measured representative native operations, not additive critical-path traces. Snapshot and incremental import are measured. Representative crypto phases use the last captured SDK update frame; they are not snapshot critical-path spans.'
    }

    return {
      kind: 'lody-e2ee-ipc-performance',
      smallBatchBytes: fixture.small.byteLength,
      largeUpdateBytes: fixture.largePlain.byteLength,
      textLength: fixture.textLength,
      snapshotFirst: fixture.snapshotFirst,
      snapshotSizes: fixture.snapshotSizes,
      historyEdits: fixture.historyEdits,
      fixtureSha256: fixture.fixtureSha256,
      sealIncludingIpc: stats(seal),
      firstSyncPlaintext: plaintext,
      firstSyncProtected: protectedFirstSync,
      firstSyncMedianRatio: protectedFirstSync.medianMs / plaintext.medianMs,
      phaseBreakdown,
      sdkFirstSyncPlaintext,
      sdkFirstSyncProtected,
      sdkFirstSyncMedianRatio: sdkFirstSyncProtected.medianMs / sdkFirstSyncPlaintext.medianMs,
      sdkScope:
        'real local Riverrun HTTP + released SDK + main binding IPC + Loro import + atomic IndexedDB state/cursor commit; fresh DB each sample, first two pairs excluded',

      scope:
        'real Electron preload-main IPC plus native core binding; Loro import only, excludes network, React and IndexedDB'
    }
  }
})
