// From packages/components: node benchmarks/file-search/run.mjs [repeats]
import { build, version as viteVersion } from 'vite';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import { cpus, platform, arch, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'lody-file-search-bench-'));
let browser;
let server;
try {
  await build({
    configFile: false,
    logLevel: 'error',
    root,
    build: {
      outDir: output,
      emptyOutDir: true,
      minify: true,
      lib: {
        entry: join(root, 'benchmarks/file-search/browser.ts'),
        formats: ['es'],
        fileName: () => 'benchmark.js',
      },
    },
  });
  server = createServer((request, response) => {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>File search benchmark</title>');
      return;
    }
    const path = resolvePath(output, `.${request.url}`);
    if (!path.startsWith(output + '/')) {
      response.writeHead(404).end();
      return;
    }
    void readFile(path).then(
      (content) => {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(content);
      },
      () => response.writeHead(404).end()
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BENCH_BROWSER_CHANNEL ? { channel: process.env.BENCH_BROWSER_CHANNEL } : {}),
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(
    async (repeats) => {
      const { runBenchmark, verifyWorkerCancellation } = await import('/benchmark.js');
      await verifyWorkerCancellation();
      return await runBenchmark(repeats);
    },
    Number(process.argv[2] ?? 3)
  );
  console.log(
    JSON.stringify(
      {
        environment: {
          node: process.version,
          vite: viteVersion,
          playwright: require('@playwright/test/package.json').version,
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
        },
        ...result,
      },
      null,
      2
    )
  );
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
