import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommands} from '../src/create-commands.mjs';
const input={sessionId:'11111111-1111-4111-8111-111111111111',turnId:'22222222-2222-4222-8222-222222222222',machineId:'m',agentConfigId:'a',text:'hello'};
function fixture(state='created') {
 const calls=[];const runtime={creationOptions:()=>({agents:[{id:'a',machineId:'m',cliType:'builtin',agentType:'codex'}],capabilities:[]}),createSession:async a=>{calls.push(['create',a]);return {state}},ensureSession:async()=>calls.push(['ensure'])};
 const c=createCommands(runtime,async a=>{calls.push(['send',a]);return {state:'accepted'}},()=>({workspaceId:'w',userId:'u'}));return {c,calls};
}
test('creation persists before first turn and supplies native identity',async()=>{const {c,calls}=fixture();assert.equal((await c.createAndSend(input)).state,'accepted');assert.deepEqual(calls.map(x=>x[0]),['create','ensure','send']);assert.equal(calls[0][1].userId,'u');assert.equal(calls[2][1].id,input.turnId);});
test('unknown creation is never sent or replayed',async()=>{const {c,calls}=fixture('unknown');assert.equal((await c.createAndSend(input)).state,'unknown');await assert.rejects(c.createAndSend(input),/already_attempted/);assert.equal(calls.length,1);});
test('invalid selection is rejected before any writes',async()=>{const {c,calls}=fixture();assert.equal((await c.createAndSend({...input,agentConfigId:'wrong'})).state,'rejected');assert.equal(calls.length,0);});
test('cancellation after creation never advances to sending',async()=>{const {c,calls}=fixture();const ctl=new AbortController();ctl.abort();await assert.rejects(c.createAndSend(input,ctl.signal));assert.equal(calls.length,0);});
test('a lost send acknowledgement is reported without replay',async()=>{
 const calls=[];const runtime={creationOptions:()=>({agents:[{id:'a',machineId:'m',cliType:'builtin',agentType:'codex'}],capabilities:[]}),createSession:async()=>({state:'created'}),ensureSession:async()=>true};
 const c=createCommands(runtime,async()=>{calls.push('send');throw Error('lost')},()=>({workspaceId:'w',userId:'u'}));
 assert.equal((await c.createAndSend(input)).state,'unknown');await assert.rejects(c.createAndSend(input),/already_attempted/);assert.equal(calls.length,1);
});
test('only advertised models can be sent',async()=>{const {c,calls}=fixture();assert.equal((await c.createAndSend({...input,modelId:'invented'})).state,'rejected');assert.equal(calls.length,0);});
test('the local project reference carries an explicit worktree choice',async()=>{
 const {build}=await import('esbuild'); const {Flock}=await import('@loro-dev/flock-wasm/base64');
 const bundle=await build({stdin:{contents:"export { createSession } from './create-session.ts'",resolveDir:new URL('../vendor/cloud-runtime/src/runtime/',import.meta.url).pathname,loader:'ts'},bundle:true,format:'esm',platform:'browser',write:false,
  plugins:[{name:'stream-fixture',setup(b){b.onResolve({filter:/^@loro-dev\/streams-client$/},()=>({path:'mock',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export class StreamsClient { async create(){return {ok:true,result:{}}} }'}));}}]});
 const {createSession}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
 const flock=new Flock('android-create-fixture');const replica={flock,client:{append:async()=>({ok:true,result:{}})}};
 for(const worktree of [false,true]) {
  const sessionId=crypto.randomUUID();
  const result=await createSession({workspaceId:'w',sessionId,machineId:'m',agentConfigId:'a',userId:'u',title:'hello',projectId:'m:local:p',useWorktree:worktree},{agents:[{id:'a',machineId:'m',cliType:'builtin',agentType:'codex'}],project:{id:'m:local:p'}},replica,async()=>({token:'synthetic',gatewayBaseUrl:'https://example.invalid'}));
  assert.equal(result.state,'created');assert.equal(flock.get(['m',`session-${sessionId}`]).project.useWorktree===true,worktree);
 }
});
test('models from another provider of the same type cannot be used',async()=>{
 const runtime={creationOptions:()=>({agents:[{id:'a',machineId:'m',cliType:'builtin',agentType:'codex'}],capabilities:[{machineId:'m',agentConfigId:'other',cliType:'builtin',agentType:'codex',models:[{id:'other-model'}]}]})};
 const c=createCommands(runtime,()=>{},()=>({workspaceId:'w',userId:'u'}));assert.equal((await c.createAndSend({...input,modelId:'other-model'})).state,'rejected');
});
test('runtime projection preserves capabilities for providers of one agent type',async()=>{
 const {readFile}=await import('node:fs/promises'),{transform}=await import('esbuild'),vm=await import('node:vm');
 const source=(await readFile(new URL('../vendor/cloud-runtime/src/runtime/create-session.ts',import.meta.url),'utf8'));
 const code=(await transform(source.slice(source.indexOf('function metadataAgents('),source.indexOf('const attempted =')).replace('export function','function'),{loader:'ts'})).code;
 const context={crypto,projectRows:()=>({projects:[]}),isThoughtLevel:()=>false,validConfigValue:()=>false};vm.runInNewContext(code+';globalThis.options=creationOptions',context);
 const rows=['a','b'].map(id=>({key:['acpCapability',id],value:{cliType:'builtin',agentType:'codex',models:[{modelId:id,name:id}],fetchedAt:1}}));
 const result=context.options(undefined,{scan:()=>[]},new Map([['m',{scan:()=>rows,get:()=>undefined}]]));assert.equal(result.capabilities.length,2);assert.equal(result.capabilities[0].agentConfigId,'a');assert.equal(result.capabilities[1].models[0].id,'b');
});

test('legacy capability keys preserve all builtin agent types',async()=>{
 const {readFile}=await import('node:fs/promises'),{transform}=await import('esbuild'),vm=await import('node:vm');
 const source=(await readFile(new URL('../vendor/cloud-runtime/src/runtime/create-session.ts',import.meta.url),'utf8'));
 const code=(await transform(source.slice(source.indexOf('function metadataAgents('),source.indexOf('const attempted =')).replace('export function','function'),{loader:'ts'})).code;
 const context={crypto,projectRows:()=>({projects:[]}),isThoughtLevel:()=>false,validConfigValue:()=>false};vm.runInNewContext(code+';globalThis.options=creationOptions',context);
 const rows=['grok','codex'].map(id=>({key:['acpCapability','builtin',id],value:{cliType:'builtin',agentType:id,models:[{modelId:id,name:id}],fetchedAt:1}}));
 const result=context.options(undefined,{scan:()=>[]},new Map([['m',{scan:()=>rows,get:()=>undefined}]]));assert.equal(result.capabilities.length,2);assert.equal(result.capabilities[0].agentConfigId,undefined);assert.equal(result.capabilities[0].agentType,'grok');assert.equal(result.capabilities[1].models[0].id,'codex');
});

test('thought-level choices validate and send without a per-model catalog',async()=>{
 let sent;
 const capability={machineId:'m',agentConfigId:'a',models:[],reasoningEfforts:{},configOptions:[{id:'thinking',type:'select',category:'thought_level',options:[{id:'high'}]}],reasoningEffortConfigId:'thinking'};
 const runtime={creationOptions:()=>({agents:[{id:'a',machineId:'m'}],capabilities:[capability]}),createSession:async()=>({state:'created'}),ensureSession:async()=>{}};
 const commands=createCommands(runtime,async value=>{sent=value;return {state:'accepted'}},()=>({userId:'u',workspaceId:'w'}));
 assert.equal((await commands.createAndSend({...input,effort:'invented'})).state,'rejected');
 assert.equal((await commands.createAndSend({...input,effort:'high'})).state,'accepted');
 assert.equal(sent.reasoningEffort,'high');assert.equal(sent.reasoningEffortConfigId,'thinking');
});
test('a conversation turn carries only the explicit run-config choice',async()=>{
 const {c,calls}=fixture();const turn={sessionId:'s1',turnId:input.turnId,text:'hi',machineId:'m',cliType:'builtin',agentType:'codex'};
 assert.equal((await c.sendText({...turn,modelId:'gpt',effort:'high',reasoningEffortConfigId:'reasoning_effort',modeId:null})).state,'accepted');
 const sent=calls.find(x=>x[0]==='send')[1];
 assert.equal(sent.modelId,'gpt');assert.equal(sent.reasoningEffort,'high');assert.equal(sent.reasoningEffortConfigId,'reasoning_effort');assert.equal('modeId' in sent,false);
 await c.sendText({...turn,modelId:null,effort:null});const cleared=calls.filter(x=>x[0]==='send').at(-1)[1];assert.equal(cleared.modelId,null);assert.equal(cleared.reasoningEffort,null);
 const image={type:'image',imageId:'i1',mimeType:'image/png',sizeBytes:3};
 await c.sendText({...turn,text:'',attachments:[image]});assert.deepEqual(calls.filter(x=>x[0]==='send').at(-1)[1].attachmentBlocks,[image]);
 await assert.rejects(c.sendText({...turn,text:' '}),/invalid_send/);
 await assert.rejects(c.sendText({...turn,attachments:[{type:'video'}]}),/invalid_send/);
 await c.sendText(turn);assert.equal('modelId' in calls.filter(x=>x[0]==='send').at(-1)[1],false);
 await assert.rejects(c.sendText({...turn,modelId:7}),/invalid_send/);
});
test('a new chat can start as an Agent Role bound to the chosen agent, with provenance and the first turn Role',async()=>{
 const calls=[];
 const reviewer={id:'reviewer',revision:4,targets:[{machineId:'m',agentConfigId:'a',state:'configured'}]};
 const runtime={creationOptions:()=>({agents:[{id:'a',machineId:'m',cliType:'builtin',agentType:'codex'}],capabilities:[]}),agentRoles:async args=>{calls.push(['roles',args]);return {roles:[reviewer,{id:'elsewhere',revision:1,targets:[{machineId:'m',agentConfigId:'other',state:'configured'}]}]}},createSession:async a=>{calls.push(['create',a]);return {state:'created'}},ensureSession:async()=>calls.push(['ensure'])};
 const c=createCommands(runtime,async a=>{calls.push(['send',a]);return {state:'accepted'}},()=>({workspaceId:'w',userId:'u'}));
 assert.deepEqual((await c.agentRoles()).roles.map(r=>r.id),['reviewer','elsewhere']);
 assert.equal((await c.createAndSend({...input,agentRoleId:'reviewer',configOptionValues:{plan_mode:true}})).state,'accepted');
 const create=calls.find(x=>x[0]==='create')[1], send=calls.find(x=>x[0]==='send')[1];
 assert.equal(create.agentRoleId,'reviewer');assert.equal(create.agentRoleRevision,4);
 assert.equal(send.agentRoleId,'reviewer');assert.equal(send.agentConfigId,'a');assert.deepEqual(send.configOptionValues,{plan_mode:true});
 const other={...input,sessionId:'33333333-3333-4333-8333-333333333333',agentRoleId:'elsewhere'};
 assert.equal((await c.createAndSend(other)).state,'rejected','a Role bound to another agent is refused before any write');
 assert.equal(calls.filter(x=>x[0]==='create').length,1);
 await assert.rejects(c.createAndSend({...other,agentRoleId:undefined,configOptionValues:{x:{}}}),/invalid_creation/);
});
// Web's session composer: any turn may run as a Role bound to the conversation's own agent
// config, an explicit None (null) ends it, and omitting it inherits the latest turn's.
test('a conversation turn carries its Role, an explicit None, or nothing to inherit',async()=>{
 const {c,calls}=fixture();const turn={sessionId:'s1',turnId:input.turnId,text:'hi',machineId:'m',cliType:'builtin',agentType:'codex'};
 const last=()=>calls.filter(x=>x[0]==='send').at(-1)[1];
 await c.sendText({...turn,agentRoleId:'reviewer',agentConfigId:'a'});
 assert.equal(last().agentRoleId,'reviewer');assert.equal(last().agentConfigId,'a');
 await c.sendText({...turn,agentRoleId:null});
 assert.equal('agentRoleId' in last(),true);assert.equal(last().agentRoleId,null);
 await c.sendText(turn);assert.equal('agentRoleId' in last(),false);
 const before=calls.length;
 await assert.rejects(c.sendText({...turn,agentRoleId:'reviewer'}),/invalid_send/,'a Role needs the session agent config');
 await assert.rejects(c.sendText({...turn,agentRoleId:''}),/invalid_send/);
 assert.equal(calls.length,before,'refusals write nothing');
});
test('a conversation turn carries the agent switches it changed (Plan, Fast)',async()=>{
 const {c,calls}=fixture();const turn={sessionId:'s1',turnId:input.turnId,text:'hi',machineId:'m',cliType:'builtin',agentType:'codex'};
 await c.sendText({...turn,configOptionValues:{plan_mode:true,collaboration_mode:'plan'}});
 assert.deepEqual(calls.filter(x=>x[0]==='send').at(-1)[1].configOptionValues,{plan_mode:true,collaboration_mode:'plan'});
 await assert.rejects(c.sendText({...turn,configOptionValues:{api_token:'x'}}),/invalid_send/);
 await assert.rejects(c.sendText({...turn,configOptionValues:{fast:7}}),/invalid_send/);
 await assert.rejects(c.sendText({...turn,configOptionValues:['x']}),/invalid_send/);
});

test('attachment-only creation forwards uploads to the first turn',async()=>{const {c,calls}=fixture();const attachments=[{type:'image',imageId:'image-1',mimeType:'image/png',sizeBytes:10}];assert.equal((await c.createAndSend({...input,text:'',attachments})).state,'accepted');assert.deepEqual(calls.at(-1)[1].attachmentBlocks,attachments);});
test('invalid attachments reject creation before writes',async()=>{const {c,calls}=fixture();await assert.rejects(c.createAndSend({...input,attachments:[{type:'video'}]}),/invalid_creation/);assert.equal(calls.length,0);});

test('creation the runtime refused unread is rejected; an unanswered write stays unknown and is never replayed',async()=>{
 for(const [code,state] of [['invalid_params','rejected'],['unsupported_method','rejected'],['runtime_timeout','unknown'],['invalid_result','unknown']]) {
  const calls=[];
  const runtime={creationOptions:()=>({agents:[{id:'a',machineId:'m',cliType:'builtin',agentType:'codex'}],capabilities:[]}),createSession:async()=>{calls.push('create');throw Error(code)},ensureSession:async()=>calls.push('ensure')};
  const c=createCommands(runtime,async()=>{calls.push('send');return {state:'accepted'}},()=>({workspaceId:'w',userId:'u'}));
  assert.equal((await c.createAndSend(input)).state,state,code);
  await assert.rejects(c.createAndSend(input),/already_attempted/);
  assert.deepEqual(calls,['create'],code);
 }
});
test('a failed read of the creation options is rejected before any write',async()=>{
 const calls=[];
 const runtime={creationOptions:async()=>{throw Error('runtime_timeout')},createSession:async()=>calls.push('create')};
 const c=createCommands(runtime,async()=>calls.push('send'),()=>({workspaceId:'w',userId:'u'}));
 assert.equal((await c.createAndSend(input)).state,'rejected');assert.deepEqual(calls,[]);
 const disconnected=createCommands(runtime,async()=>calls.push('send'),()=>undefined);
 assert.equal((await disconnected.createAndSend(input)).state,'rejected');assert.deepEqual(calls,[]);
});
