import { verifySnapshot } from './snapshot.mjs';
import { buildMarkdownRepair } from './src/markdown-repair.mjs';
await verifySnapshot();
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(root,'../app/build/generated/runtime');
const preludeBuild = await build({entryPoints:[path.join(root,'src/prelude.mjs')],bundle:true,format:'iife',platform:'browser',target:'chrome100',write:false});
const prelude = preludeBuild.outputFiles[0].text;
const documents={main:'DataRuntime.html',debug:'DebugRuntime.html',network:'NetworkRuntime.html'};
for (const variant of Object.keys(documents)) {
  const result = await build({entryPoints:[path.join(root,`src/${variant}.mjs`)], bundle:true,format:'esm',platform:'browser',target:'chrome100',write:false,
    plugins:[{name:'inline-loro-wasm',setup(b){b.onResolve({filter:/^loro-crdt$/},()=>b.resolve('loro-crdt/base64',{resolveDir:root,kind:'import-statement'}));}}]});
  const dir=path.join(output,variant==='network'?'main':variant,'runtime');await mkdir(dir,{recursive:true});
  const script=result.outputFiles[0].text.replaceAll('</script','<\\/script');
  // Offline probe: no network access, external scripts, frames or persistent web storage.
  const html=`<!doctype html><meta charset="utf-8"><title>Lody Runtime</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${variant==='network'?'__LODY_STREAM_ORIGIN__':"'none'"}; script-src 'unsafe-inline' 'wasm-unsafe-eval'; base-uri 'none'; form-action 'none'"><script>${prelude}</script><script type="module">${script}</script>`;
  await writeFile(path.join(dir,documents[variant]),html);
}
const licenses=path.join(output,'main/runtime/licenses');await rm(licenses,{recursive:true,force:true});await mkdir(licenses,{recursive:true});
await copyFile(path.join(root,'vendor/cloud-runtime/LICENSE'),path.join(licenses,'CloudRuntime-LICENSE.txt'));
const lock=JSON.parse(await readFile(path.join(root,'package-lock.json')));
const inventory=[];
const DECLARED_ONLY={'loro-mirror':'MIT'};
for (const [location, info] of Object.entries(lock.packages)) {
 if (!location || info.dev || info.devOptional) continue;
 const name=info.name ?? location.split('node_modules/').at(-1);
 const version=info.version;
 const dir=path.join(root,location);
 const file=(await readdir(dir)).find(name=>/^LICENSE(?:\.|$)/i.test(name));
 // A reviewed package that declares its license only in package.json (no text shipped upstream).
 const declared=DECLARED_ONLY[name]===info.license ? info.license : undefined;
 if(!file && !declared) throw Error(`Missing license: ${name}@${version}`);
 const text=file ? await readFile(path.join(dir,file)) : Buffer.from(`${name}@${version} is licensed ${declared}, as declared in its package.json; the package ships no license text.\n`);
 await writeFile(path.join(licenses,name.replaceAll('/','-')+'-'+version+'-LICENSE.txt'),text);
 inventory.push({name,version,licenseSha256:createHash('sha256').update(text).digest('hex')});
}
await writeFile(path.join(licenses,'dependencies.json'),JSON.stringify(inventory,null,2)+'\n');
// Streaming-Markdown repair for the chat renderer (QuickJS). Its remend license is in the inventory above.
const markdown=path.join(output,'main/markdown');await mkdir(markdown,{recursive:true});
await writeFile(path.join(markdown,'MarkdownRepair.js'),await buildMarkdownRepair());
console.log('Generated release and debug runtime assets with dependency licenses.');

await writeFile(path.join(output,'debug/runtime/MismatchRuntime.html'),`<!doctype html><script>LodyHost.postMessage(JSON.stringify({type:'hostReady',protocol:2,capabilities:['ping']}))</script>`);
