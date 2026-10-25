import { createServer, build } from 'vite';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const root = fileURLToPath(new URL('../../../..', import.meta.url));
const electron = createRequire(root + '/apps/electron/package.json')('electron');
const server = await createServer({
  configFile: false,
  root,
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const temp = await mkdtemp(join(os.tmpdir(), 'lody-highlights-bench-'));
const main = join(temp, 'main.cjs');
await writeFile(
  main,
  `const {app,BrowserWindow}=require('electron');app.setPath('userData',__dirname+'/profile');app.whenReady().then(async()=>{try{const w=new BrowserWindow({show:false});await w.loadURL(process.argv[2]);const result=await w.webContents.executeJavaScript("import('/packages/components/benchmarks/highlights/browser.ts').then(m=>m.run())");console.log('BENCH_RESULT '+JSON.stringify({electron:process.versions.electron,...result}));app.quit()}catch(e){console.error(e);app.exit(1)}});`
);
try {
  const child = spawn(electron, [main, server.resolvedUrls.local[0]], {
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')
    ),
    stdio: 'inherit',
  });
  const timeout = setTimeout(() => child.kill(), 300000);
  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  }).finally(() => clearTimeout(timeout));
  if (code !== 0) throw Error('Electron benchmark failed');
} finally {
  await server.close();
  await rm(temp, { recursive: true, force: true });
}
console.log(
  'MACHINE ' + JSON.stringify({ cpu: os.cpus()[0].model, arch: os.arch(), node: process.version })
);
for (const [name, entry] of [
  ['shiki', 'packages/components/benchmarks/highlights/baseline.ts'],
  ['highlights', 'packages/components/src/lib/markdown-highlighter.ts'],
]) {
  const result = await build({
    configFile: false,
    root,
    logLevel: 'error',
    build: {
      write: false,
      minify: 'esbuild',
      lib: { entry: root + '/' + entry, formats: ['es'] },
      rollupOptions: { output: {} },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((x) => x.output);
  const sizes = outputs.map((o) => Buffer.from(o.type === 'chunk' ? o.code : o.source));
  console.log(
    'BUNDLE ' +
      JSON.stringify({
        name,
        chunks: sizes.length,
        bytes: sizes.reduce((n, b) => n + b.length, 0),
        gzip: sizes.reduce((n, b) => n + gzipSync(b).length, 0),
      })
  );
}
