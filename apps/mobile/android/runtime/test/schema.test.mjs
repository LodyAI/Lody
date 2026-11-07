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

const usage = await module('../vendor/cloud-runtime/src/protocol/session-usage.ts');
const agentUsage = await module('../vendor/cloud-runtime/src/protocol/agent-usage.ts');
const projection = await module('../vendor/cloud-runtime/src/runtime/project.ts');
test('session summary follows live context and latest compaction, never sums turn tokens', async () => {
 const {LoroDoc} = await import('loro-crdt/base64');
 const doc = new LoroDoc();
 doc.getMap('session').set('contextWindowUsage',{used:120,size:100});
 doc.getList('history').push({id:'a',role:'assistant',finished:false,tokenUsage:{input:9999},items:[{type:'tool_call',toolCallId:'compact',activityKind:'context_compaction',status:'in_progress'}]});
 let snapshot=JSON.parse(JSON.stringify(projection.projectSession(doc,'live')));
 assert.deepEqual(snapshot.usage.context,{used:120,size:100});
 assert.equal(snapshot.usage.isContextCompacting,true);
 doc.getList('history').push({id:'b',role:'assistant',finished:true,items:[{type:'tool_call',toolCallId:'done',activityKind:'context_compaction',status:'completed'}]});
 doc.getMap('session').set('contextWindowUsage',{used:0,size:100});
 snapshot=projection.projectSession(doc,'live');
 assert.deepEqual(snapshot.usage.context,{used:0,size:100});
 assert.equal(snapshot.usage.isContextCompacting,false);
 doc.getMap('session').delete('contextWindowUsage');
 assert.equal(projection.projectSession(doc,'live').usage.context,null);
});
test('provider quotas preserve config identity, capabilities, model tiers and expired reset values', () => {
 const config={id:'official',machineId:'m',cliType:'builtin',agentType:'codex',env:{LANG:'en'}};
 const quota=(percent,id='codex')=>({limitId:id,scope:{providerId:'codex'},windows:[{usedPercent:percent,windowDurationSeconds:18000,resetsAtEpochSeconds:1}]});
 const rows=[
  {key:['agentConfig','official'],value:config},
  {key:['acpCapability','official'],value:{rateLimits:{version:1}}},
  {key:['rateLimit','official','codex','codex'],value:quota(0)},
  {key:['rateLimit','other','codex','codex'],value:quota(99)},
  {key:['rateLimit','official','codex','codex_bengalfox'],value:quota(12,'codex_bengalfox')},
 ];
 const session={agentType:'codex',agentConfigId:'official'};
 let projected=agentUsage.projectAgentUsage(rows,'m');
 let selected=usage.sessionQuotaProjection(session,projected,'gpt-standard');
 assert.equal(selected.quotaEligible,true);
 assert.equal(selected.quota.windows[0].usedPercent,0);
 assert.equal(selected.quota.windows[0].resetsAt,1);
 assert.equal(usage.sessionQuotaProjection(session,projected,'gpt-spark').quota.id,'codex_bengalfox');
 assert.equal(usage.selectSessionQuota(projected.quotas.filter(q=>q.id!=='codex'),'codex','official','standard'),null);
 assert.equal(usage.selectSessionQuota(projected.quotas,'codex',null,'standard'),null);
 assert.equal(usage.sessionQuotaProjection(session,agentUsage.projectAgentUsage(rows.filter(r=>r.key[0]!=='acpCapability'),'m'),'standard').quota,null);
 for(const override of [{env:{OPENAI_API_KEY:'synthetic'}},{codexAuth:{mode:'api-key'}},{magpieGatewayUrl:'https://example.invalid'},{brandId:'custom'}]) {
  const restricted=agentUsage.projectAgentUsage([{key:['agentConfig','official'],value:{...config,...override}},...rows.slice(1)],'m');
  assert.equal(usage.sessionQuotaProjection(session,restricted,'standard').quota,null);
  assert.ok(!JSON.stringify(restricted).includes('synthetic'));
 }
 const legacy=agentUsage.legacyAgentQuotas({'provider::official::codex::codex':quota(65)});
 const merged=agentUsage.mergeAgentQuotas(legacy,projected.quotas);
 assert.equal(merged.filter(q=>q.id==='codex').length,2);
 assert.equal(usage.selectSessionQuota(merged,'codex','official','standard').windows[0].usedPercent,0);
});
