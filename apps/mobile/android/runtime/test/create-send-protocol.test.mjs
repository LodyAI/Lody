import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {transform} from 'esbuild';
import {LoroDoc,LoroMap,LoroList,LoroText} from 'loro-crdt';
const source=await readFile(new URL('../vendor/cloud-runtime/src/runtime/session.ts',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('export function appendUserTurn('),source.indexOf('export function checkTurnQuota('))+source.slice(source.indexOf('export async function sendTurn('),source.indexOf('export async function controlTurn('));
const code=(await transform(functions.replaceAll('export ',''),{loader:'ts'})).code;
async function send(failAt) {
 const doc=new LoroDoc(),calls=[];let rpc;
 const state={id:'s',workspace:'w',ready:true,doc,controller:new AbortController(),getGrant:()=>{},client:{append:async()=>{calls.push('history');if(failAt==='history')throw Error('lost');return {ok:true}}},markDispatch:async()=>calls.push('dispatch-pointer')};
 const context={LoroDoc,LoroMap,LoroList,LoroText,crypto,Date,TextDecoder,AbortSignal,sessions:new Map([['s',state]]),reserved:new Set(),checkTurnQuota:()=>({state:'allowed'}),encodeFrame:x=>x,scheduleEmit(){},clientFor:async id=>id.includes(':rpc:res:')?{create:async()=>{calls.push('reply-stream');return {ok:true}},readOnce:async()=>({ok:true,result:{nextOffset:'1',payload:{body:new TextEncoder().encode(JSON.stringify({id:rpc.id,result:{accepted:true}}))}}})}:{append:async({part})=>{calls.push('rpc');rpc=JSON.parse(part.body);if(failAt==='rpc')throw Error('lost');return {ok:true}}}};
 vm.runInNewContext(code+';globalThis.send=sendTurn',context);
 const args={id:'22222222-2222-4222-8222-222222222222',sessionId:'s',machineId:'m',userId:'u',text:'hello',cliType:'builtin',agentType:'codex',modelId:'model'};
 const result=await context.send(args),second=await context.send(args);const history=doc.toJSON().history;doc.free();return {result,second,calls,history,rpc};
}
test('real Loro history is durable before dispatch pointer and Machine RPC',async()=>{const {result,second,calls,history,rpc}=await send();assert.equal(result.state,'accepted');assert.equal(second.state,'unknown');assert.deepEqual(calls,['history','dispatch-pointer','reply-stream','rpc']);assert.equal(history[0].items[0].text,'hello');assert.equal(history[0].inputConfig.modelId,'model');assert.equal(rpc.method,'session/dispatch-turn');});
test('lost append ACK never dispatches or replays history',async()=>{const {result,second,calls}=await send('history');assert.equal(result.state,'unknown');assert.equal(second.state,'unknown');assert.deepEqual(calls,['history']);});
test('lost Machine RPC ACK retains uploaded history without replay',async()=>{const {result,second,calls}=await send('rpc');assert.equal(result.state,'uploaded');assert.equal(second.state,'unknown');assert.equal(calls.filter(x=>x==='rpc').length,1);});
