import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2]);
const tools = path.resolve(process.argv[3] ?? '/tmp/lody-inbox-verification-tools');
const variant = process.argv[4] ?? 'current';
const faultMode = process.argv[5] ?? 'trigger';
const require = createRequire(path.join(tools, 'package.json'));
for (const [name, version] of Object.entries({effect:'4.0.2',zod:'4.3.6','better-sqlite3':'13.0.3',esbuild:'0.28.2'})) {
  const installed = JSON.parse(await fs.readFile(path.join(tools,'node_modules',name,'package.json'),'utf8'));
  assert.equal(installed.version, version, 'Verifier dependency version mismatch: '+name);
}
const { build } = require('esbuild');
const Database = require('better-sqlite3');
const { Effect, Layer, ManagedRuntime, Deferred, Exit } = await import(pathToFileURL(require.resolve('effect')).href);
const { TestClock } = await import(pathToFileURL(require.resolve('effect/testing')).href);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-inbox-replay-'));
const outfile = path.join(scratch,'subject.mjs');
const mutations = [];
function replaceOnce(text, before, after, label) {
  assert.equal(text.split(before).length,2,'Source patch must match once: '+label);
  mutations.push(label);
  return text.replace(before,after);
}
await build({
  stdin:{contents:['inbox/service','inbox/sqlite','inbox/execution-owner','platform/inbox-repository'].map(s=>'export * from '+JSON.stringify(path.join(root,'apps/cli/src/orchestration',s+'.ts'))+';').join('\n'),resolveDir:root,loader:'ts'},
  outfile,bundle:true,format:'esm',platform:'node',packages:'external',logLevel:'silent',
  plugins:[{name:'verification-boundary',setup(builder){
    builder.onResolve({filter:/^(effect|zod|better-sqlite3)$/},args=>({path:require.resolve(args.path),external:true}));
    builder.onResolve({filter:/^@\/utils\/logger$/},()=>({path:'logger',namespace:'verification'}));
    builder.onLoad({filter:/.*/,namespace:'verification'},()=>({contents:'export const getLogger = () => ({ warn() {} });',loader:'js'}));
    builder.onLoad({filter:/\/inbox\/(service|sqlite)\.ts$/},async args=>{
      let text=await fs.readFile(args.path,'utf8');
      if(args.path.endsWith('/service.ts')) {
        if(variant==='blocked-scan')text=replaceOnce(text,'          yield* retrySettlements().pipe(Effect.catchCause(reportIndependentFailure));','          yield* retrySettlements();','restore scan-wide retry failure');
        if(variant==='busy-amplification')text=replaceOnce(text,'Cause.hasInterrupts(cause) || storageBusy(cause)','Cause.hasInterrupts(cause)','restore repeated native BUSY waits');
        if(variant==='drop-retry')text=replaceOnce(text,'            settlements.set(batch.batchId, receipt);','            // Deliberately broken: forget the unconfirmed receipt.','drop unconfirmed settlement');
        if(variant==='unsafe-submit') {
          const start=text.indexOf('                  if (\n                    quiesced ||');
          const end=text.indexOf('                  // Return a container:',start);
          assert.ok(start>=0&&end>start,'Submit refusal branch moved');
          text=text.slice(0,start)+text.slice(end);mutations.push('remove actual-start refusal branch');
        }
      }
      if(args.path.endsWith('/sqlite.ts')&&variant==='stale-release') {
        const start=text.indexOf('  release(event: InboxRelease): void');
        const needle='UPDATE inbox_sessions SET active_execution=NULL,active_input=NULL WHERE workspace_id=? AND session_id=? AND user_id=?';
        text=text.slice(0,start)+replaceOnce(text.slice(start),needle,'UPDATE inbox_sessions SET active_execution=NULL,active_input=NULL WHERE workspace_id=? AND (? IS NOT NULL) AND user_id=?','release wrong session slot');
      }
      return {contents:text,loader:'ts'};
    });
  }}]
});
const m=await import(pathToFileURL(outfile).href);
const observed=[];
let fixtureId=0;
function fixture(disk=false) {
  const filename=disk?path.join(scratch,'fixture-'+String(fixtureId++)+'.sqlite'):':memory:';
  const db=new Database(filename);
  if(disk){db.pragma('journal_mode = WAL');db.pragma('busy_timeout = 0');}
  m.InboxSqlite.migrate(db);
  db.exec("CREATE TABLE orchestration_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO orchestration_meta VALUES('inbox_sequence','0');");
  const sql=new m.InboxSqlite(db,()=> '2026-11-09T00:00:00.000Z');
  sql.activate('w','owner');
  const input=(sessionId,id='human-'+sessionId)=>({workspaceId:'w',sessionId,userId:'u',inputId:id,kind:'human',config:{}});
  const add=(sessionId,id='result-'+sessionId)=>db.transaction(()=>sql.indexCompletion({workspaceId:'w',requesterSessionId:sessionId,requesterUserId:'u',operationId:id,kind:'session_chat',frozenContinuationConfig:{inputConfig:{}},initiatorChainDepth:0,createdAt:'2026-11-09T00:00:00.000Z',finishedAt:'2026-11-09T00:00:00.000Z',completion:{type:'result',value:{items:[]}}})).immediate();
  let runtime;
  const startRuntime=async (ports,clockLayer)=>{
    const deps=Layer.mergeAll(m.inboxRepositoryLayer(sql),Layer.succeed(m.ExecutionMembers,{members:b=>Effect.try(()=>sql.members(b))}),Layer.succeed(m.InboxExecution,{ready:()=>false,admit:()=>true,launch:()=>Effect.void,report:()=>Effect.void,...ports}));
    let layer=m.OperationInbox.layer('w','owner').pipe(Layer.provideMerge(deps));
    if(clockLayer)layer=layer.pipe(Layer.provideMerge(clockLayer));
    runtime=ManagedRuntime.make(layer);
    const service=await runtime.runPromise(m.OperationInbox);
    return {runtime,service,run:e=>runtime.runPromise(e)};
  };
  return {filename,db,sql,input,add,startRuntime,close:async()=>{try {if(runtime)await runtime.dispose();} finally {db.close();}}};
}
async function safety(name,body,disk=false) {
  const f=fixture(disk);
  let failure,failed=false;
  try {await body(f);observed.push({name,result:'PASS'});} catch(error) {failure=error;failed=true;}
  try {await f.close();} catch(cleanup) {
    if(failed)throw new AggregateError([failure,cleanup],'Source behavior failed and cleanup also failed');
    throw cleanup;
  }
  if(failed)throw failure;
}
try {
  if(variant==='current'||variant==='busy-amplification')await safety('Native BUSY waits are bounded per scan, back off, and recover without new external events',async f=>{
    for(const s of ['A','B','C'])f.add(s);
    const blocker=new Database(f.filename);blocker.exec('BEGIN IMMEDIATE');
    let locked=true,run;const attempts=[],starts=[];const busy=Deferred.makeUnsafe(),done=Deferred.makeUnsafe();
    const prepare=f.sql.prepare.bind(f.sql);f.sql.prepare=(...args)=>{if(locked)attempts.push(args[0].sessionId);return prepare(...args);};
    try{
      const runtime=await f.startRuntime({ready:()=>true,report:()=>Effect.sync(()=>Deferred.doneUnsafe(busy,Effect.void)),launch:batch=>Effect.tryPromise(async()=>{
        const owner=await run(m.makeExecutionOwner(batch,'exec-'+batch.sessionId,batch));
        await run(owner.submit(()=>{starts.push(batch.sessionId);return Promise.resolve();}));await run(owner.finish('normal'));
        if(starts.filter(x=>x!=='D').length===3)Deferred.doneUnsafe(done,Effect.void);
      })},TestClock.layer());run=runtime.run;
      await run(Deferred.await(busy));await run(TestClock.adjust(0));
      assert.deepEqual(attempts,['A'],'NativeBusyWaitBound: one shared lock must not multiply blocking attempts');
      for(let i=0;i<5;i++)await run(runtime.service.wake);
      await run(TestClock.adjust(249));assert.deepEqual(attempts,['A']);
      await run(TestClock.adjust(1));assert.deepEqual(attempts,['A','A']);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox_results WHERE consumed=0').get().n,3);
      locked=false;blocker.exec('ROLLBACK');
      const fresh=f.input('D','fresh-after-unlock');assert.equal(await run(runtime.service.accept(fresh)),true);
      const owner=await run(m.makeExecutionOwner(fresh,'exec-D'));await run(owner.submit(()=>{starts.push('D');return Promise.resolve();}));await run(owner.finish('normal'));
      await run(TestClock.adjust(500));await run(Deferred.await(done));assert.deepEqual(starts.toSorted(),['A','B','C','D']);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox_results WHERE consumed=0').get().n,0);
    }finally{locked=false;if(blocker.inTransaction)blocker.exec('ROLLBACK');blocker.close();}
  },true);
  await safety('Stop before actual transport start preserves unconsumed results',async f=>{
    const input=f.input('B');f.sql.accept(input);f.add('B');const {run,service}=await f.startRuntime();
    const owner=await run(m.makeExecutionOwner(input,'exec-B'));
    const batch=owner.batch;assert.ok(batch);
    assert.equal(await run(service.pause(input,'exec-B')),true);
    let started=false;
    const submitted=await run(Effect.exit(owner.submit(()=>{started=true;return Promise.resolve();})));
    assert.equal(started,false,'NoStartAfterStop: cancelled input reached transport');
    assert.ok(Exit.isFailure(submitted));
    assert.deepEqual(f.db.prepare('SELECT consumed FROM inbox_results').all(),[{consumed:0}]);
    await run(owner.finish('user_stop'));
  });
  await safety('Batch membership freezes before a later arrival and duplicate finish cannot replay',async f=>{
    const input=f.input('B');f.sql.accept(input);f.add('B','before-claim');const {run}=await f.startRuntime();
    const owner=await run(m.makeExecutionOwner(input,'exec-B'));
    f.add('B','after-claim');
    assert.deepEqual(f.sql.members(owner.batch).map(x=>x.operationId),['before-claim']);
    const starts=[];await run(owner.submit(()=>{starts.push('original');return Promise.resolve();}));
    await run(owner.finish('normal'));await run(owner.finish('normal'));
    assert.deepEqual(starts,['original']);
    const [pending]=f.sql.pending('w');assert.ok(pending);
    const next=f.sql.prepare(pending.input,'owner',pending.intentId);
    assert.deepEqual(f.sql.members(next).map(x=>x.operationId),['after-claim']);
  });
  await safety('Unknown transport outcome remains consumed and cannot restart the old input',async f=>{
    const input=f.input('B');f.sql.accept(input);f.add('B');const {run}=await f.startRuntime();
    const owner=await run(m.makeExecutionOwner(input,'exec-B'));const batch=owner.batch;
    await run(owner.submit(()=>Promise.resolve()));
    await run(owner.finish('failed',new Error('synthetic transport outcome unknown')));
    assert.equal(f.sql.getBatch(batch.batchId,input).state,'unknown');
    f.sql.activate('w','replacement');
    assert.equal(f.sql.begin(input,'new-exec','replacement'),false);
    assert.equal(f.sql.prepare(input,'replacement'),undefined);
    assert.deepEqual(f.db.prepare('SELECT consumed FROM inbox_results').all(),[{consumed:1}]);
  });
  await safety('A release cannot clear a live execution in B',async f=>{
    const a=f.input('A');f.sql.accept(a);f.sql.begin(a,'exec-A','owner');
    const b=f.input('B');f.sql.accept(b);const {run}=await f.startRuntime();
    const owner=await run(m.makeExecutionOwner(b,'exec-B'));
    f.sql.release({...a,executionId:'exec-A',outcome:'normal'});
    assert.equal(f.sql.activeExecution('w','B')?.executionId,'exec-B','OldReleaseCannotFreeSuccessor: A release cleared B');
    await run(owner.finish('failed'));
  });
  await safety('A failed pause retry does not skip an independent release or settlement, and fresh B still submits',async f=>{
    const a=f.input('A'),b=f.input('B'),c=f.input('C');
    for(const i of [a,b,c])f.sql.accept(i);
    f.sql.begin(a,'exec-A','owner');f.sql.begin(b,'exec-B','owner');f.add('C');
    const {run,service}=await f.startRuntime();const ownerC=await run(m.makeExecutionOwner(c,'exec-C'));const batchC=ownerC.batch;assert.ok(batchC);
    f.db.exec("CREATE TRIGGER fail_pause_A BEFORE UPDATE OF paused ON inbox_sessions WHEN NEW.session_id='A' AND NEW.paused=1 BEGIN SELECT RAISE(ABORT,'pause A unavailable'); END; CREATE TRIGGER fail_release_B BEFORE UPDATE OF active_execution ON inbox_sessions WHEN OLD.session_id='B' AND NEW.active_execution IS NULL BEGIN SELECT RAISE(ABORT,'release B unavailable'); END; CREATE TRIGGER fail_settle_C BEFORE UPDATE ON inbox_batches WHEN OLD.session_id='C' AND OLD.state IN ('submitting','submitted') BEGIN SELECT RAISE(ABORT,'settlement C unavailable'); END;");
    assert.ok(Exit.isFailure(await run(Effect.exit(service.pause(a,'exec-A',[],'cancel-A')))));
    assert.ok(Exit.isFailure(await run(Effect.exit(service.release({...b,executionId:'exec-B',outcome:'normal'})))));
    await run(ownerC.submit(()=>Promise.resolve()));await run(ownerC.finish('failed',new Error('synthetic unknown C')));
    f.db.exec('DROP TRIGGER fail_release_B; DROP TRIGGER fail_settle_C;');
    const repository=await run(m.InboxRepository);
    const recovery=await run(Effect.exit(service.recoverSettlements(repository.settle,repository.release,()=>{throw new Error('synthetic pause callback construction failure');})));
    assert.ok(Exit.isFailure(recovery),'Unconfirmed pause must still be reported as failure');
    assert.equal(f.sql.activeExecution('w','B'),undefined,'Independent release was skipped');
    assert.equal(f.sql.getBatch(batchC.batchId,c).state,'unknown','RetryEvidenceRetained: Independent settlement was skipped');
    f.add('B','future-B');const fresh=f.input('B','fresh-B');assert.equal(await run(service.accept(fresh)),true);
    const next=await run(m.makeExecutionOwner(fresh,'fresh-exec-B'));let started=false;
    await run(next.submit(()=>{started=true;return Promise.resolve();}));await run(next.finish('normal'));assert.equal(started,true);
    f.db.exec('DROP TRIGGER fail_pause_A');
    await run(service.recoverSettlements(repository.settle,repository.release,repository.pause));
    assert.equal(f.sql.inputCanceled('w','A',a.inputId),true,'The failed pause was lost');
    await run(service.release({...a,executionId:'exec-A',outcome:'user_stop'}));
  });
  await safety('Persistent A prepare failure and broken diagnostics do not block B or its later Inbox input',async f=>{
    f.add('A');f.add('B');
    f.db.exec("CREATE TRIGGER fail_prepare_A BEFORE INSERT ON inbox_batches WHEN NEW.session_id='A' BEGIN SELECT RAISE(ABORT,'prepare A unavailable'); END;");
    let armed=false,run;const starts=[];const first=Deferred.makeUnsafe(),second=Deferred.makeUnsafe();
    const runtime=await f.startRuntime({ready:()=>armed,report:()=>{throw new Error('synthetic failed diagnostic sink');},launch:batch=>Effect.tryPromise(async()=>{
      const owner=await run(m.makeExecutionOwner(batch,'exec-B-'+starts.length,batch));
      await run(owner.submit(()=>{starts.push(batch.sessionId);return Promise.resolve();}));await run(owner.finish('normal'));
      Deferred.doneUnsafe(starts.length===1?first:second,Effect.void);
    })});run=runtime.run;armed=true;
    await run(runtime.service.wake);await run(Deferred.await(first));
    f.add('B','later-B');await run(runtime.service.wake);await run(Deferred.await(second));
    assert.deepEqual(starts,['B','B']);
    assert.ok(f.sql.pending('w').some(x=>x.input.sessionId==='A'),'Failed A evidence must remain retryable');
    f.db.exec('DROP TRIGGER fail_prepare_A');
  });
  await safety('A synchronous launch exception cannot strand the running latch or later Inbox input',async f=>{
    f.add('B');let armed=false,rejectOnce=true,run;const starts=[];
    const rejected=Deferred.makeUnsafe(),done=Deferred.makeUnsafe();
    const runtime=await f.startRuntime({ready:()=>armed,report:()=>Effect.sync(()=>Deferred.doneUnsafe(rejected,Effect.void)),launch:batch=>{
      if(rejectOnce){rejectOnce=false;throw new Error('synthetic synchronous launch construction failure');}
      return Effect.tryPromise(async()=>{
        const owner=await run(m.makeExecutionOwner(batch,'B-'+starts.length,batch));
        await run(owner.submit(()=>{starts.push(batch.batchId);return Promise.resolve();}));await run(owner.finish('normal'));
        if(starts.length===2)Deferred.doneUnsafe(done,Effect.void);
      });
    }});run=runtime.run;armed=true;
    await run(runtime.service.wake);await run(Deferred.await(rejected));
    f.add('B','after-rejected-launch');await run(runtime.service.wake);await run(Deferred.await(done));
    assert.equal(starts.length,2);assert.equal(new Set(starts).size,2,'A fixed batch was replayed');
    assert.equal(f.sql.pending('w').length,0,'A failed launch left the queue unusable');
  });
  await safety('Synchronous Stop persistence failure vetoes only its own input and a fresh B remains usable',async f=>{
    const a=f.input('A');f.sql.accept(a);const {run,service}=await f.startRuntime();
    const owner=await run(m.makeExecutionOwner(a,'A'));
    const repo=await run(m.InboxRepository),pause=repo.pause;
    repo.pause=()=>{throw new Error('synthetic pause construction failure');};
    assert.ok(Exit.isFailure(await run(Effect.exit(service.pause(a,'A',[],'stop-A')))));
    let oldStarted=false;assert.ok(Exit.isFailure(await run(Effect.exit(owner.submit(()=>{oldStarted=true;return Promise.resolve();})))));
    assert.equal(oldStarted,false,'NoStartAfterStop: a synchronous pause failure lost the input veto');
    const b=f.input('B');assert.equal(await run(service.accept(b)),true);const next=await run(m.makeExecutionOwner(b,'B'));
    let freshStarted=false;await run(next.submit(()=>{freshStarted=true;return Promise.resolve();}));await run(next.finish('normal'));
    assert.equal(freshStarted,true);
    repo.pause=pause;await run(service.recoverSettlements(repo.settle,repo.release,repo.pause));await run(owner.finish('user_stop'));
  });
  await safety('A synchronous settlement construction failure retains its receipt without abandoning submitted work',async f=>{
    const input=f.input('A');f.sql.accept(input);f.add('A');const {run,service}=await f.startRuntime();const owner=await run(m.makeExecutionOwner(input,'A'));
    const repo=await run(m.InboxRepository),settle=repo.settle;repo.settle=()=>{throw new Error('synthetic settlement construction failure');};
    let starts=0;await run(owner.submit(()=>{starts++;return Promise.resolve();}));assert.equal(starts,1);
    assert.equal(f.sql.getBatch(owner.batch.batchId,input).state,'submitting');
    repo.settle=settle;await run(service.recoverSettlements(repo.settle,repo.release,repo.pause));
    assert.equal(f.sql.getBatch(owner.batch.batchId,input).state,'submitted','RetryEvidenceRetained: the submitted receipt was lost');
    await run(owner.finish('normal'));assert.equal(starts,1);
  });
  const f=fixture();
  let result;
  try {
    const a=f.input('A');f.sql.accept(a);f.add('A');
    let allowB=false;
    if(faultMode==='sqlite-full') {
      f.add('B');const pending=f.sql.pending('w').find(x=>x.input.sessionId==='B');
      assert.ok(f.sql.prepare(pending.input,'owner',pending.intentId));
    }
    const firstObserved=Deferred.makeUnsafe();const launched=Deferred.makeUnsafe();let armed=false;const starts=[];
    let run;
    const runtime=await f.startRuntime({
      ready:()=>allowB,
      launch:b=>Effect.tryPromise(async()=>{const owner=await run(m.makeExecutionOwner(b,'exec-'+b.sessionId,b));await run(owner.submit(()=>{starts.push(b.sessionId);return Promise.resolve();}));await run(owner.finish('normal'));Deferred.doneUnsafe(launched,Effect.void);}),
      report:()=>Effect.sync(()=>{if(armed)Deferred.doneUnsafe(firstObserved,Effect.void);})
    });run=runtime.run;
    const ownerA=await run(m.makeExecutionOwner(a,'exec-A'));
    const batch=ownerA.batch;assert.ok(batch);
    let pageLimit;
    if(faultMode==='sqlite-full') {
      f.db.exec('CREATE TABLE reserve_space(value BLOB); INSERT INTO reserve_space VALUES(zeroblob(131072)); DROP TABLE reserve_space;');
      pageLimit=f.db.pragma('page_count',{simple:true});f.db.pragma('max_page_count='+pageLimit);
    } else {
      f.db.exec("CREATE TRIGGER fail_A_settlement BEFORE UPDATE ON inbox_batches WHEN OLD.session_id='A' AND OLD.state IN ('submitting','submitted') BEGIN SELECT RAISE(ABORT,'A settlement unavailable'); END;");
    }
    const repository=await run(m.InboxRepository);const originalSettle=repository.settle;const faultCodes=[];
    repository.settle=(...args)=>originalSettle(...args).pipe(Effect.tapError(error=>Effect.sync(()=>faultCodes.push(error.code))));
    const submittedA=[];
    await run(ownerA.submit(()=>{submittedA.push('A');return Promise.resolve();}));
    assert.deepEqual(submittedA,['A']);
    // A's real owner releases its slot while retaining the failed final settlement.
    if(faultMode==='sqlite-full') await run(ownerA.finish('failed',new Error('synthetic large retained failure '+ 'x'.repeat(1024*1024))));
    else await run(ownerA.finish('normal'));
    if(variant!=='drop-retry') {armed=true;await run(runtime.service.wake);await run(Deferred.await(firstObserved));armed=false;}
    allowB=true;
    if(faultMode!=='sqlite-full') f.add('B');
    assert.ok(f.sql.pending('w').some(x=>x.input.sessionId==='B'));
    const retryObserved=Deferred.makeUnsafe();const port=await run(m.InboxExecution);
    port.report=()=>Effect.sync(()=>Deferred.doneUnsafe(retryObserved,Effect.void));
    await run(runtime.service.wake);
    if(variant==='blocked-scan')await run(Deferred.await(retryObserved));else await run(Deferred.await(launched));
    result={faultMode,faultCodes:[...new Set(faultCodes)],property:'HealthySessionProgress',result:starts.includes('B')?'PASS':'FAIL',aSlotReleased:!f.sql.activeExecution('w','A'),bHasPendingIntent:f.sql.pending('w').some(x=>x.input.sessionId==='B'),startedBeforeRepair:[...starts],aBatchBeforeRepair:f.sql.getBatch(batch.batchId,a).state};
    // New explicit input in A must remain usable too; a failed old settlement
    // is not a permanent fence on that conversation or its future Inbox results.
    f.add('A','fresh-result-A');const freshA=f.input('A','fresh-A-during-old-write-fault');
    assert.equal(await run(runtime.service.accept(freshA)),true);
    const futureA=await run(m.makeExecutionOwner(freshA,'exec-fresh-A'));
    let freshAStarts=0;await run(futureA.submit(()=>{freshAStarts++;return Promise.resolve();}));await run(futureA.finish('normal'));
    assert.equal(freshAStarts,1,'Same-session fresh input was blocked by old settlement');
    result.sameSessionFreshInputDuringFault='PASS';
    if(faultMode==='sqlite-full')f.db.pragma('max_page_count='+(pageLimit+4096));
    else f.db.exec('DROP TRIGGER fail_A_settlement');
    await run(runtime.service.recoverSettlements(repository.settle,repository.release,repository.pause));
    await run(runtime.service.wake);await run(Deferred.await(launched));
    result.startedAfterRepair=[...starts];
    result.aBatchAfterRepair=f.sql.getBatch(batch.batchId,a).state;
    assert.equal(result.aBatchAfterRepair,faultMode==='sqlite-full'?'unknown':'settled','RetryEvidenceRetained: unconfirmed A receipt was lost');
    assert.deepEqual(starts,['B'],'AtMostOnce: B transport was started twice');
    if(faultMode==='sqlite-full')assert.deepEqual(result.faultCodes,['SQLITE_FULL'],'Native SQLite capacity fault was not established');
  } finally {await f.close();}
  console.log(JSON.stringify({variant,safety:observed,progress:result,mutations,limits:'Real production Inbox service, owner, repository and better-sqlite3; logger replaced; provider transport injected. No full Session/Agent, native process or real-device acceptance.'},null,2));
  process.exitCode=result.result==='PASS'?0:1;
} finally {await fs.rm(scratch,{recursive:true,force:true});}
