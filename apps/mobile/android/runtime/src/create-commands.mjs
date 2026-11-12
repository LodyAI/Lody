import { effortsFor } from '../vendor/cloud-runtime/src/protocol/capability.ts';
// Android-only text creation adapter. Shared CRDT persistence and dispatch remain upstream.
// The native host's workspace plan read (iOS `WorkspaceBilling`), or null when unavailable: the
// shared runtime then fails open, as the other clients do.
export function billingEntitlement(value) {
 return value && typeof value==='object' && ['free','plus','enterprise'].includes(value.effectivePlanTier) && typeof value.checkoutPending==='boolean'
  ? {effectivePlanTier:value.effectivePlanTier,checkoutPending:value.checkoutPending} : null;
}
export function createCommands(runtime, sendTurn, identity) {
 const attempted=new Set();
 const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
 function options(projectId, agentConfigId) {
  const scope=identity();if(!scope?.userId)throw Error('not_connected');
  return runtime.creationOptions({workspaceId:scope.workspaceId,...(projectId?{projectId}:{}),...(typeof agentConfigId==='string'?{agentConfigId}:{})});
 }
 async function roles() {
  const scope=identity();if(!scope?.userId)throw Error('not_connected');
  return (await runtime.agentRoles({action:'list',workspaceId:scope.workspaceId,userId:scope.userId})).roles;
 }
 return {
  creationOptions:options,
  // The workspace's Agent Roles (emoji, per-machine targets and what each pins); a read.
  agentRoles:async()=>({roles:await roles()}),
  // One mention category for the composer's @ panel (shared runtime `mentionCatalog`); a read.
  // The Projects tab's "Add local folder" (shared runtime `localProjects`): `machines`, `browse`
  // a computer's folders (home by default; `cursor` pages), `add` registers the folder as a
  // project (the computer derives its id from the path, so an existing project is returned),
  // `cancel` ends the browser's machine RPCs. Reads, except `add`, which is never retried.
  async localProjects(action,browserId,machineId,path,cursor) {
   const scope=identity();if(!scope?.userId)throw Error('not_connected');
   if(!['machines','browse','add','cancel'].includes(action) || typeof browserId!=='string' || !/^[A-Za-z0-9-]{1,200}$/.test(browserId))throw Error('invalid_request');
   const fields={};
   for(const [key,value] of [['machineId',machineId],['path',path],['cursor',cursor]]) {
    if(value===undefined || value===null)continue;
    if(typeof value!=='string' || !value || value.length>4096)throw Error('invalid_request');
    fields[key]=value;
   }
   return runtime.localProjects({workspaceId:scope.workspaceId,userId:scope.userId,browserId,action,...(action==='cancel' || action==='machines'?{}:fields)});
  },
  // The workspace's multi-repository projects (shared runtime `projectGroups`); a read.
  async projectGroups() {
   const scope=identity();if(!scope?.userId)throw Error('not_connected');
   return runtime.projectGroups({workspaceId:scope.workspaceId,userId:scope.userId});
  },
  // A prompt shortcut's body for the composer (web `prepareShortcutSelection`): the index entry
  // by id, then its body for that revision. Returns the prompt and its references; a read.
  async shortcutBody(id) {
   const scope=identity();if(!scope?.userId)throw Error('not_connected');
   if(typeof id!=='string' || !id || id.length>200)throw Error('invalid_request');
   const base={workspaceId:scope.workspaceId,userId:scope.userId};
   const list=await runtime.promptShortcuts({...base,action:'list'});
   const entry=(list?.entries??[]).find(item=>item.id===id);
   if(!entry)throw Error('shortcut_unavailable');
   const read=await runtime.promptShortcuts({...base,action:'read',entry});
   const shortcut=read?.shortcut;
   if(!shortcut || typeof shortcut.prompt!=='string')throw Error('shortcut_unavailable');
   return {prompt:shortcut.prompt,mentions:Array.isArray(shortcut.mentions)?shortcut.mentions:[]};
  },
  // `source` names what the references come from: a conversation, or the new-chat page's
  // project / computer / agent (iOS `MentionSource`); only non-empty strings cross.
  async mentionCatalog(category,source) {
   const scope=identity();if(!scope?.userId)throw Error('not_connected');
   if(!['file','skill','session','role','issue','pr','cmd'].includes(category))throw Error('invalid_category');
   const fields={};
   for(const key of ['sessionId','projectId','machineId','agentConfigId','cliType','agentType']) {
    const value=source?.[key];
    if(typeof value==='string' && value && value.length<=256)fields[key]=value;
   }
   return runtime.mentionCatalog({workspaceId:scope.workspaceId,userId:scope.userId,category,...fields});
  },
  // iOS `turnQuota`: whether the free-plan turn quota still admits a turn, checked before native
  // uploads attachments that a refused send would waste. A read; the send checks again.
  async turnQuota(sessionId,entitlement) {
   if(typeof sessionId!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId))throw Error('invalid_request');
   const result=await runtime.checkTurnQuota({sessionId,billingEntitlement:billingEntitlement(entitlement)});
   return {state:result?.state==='not_sent'?'not_sent':'allowed',...(result?.state==='not_sent'&&typeof result.reason==='string'?{reason:result.reason}:{})};
  },
  // A text turn in an existing conversation. The stable turn id lets upstream reject a
  // duplicate; nothing here retries, and an uncertain write reports `unknown`.
  async sendText(input,signal) {
   signal?.throwIfAborted();
   if(!input || !uuid.test(input.turnId) || typeof input.sessionId!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId) || typeof input.text!=='string' || input.text.length>32000)throw Error('invalid_send');
   // Attachments are server references uploaded natively; upstream validates each block.
   const attachments=input.attachments??[];
   if(!Array.isArray(attachments) || attachments.length>16 || attachments.some(block=>!block || typeof block!=='object' || !['image','file'].includes(block.type)) || JSON.stringify(attachments).length>64000)throw Error('invalid_send');
   if(!input.text.trim() && !attachments.length)throw Error('invalid_send');
   for(const key of ['machineId','cliType','agentType'])if(typeof input[key]!=='string' || !input[key])throw Error('invalid_send');
   // The composer's run-config choice: an omitted field keeps the session's previous one; a null
   // model or effort clears it to the agent default (upstream `sendTurn`).
   const choice={};
   for(const [key,field] of [['modelId','modelId'],['modeId','modeId'],['effort','reasoningEffort'],['reasoningEffortConfigId','reasoningEffortConfigId']]) {
    if(input[key]===undefined)continue;
    if(input[key]===null){if(key==='modelId' || key==='effort')choice[field]=null;continue;}
    if(typeof input[key]!=='string' || !input[key] || input[key].length>128)throw Error('invalid_send');
    choice[field]=input[key];
   }
   // The turn's Agent Role (web session composer): an id runs as that Role, bound to the
   // conversation's own agent config; null is an explicit None; absent inherits the latest turn's.
   if(input.agentRoleId!==undefined && input.agentRoleId!==null) {
    if(typeof input.agentRoleId!=='string' || !input.agentRoleId || input.agentRoleId.length>4096 || typeof input.agentConfigId!=='string' || !input.agentConfigId)throw Error('invalid_send');
    choice.agentRoleId=input.agentRoleId;choice.agentConfigId=input.agentConfigId;
   } else if(input.agentRoleId===null)choice.agentRoleId=null;
   // Agent switches the reader changed (Plan, Fast, permission selectors), as upstream validates them.
   if(input.configOptionValues!==undefined) {
    const values=input.configOptionValues;
    if(!values || typeof values!=='object' || Array.isArray(values) || Object.keys(values).length>64 || Object.entries(values).some(([id,value])=>!id || id.length>128 || /(?:api[_-]?key|auth|bearer|credential|password|passwd|secret|token)/i.test(id) || !(typeof value==='boolean' || (typeof value==='string' && value.length>0 && value.length<=512))))throw Error('invalid_send');
    choice.configOptionValues=values;
   }
   const scope=identity();if(!scope?.userId)throw Error('not_connected');
   try {
    await runtime.ensureSession({sessionId:input.sessionId});
    signal?.throwIfAborted();
    const sent=await sendTurn({billingEntitlement:billingEntitlement(input.billingEntitlement),id:input.turnId,sessionId:input.sessionId,machineId:input.machineId,userId:scope.userId,text:input.text,cliType:input.cliType,agentType:input.agentType,...choice,...(attachments.length?{attachmentBlocks:attachments}:{}),...(input.resume?{resume:input.resume}:{}),...(input.guide===true?{guide:true}:input.queue?{queue:true}:{})});
    return {state:sent.state,reason:sent.reason};
   } catch {return {state:'unknown'};}
  },
  // Before the write, a selection the live options or Roles refuse (or a failed read of them) is
  // `rejected`: nothing was written. After it only a refusal the runtime made unread is.
  async createAndSend(input,signal) {
   signal?.throwIfAborted();
   if(!input || !uuid.test(input.sessionId) || !uuid.test(input.turnId) || typeof input.text!=='string' || input.text.length>32000)throw Error('invalid_creation');
   const attachments=input.attachments??[];
   if(!Array.isArray(attachments) || attachments.length>16 || attachments.some(block=>!block || typeof block!=='object' || !['image','file'].includes(block.type)) || JSON.stringify(attachments).length>64000 || (!input.text.trim() && !attachments.length))throw Error('invalid_creation');
   if(attempted.has(input.sessionId))throw Error('already_attempted');
   // A multi-repository project (`group:<uuid>`): workspace-wide agents; the runtime reads the
   // group fresh, checks its computer and writes its frozen run (web Project group).
   const group=typeof input.projectId==='string' && input.projectId.startsWith('group:') ? input.projectId.slice(6) : undefined;
   if(group!==undefined && !uuid.test(group))throw Error('invalid_creation');
   const pinned=input.configOptionValues;
   if(pinned!==undefined && (!pinned || typeof pinned!=='object' || Array.isArray(pinned) || Object.keys(pinned).length>64 || Object.entries(pinned).some(([k,v])=>!k || k.length>128 || !['string','boolean'].includes(typeof v) || (typeof v==='string' && v.length>128))))throw Error('invalid_creation');
   if(input.agentRoleId!==undefined && (typeof input.agentRoleId!=='string' || !input.agentRoleId))throw Error('invalid_creation');
   let scope, agent, capability, role;
   try {
    scope=identity();
    const available=await options(group===undefined?input.projectId:undefined);
    agent=available.agents.find(a=>a.id===input.agentConfigId && a.machineId===input.machineId);
    if(!agent)throw Error('agent_unavailable');
    capability=available.capabilities.find(c=>c.machineId===agent.machineId && c.agentConfigId===agent.id) ?? available.capabilities.find(c=>c.machineId===agent.machineId && !c.agentConfigId && c.cliType===agent.cliType && c.agentType===agent.agentType);
    if(input.modelId && !capability?.models.some(m=>m.id===input.modelId))throw Error('invalid_model');
    if(input.modeId && !capability?.modes.some(m=>m.id===input.modeId))throw Error('invalid_mode');
    if(input.effort && !effortsFor(capability, input.modelId).includes(input.effort))throw Error('invalid_effort');
    // A Role binds this computer's agent exactly (web): re-read it to freeze its revision as
    // provenance; the first turn's send re-reads it again and applies it or refuses.
    if(input.agentRoleId!==undefined) {
     role=(await roles()).find(r=>r.id===input.agentRoleId);
     const target=role?.targets.find(t=>t.machineId===agent.machineId);
     if(!target || target.agentConfigId!==agent.id || target.state!=='configured')throw Error('role_unavailable');
    }
   } catch {
    signal?.throwIfAborted();
    return {state:'rejected',sessionId:input.sessionId};
   }
   signal?.throwIfAborted();
   attempted.add(input.sessionId);
   const billing=billingEntitlement(input.billingEntitlement);
   try {
    let result;
    try {
     result=await runtime.createSession({billingEntitlement:billing,workspaceId:scope.workspaceId,userId:scope.userId,preferRoost:input.preferRoost===true,sessionId:input.sessionId,machineId:agent.machineId,agentConfigId:agent.id,...(group===undefined?{projectId:input.projectId}:{projectGroupId:group}),branch:group===undefined?input.branch:undefined,useWorktree:input.worktree===true,title:input.text.trim().slice(0,200),...(role?{agentRoleId:role.id,agentRoleRevision:role.revision}:{})});
    } catch(error) {
     // The shared channel answers these before its handler runs, so no write was attempted.
     if(['invalid_params','unsupported_method'].includes(error?.message))return {state:'rejected',sessionId:input.sessionId};
     throw error;
    }
    if(result.state!=='created')return {state:result.state==='unknown'?'unknown':'rejected',sessionId:input.sessionId,...(result.state==='rejected'&&typeof result.reason==='string'?{reason:result.reason}:{})};
    signal?.throwIfAborted();
    await runtime.ensureSession({sessionId:input.sessionId});
    signal?.throwIfAborted();
    const sent=await sendTurn({billingEntitlement:billing,id:input.turnId,sessionId:input.sessionId,machineId:agent.machineId,userId:scope.userId,text:input.text,...(attachments.length?{attachmentBlocks:attachments}:{}),cliType:agent.cliType,agentType:agent.agentType,modelId:input.modelId,modeId:input.modeId,reasoningEffort:input.effort,reasoningEffortConfigId:capability?.reasoningEffortConfigId,...(pinned?{configOptionValues:pinned}:{}),...(role?{agentRoleId:role.id,agentConfigId:agent.id}:{})});
    return {state:sent.state,sessionId:input.sessionId,...(sent.state==='not_sent'&&sent.reason?{reason:sent.reason}:{})};
   } catch {return {state:'unknown',sessionId:input.sessionId};}
  },
 };
}
