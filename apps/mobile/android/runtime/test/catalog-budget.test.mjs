import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {StreamsClient} from '@loro-dev/streams-client';
import {Flock} from '@loro-dev/flock-wasm/base64';
import {retrySessionRead} from '../vendor/cloud-runtime/src/runtime/session-read.ts';
import {createReadAccess} from '../src/read-access.mjs';

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
  retrySessionRead,AbortController,DOMException,Error,Uint8Array,crypto,watchers,catalogs,unhealthy:new Set(),machineReplicas:new Map(),workspace:'fixture',state:{workspace:'fixture'},
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
  apply(){},providerRows:()=>({providers:[],setups:[]}),decompress:bytes=>bytes,projectRows:()=>({projects:[],sessions:[]}),
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

const turn = () => new Promise(resolve=>setImmediate(resolve));

// Real watcher, Flock, read gate and Streams parser; synthetic server and host.
async function reconnectingCatalog(t) {
 t.mock.timers.enable({apis:['setTimeout']});
 const {transform}=await import('esbuild');
 const start=source.indexOf('function watch(');
 const js=(await transform(source.slice(start,source.indexOf('\nconst ctx',start)),{loader:'ts',format:'cjs'})).code;
 const server=new Flock('server');server.set(['title'],'Before',1);
 const snapshot=server.exportFile(), version=server.version();
 server.set(['title'],'After',2);
 const update=new TextEncoder().encode(JSON.stringify(server.exportJson(version)));
 const requests=[], events=[], pending=[], watchers=new Map(), unhealthy=new Set(), catalogs=new Map(), machineReplicas=new Map();
 let bootstraps=0, grantRequests=0;
 const authorizations=[];
 const access=createReadAccess(request=>new Promise((resolve,reject)=>{
  requests.push(new URL(request.url));
  authorizations.push(request.headers.get('Authorization'));
  request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true});
  pending.push({resolve,reject});
 }),event=>events.push(event));
 access.configure({gatewayBaseUrl:'https://example.org',workspaceId:'fixture'});
 const context={
  retrySessionRead,AbortController,DOMException,Error,Uint8Array,crypto,watchers,unhealthy,catalogs,machineReplicas,
  state:{workspace:'fixture'},grant:undefined,
  getGrant:async()=>context.grant ??= {gatewayBaseUrl:'https://example.org',token:'fixture-'+(++grantRequests)},Flock,
  StreamsClient:class extends StreamsClient {
   constructor(options){super({...options,fetch:access.fetch});}
   async bootstrap(){bootstraps++;return {ok:true,result:{snapshotOffset:'0',snapshot:{body:snapshot},updates:[],nextOffset:'1',cursor:'cursor-1',upToDate:true}};}
  },
  apply(flock,bytes){if(bytes.length)flock.importJson(JSON.parse(new TextDecoder().decode(bytes)));},
  providerRows:()=>[],projectRows:rows=>rows,
  publish(){events.push({type:'published',title:machineReplicas.get('machine')?.get(['title'])});},
  channel:{emit(type,payload){events.push({type,...payload});}},
  delay:async(ms,signal)=>{signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,ms));signal.throwIfAborted();},
 };
 vm.runInNewContext(js+'\nwatch("machine");',context);
 await turn();
 t.after(()=>watchers.get('machine').abort());
 return {context,access,events,requests,authorizations,pending,unhealthy,machineReplicas,watchers,update,get bootstraps(){return bootstraps;},get grantRequests(){return grantRequests;},
  reply(body=update,upToDate=true,offset='2'){
   pending.shift().resolve(new Response(body,{headers:{'Content-Type':'application/octet-stream','Stream-Next-Offset':offset,'Stream-Cursor':'cursor-'+offset,'Stream-Up-To-Date':String(upToDate)}}));
  },
 };
}

for(const failure of ['background','network','server','transportAbort','unauthorized','forbidden','rateLimited'])test(`catalog ${failure} recovery retains its replica and cursor and imports missed updates`,async t=>{
 const c=await reconnectingCatalog(t);
 const replica=c.machineReplicas.get('machine');
 if(failure==='background')c.access.setActive(false);
 else if(failure==='network')c.pending[0].reject(new TypeError('offline'));
 else if(failure==='transportAbort')c.pending[0].reject(new DOMException('transport aborted','AbortError'));
 else c.pending[0].resolve(new Response(null,{status:{unauthorized:401,forbidden:403,rateLimited:429}[failure] ?? 503}));
 c.pending.shift();
 await turn();
 if(failure==='unauthorized' || failure==='forbidden'){
  // Streams first asks its auth callback again; the catalog owns invalidating
  // the cached grant once that attempt also fails.
  c.pending.shift().resolve(new Response(null,{status:failure==='unauthorized'?401:403}));
  await turn();
 }
 assert.equal(c.unhealthy.has('machine'),true);
 assert.ok(c.events.some(e=>e.type==='syncError'));
 assert.equal(c.machineReplicas.get('machine'),replica);
 assert.equal(c.context.grant !== undefined,failure==='background','only explicit host suspension retains the grant');
 const published=c.events.filter(e=>e.type==='published').length;
 t.mock.timers.tick(1000);await turn();
 if(failure==='background'){
  assert.equal(c.requests.length,1,'background cannot initiate cloud reads');
  c.access.setActive(true);await turn();
 }
 assert.equal(c.bootstraps,1);
 assert.equal(c.requests.at(-1).searchParams.get('offset'),'1');
 assert.equal(c.requests.at(-1).searchParams.get('cursor'),'cursor-1');
 assert.equal(c.grantRequests,failure==='background'?1:2,'suspension alone must not request a new grant');
 assert.equal(c.authorizations[0],'Bearer fixture-1');
 assert.equal(c.authorizations.at(-1),failure==='background'?'Bearer fixture-1':'Bearer fixture-2');
 c.reply(c.update,false);await turn();
 assert.equal(c.unhealthy.has('machine'),true,'partial catch-up cannot restore readiness');
 assert.equal(c.events.filter(e=>e.type==='published').length,published);
 c.reply(new Uint8Array(),true,'3');await turn();
 t.mock.timers.tick(1000);await turn();
 assert.equal(c.unhealthy.has('machine'),false);
 assert.equal(c.events.filter(e=>e.type==='published').at(-1).title,'After');
 assert.equal(c.machineReplicas.get('machine'),replica);
 assert.equal(c.bootstraps,1);
 assert.equal(c.requests.at(-1).searchParams.get('offset'),'3');
});

for(const failure of ['cursor','corrupt'])test(`catalog ${failure} failure discards the unsafe replica and bootstraps`,async t=>{
 const c=await reconnectingCatalog(t);
 if(failure==='cursor')c.pending.shift().resolve(new Response(null,{status:400}));
 else c.reply(new TextEncoder().encode('not json'));
 await turn();
 assert.equal(c.machineReplicas.has('machine'),false);
 assert.equal(c.unhealthy.has('machine'),true);
 t.mock.timers.tick(2000);await turn();
 assert.equal(c.bootstraps,2);
 assert.equal(c.events.filter(e=>e.type==='published').at(-1).title,'Before');
});

test('stopping a catalog during transport recovery prevents late publication and further reads',async t=>{
 const c=await reconnectingCatalog(t);
 c.pending.shift().reject(new TypeError('offline'));await turn();
 const count=c.events.length;
 c.watchers.get('machine').abort();await turn();
 t.mock.timers.tick(60000);await turn();
 assert.equal(c.events.length,count);
 assert.equal(c.bootstraps,1);
 assert.equal(c.requests.length,1);
});
