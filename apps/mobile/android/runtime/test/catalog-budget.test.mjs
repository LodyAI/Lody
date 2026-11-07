import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../vendor/cloud-runtime/src/runtime/index.ts',import.meta.url),'utf8');

// Execute the actual bundled watcher against a deterministic transport. The
// transport supplies byte counts; no captured account or catalog data is used.
async function runWatcher(snapshotBytes, updateBytes=0, liveBytes=0) {
 const {transform}=await import('esbuild');
 const start=source.indexOf('function watch(');
 const watch=source.slice(start,source.indexOf('\nconst ctx',start));
 const js=(await transform(watch,{loader:'ts',format:'cjs'})).code;
 const events=[],watchers=new Map(),catalogs=new Map();
 let reads=0,finish;
 const done=new Promise(resolve=>{finish=resolve;});
 const context={
  AbortController,Error,Uint8Array,crypto,watchers,catalogs,unhealthy:new Set(),machineReplicas:new Map(),workspace:'fixture',state:{workspace:'fixture'},
  getGrant:async()=>({gatewayBaseUrl:'https://example.org',token:'fixture'}),
  Flock:class {importFile(){} scan(){return [];}},
  StreamsClient:class {
   async bootstrap(){return {ok:true,result:{snapshotOffset:'0',snapshot:{body:new Uint8Array(snapshotBytes)},updates:updateBytes?[{body:new Uint8Array(updateBytes)}]:[],nextOffset:'1',upToDate:true}};}
   async readOnce(){
    if(reads++===0&&liveBytes)return {ok:true,result:{payload:{body:new Uint8Array(liveBytes)},nextOffset:'2',upToDate:true}};
    watchers.get('machine')?.abort();finish();
    return {ok:true,result:{nextOffset:'2',upToDate:true}};
   }
  },
  apply(){},decompress:bytes=>bytes,projectRows:()=>({projects:[],sessions:[]}),
  publish(){events.push({type:'published'});},send:event=>{events.push(event);if(event.type==='syncError')finish();},
  channel:{emit(type,payload){events.push({type,...payload});if(type==='syncError')finish();}},
  delay:async()=>{},grant:{},
 };
 vm.runInNewContext(js+'\nwatch("machine");',context);
 await done;
 return events;
}
test('a catalog larger than 8 MiB can publish after bootstrap',async()=>{
 const events=await runWatcher(1024,9*1024*1024);
 assert.ok(events.some(e=>e.type==='published'));
 assert.ok(!events.some(e=>e.type==='syncError'));
});
test('catalog input remains bounded across snapshots, bootstrap updates and live updates',async()=>{
 for(const input of [[16*1024*1024+1,0,0],[8*1024*1024,8*1024*1024+1,0],[8*1024*1024,0,8*1024*1024+1]]) {
  const events=await runWatcher(...input);
  assert.equal(events.find(e=>e.type==='syncError')?.reason,'catalog_limit');
 }
});
