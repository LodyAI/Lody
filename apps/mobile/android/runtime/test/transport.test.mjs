import test from 'node:test';
import assert from 'node:assert/strict';
import {createSender} from '../src/transport.mjs';
test('large Unicode payloads cross the bridge in bounded ordered frames',()=>{
 const frames=[];const message={type:'reply',id:'a',value:'中文😀'.repeat(180000)};
 createSender(s=>frames.push(JSON.parse(s)))(message);
 assert.ok(frames.length>1);
 assert.ok(frames.every((f,i)=>f.type==='bridgeChunk' && f.index===i && f.data.length<=16384));
 assert.deepEqual(JSON.parse(frames.map(f=>f.data).join('')),message);
});
test('oversize payload is rejected before any partial transmission',()=>{
 const frames=[];createSender(s=>frames.push(JSON.parse(s)))({value:'中'.repeat(3*1024*1024)});
 assert.deepEqual(frames,[{type:'bridgeError',code:'message_too_large'}]);
});
