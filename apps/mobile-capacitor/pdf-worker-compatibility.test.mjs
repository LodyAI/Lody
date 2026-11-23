import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import test from 'node:test';
import { build, loadConfigFromFile } from 'vite';

const requireFromComponents = createRequire(
  new URL('../../packages/components/package.json', import.meta.url)
);
const { getDocument, GlobalWorkerOptions, PDFWorker } = await import(
  pathToFileURL(requireFromComponents.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href
);

const mobileRoot = fileURLToPath(new URL('./', import.meta.url));
const workerEntry = fileURLToPath(
  new URL(
    '../../packages/components/src/components/sessions/session-file-pdf.worker.js',
    import.meta.url
  )
);

function makePdf() {
  let text = '%PDF-1.4\n';
  const offsets = [];
  for (const body of [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
  ]) {
    offsets.push(text.length);
    text += `${offsets.length} 0 obj\n${body}\nendobj\n`;
  }
  const xref = text.length;
  text += `xref\n0 4\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  text += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(text);
}

void test('the bundled PDF Worker loads documents in an older realm and retains the no-Worker fallback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lody-pdf-worker-compat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'main.js');
  await writeFile(
    entry,
    `import workerUrl from ${JSON.stringify(`${workerEntry}?worker&url`)}; globalThis.pdfWorkerUrl = workerUrl;`
  );
  const { config } = await loadConfigFromFile(
    { command: 'build', mode: 'dev' },
    join(mobileRoot, 'vite.config.ts'),
    mobileRoot,
    'silent'
  );
  const result = await build({
    ...config,
    configFile: false,
    root,
    logLevel: 'silent',
    build: { ...config.build, write: false, rollupOptions: { input: entry } },
  });
  const worker = result.output.find(
    (chunk) => chunk.type === 'asset' && chunk.fileName.includes('session-file-pdf.worker')
  );
  assert.ok(worker, 'PDF Worker must be emitted through the Worker build pipeline');

  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  port1.start();
  port2.start();
  const context = vm.createContext({
    postMessage: port2.postMessage.bind(port2),
    addEventListener: port2.addEventListener.bind(port2),
    removeEventListener: port2.removeEventListener.bind(port2),
    onmessage: null,
    AbortController,
    AbortSignal: class extends AbortSignal {
      static any = undefined;
    },
    URL,
    Blob,
    File,
    TextEncoder,
    TextDecoder,
    ReadableStream,
    WritableStream,
    TransformStream,
    Response,
    Headers,
    Request,
    fetch,
    structuredClone,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    atob,
    btoa,
    performance,
  });
  vm.runInContext('self = globalThis; delete Promise.withResolvers', context);
  const module = new vm.SourceTextModule(String(worker.source), { context });
  await module.link((specifier) => {
    throw new Error(`Unbundled PDF Worker dependency: ${specifier}`);
  });
  await module.evaluate();
  // PDF.js consumes the module export directly, without awaiting a generated __tla.
  assert.equal(typeof module.namespace.WorkerMessageHandler?.setup, 'function');

  const client = new PDFWorker({ port: port1 });
  t.after(() => client.destroy());
  // Reopening uses a fresh document owner after the previous one has drained.
  for (let index = 0; index < 2; index++) {
    const task = getDocument({ data: makePdf(), worker: client });
    try {
      const document = await task.promise;
      assert.equal(document.numPages, 1);
      assert.equal((await document.getPage(1)).pageNumber, 1);
    } finally {
      await task.destroy();
    }
  }

  // PDF.js dynamically imports workerSrc on hosts where dedicated Workers fail.
  // Run that real path too: a Vite worker bundle with stripped exports cannot load it.
  const fallbackPath = join(root, 'pdf-fallback.mjs');
  await writeFile(fallbackPath, worker.source);
  const previousWorkerSrc = GlobalWorkerOptions.workerSrc;
  const previousWorkerGlobal = globalThis.pdfjsWorker;
  delete globalThis.pdfjsWorker;
  GlobalWorkerOptions.workerSrc = pathToFileURL(fallbackPath).href;
  try {
    const task = getDocument({ data: makePdf() });
    try {
      const document = await task.promise;
      assert.equal(document.numPages, 1);
      assert.equal((await document.getPage(1)).pageNumber, 1);
    } finally {
      await task.destroy();
    }
  } finally {
    GlobalWorkerOptions.workerSrc = previousWorkerSrc;
    if (previousWorkerGlobal === undefined) delete globalThis.pdfjsWorker;
    else globalThis.pdfjsWorker = previousWorkerGlobal;
  }
});
