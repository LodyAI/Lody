import { build } from 'vite';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
const root = fileURLToPath(new URL('../..', import.meta.url));
const electron = createRequire(resolve(root, '../../apps/electron/package.json'))(
  'electron'
).trim();
const sourceHashes = Object.fromEntries(
  await Promise.all(
    [
      'src/providers/local-window-bootstrap.ts',
      '../../apps/electron/src/main/window-target.ts',
      '../../apps/electron/src/renderer/src/warm-window-reveal.ts',
    ].map(async (file) => [
      file,
      createHash('sha256')
        .update(await readFile(resolve(root, file)))
        .digest('hex'),
    ])
  )
);
const cache = join(root, 'node_modules/.cache');
await mkdir(cache, { recursive: true });
const repeats = Number(process.argv[2] ?? 20);
const nativeOnly = process.argv.includes('--native');
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
        external: ['electron', 'loro-crdt', 'loro-repo', 'loro-mirror', '@loro-dev/flock-wasm'],
      },
    },
  });
  if (nativeOnly)
    await build({
      configFile: false,
      root,
      logLevel: 'error',
      build: {
        target: 'esnext',
        minify: false,
        outDir: output,
        emptyOutDir: false,
        lib: {
          entry: resolve(root, '../../apps/electron/src/main/window-target.ts'),
          formats: ['cjs'],
          fileName: () => 'window-target.cjs',
        },
        rollupOptions: { external: ['electron', 'node:fs', 'node:path'] },
      },
    });
  await writeFile(
    join(output, 'index.html'),
    '<!doctype html><title>Window bootstrap benchmark</title>'
  );
  await writeFile(
    join(output, 'main.cjs'),
    `
const {app,BrowserWindow,ipcMain}=require('electron');
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
  if (${nativeOnly}) {
   const {presentWindowTarget,handleWindowContentReady}=require('./window-target.cjs');
   await windows[0].webContents.executeJavaScript('bench.seed(1500)');
   const target=windows[1];
   await target.webContents.executeJavaScript('bench.installNativeRevealProbe();void 0');
   ipcMain.on('app.windowContentReady',(event,value)=>handleWindowContentReady(event.sender.id,value));
   const started=performance.now();
   const shown=new Promise(resolve=>target.once('show',resolve));
   presentWindowTarget(target,{workspace:'bench',sessionId:'benchmark'},{type:'file',filePath:join(__dirname,'index.html')});
   if(target.isVisible())throw new Error('Native window was visible before content');
   await shown;
   const claimToShowMs=performance.now()-started;
   const state=await target.webContents.executeJavaScript('({ready:!!document.querySelector("[data-window-session-ready]"),rows:document.querySelectorAll("main p").length})');
   if(!state.ready || state.rows!==30)throw new Error('First show had no readable history');
   const screenshot=join(require('node:os').tmpdir(),'lody-native-first-show.png');
   require('node:fs').writeFileSync(screenshot,(await target.webContents.capturePage()).toPNG());
   console.log(JSON.stringify({sourceHashes:${JSON.stringify(sourceHashes)},claimToShowMs,visibleBeforeContent:false,firstShow:state,screenshot}));
   return;
  }
  const result=[];
  for(const rounds of [50,500,1500]){
   const fixture=await windows[0].webContents.executeJavaScript('bench.seed('+rounds+')');
   for(const scenario of ['disk-hit','peer-hit','miss']){
    const samples={before:[],fixed:[]};
    for(let i=0;i<${repeats}+3;i++){
     for(const variant of [0,1].map(offset=>['before','fixed'][(i+offset)%2])){
      const value=await windows[1].webContents.executeJavaScript('bench.sample('+JSON.stringify(variant)+','+JSON.stringify(scenario)+','+fixture.entries+')');
      if(i>=3) samples[variant].push(value);
     }
    }
    result.push({...fixture,scenario,samples});
    console.error('Completed '+fixture.entries+' entries / '+scenario);
   }
  }
  console.log(JSON.stringify({sourceHashes:${JSON.stringify(sourceHashes)},environment:{electron:process.versions.electron,chrome:process.versions.chrome,cpu:${JSON.stringify(cpus()[0]?.model)},platform:process.platform,arch:process.arch},repeats:${repeats},result}));
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
