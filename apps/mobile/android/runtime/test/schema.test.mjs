import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
async function module(relative) {
 const compiled=await build({entryPoints:[new URL(relative,import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
 return import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
}
const memory=await module('../vendor/cloud-runtime/src/protocol/memory.ts');
const shortcut=await module('../vendor/cloud-runtime/src/protocol/prompt-shortcuts/model.ts');
const share=await module('../vendor/cloud-runtime/src/runtime/sharing/session-share-package.ts');
test('oversized constrained remote collections fail before allocating per-item errors',()=>{
 const result=memory.memoryInventory.safeParse({type:'machine/memory',status:'ready',memories:Array(10001).fill(null)});
 assert.equal(result.success,false);
 assert.ok(result.error.issues.length<=2,'oversize input must fail before visiting every element');
});
test('shared schemas retain accepted identities and reject extra or malformed fields',()=>{
 const identity={machineId:'m',providerId:'p',memoryId:'id',name:'Memory'};
 assert.deepEqual(memory.memoryAssociation.parse(identity),identity);
 assert.equal(memory.memoryAssociation.safeParse({...identity,secret:'forbidden'}).success,false);
 assert.equal(shortcut.PromptShortcutTargetSchema.safeParse({kind:'agent_role',agentRoleId:'role'}).success,true);
 assert.equal(shortcut.PromptShortcutTargetSchema.safeParse({kind:'issue',repository:'owner/repo',number:-1}).success,false);
 const object={id:'object',mediaType:'text/plain',sizeBytes:0,sha256:'a'.repeat(64)};
 assert.deepEqual(share.ShareObjectSchema.parse(object),object);
 assert.equal(share.ShareObjectSchema.safeParse({...object,sizeBytes:-1}).success,false);
});
