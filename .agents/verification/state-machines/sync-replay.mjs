import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root=path.resolve(process.argv[2]);
const tools=path.resolve(process.argv[3]??'/tmp/lody-inbox-verification-tools');
const require=createRequire(path.join(tools,'package.json'));
const {build}=require('esbuild');
for(const [name,version] of Object.entries({effect:'4.0.2',zod:'4.3.6','better-sqlite3':'13.0.3',esbuild:'0.28.2'})){assert.equal(JSON.parse(await fs.readFile(path.join(tools,'node_modules',name,'package.json'),'utf8')).version,version,'Locked verifier dependency: '+name);}
const Database=require('better-sqlite3');
const variant=process.argv[4]??'current';
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'lody-inbox-sync-replay-'));
const subject=path.join(scratch,'subject.mjs');
function span(text,first,next){assert.equal(text.split(first).length,2);const start=text.indexOf(first),end=text.indexOf(next,start+first.length);assert.ok(end>start);return text.slice(start,end);}
const handler=await fs.readFile(path.join(root,'apps/cli/src/lib/message-handler.ts'),'utf8');
let writerBody=span(handler,'  private async writeAssistantEntryForTurn(','\n  /**');
if(variant==='unsafe-late-write'){
 const guard="      if (signal?.aborted) {\n        span.end();\n        return;\n      }\n      await backend.openAssistantTurn";
 assert.equal(writerBody.split(guard).length,2);
 writerBody=writerBody.replace(guard,'      await backend.openAssistantTurn');
}
const author=await fs.readFile(path.join(root,'packages/shared/src/message-author.ts'),'utf8');
const writerModule=[
 "import {z} from 'zod';",
 `import {AGENT_BRAND_IDS} from ${JSON.stringify(path.join(root,'packages/shared/src/agent-brand.ts'))};`,
 `import {getServerNow} from ${JSON.stringify(path.join(root,'packages/shared/src/time-sync.ts'))};`,
 span(author,'const id =','const short ='),
 span(author,'export function readMessageAuthor(','\n/**'),
 'const startTraceSpan=()=>({end(){},fail(){}});',
 'export class AssistantWriterSubject { constructor(backend){this.backend=backend;this.logger={debug(){}};} async getSessionBackend(){return await this.backend;}',
 writerBody,'}'
].join('\n');
await build({stdin:{contents:[
 `export * from ${JSON.stringify(path.join(root,'apps/cli/src/orchestration/inbox/sqlite.ts'))};`,
 `export * from ${JSON.stringify(path.join(root,'apps/cli/src/session/turn-history-gate.ts'))};`,writerModule
].join('\n'),resolveDir:root,loader:'ts'},outfile:subject,bundle:true,format:'esm',platform:'node',packages:'external',logLevel:'silent',plugins:[{name:'real-boundaries',setup(b){
 b.onResolve({filter:/^(effect|zod|better-sqlite3)$/},a=>({path:require.resolve(a.path),external:true}));
 b.onResolve({filter:/^@\/utils\/logger$/},()=>({path:'logger',namespace:'fixture'}));
 b.onResolve({filter:/^@\/utils\/format-error$/},()=>({path:path.join(root,'apps/cli/src/utils/format-error.ts')}));
 b.onLoad({filter:/\/turn-history-gate\.ts$/},async a=>{
  let text=await fs.readFile(a.path,'utf8');
  if(variant==='unsafe-timeout-abort'){
   const release="    this.phase = 'open';";assert.equal(text.split(release).length,3);
   const at=text.indexOf(release,text.indexOf('  private release():'));
   text=text.slice(0,at)+"    this.beforeOpenAbort.abort();\n"+text.slice(at);
  }
  if(variant==='unsafe-gate'){
   const before="    if (reason === 'disposed') {\n      this.release();";
   assert.equal(text.split(before).length,2);
   text=text.replace(before,"    if (reason === 'disposed') {\n      if (this.phase === 'opening') return;\n      this.release();");
   const opening="    this.phase = 'opening';";assert.equal(text.split(opening).length,2);
   text=text.replace(opening,opening+"\n    if (this.timer) clearTimeout(this.timer);\n    this.timer = null;");
  }
  return {contents:text,loader:'ts'};
 });
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const getLogger=()=>({warn(){}});',loader:'js'}));
}}]});
const {InboxSqlite,TurnHistoryGate,AssistantWriterSubject}=await import(pathToFileURL(subject).href);
const now='2026-11-09T00:00:00.000Z';
const input=id=>({workspaceId:'w',sessionId:'s',userId:'u',inputId:id,kind:'human',config:{}});
function fixture(){
 const db=new Database(':memory:');InboxSqlite.migrate(db);
 db.exec("CREATE TABLE orchestration_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO orchestration_meta VALUES('inbox_sequence','0');");
 const sql=new InboxSqlite(db,()=>now);sql.activate('w','owner-1');
 const result=id=>db.transaction(()=>sql.indexCompletion({workspaceId:'w',requesterSessionId:'s',requesterUserId:'u',operationId:id,kind:'session_chat',frozenContinuationConfig:{inputConfig:{}},initiatorChainDepth:0,createdAt:now,finishedAt:now,completion:{type:'result',value:{items:[]}}})).immediate();
 return {db,sql,result};
}
function* orders(prefix=[],remaining=['accept-A','begin-A','submit-A','settle-A','release-A','accept-B','stop-A','restart']){
 if(!remaining.length){yield prefix;return;}
 const chain=['accept-A','begin-A','submit-A','settle-A','release-A'];
 for(const item of remaining){const index=chain.indexOf(item);if(index>0&&!prefix.includes(chain[index-1]))continue;
  yield*orders([...prefix,item],remaining.filter(x=>x!==item));}
}
const counts={timelines:0,startedBeforeStop:0,stopBeforeSubmit:0,staleOwnerRefused:0,canceledB:0,healthyB:0,freshFutureInbox:0};
for(const order of orders()){
 const f=fixture();const {db,sql}=f;let owner='owner-1',begun=false,batch,started=false,stop=false;
 try{
  f.result('result-before');
  const a=input('A'),b=input('B');
  for(const event of order){
   if(event==='accept-A'){sql.accept(a);assert.equal(sql.accept(a),!sql.inputCanceled('w','s','A'),'same-ID duplicate receipt');}
   if(event==='accept-B')sql.accept(b);
   if(event==='begin-A'){begun=sql.begin(a,'exec-A','owner-1');if(begun)batch=sql.prepare(a,'owner-1');}
   if(event==='submit-A'){
    if(sql.canSubmit(a,'exec-A','owner-1')&&(!batch||sql.fence(batch,'exec-A'))){
     started=true;assert.equal(stop,false,'Stop fenced before actual start');
     if(batch)assert.equal(sql.fence(batch,'exec-A'),false,'same batch start cannot repeat');
    }
   }
   if(event==='settle-A'&&started&&batch)sql.settle(batch,'submitted');
   if(event==='release-A'){
    if(started&&batch)sql.settle(batch,'settled');
    sql.release({...a,executionId:'exec-A',outcome:stop?'user_stop':'normal'});
   }
   if(event==='stop-A'){
    stop=sql.pause(a,'exec-A',[],'cancel-1');
    if(stop){const before=JSON.stringify(db.prepare('SELECT * FROM inbox_sessions').all());
     assert.equal(sql.pause(a,'exec-A',[],'cancel-1'),true);assert.equal(JSON.stringify(db.prepare('SELECT * FROM inbox_sessions').all()),before,'duplicate Stop does not pause twice');
     if(started)counts.startedBeforeStop++;else counts.stopBeforeSubmit++;
    }
   }
   if(event==='restart'){
    owner='owner-2';sql.activate('w',owner);
    assert.equal(sql.canSubmit(a,'exec-A','owner-1'),false,'prior owner cannot start after lease handoff');
    assert.equal(sql.begin(a,'stale-owner-exec','owner-1'),false);counts.staleOwnerRefused++;
   }
   assert.ok(db.prepare('SELECT * FROM inbox_sessions WHERE active_execution IS NOT NULL').all().length<=1,'one active execution');
  }
  // The second already-accepted message is either explicitly canceled by Stop,
  // or can proceed after A. Retrying its old identity cannot clear a Stop.
  const canceled=sql.inputCanceled('w','s','B');
  if(canceled){counts.canceledB++;assert.equal(sql.accept(b),false);assert.equal(sql.begin(b,'exec-B',owner),false);}
  else{
   const active=db.prepare('SELECT active_execution FROM inbox_sessions').get()?.active_execution;
   assert.equal(active,null,'old A slot was released/recovered');
   assert.equal(sql.begin(b,'exec-B',owner),true,'healthy later message must begin');
   counts.healthyB++;sql.release({...b,executionId:'exec-B',outcome:'normal'});
  }
  // Fresh explicit input after every timeline must recover pause, preserve old
  // cancellation, and allow newly arrived Inbox results on the current owner.
  const future=input('fresh-after-recovery');f.result('result-after');
  assert.equal(sql.accept(future),true);assert.equal(sql.begin(future,'exec-future',owner),true);
  const futureBatch=sql.prepare(future,owner);assert.ok(futureBatch);
  const members=sql.members(futureBatch).map(x=>x.operationId);assert.ok(members.includes('result-after'));
  sql.release({...a,executionId:'exec-A',outcome:'failed'});
  assert.equal(db.prepare('SELECT active_execution FROM inbox_sessions').get().active_execution,'exec-future','late old release cannot clear successor');
  const futureState=JSON.stringify(db.prepare('SELECT * FROM inbox_sessions').all());
  assert.equal(sql.pause(a,'exec-A',[],'cancel-1'),stop,'delayed duplicate Stop preserves the later run');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM inbox_sessions').all()),futureState,'old Stop must not pause successor');
  assert.equal(sql.accept(a),!sql.inputCanceled('w','s','A'),'old input receipt cannot clear pause or reauthorize a canceled identity');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM inbox_sessions').all()),futureState,'old admission receipt leaves successor unchanged');
  assert.equal(sql.canSubmit(future,'exec-future',owner),true);assert.equal(sql.fence(futureBatch,'exec-future'),true);
  sql.settle(futureBatch,'settled');sql.release({...future,executionId:'exec-future',outcome:'normal'});
  assert.equal(sql.begin(future,'replay',owner),false);counts.freshFutureInbox++;counts.timelines++;
 }catch(error){error.message+='\nTimeline: '+order.join(' → ');throw error;}finally{db.close();}
}
assert.equal(counts.timelines,336);
// A stalled asynchronous assistant-entry write must not defeat teardown.
// Explicit hook-entered/resolve signals and a manually fired deadline replace
// wall-clock sleeps. The gate code is production source; scratch mutants only restore the old blocking behavior.
const gateResults=[];
for(const [trigger,release] of [['history','dispose'],['history','deadline'],['timeout','dispose']]){
 const realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout;let deadline,cleared=false;
 globalThis.setTimeout=callback=>{deadline=callback;return {unref(){}};};
 globalThis.clearTimeout=()=>{cleared=true;};
 let enter,complete;const entered=new Promise(r=>enter=r),hook=new Promise(r=>complete=r);let waiterReleased=false;
 let gate;
 try{
  gate=TurnHistoryGate.waitForUserTurn({logger:{debug(){},warn(){},error(){}},sessionId:'s',userTurnId:'rpc-turn',hasUserTurn:async()=>trigger==='history',subscribeHistory:()=>()=>{},onBeforeOpen:async()=>{enter();await hook;}});
  if(trigger==='timeout')deadline();
  await entered;if(trigger==='history'){assert.equal(gate.isOpen,false);if(variant!=='unsafe-gate')assert.equal(cleared,false);}
  const waiter=gate.waitUntilOpen().then(()=>{waiterReleased=true;});
  if(release==='dispose')gate.dispose();else if(!cleared)deadline();
  await Promise.resolve();await Promise.resolve();
  const result=waiterReleased?'PASS':'FAIL';
  gateResults.push({trigger,release,property:release==='dispose'?'DisposeUnblocks':'DeadlineUnblocks',result,openFlag:gate.isOpen,waiterReleasedAfterDispose:waiterReleased});
  complete();await waiter;assert.equal(waiterReleased,true,'finishing old hook finally releases waiters');
 }finally{complete?.();gate?.dispose();globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;}
}
const lateWriterCases=[];
if(variant!=='unsafe-gate')for(const trigger of ['history','timeout'])for(const release of ['dispose','deadline','deadline-dispose']){
 const realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout;let deadline;
 globalThis.setTimeout=callback=>{deadline=callback;return {unref(){}};};globalThis.clearTimeout=()=>{};
 const db=new Database(':memory:');
 db.exec("CREATE TABLE assistant_turns(id TEXT PRIMARY KEY,finished INTEGER NOT NULL, data TEXT); INSERT INTO assistant_turns VALUES('old-assistant',1,NULL),('new-assistant',0,NULL);");
 let enter,unblock;const entered=new Promise(r=>enter=r),backendReady=new Promise(r=>unblock=r);
 const backend={history:{readTurn:async id=>({state:'ready',turn:{id,role:'assistant',author:{v:1,kind:'agent',sessionId:'s',turnId:id,name:'Fixture Agent'}}})},openAssistantTurn:async entry=>{db.prepare('UPDATE assistant_turns SET finished=0,data=? WHERE id=?').run(JSON.stringify(entry),entry.turnId);}};
 const writer=new AssistantWriterSubject(backendReady);let work;
 const gate=TurnHistoryGate.waitForUserTurn({logger:{debug(){},warn(){},error(){}},sessionId:'s',userTurnId:'A',hasUserTurn:async()=>trigger==='history',subscribeHistory:()=>()=>{},onBeforeOpen:(_reason,signal)=>{enter();work=writer.writeAssistantEntryForTurn('s',{},'old-assistant',{modelId:'fixture-model'},'A',signal);return work;}});
 try{
  if(trigger==='timeout')deadline();
  await entered;if(release==='dispose')gate.dispose();else {deadline();if(release==='deadline-dispose')gate.dispose();}await gate.waitUntilOpen();
  unblock(backend);await work;
  const rows=db.prepare('SELECT * FROM assistant_turns ORDER BY id').all();
  assert.deepEqual(rows[0],{id:'new-assistant',finished:0,data:null},'successor unchanged');
  if(release==='deadline'){
   assert.equal(rows[1].finished,0,'TimeoutMetadata: the live assistant entry must still open');
   const entry=JSON.parse(rows[1].data);
   assert.equal(entry.author.name,'Fixture Agent','TimeoutMetadata: author retained');
   assert.deepEqual(entry.modelInfo,{modelId:'fixture-model'},'TimeoutMetadata: model retained');
   assert.equal(entry.userTurnId,'A');assert.ok(!Number.isNaN(Date.parse(entry.timestamp)));
  }else assert.deepEqual(rows[1],{id:'old-assistant',finished:1,data:null},'NoLateWrites: a late callback reopened an ended assistant turn');
  lateWriterCases.push({trigger,release,result:'PASS',metadataWritten:release==='deadline',successorUnchanged:true});
 }finally{unblock(backend);gate.dispose();globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;db.close();}
}
const result={variant,sqliteTimelines:{result:'PASS',...counts,bounds:'Two explicit messages in one session, one preexisting and one future completion, one exact-ID Stop and duplicate, one lease-safe owner handoff; accept/begin/submit/settle/release A ordered; B, Stop and handoff interleave in all 336 possible orders. Late A release is also tried while future input owns slot. Injected synchronous provider-start boundary; no native process or lease producer.'},lateWriterCases,outputGate:{result:gateResults.some(x=>x.result==='FAIL')?'FAIL':'PASS',cases:gateResults},limits:'SQL transactions, gate class and the complete assistant-entry write method are production code. The late-writer witness uses a synthetic SQLite-backed history port and a diagnostic span stub; it does not test the real HistoryWriter. This is not end-to-end CRDT, RPC, permission, watcher, provider or UI acceptance. Accepted two-message events represent host admission after verified delivery, not arbitrary raw remote packets.'};
console.log(JSON.stringify(result,null,2));process.exitCode=result.outputGate.result==='FAIL'?1:0;
