import { build } from 'vite';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
const root = fileURLToPath(new URL('../..', import.meta.url));
const electron = createRequire(resolve(root, '../../apps/electron/package.json'))(
  'electron'
).trim();
const cache = join(root, 'node_modules/.cache');
await mkdir(cache, { recursive: true });
const repeats = Number(process.argv[2] ?? 20);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 1000)
  throw new Error('Repeats must be an integer between 1 and 1000');
const output = await mkdtemp(join(cache, 'window-bench-'));
try {
  await build({
    configFile: false,
    root,
    logLevel: 'error',
    resolve: { alias: { '@': join(root, 'src') } },
    build: {
      target: 'esnext',
      minify: false,
      outDir: output,
      emptyOutDir: false,
      lib: {
        entry: join(root, 'benchmarks/window-bootstrap/renderer.ts'),
        formats: ['cjs'],
        fileName: () => 'renderer.cjs',
      },
      rollupOptions: {
        external: ['loro-crdt', 'loro-repo', 'loro-mirror', '@loro-dev/flock-wasm'],
      },
    },
  });
  await writeFile(
    join(output, 'index.html'),
    '<!doctype html><title>Window bootstrap benchmark</title>'
  );
  await writeFile(
    join(output, 'main.cjs'),
    `
const {app,BrowserWindow}=require('electron');
const {join}=require('node:path');
app.setPath('userData',join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const windows=[];
 try {
  for(let i=0;i<2;i++){
   const window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false,backgroundThrottling:false}});
   windows.push(window);
   await window.loadFile(join(__dirname,'index.html'));
   await window.webContents.executeJavaScript('window.bench=require('+JSON.stringify(join(__dirname,'renderer.cjs'))+');void 0');
  }
  const result=[];
  for(const rounds of [50,500,1500]){
   const fixture=await windows[0].webContents.executeJavaScript('bench.seed('+rounds+')');
   for(const scenario of ['disk-hit','peer-hit','miss']){
    const samples={before:[],after:[]};
    for(let i=0;i<${repeats}+3;i++){
     for(const variant of i%2 ? ['after','before']:['before','after']){
      const value=await windows[1].webContents.executeJavaScript('bench.sample('+JSON.stringify(variant)+','+JSON.stringify(scenario)+','+fixture.entries+')');
      if(i>=3) samples[variant].push(value);
     }
    }
    result.push({...fixture,scenario,samples});
    console.error('Completed '+fixture.entries+' entries / '+scenario);
   }
  }
  console.log(JSON.stringify({environment:{electron:process.versions.electron,chrome:process.versions.chrome,cpu:${JSON.stringify(cpus()[0]?.model)},platform:process.platform,arch:process.arch},repeats:${repeats},result}));
 }catch(error){ console.error(error);process.exitCode=1; }
 finally{for(const window of windows)window.destroy();app.exit(process.exitCode || 0);}
});`
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const exit = await new Promise((resolveExit, reject) => {
    const child = spawn(electron, [join(output, 'main.cjs')], { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', resolveExit);
  });
  if (exit !== 0) throw new Error(`Electron benchmark exited ${exit}`);
} finally {
  await rm(output, { recursive: true, force: true });
}
