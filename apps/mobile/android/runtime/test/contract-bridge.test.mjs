import test from 'node:test';
import assert from 'node:assert/strict';
import {contractBridge} from '../src/contract-bridge.mjs';

test('contract bridge translates requests, events and native grant replies',async()=>{
 const sent=[], events=[];
 const runtime={receive(text){const e=JSON.parse(text);sent.push(e);if(e.kind==='request')globalThis.androidRuntimeMessage({type:'envelope',envelope:JSON.stringify({...e,kind:'result',payload:{}})});}};
 const bridge=contractBridge(runtime,e=>events.push(e));
 assert.equal(await bridge.ping(),true);
 await bridge.start('workspace','user',true);
 assert.deepEqual(sent.find(e=>e.method==='start').payload,{workspaceId:'workspace',userId:'user',active:true});
 await bridge.loadOlderSession({sessionId:'s'});
 assert.deepEqual(sent.find(e=>e.method==='loadOlderSession').payload,{sessionId:'s'});
 await bridge.retryPendingInput({sessionId:'s',inputId:'i'});
 assert.deepEqual(sent.find(e=>e.method==='retryPendingInput').payload,{sessionId:'s',inputId:'i'});
 await bridge.forgetPendingInput({sessionId:'s',inputId:'i'});
 assert.deepEqual(sent.find(e=>e.method==='forgetPendingInput').payload,{sessionId:'s',inputId:'i'});
 const event={v:1,gen:1,kind:'event',method:'session',payload:{sessionId:'s',session:'{}',synced:true}};
 globalThis.androidRuntimeMessage({type:'envelope',envelope:JSON.stringify(event)});
 assert.equal(events.at(-1).sessionId,'s');
 globalThis.androidRuntimeMessage({type:'envelope',envelope:JSON.stringify({...event,gen:0})});
 assert.equal(events.length,1);
 const request={v:1,gen:1,kind:'request',id:'grant-1',method:'grant',payload:{}};
 globalThis.androidRuntimeMessage({type:'envelope',envelope:JSON.stringify(request)});
 assert.equal(events.at(-1).type,'grant');
 bridge.grant({token:'test-only',gatewayBaseUrl:'https://example.test',expiresIn:60});
 assert.equal(sent.at(-1).id,'grant-1');assert.equal(sent.at(-1).kind,'result');
 delete globalThis.androidRuntimeMessage;
});

import {providerCommands} from '../src/provider-commands.mjs';
test('provider adapter uses verified scope and retains auth-required refresh results',async()=>{
 const adapter=providerCommands({async agentProviders(input){assert.equal(input.workspaceId,'workspace');assert.equal(input.userId,'user');return {machines:[],providers:[],setups:[],catalog:[],authRequired:true};}},()=>({workspaceId:'workspace',userId:'user'}));
 assert.equal((await adapter.agentProviders({action:'refresh',workspaceId:'foreign',userId:'other',base:{id:'provider'}})).authRequired,true);
 const offline=providerCommands({agentProviders(){throw Error('must not run')}},()=>null);
 assert.deepEqual(await offline.agentProviders({action:'list'}),{error:'not_connected'});
});
test('provider failure hides private diagnostics and does not retry an uncertain write',async()=>{
 let applied=false;
 const adapter=providerCommands({async agentProviders(){assert.equal(applied,false);applied=true;throw Error('private backend diagnostic');}},()=>({workspaceId:'workspace',userId:'user'}));
 assert.deepEqual(await adapter.agentProviders({action:'delete',base:{id:'provider'}}),{error:'provider_write_unknown'});
 assert.equal(applied,true);
});
test('provider detail and interactive auth use native scope and redact failures', async()=>{
 const adapter=providerCommands({
  async agentProviderDetail(input){ assert.equal(input.workspaceId,'workspace');assert.equal(input.userId,'user');return {env:[{key:'EXAMPLE_TOKEN',hasValue:true}],revision:'opaque'}; },
  async agentProviderAuth(input){ assert.equal(input.workspaceId,'workspace');assert.equal(input.userId,'user');assert.equal(input.values.key,'synthetic');throw Error('credential diagnostic'); }
 },()=>({workspaceId:'workspace',userId:'user'}));
 assert.deepEqual((await adapter.agentProviderDetail({machineId:'machine',id:'provider',workspaceId:'other'})).env,[{key:'EXAMPLE_TOKEN',hasValue:true}]);
 assert.deepEqual(await adapter.agentProviderAuth({action:'submit',values:{key:'synthetic'},userId:'other'}),{error:'provider_write_unknown'});
});
import {roleCommands} from '../src/role-commands.mjs';
test('role settings use the verified scope, keep known refusals and report other write failures as unknown',async()=>{
 let writes=0;
 const adapter=roleCommands({async agentRoles(input){
  assert.equal(input.workspaceId,'workspace');assert.equal(input.userId,'user');
  if(input.action==='list')return {roles:[],agents:[]};
  writes++;
  throw Error(input.action==='delete'?'role_read_only':'private backend diagnostic');
 }},()=>({workspaceId:'workspace',userId:'user'}));
 assert.deepEqual(await adapter.agentRoleSettings({action:'list',workspaceId:'foreign',userId:'other'}),{roles:[],agents:[]});
 assert.deepEqual(await adapter.agentRoleSettings({action:'delete',base:{id:'r'}}),{error:'role_read_only'});
 assert.deepEqual(await adapter.agentRoleSettings({action:'save',id:'r',base:null,fields:{}}),{error:'role_write_unknown'});
 assert.equal(writes,2);
 assert.deepEqual(await adapter.agentRoleSettings({action:'drop'}),{error:'role_invalid'});
 const offline=roleCommands({agentRoles(){throw Error('must not run')}},()=>null);
 assert.deepEqual(await offline.agentRoleSettings({action:'list'}),{error:'not_connected'});
});
test('shortcutCloud host calls go to native once, only for this workspace and allow-listed operations',async()=>{
 const sent=[], events=[];
 const runtime={receive(text){const e=JSON.parse(text);sent.push(e);if(e.kind==='request')globalThis.androidRuntimeMessage({type:'envelope',envelope:JSON.stringify({...e,kind:'result',payload:{}})});}};
 const bridge=contractBridge(runtime,e=>events.push(e));
 await bridge.start('workspace','user',true);
 const ask=(id,payload)=>globalThis.androidRuntimeMessage({type:'envelope',envelope:JSON.stringify({v:1,gen:1,kind:'request',id,method:'shortcutCloud',payload})});
 ask('c1',{workspaceId:'workspace',operation:'listAccessibleDocuments',args:{}});
 assert.deepEqual(events.at(-1),{type:'shortcutCloud',requestId:'c1',operation:'listAccessibleDocuments',args:'{}'});
 assert.equal(bridge.shortcutCloud('c1',{value:[]}),true);
 assert.deepEqual([sent.at(-1).kind,sent.at(-1).payload],['result',{value:[]}]);
 assert.equal(bridge.shortcutCloud('c1',{value:[]}),false);
 ask('c2',{workspaceId:'workspace',operation:'activateDocument',args:{}});
 bridge.shortcutCloud('c2',null);
 assert.deepEqual([sent.at(-1).kind,sent.at(-1).error.code],['error','shortcut_unavailable']);
 const before=events.length;
 ask('c3',{workspaceId:'other',operation:'listAccessibleDocuments',args:{}});
 ask('c4',{workspaceId:'workspace',operation:'deleteEverything',args:{}});
 assert.equal(events.length,before);
 assert.deepEqual(sent.slice(-2).map(e=>[e.id,e.kind]),[['c3','error'],['c4','error']]);
 delete globalThis.androidRuntimeMessage;
});
import {shortcutCommands} from '../src/shortcut-commands.mjs';
test('shortcut settings use the verified scope and report an uncertain save as unknown',async()=>{
 const adapter=shortcutCommands({async promptShortcuts(input){
  assert.equal(input.workspaceId,'workspace');assert.equal(input.userId,'user');
  if(input.action==='list')return {action:'list',entries:[]};
  throw Error(input.action==='read'?'shortcut_changed':'private backend diagnostic');
 }},()=>({workspaceId:'workspace',userId:'user'}));
 assert.deepEqual(await adapter.shortcutSettings({action:'list',workspaceId:'foreign'}),{action:'list',entries:[]});
 assert.deepEqual(await adapter.shortcutSettings({action:'read',entry:{}}),{error:'shortcut_changed'});
 assert.deepEqual(await adapter.shortcutSettings({action:'save',value:{}}),{error:'shortcut_write_unknown'});
 assert.deepEqual(await adapter.shortcutSettings({action:'delete'}),{error:'invalid_shortcut'});
 assert.deepEqual(await shortcutCommands({},()=>null).shortcutSettings({action:'list'}),{error:'not_connected'});
});
test('browse files forwards listDir and readFile to the shared runtime unchanged',async()=>{
 const sent=[];
 const runtime={receive(text){const e=JSON.parse(text);sent.push(e);if(e.kind==='request')globalThis.androidRuntimeMessage({type:'envelope',envelope:JSON.stringify({...e,kind:'result',payload:e.method==='listDir'?{entries:[],truncated:false}:{status:'error',path:'a.md',code:'file_not_found'}})});}};
 const bridge=contractBridge(runtime,()=>{});
 await bridge.start('workspace','user',true);
 assert.deepEqual(await bridge.listDir({workspaceId:'workspace',sessionId:'s',relativePath:'docs',userId:'user'}),{entries:[],truncated:false});
 assert.deepEqual(sent.at(-1).payload,{workspaceId:'workspace',sessionId:'s',relativePath:'docs',userId:'user'});
 assert.equal((await bridge.readFile({sessionId:'s',path:'a.md'})).code,'file_not_found');
 assert.deepEqual([sent.at(-1).method,sent.at(-1).payload],['readFile',{sessionId:'s',path:'a.md'}]);
 delete globalThis.androidRuntimeMessage;
});
test('previewToken share requests go to native once, only for this workspace, and pass status refusals through',async()=>{
 const sent=[], events=[];
 const runtime={receive(text){const e=JSON.parse(text);sent.push(e);if(e.kind==='request')globalThis.androidRuntimeMessage({type:'envelope',envelope:JSON.stringify({...e,kind:'result',payload:{}})});}};
 const bridge=contractBridge(runtime,e=>events.push(e));
 await bridge.start('workspace','user',true);
 const intent=workspaceId=>({workspaceId,machineId:'m',sessionId:'s',runtimeNonce:'n',requestId:'r',operation:{action:'revoke'}});
 const ask=(id,workspaceId,operation='previewToken')=>globalThis.androidRuntimeMessage({type:'envelope',envelope:JSON.stringify({v:1,gen:1,kind:'request',id,method:'shareRequest',payload:{workspaceId:'workspace',operation,args:{intent:intent(workspaceId)}}})});
 ask('t1','workspace');
 assert.deepEqual(events.at(-1),{type:'previewToken',requestId:'t1',intent:JSON.stringify(intent('workspace'))});
 assert.equal(bridge.previewToken('t1',{value:'request-token'}),true);
 assert.deepEqual([sent.at(-1).id,sent.at(-1).kind,sent.at(-1).payload],['t1','result',{value:'request-token'}]);
 assert.equal(bridge.previewToken('t1',{value:'again'}),false);
 ask('t2','workspace');
 bridge.previewToken('t2',{value:{status:403,extra:'dropped'}});
 assert.deepEqual(sent.at(-1).payload,{value:{status:403}});
 ask('t3','workspace');
 bridge.previewToken('t3',null);
 assert.deepEqual([sent.at(-1).kind,sent.at(-1).error.code],['error','preview_token_unavailable']);
 const before=events.length;
 ask('t4','other');
 ask('t5','workspace','saveSecret');
 assert.equal(events.length,before);
 assert.deepEqual(sent.slice(-2).map(e=>[e.id,e.kind]),[['t4','error'],['t5','error']]);
 delete globalThis.androidRuntimeMessage;
});
test('preview controls forward to the shared runtime with their long deadlines',async()=>{
 const sent=[];
 const runtime={receive(text){const e=JSON.parse(text);sent.push(e);if(e.kind==='request')globalThis.androidRuntimeMessage({type:'envelope',envelope:JSON.stringify({...e,kind:'result',payload:e.method==='sessionPreview'?{url:'https://a-b.trycloudflare.com/?__lody_preview_token=t'}:{success:true,devices:[]}})});}};
 const bridge=contractBridge(runtime,()=>{});
 await bridge.start('workspace','user',true);
 assert.equal((await bridge.sessionPreview({sessionId:'s',userId:'user',action:'create'})).url,'https://a-b.trycloudflare.com/?__lody_preview_token=t');
 assert.deepEqual(await bridge.androidEmulatorControl({workspaceId:'workspace',sessionId:'s',userId:'user',command:{action:'list'}}),{success:true,devices:[]});
 assert.deepEqual([sent.at(-1).method,sent.at(-1).payload.command],['androidEmulatorControl',{action:'list'}]);
 await bridge.iosSimulatorControl({workspaceId:'workspace',sessionId:'s',userId:'user',command:{action:'status'}});
 assert.equal(sent.at(-1).method,'iosSimulatorControl');
 delete globalThis.androidRuntimeMessage;
});
