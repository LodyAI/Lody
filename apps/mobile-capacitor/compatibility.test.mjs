import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { build, loadConfigFromFile } from 'vite';

const mobileRoot = fileURLToPath(new URL('./', import.meta.url));
const polyfills = fileURLToPath(new URL('./src/polyfills.ts', import.meta.url));
const components = fileURLToPath(new URL('../../packages/components/src/', import.meta.url));
const shared = fileURLToPath(new URL('../../packages/shared/src/', import.meta.url));

function oldRuntime() {
  // A separate Promise constructor per realm, with native AbortSignal branding.
  const context = vm.createContext({
    AbortController,
    AbortSignal: class extends AbortSignal {
      static any = undefined;
    },
    Response,
    Headers,
    Request,
    URL,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    performance,
    console,
  });
  vm.runInContext('delete Promise.withResolvers', context);
  return context;
}

async function evaluate(code, context, identifier = 'file:///compatibility.js') {
  const module = new vm.SourceTextModule(code, {
    context,
    identifier,
    initializeImportMeta(meta) {
      meta.url = identifier;
    },
  });
  await module.link((specifier) => {
    throw new Error(`Unexpected unbundled import: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace;
}

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'lody-mobile-compat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), source);
  }
  const { config } = await loadConfigFromFile(
    { command: 'build', mode: 'dev' },
    join(mobileRoot, 'vite.config.ts'),
    mobileRoot,
    'silent'
  );
  return { root, config };
}

void test('production Worker entries initialize compatibility before dependency evaluation', async (t) => {
  const { root, config } = await fixture(t, {
    'main.js': `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      import DependencyWorker from 'compat-worker/worker.js?worker'; new DependencyWorker();
      import workerUrl from './worker.js?worker&url'; globalThis.pdfWorkerUrl = workerUrl;`,
    'worker.js': `import './dependency.js';`,
    'node_modules/compat-worker/package.json': JSON.stringify({
      name: 'compat-worker',
      type: 'module',
      sideEffects: false,
    }),
    'node_modules/compat-worker/worker.js': `
      const done = Promise.withResolvers();
      done.resolve(AbortSignal.any([AbortSignal.abort('worker-aborted')]).reason);
      globalThis.workerResult = done.promise;`,
    'dependency.js': `const result = Promise.withResolvers();
      const parent = new AbortController();
      const combined = AbortSignal.any([parent.signal]);
      parent.abort('worker-aborted');
      result.resolve(combined.reason);
      globalThis.workerResult = result.promise;`,
  });
  const output = await build({
    ...config,
    configFile: false,
    root,
    logLevel: 'silent',
    build: { ...config.build, write: false, rollupOptions: { input: join(root, 'main.js') } },
  });
  const chunks = output.output;
  const entry = chunks.find((chunk) => chunk.type === 'chunk' && chunk.isEntry);
  const workerUrls = [];
  const main = vm.createContext({
    URL,
    Worker: class {
      constructor(url) {
        workerUrls.push(String(url));
      }
    },
  });
  await evaluate(entry.code, main);
  workerUrls.push(main.pdfWorkerUrl);
  assert.equal(workerUrls.length, 3);
  for (const url of workerUrls) {
    const worker = chunks.find((chunk) => url.endsWith(chunk.fileName));
    assert.ok(worker, `missing Worker asset ${url}`);
    const context = oldRuntime();
    await evaluate(worker.type === 'asset' ? String(worker.source) : worker.code, context);
    assert.equal(await context.workerResult, 'worker-aborted');
  }
});

void test('the actual token provider and reconnect owner work without the Safari 17.4 APIs', async (t) => {
  const { root } = await fixture(t, {
    'main.js': `
      import ${JSON.stringify(polyfills)};
      import { createLoroStreamsTokenProviderLegacy } from ${JSON.stringify(shared + 'loro-streams-token/legacy.ts')};
      import { createLocalReconnectLoop } from ${JSON.stringify(components + 'providers/local-reconnect-loop.ts')};
      export async function connect() {
        const lifetime = new AbortController();
        const provider = createLoroStreamsTokenProviderLegacy({
          workspaceId: 'compatibility-test', endpoint: 'https://example.invalid/token', authToken: 'synthetic',
          fetchImpl: async (_input, init) => {
            const signal = AbortSignal.any([lifetime.signal, init.signal]);
            signal.throwIfAborted();
            return new Response(JSON.stringify({ token: 'synthetic-stream-token', expiresIn: 900 }), { status: 200 });
          },
        });
        const completed = Promise.withResolvers();
        const loop = createLocalReconnectLoop({
          canRun: () => true, hasProblem: () => false, onStateChange: () => {},
          reconnect: async () => { completed.resolve(await provider.getToken()); },
          onError: completed.reject,
        });
        try {
          loop.trigger('network-online');
          const token = await completed.promise;
          await loop.close();
          return { token, active: loop.isActive() };
        } finally { await loop.close(); await provider.close(); }
      }
    `,
  });
  const output = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    build: {
      target: 'safari16.4',
      write: false,
      minify: false,
      lib: { entry: join(root, 'main.js'), formats: ['es'] },
    },
  });
  const context = oldRuntime();
  const chunks = (Array.isArray(output) ? output[0] : output).output;
  const { connect } = await evaluate(chunks.find((chunk) => chunk.type === 'chunk').code, context);
  const result = await connect();
  assert.equal(result.token, 'synthetic-stream-token');
  assert.equal(result.active, false);
});
