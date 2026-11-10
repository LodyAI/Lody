import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]);const tools=path.resolve(process.argv[3]??'/tmp/lody-inbox-verification-tools');
const require=createRequire(path.join(tools,'package.json'));const {build}=require('esbuild');
for(const [name,version] of Object.entries({effect:'4.0.2',zod:'4.3.6','better-sqlite3':'13.0.3',esbuild:'0.28.2'})){assert.equal(JSON.parse(await fs.readFile(path.join(tools,'node_modules',name,'package.json'),'utf8')).version,version,'Locked verifier dependency: '+name);}

const read=p=>fs.readFile(path.join(root,p),'utf8');
// Extract complete, unchanged declaration spans, rather than replacing shared
// policy helpers. This avoids loading unrelated native/E2EE/UI modules through
// the shared barrel. Every delimiter is unique and covered by source hashes.
function span(text,first,next){assert.equal(text.split(first).length,2,'unique source start: '+first);const start=text.indexOf(first),end=text.indexOf(next,start+first.length);assert.ok(end>start,'source end: '+next);return text.slice(start,end);}
let logic=await read('apps/cli/src/session/session-dispatch-logic.ts');
if(process.argv[4]==='unsafe-cancel'){const guard='getSessionCancelRequestMarker(cancelRequest.id) !== lastCanceledTurn';assert.equal(logic.split(guard).length,2);logic=logic.replace(guard,'false');}
const schema=await read('packages/shared/src/schema.ts');
const control=await read('packages/shared/src/session-control-plane.ts');
const project=await read('packages/shared/src/project.ts');
let watcher=await read('apps/cli/src/session/session-dispatch-watcher.ts');
if(process.argv[4]==='unsafe-negative-ack') {
 const start=watcher.indexOf('      recoveryPatch.missingHistoryUserMsgIds = {');
 const end=watcher.indexOf('      };',start);
 assert.ok(start>=0&&end>start);
 watcher=watcher.slice(0,start)+watcher.slice(end+9);
}
const index=await read('packages/shared/src/index.ts');
const contents=[
 span(schema,'export const resolveSessionHistoryStatus =','export const getLegacyReadForSessionHistoryStatus ='),
 span(schema,'export function isMissingHistoryUserTurn','export type SessionLegacyMetaFields ='),
 span(control,"const CANCEL_REQUEST_PREFIX =",'// # Session control-plane Mirror'),
 span(project,'export function getLocalProjectHistoryProviderKey','/** Catalogs are account-scoped;'),
 span(logic,'export function findLastHistoryEntry','// ── Action types'),
 span(logic,'function getImportedAcpSourceAcpSessionId','// ── Dispatch decision'),
 span(logic,'export function resolveSessionCancelAction','// ── Turn finding'),
 span(logic,'export function findNextDispatchableUserTurn','export function resolveDispatchTurnInput'),
 span(index,'export const SESSION_DOC_PREFIX =','// Compatibility tombstone:'),
 span(index,'export const getSessionRoomId =','export const getMachineRoomId ='),
 await read('packages/shared/src/repo-doc-meta.ts'),
 `import {SessionStatusFactory} from ${JSON.stringify(path.join(root,'packages/shared/src/session-status-machine.ts'))};`,
 `import {formatErrorMessage} from ${JSON.stringify(path.join(root,'apps/cli/src/utils/format-error.ts'))};`,
 'export class RecoverySubject { constructor(deps){this.deps=deps;this.watchedSessions=new Map();this.rpcTurnStash=new Map();this.turnSourceHints=new Map();}',
 span(watcher,'  private async markMissingUserTurnRecovery(','\n  /**'),
 span(watcher,'  private peekStashedRpcTurn(','\n  /**'),
 '}'
].join('\n');
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'lody-inbox-decisions-'));const outfile=path.join(scratch,'subject.mjs');
await build({stdin:{contents,resolveDir:root,loader:'ts'},outfile,bundle:true,format:'esm',platform:'node',packages:'external',logLevel:'silent'});
const m=await import(pathToFileURL(outfile).href);
const meta={id:'s',machineId:'machine',status:{type:'idle'}};
// Both replicas may deliver the metadata marker and control request in either
// order. Mismatched request identities must not cancel the currently running turn.
let cancelCases=0;
for(const marker of [undefined,'cancel-request:c1','cancel-request:c2','legacy-turn'])
 for(const request of [undefined,{id:'c1',turnId:'A'},{id:'c2',turnId:'B'}])
  for(const seen of [undefined,marker]){
   const action=m.resolveSessionCancelAction({...meta,lastCanceledTurn:marker},seen,'machine',request);
   const matching=marker&&marker!==seen&&(marker==='legacy-turn'||marker===`cancel-request:${request?.id}`);
   assert.equal(action.type,matching?'cancel':'noop','CancelRequestIdentity: mismatched control payload must not cancel');
   if(action.type==='cancel'&&marker!=='legacy-turn')assert.equal(action.turnId,request.turnId);
   cancelCases++;
  }
// Three independent documents/channels: metadata, user payload, receipt. We
// check only pure dispatch eligibility here, not the external signer/lease gate.
let payloadOrders=0;
function* permutations(items){if(!items.length){yield [];return;}for(const item of items)for(const tail of permutations(items.filter(x=>x!==item)))yield[item,...tail];}
for(const status of ['prepared','pending','handled','canceled','delivery_unknown'])
 for(const order of permutations(['activation','payload','receipt'])){
  let current={...meta},history=[],receipt=false;
  for(const event of order){
   if(event==='activation')current.latestUserMsgId='A';
   if(event==='payload')history=[{id:'A',role:'user',status,items:[]}];
   if(event==='receipt')receipt=true;
   const candidate=m.findNextDispatchableUserTurn(history,current);
   if(!history.length||['handled','canceled','delivery_unknown'].includes(status))assert.equal(candidate,null);
   if(status==='prepared'&&!current.latestUserMsgId)assert.equal(candidate,null);
   // Receipt is intentionally not an argument of this helper. A candidate
   // is NOT an execution grant; source/native admission must still validate it.
   void receipt;
  }
  payloadOrders++;
 }
// Replay both missing-history timeout writes through the actual recovery
// method, using synthetic workspace/document ports. No handwritten recovery
// transition or dispatch predicate is used.
let stored={...meta,latestUserMsgId:'A'};const failed=[];
const subject=new m.RecoverySubject({machineId:'machine',logger:{debug(){},warn(){},info(){}},workspaceDocument:{repo:{getDocMeta:async()=>({meta:{...stored}}),upsertDocMeta:async(_id,patch)=>{stored={...stored,...patch};}},cleanSessionDoc:async()=>{}},executionService:{acknowledgeSteerTurn:async()=>{}},recordChatFailure:async()=>{failed.push(stored.lastMissingHistoryUserMsgId);}});
await subject.markMissingUserTurnRecovery('s',{},stored);
assert.equal(stored.lastMissingHistoryUserMsgId,'A');
const late={id:'A',role:'user',status:'pending',items:[]};
assert.equal(m.findNextDispatchableUserTurn([late],stored),null);
stored={...stored,latestUserMsgId:'B'};
await subject.markMissingUserTurnRecovery('s',{},stored);
assert.deepEqual(failed,['A','B']);assert.equal(stored.lastMissingHistoryUserMsgId,'B');
const revived=m.findNextDispatchableUserTurn([late],stored);
subject.rpcTurnStash.set('s',new Map([['A',{entry:late,expiresAtMs:Number.POSITIVE_INFINITY}]]));
const revivedRpc=subject.peekStashedRpcTurn('s',stored,[]);
assert.equal(revived,null,'NoFailedReplay: late history must remain retired');
assert.equal(revivedRpc,null,'NoFailedReplay: late RPC must remain retired');
stored={...stored,lastMissingHistoryUserMsgId:undefined,latestUserMsgId:'fresh'};
assert.equal(m.findNextDispatchableUserTurn([late],stored),null,'NoFailedReplay: clearing a legacy scalar must not clear per-ID acknowledgement');
assert.equal(m.getPendingUserTurnActivationId({...stored,latestUserMsgId:'A'}),undefined);
const fresh={...late,id:'fresh'};assert.equal(m.findNextDispatchableUserTurn([late,fresh],stored)?.id,'fresh');
const staleSnapshot={...stored,latestUserMsgId:'old-wait'};
stored={...stored,latestUserMsgId:'new-arrival'};
const beforeFailureCount=failed.length;
await subject.markMissingUserTurnRecovery('s',{},staleSnapshot);
assert.equal(failed.length,beforeFailureCount,'Stale timeout must not accuse a newer activation');
assert.equal(stored.missingHistoryUserMsgIds?.['new-arrival'],undefined);
const result={cancelDecisions:{result:'PASS',cases:cancelCases},payloadArrivalOrders:{result:'PASS',cases:payloadOrders},negativeAck:{result:revived?'FAIL':'PASS',property:'NoFailedReplay',boundary:'actual recovery and candidate selection; fresh-ID continuation and legacy-marker removal',failedInputs:failed,lateCandidate:revived?.id??null,lateRpcCandidate:revivedRpc?.id??null,executionProven:false},limits:'Unchanged source declaration spans are compiled with actual helper bodies. Synthetic workspace and session ports replace document I/O. Full watcher lifecycle, authorization, durable Inbox acceptance, actual Agent execution and UI are not executed. This checks recovery/selection and later fresh input, not full Agent execution or device acceptance.'};
console.log(JSON.stringify(result,null,2));process.exitCode=revived?1:0;
