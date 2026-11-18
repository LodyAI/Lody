import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {StreamsClient} from '@loro-dev/streams-client';
import {Flock} from '@loro-dev/flock-wasm/base64';
import {readCatalogRefresh, importCatalogUpdates, catalogBootstrapSlots} from '../vendor/cloud-runtime/src/runtime/catalog-sync.ts';
import {retrySessionRead} from '../vendor/cloud-runtime/src/runtime/session-read.ts';
import {createReadAccess} from '../src/read-access.mjs';

const source=await readFile(new URL('../vendor/cloud-runtime/src/runtime/index.ts',import.meta.url),'utf8');

// Execute the production watcher with deterministic transport windows.
async function runWatcher({snapshot=1024, updates=0, initialReady=true, reads=[], fallback=snapshot, mode='meta', metadata, offset='1'}={}) {
 const {transform}=await import('esbuild');
 const start=source.indexOf('function watch(');
 const js=(await transform(source.slice(start,source.indexOf('\nconst ctx',start)),{loader:'ts',format:'cjs'})).code;
 const events=[],watchers=new Map(),catalogs=new Map(), replicas=new Map();
 let bootstraps=0,index=0,finish;
 const done=new Promise(resolve=>{finish=resolve;});
 const context={
  readCatalogRefresh, importCatalogUpdates:async()=>{}, catalogImportCheckpoint:()=>async()=>{}, acquireCatalogBootstrap:catalogBootstrapSlots(), retrySessionRead,AbortController,DOMException,Error,Uint8Array,crypto,watchers,catalogs,unhealthy:new Set(),machineReplicas:replicas,state:{workspace:'fixture'},
  getGrant:async()=>({gatewayBaseUrl:'https://example.org',token:'fixture'}),
  Flock:class {importFile(){} scan(){return [];}},
  StreamsClient:class {
   async bootstrap(){const bytes=bootstraps++ ? fallback : snapshot;return {ok:true,result:{snapshotOffset:'0',snapshot:{body:new Uint8Array(bytes)},updates:updates?[{body:new Uint8Array(updates)}]:[],nextOffset:offset,upToDate:bootstraps>1 || initialReady}};}
   async head(){return metadata ?? {ok:true,result:{nextOffset:'1'}};}
   async readOnce(){
    const page=reads[index++];
    if(!page){watchers.get(mode).abort();finish();return {ok:true,result:{nextOffset:'end',upToDate:true}};}
    return {ok:true,result:{payload:{body:new Uint8Array(page.bytes)},nextOffset:String(index+1),upToDate:page.ready}};
   }
  },
  apply(){},resumeAcceptedInputs(){},providerRows:()=>[],decompress:bytes=>bytes,projectRows:()=>({projects:[],sessions:[]}),
  publish(){events.push({type:'published'});},
  channel:{emit(type,payload){events.push({type,...payload});if(type==='syncError' || payload.stage==='sync_error:catalog_limit')finish();}},
  delay:async()=>{},grant:{},
 };
 vm.runInNewContext(js+`\nwatch(${JSON.stringify(mode)});`,context);
 await done;
 return {events,bootstraps,context};
}
const MiB=1024*1024;
test('bootstrap snapshot and updates share the 16 MiB ceiling',async()=>{
 for(const input of [{snapshot:16*MiB+1},{snapshot:8*MiB,updates:8*MiB+1},{snapshot:8*MiB,initialReady:false,reads:[{bytes:8*MiB+1,ready:true}]},{initialReady:false,reads:Array.from({length:101},()=>({bytes:1,ready:false}))}]) {
  const {events,bootstraps}=await runWatcher(input);
  assert.equal(events.find(e=>e.type==='syncError')?.reason,'catalog_limit');
  assert.equal(bootstraps,1);
  assert.equal(events.some(e=>e.type==='published'),false);
 }
});
test('completed live windows reset bytes and pages even after more than 16 MiB and 100 reads',async()=>{
 const {events,bootstraps}=await runWatcher({snapshot:9*MiB,reads:Array.from({length:110},()=>({bytes:MiB,ready:true}))});
 assert.equal(events.filter(e=>e.type==='published').length,111);
 assert.equal(events.some(e=>e.type==='syncError'),false);
 assert.equal(bootstraps,1);
});
for(const limit of ['bytes','pages'])test(`old replica ${limit} limit recovers via fresh bootstrap`,async()=>{
 const reads=limit==='bytes'?[{bytes:9*MiB,ready:false},{bytes:8*MiB,ready:true}]:Array.from({length:101},()=>({bytes:1,ready:false}));
 const {events,bootstraps}=await runWatcher({reads});
 assert.equal(bootstraps,2);
 assert.equal(events.filter(e=>e.type==='published').length,2);
 assert.ok(events.some(e=>e.stage==='catalog_rebootstrap'));
 assert.equal(events.some(e=>e.type==='syncError'),false);
});
test('fresh bootstrap exceeding the ceiling after stale catch-up is terminal',async()=>{
 const {events,bootstraps,context}=await runWatcher({reads:[{bytes:17*MiB,ready:false}],fallback:17*MiB});
 assert.equal(bootstraps,2);
 assert.equal(events.filter(e=>e.type==='syncError').length,1);
 assert.equal(context.state.metaReplica,undefined);
 assert.equal(context.unhealthy.has('meta'),true);
});
test('oversized machine emits a diagnostic without making workspace unavailable',async()=>{
 const {events,context}=await runWatcher({snapshot:17*MiB,mode:'machine'});
 assert.equal(events.some(e=>e.type==='syncError'),false);
 assert.ok(events.some(e=>e.stage==='sync_error:catalog_limit'));
 assert.equal(context.machineReplicas.has('machine'),false);
 assert.equal(context.unhealthy.has('machine'),true);
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
  readCatalogRefresh, importCatalogUpdates, catalogImportCheckpoint:()=>async()=>{}, acquireCatalogBootstrap:catalogBootstrapSlots(), retrySessionRead,AbortController,DOMException,Error,Uint8Array,crypto,watchers,unhealthy,catalogs,machineReplicas,
  state:{workspace:'fixture'},grant:undefined,
  getGrant:async()=>context.grant ??= {gatewayBaseUrl:'https://example.org',token:'fixture-'+(++grantRequests)},Flock,
  StreamsClient:class extends StreamsClient {
   constructor(options){super({...options,fetch:access.fetch});}
   async head(){return {ok:true,result:{nextOffset:'1'}};}
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
 assert.ok(c.events.some(e=>e.stage==='sync_error:network_or_auth'));
 assert.equal(c.events.some(e=>e.type==='syncError'),false);
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

test('healthy metadata publishes with missing or failed machine streams and keeps their last known projects',async()=>{
 const {transform}=await import('esbuild');
 const start=source.indexOf('let revision =');
 const js=(await transform(source.slice(start,source.indexOf('\nfunction watch(',start)),{loader:'ts',format:'cjs'})).code;
 const events=[], tasks=[];
 const meta={projects:[{id:'meta-project',name:'Meta'}],sessions:[{id:'s',createdAt:'2026-01-01'}],machineIds:['good','bad','pending']};
 const catalogs=new Map([['meta',meta],['good',{projects:[{id:'good-project',name:'Good'}]}],['bad',{projects:[{id:'cached-project',name:'Cached'}]}]]);
 const unhealthy=new Set(['bad']);
 const context={setTimeout:task=>{tasks.push(task);return tasks.length;},catalogs,unhealthy,watchers:new Map(),machineReplicas:new Map(),state:{knownProjects:[]},gitRepos:new Map(),
  watch(id){context.watchers.set(id,new AbortController());},refreshSessionUsage(){},askGitState(){},mergeAgentQuotas:()=>[],keepRepos:value=>value,
  channel:{emit(type,payload){events.push({type,...payload});}}
 };
 context.watchers.set('meta',new AbortController());
 vm.runInNewContext(js+'\npublish();publish();',context);
 assert.equal(events.length,0,'publication is coalesced until the short flush window');
 assert.equal(tasks.length,1);
 tasks.shift()();
 const first=JSON.parse(events.find(e=>e.type==='catalog').catalog);
 assert.deepEqual(first.sessions.map(s=>s.id),['s']);
 assert.deepEqual(first.projects.map(p=>p.id).sort(),['cached-project','good-project','meta-project']);
 assert.equal(events.at(-1).type,'synced');
 assert.equal(events.at(-1).revision,events.find(e=>e.type==='catalog').revision);
 const count=events.filter(e=>e.type==='catalog').length;
 unhealthy.add('meta');meta.sessions.push({id:'unconfirmed',createdAt:'2026-01-02'});
 vm.runInNewContext('publish();',context);
 tasks.shift()();
 assert.equal(events.filter(e=>e.type==='catalog').length,count,'failed metadata cannot publish new data');
 unhealthy.delete('meta');
 catalogs.set('good',{projects:[{id:'new-good-project',name:'New'}]});
 vm.runInNewContext('publish();',context);
 tasks.shift()();
 const next=JSON.parse(events.filter(e=>e.type==='catalog').at(-1).catalog);
 assert.ok(next.projects.some(p=>p.id==='new-good-project'));
 assert.ok(next.projects.some(p=>p.id==='cached-project'));
 const emitted=events.filter(e=>e.type==='catalog').length;
 vm.runInNewContext('publish();',context);
 catalogs.clear();
 tasks.shift()();
 assert.equal(events.filter(e=>e.type==='catalog').length,emitted,'stopped scopes cannot emit a queued catalog');
 vm.runInNewContext('publish();',context);
 catalogs.set('meta',{projects:[],sessions:[{id:'new-scope',createdAt:'2026-02-01'}],machineIds:[]});
 vm.runInNewContext('publish();',context);
 tasks.shift()();
 assert.deepEqual(JSON.parse(events.filter(e=>e.type==='catalog').at(-1).catalog).sessions.map(s=>s.id),['new-scope']);

});

for(const scenario of [
 {name:'compact newer snapshot replaces a large backlog',snapshot:1024,base:9007199254740993000n,delta:2n*1024n*1024n,newer:2n*1024n*1024n-1n,rebuild:true},
 {name:'expensive snapshot keeps a cheaper incremental catch-up',snapshot:12*MiB,base:9007199254740993000n,delta:2n*1024n*1024n,newer:2n*1024n*1024n-1n,rebuild:false},
 {name:'a snapshot behind the retained cursor cannot replace it',snapshot:1024,base:9007199254740993000n,delta:2n*1024n*1024n,newer:0n,rebuild:false},
 {name:'20 digit offsets preserve the single byte above the decision threshold',snapshot:1024,base:9007199254740993000n,delta:256n*1024n+1n,newer:256n*1024n,rebuild:true},
 {name:'snapshot tail bytes can outweigh a newer snapshot',snapshot:2*MiB,base:9007199254740993000n,delta:4n*1024n*1024n,newer:512n*1024n,rebuild:false},
 {name:'the 256 KiB floor keeps small incremental catch-ups',snapshot:1024,base:9007199254740993000n,delta:256n*1024n,newer:256n*1024n,rebuild:false},
])test(scenario.name,async()=>{
 const {base,delta,newer,snapshot,rebuild}=scenario;
 const {events,bootstraps}=await runWatcher({snapshot,offset:String(base).padStart(20,'0'),metadata:{ok:true,result:{snapshotOffset:String(base+newer).padStart(20,'0'),nextOffset:String(base+delta).padStart(20,'0')}},reads:[{bytes:1,ready:false},{bytes:1,ready:true}]});
 assert.equal(events.some(e=>e.stage==='catalog_rebootstrap'),rebuild);
 assert.equal(bootstraps,rebuild?2:1);
 assert.equal(events.filter(e=>e.type==='published').length,rebuild?3:2);
 assert.equal(events.some(e=>e.type==='syncError'),false);
});
test('unavailable HEAD metadata keeps incremental recovery usable',async()=>{
 const {events,bootstraps}=await runWatcher({metadata:{ok:false,result:{code:'network_error'}},reads:[{bytes:1,ready:false},{bytes:1,ready:true}]});
 assert.equal(bootstraps,1);
 assert.equal(events.filter(e=>e.type==='published').length,2);
 assert.equal(events.some(e=>e.type==='syncError'),false);
});

test('queued machine bootstraps cannot block metadata, cancellation or healthy machine recovery',async t=>{
 const {projectRows}=await import('../vendor/cloud-runtime/src/protocol/catalog.ts');
 const {transform}=await import('esbuild');
 const start=source.indexOf('function watch(');
 const js=(await transform(source.slice(start,source.indexOf('\nconst ctx',start)),{loader:'ts',format:'cjs'})).code;
 const watchers=new Map(), catalogs=new Map(), machineReplicas=new Map(), unhealthy=new Set(), pending=new Map(), events=[];
 const context={
  catalogImportCheckpoint:()=>async()=>{},importCatalogUpdates,readCatalogRefresh,acquireCatalogBootstrap:catalogBootstrapSlots(2),
  retrySessionRead,AbortController,DOMException,Error,Uint8Array,crypto,watchers,catalogs,machineReplicas,unhealthy,state:{workspace:'fixture'},Flock,projectRows,
  getGrant:async()=>({gatewayBaseUrl:'https://example.org',token:'fixture'}),resumeAcceptedInputs(){},providerRows:()=>[],decompress:bytes=>bytes,
  StreamsClient:class {
   constructor({url}){this.mode=decodeURIComponent(url).split(':').at(-1);}
   bootstrap(){return new Promise(resolve=>pending.set(this.mode,{resolve}));}
   readOnce({signal}){return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({ok:true,result:{upToDate:true,nextOffset:'1'}}),{once:true}));}
  },
  publish(){events.push({type:'published',catalogs:new Map(catalogs)});},
  channel:{emit(type,payload){events.push({type,...payload});}},grant:{},
  delay:(ms,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),
 };
 t.after(()=>{for(const controller of watchers.values())controller.abort();});
 vm.runInNewContext(js+'\nfor(const id of ["a","b","c","d","meta"])watch(id);',context);
 await turn();
 assert.equal(pending.has('c'),false);
 assert.equal(pending.has('d'),false);
 const reply=id=>{
  const flock=new Flock('server-'+id);
  if(id==='meta'){flock.set(['e','session-s'],true,1);flock.set(['m','session-s'],{title:'Visible session'},1);}
  else flock.set(['localProject','p'],{name:id,rootPath:'/fixture'},1);
  return {ok:true,result:{snapshotOffset:'0',snapshot:{body:flock.exportFile()},updates:[],nextOffset:'1',upToDate:true}};
 };
 pending.get('meta').resolve(reply('meta'));await turn();
 assert.equal(catalogs.get('meta').sessions[0].title,'Visible session','meta is readable with both machine slots still occupied');
 watchers.get('c').abort();
 pending.get('a').resolve({ok:false,result:{code:'network_error'}});await turn();
 assert.equal(pending.has('c'),false,'cancelled queued work never starts');
 assert.ok(pending.has('d'),'a failed initialization releases capacity before retry backoff');
 pending.get('b').resolve(reply('b'));pending.get('d').resolve(reply('d'));await turn();
 assert.equal(catalogs.get('b').projects[0].name,'b');
 assert.equal(catalogs.get('d').projects[0].name,'d');
 assert.equal(unhealthy.has('a'),true);
 assert.equal(catalogs.has('c'),false);
 assert.equal(events.some(e=>e.type==='syncError'),false);
 assert.ok(events.some(e=>e.type==='published' && e.catalogs.has('b') && e.catalogs.has('d')));
});

test('an unexpectedly oversized optional snapshot preserves the old incremental replica',async()=>{
 const {events,bootstraps}=await runWatcher({snapshot:1024,fallback:20*MiB,metadata:{ok:true,result:{snapshotOffset:'2000000',nextOffset:'2000001'}},reads:[{bytes:MiB,ready:false},{bytes:MiB,ready:true}]});
 assert.equal(bootstraps,2);
 assert.equal(events.some(e=>e.stage==='catalog_rebootstrap'),false);
 assert.equal(events.some(e=>e.type==='syncError'),false);
 assert.equal(events.filter(e=>e.type==='published').length,2);
});

test('session and Machine RPC uploads keep the native 15-second deadline with the real Streams client', async t => {
 t.mock.timers.enable({apis:['setTimeout']});
 const sessionSource=await readFile(new URL('../vendor/cloud-runtime/src/runtime/session.ts',import.meta.url),'utf8');
 const {transform}=await import('esbuild');
 const start=sessionSource.indexOf('export async function clientFor(');
 const code=(await transform(sessionSource.slice(start,sessionSource.indexOf('export async function ensureSession(',start)).replace('export ',''),{loader:'ts'})).code;
 for(const stream of ['fixture:session:s1','fixture:rpc:req:m1']) {
  const requestStarted=Promise.withResolvers();
  let requests=0;
  const context={StreamsClient:class extends StreamsClient {
   constructor(options){super({...options,fetch:(_url,init)=>{
    requests++;requestStarted.resolve();
    return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
   }});}
  }};
  vm.runInNewContext(code+';globalThis.clientFor=clientFor;',context);
  const client=await context.clientFor(stream,async()=>({gatewayBaseUrl:'https://example.invalid',token:'synthetic'}));
  let settled=false;
  const upload=client.append({part:{body:'synthetic input',contentType:'application/octet-stream'}}).then(result=>{settled=true;return result;});
  await requestStarted.promise;
  t.mock.timers.tick(14999);
  assert.equal(settled,false);
  t.mock.timers.tick(1);
  const result=await upload;
  assert.equal(result.ok,false);
  assert.equal(result.result.code,'timeout');
  assert.equal(requests,1,'an uncertain write must not be replayed');
 }
});
