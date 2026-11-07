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
