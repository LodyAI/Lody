import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudCommands} from '../src/cloud-commands.mjs';
test('read probe never enables presence or supplies identity for implicit Machine RPC',()=>{
 const calls=[];const runtime={start:(...args)=>calls.push(args),grant(){},setActive:value=>calls.push(value)};
 const access={configure(){},setActive(){}};
 const commands=cloudCommands(runtime,access);
 commands.connect('workspace','https://streams.example.org');
 assert.deepEqual(calls,[['workspace',undefined,false]]);
 assert.throws(()=>commands.connect('other','https://streams.example.org'),/already_connected/);
 assert.equal(commands.sendTurn,undefined);
});
test('session subscription validates ids and closes only the matching selection',async()=>{
 const calls=[];
 const commands=cloudCommands({start(){},session:id=>{calls.push(id);return 'watching';}}, {configure(){}},()=>calls.push('stop'));
 assert.throws(()=>commands.watchSession('s'),/not_connected/);
 commands.connect('workspace','https://streams.example.org');
 assert.throws(()=>commands.watchSession('../other'),/invalid_session/);
 await commands.watchSession('s1');await commands.watchSession('s2');
 commands.closeSession('s1');
 assert.deepEqual(calls,['stop','s1','stop','s2']);
 commands.closeSession('s2');assert.equal(calls.at(-1),'stop');
 assert.equal(commands.sendTurn,undefined);
});
test('native verified identity enables presence and rejects malformed identities',()=>{
 const calls=[];const c=cloudCommands({start:(...args)=>calls.push(args)}, {configure(){}});
 assert.throws(()=>c.connect('workspace','https://streams.example.org',{}),/invalid_identity/);
 c.connect('workspace','https://streams.example.org','user');assert.deepEqual(calls,[['workspace','user',true]]);
});
